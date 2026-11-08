// ── TARAMA KARNESI (v31.47) — saf, test edilebilir ─────────────────────────
//
// Kullanici: "Her ongordugu hisseyi sabah tarattigimda BIST kapandiktan sonra
// ongordugum hisseler bugun bu kadar artti veya azaldi diye gostersin" ve
// "tum taradigimiz hisselerin gecmis verilerini de guncelle".
//
// Neden ayri bir kayit: forwardTestJournal gun basina SON taramayi tutar. 18:15
// kapanis taramasi o gunun kaydina yazildigi icin sabah onerilen liste kapanista
// artik yoktu. Sinyal takibi ise her taramayi ayri satir olarak tutar; "bu sabah
// ne onerildi, kapanista ne oldu" sorusunun tek bir cevabi yoktu.
//
// Kural: bir oneri, onu YARGILAYAN seansin gunune yazilir. Seans icinde ya da
// acilistan once yapilan tarama o gunun kapanisiyla, aksam/hafta sonu taramasi bir
// sonraki seansin kapanisiyla yargilanir. Ayni gun ayni hisse tekrar onerilirse
// ILK goruldugu an ve fiyat kalir; "ne zaman ongordu" sorusunun dogru cevabi budur.
//
// Sonuc iki kaynaktan gelir ve kaynagi her zaman yazilidir:
//   live        seans suruyor, anlik fiyat (gecici)
//   quote_close seans bitti, toplu fiyat listesinin kapanisi (resmi bar henuz yok)
//   bar         resmi gunluk bar (kesin). Bar gelince digerlerinin yerini alir.

import { istanbulDayKey, lastSettledTradingDay } from './signalPerfHistory.js';
import { nextWeekdayKey } from './sessionEntry.js';
import { parseSessionDate } from './liveSession.js';
import { deriveDisplayPicks } from './displayPicks.js';

export const SCORECARD_KEY = 'bist_scan_scorecard_v1';
export const MAX_DAYS = 60;            // tutulan seans gunu
export const MAX_PICKS_PER_DAY = 16;   // gun icinde toplanan farkli oneri tavani
export const FOLLOW_SESSIONS = 5;      // kapanistan sonra izlenen seans (1G..5G)
export const SEED_WINDOW_DAYS = 75;    // gecmisten tohumlama penceresi (takvim gunu)
export const MAX_SETTLE_TRIES = 6;     // bar hic gelmezse (tatil/veri yok) kac kez denenir

const SESSION_OPEN_MIN = 9 * 60 + 55;   // 09:55 surekli islem
const SESSION_CLOSE_MIN = 18 * 60 + 10; // 18:10 kapanis
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const pctOf = (to, from) => (Number.isFinite(to) && from > 0 ? ((to - from) / from) * 100 : null);

function trtParts(ts) {
  const t = ts instanceof Date ? ts.getTime() : Number(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 3 * 3600 * 1000);            // Istanbul duvar saati (DST yok)
  return { day: d.toISOString().slice(0, 10), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Bir oneriyi hangi seansin kapanisi yargilar? 'YYYY-MM-DD' */
export function judgingSessionDay(ts) {
  const p = trtParts(ts);
  if (!p) return '';
  if (p.dow >= 1 && p.dow <= 5 && p.min < SESSION_CLOSE_MIN) return p.day;
  return nextWeekdayKey(p.day);
}

/** Oneri seans icinde mi verildi, yoksa seans baslamadan mi? */
export function pickTiming(ts) {
  const p = trtParts(ts);
  if (!p) return 'before';
  return (p.dow >= 1 && p.dow <= 5 && p.min >= SESSION_OPEN_MIN && p.min < SESSION_CLOSE_MIN) ? 'session' : 'before';
}

/** Yargilayan seans bitti mi (18:10 gecti mi)? */
export function isSessionOver(day, now = Date.now()) {
  const p = trtParts(now);
  if (!p || !DAY_KEY_RE.test(String(day || ''))) return false;
  if (p.day > day) return true;
  return p.day === day && p.min >= SESSION_CLOSE_MIN;
}

// ── Storage ──────────────────────────────────────────────────────────────

export function loadScorecard() {
  try {
    const raw = localStorage.getItem(SCORECARD_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(d => d && DAY_KEY_RE.test(d.day) && Array.isArray(d.picks)) : [];
  } catch { return []; }
}

export function pruneDays(days) {
  return (Array.isArray(days) ? days : [])
    .slice()
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, MAX_DAYS);
}

export function persistScorecard(days) {
  const trimmed = pruneDays(days);
  try { localStorage.setItem(SCORECARD_KEY, JSON.stringify(trimmed)); } catch { /* kota */ }
  return trimmed;
}

// ── Recording ────────────────────────────────────────────────────────────

/**
 * Taramanin kullaniciya GOSTERDIGI AL onerileri — paneldeki ile ayni turetme
 * (deriveDisplayPicks), boylece karne ekranda gorulmeyen bir hisseyi saymaz.
 */
export function selectScorecardPicks(detail) {
  const top = Array.isArray(detail?.topPicks) ? detail.topPicks : [];
  if (!top.length) return [];
  const results = Array.isArray(detail?.results) ? detail.results : [];
  const regime = top.find(p => typeof p?._regime === 'string')?._regime || null;
  let shown;
  try {
    shown = deriveDisplayPicks(top, results, !!(regime && regime !== 'BULL'), regime);
  } catch {
    shown = top;
  }
  return shown.filter(p => p && p.symbol && p.cls !== 'sell');
}

function emptyDay(day) {
  return { day, scans: 0, firstScanTs: null, lastScanTs: null, regime: null, picks: [], bench: null, settleTries: 0 };
}

/** Bir oneriyi gune ekle (ilk gorulen kalir). Mutasyon yapmaz, yeni gun doner. */
function addPick(rec, entry) {
  const i = rec.picks.findIndex(x => x.symbol === entry.symbol);
  if (i >= 0) {
    const cur = rec.picks[i];
    // Daha ERKEN bir kayit geldiyse (tohumlama sirasi) onu esas al.
    if (Number.isFinite(entry.ts) && entry.ts < cur.ts) {
      const picks = rec.picks.slice();
      picks[i] = { ...cur, ...entry, seen: (cur.seen || 1) + 1, result: null };
      return { ...rec, picks };
    }
    const picks = rec.picks.slice();
    picks[i] = { ...cur, seen: (cur.seen || 1) + 1 };
    return { ...rec, picks };
  }
  if (rec.picks.length >= MAX_PICKS_PER_DAY) return rec;
  return { ...rec, picks: [...rec.picks, { ...entry, seen: 1, result: null }] };
}

function pickEntry(p, ts, extra = {}) {
  const ref = Number(p.price) > 0 ? Number(p.price) : (Number(p.entry) > 0 ? Number(p.entry) : null);
  if (!ref || !p?.symbol) return null;
  return {
    symbol: String(p.symbol).toUpperCase(),
    refPrice: r4(ref),
    ts,
    when: pickTiming(ts),
    score: Number.isFinite(p.score) ? Math.round(p.score * 10) / 10 : null,
    tier: p.convictionTier || null,
    watchOnly: !!p._watchOnly,
    bestOfDay: !!p._bestOfDay,
    stop: Number(p.stop) > 0 ? r4(Number(p.stop)) : null,
    target: Number(p.target ?? p.t1) > 0 ? r4(Number(p.target ?? p.t1)) : null,
    sector: p.sector || '',
    ...extra,
  };
}

/** advisor-scan-complete → karneye yaz. */
export function recordScan(days, detail, now = Date.now()) {
  const picks = selectScorecardPicks(detail);
  if (!picks.length) return days;
  const day = judgingSessionDay(now);
  if (!day) return days;
  const list = Array.isArray(days) ? days : [];
  let rec = list.find(d => d.day === day) || emptyDay(day);
  for (const p of picks) {
    const ts = Number.isFinite(p._scanTs) ? p._scanTs : now;
    const e = pickEntry(p, ts);
    if (e) rec = addPick(rec, e);
  }
  const regime = picks.find(p => typeof p._regime === 'string')?._regime || rec.regime || null;
  rec = {
    ...rec,
    scans: (rec.scans || 0) + 1,
    firstScanTs: rec.firstScanTs ?? now,
    lastScanTs: now,
    regime,
  };
  const exists = list.some(d => d.day === day);
  return pruneDays(exists ? list.map(d => (d.day === day ? rec : d)) : [rec, ...list]);
}

/**
 * Gecmisi tohumla: sinyal takibindeki tarama kayitlari + tahmin defteri.
 * Idempotent — ayni hisse/gun ikinci kez eklenmez, daha erken kayit kazanir.
 */
export function seedFromHistory(days, { signals = [], journal = [] } = {}, now = Date.now()) {
  const minTs = now - SEED_WINDOW_DAYS * 86400000;
  const entries = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    if (!s || s.source !== 'advisor' || (s.cls && s.cls !== 'buy')) continue;
    const ts = new Date(s.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < minTs) continue;
    const e = pickEntry({
      symbol: s.symbol, price: s.price ?? s.entry, score: s.score ?? s.score100,
      convictionTier: s.convictionTier, stop: s.stop, target: s.target, sector: s.sector,
    }, ts, { seeded: 'signals' });
    if (e) entries.push(e);
  }
  for (const d of Array.isArray(journal) ? journal : []) {
    const ts = Number(d?.timestamp);
    if (!Number.isFinite(ts) || ts < minTs) continue;
    for (const pr of Array.isArray(d.predictions) ? d.predictions : []) {
      const e = pickEntry({
        symbol: pr.symbol, price: pr.entryPrice, score: pr.score, stop: pr.stop,
        target: pr.target, sector: pr.sector,
      }, ts, { seeded: 'journal' });
      if (e) entries.push(e);
    }
  }
  if (!entries.length) return days;

  entries.sort((a, b) => a.ts - b.ts);
  const byDay = new Map((Array.isArray(days) ? days : []).map(d => [d.day, d]));
  let changed = false;
  for (const e of entries) {
    const day = judgingSessionDay(e.ts);
    if (!day) continue;
    const before = byDay.get(day) || emptyDay(day);
    const has = before.picks.find(x => x.symbol === e.symbol);
    if (has && !(e.ts < has.ts)) continue;            // zaten var, daha erken degil
    const after = addPick(before, e);
    if (after !== before) {
      byDay.set(day, { ...after, firstScanTs: Math.min(after.firstScanTs ?? e.ts, e.ts), seeded: true });
      changed = true;
    }
  }
  return changed ? pruneDays([...byDay.values()]) : days;
}

// ── Settlement ───────────────────────────────────────────────────────────

/**
 * Resmi gunluk barlardan bir onerinin sonucunu kur.
 * @returns {object|null} bar bulunamazsa null
 */
export function resultFromBars(pick, day, bars) {
  const ref = pick?.refPrice;
  if (!(ref > 0) || !Array.isArray(bars) || !bars.length) return null;
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (istanbulDayKey(bars[i]?.date) === day) { idx = i; break; }
  }
  if (idx < 0) return null;
  const bar = bars[idx];
  const close = Number(bar?.close);
  if (!(close > 0)) return null;
  const prevClose = idx > 0 && Number(bars[idx - 1]?.close) > 0 ? Number(bars[idx - 1].close) : null;
  const high = Number(bar.high) > 0 ? Number(bar.high) : null;
  const low = Number(bar.low) > 0 ? Number(bar.low) : null;
  const follow = [];
  for (let k = 1; k <= FOLLOW_SESSIONS; k++) {
    const b = bars[idx + k];
    const c = Number(b?.close);
    if (!(c > 0)) break;
    follow.push({ d: istanbulDayKey(b.date), pct: r2(pctOf(c, ref)) });
  }
  return {
    src: 'bar',
    close: r4(close),
    prevClose: r4(prevClose),
    pct: r2(pctOf(close, ref)),
    dayPct: r2(pctOf(close, prevClose)),
    highPct: r2(pctOf(high, ref)),
    lowPct: r2(pctOf(low, ref)),
    hitTarget: !!(pick.target && high && high >= pick.target),
    hitStop: !!(pick.stop && low && low <= pick.stop),
    follow,
    complete: follow.length >= FOLLOW_SESSIONS,
  };
}

/**
 * Toplu fiyat kaydindan gecici (ya da kapanis sonrasi) sonuc.
 * Kayit baska bir oturuma aitse (ornegin acilistan once dunun listesi) null.
 */
export function resultFromQuote(pick, day, quote, now = Date.now()) {
  const ref = pick?.refPrice;
  const price = Number(quote?.price);
  if (!(ref > 0) || !(price > 0)) return null;
  const sd = parseSessionDate(quote?.sessionDate);
  const sessionKey = sd ? istanbulDayKey(sd) : '';
  if (sessionKey && sessionKey !== day) return null;
  if (!sessionKey) {
    // Oturum bilgisi yoksa yalniz yargilayan gunun seansi icindeyken guven.
    const p = trtParts(now);
    if (!p || p.day !== day || p.min < SESSION_OPEN_MIN) return null;
  }
  const over = isSessionOver(day, now);
  const high = Number(quote.high) > 0 ? Number(quote.high) : null;
  const low = Number(quote.low) > 0 ? Number(quote.low) : null;
  const prevClose = Number(quote.prevClose) > 0 ? Number(quote.prevClose) : null;
  return {
    src: over ? 'quote_close' : 'live',
    close: r4(price),
    prevClose: r4(prevClose),
    pct: r2(pctOf(price, ref)),
    dayPct: r2(prevClose ? pctOf(price, prevClose) : Number(quote.change)),
    highPct: r2(pctOf(high, ref)),
    lowPct: r2(pctOf(low, ref)),
    hitTarget: !!(pick.target && high && high >= pick.target),
    hitStop: !!(pick.stop && low && low <= pick.stop),
    follow: [],
    complete: false,
    at: now,
  };
}

/** Bir gunun resmi kapanisi artik bekleniyor mu? (18:30 TRT sonrasi) */
export function isDaySettleable(day, now = Date.now()) {
  return DAY_KEY_RE.test(String(day || '')) && day <= lastSettledTradingDay(now);
}

/** Bar ile yerlesmesi gereken gunler (eksik ya da 5G izlemesi tamamlanmamis). */
export function daysNeedingBars(days, now = Date.now()) {
  return (Array.isArray(days) ? days : []).filter(d => {
    if (!isDaySettleable(d.day, now)) return false;
    if ((d.settleTries || 0) >= MAX_SETTLE_TRIES && d.picks.every(p => !p.result || p.result.src !== 'bar')) return false;
    if (!d.bench || d.bench.src !== 'bar') return true;
    return d.picks.some(p => !p.result || p.result.src !== 'bar' || !p.result.complete);
  });
}

/** Seansi suren / kapanisi resmi bar bekleyen gunler (canli fiyatla doldurulur). */
export function daysNeedingQuotes(days, now = Date.now()) {
  const p = trtParts(now);
  if (!p) return [];
  return (Array.isArray(days) ? days : []).filter(d =>
    d.day === p.day && !isDaySettleable(d.day, now)
    && d.picks.some(x => !x.result || x.result.src !== 'bar'));
}

/**
 * Barlarla gunleri guncelle. barsBySymbol: { SYM: bars[] }, benchBars: XU100.
 * Sembolun bari bu pasta yoksa (cekilmedi) dokunulmaz.
 */
export function settleWithBars(days, barsBySymbol, benchBars, now = Date.now()) {
  let changed = false;
  // The source can publish the day's bar after 18:30; a missing bar only counts
  // as a failed try once the evening of that day is over.
  const todayKey = trtParts(now)?.day || '';
  const next = (Array.isArray(days) ? days : []).map(d => {
    if (!isDaySettleable(d.day, now)) return d;
    let touched = false;
    let anyMissing = false;
    const picks = d.picks.map(p => {
      if (p.result?.src === 'bar' && p.result.complete) return p;
      const bars = barsBySymbol?.[p.symbol];
      if (!Array.isArray(bars)) return p;              // bu pasta cekilmedi
      const res = resultFromBars(p, d.day, bars);
      if (!res) { anyMissing = true; return p; }
      touched = true;
      return { ...p, result: res };
    });
    let bench = d.bench;
    if (Array.isArray(benchBars) && (!bench || bench.src !== 'bar')) {
      const b = resultFromBars({ refPrice: 1 }, d.day, benchBars);
      if (b) {
        bench = { src: 'bar', close: b.close, pct: b.dayPct };
        touched = true;
      }
    }
    const countTry = anyMissing && d.day < todayKey;
    if (!touched && !countTry) return d;
    changed = true;
    return {
      ...d,
      picks,
      bench,
      settleTries: countTry ? (d.settleTries || 0) + 1 : (d.settleTries || 0),
      settledAt: touched ? now : d.settledAt,
    };
  });
  return { days: next, changed };
}

/** Toplu fiyatlarla bugunu guncelle (resmi bar gelmeden). */
export function settleWithQuotes(days, quoteMap, now = Date.now()) {
  let changed = false;
  const due = new Set(daysNeedingQuotes(days, now).map(d => d.day));
  const next = (Array.isArray(days) ? days : []).map(d => {
    if (!due.has(d.day)) return d;
    let touched = false;
    const picks = d.picks.map(p => {
      if (p.result?.src === 'bar') return p;
      const res = resultFromQuote(p, d.day, quoteMap?.[p.symbol], now);
      if (!res) return p;
      touched = true;
      return { ...p, result: res };
    });
    if (!touched) return d;
    changed = true;
    return { ...d, picks, quotedAt: now };
  });
  return { days: next, changed };
}

/** Yerlesim icin cekilecek semboller (gunler yeniden eskiye, tekil). */
export function symbolsToSettle(days, now = Date.now(), limit = 12) {
  const out = [];
  for (const d of daysNeedingBars(days, now)) {
    for (const p of d.picks) {
      if (p.result?.src === 'bar' && p.result.complete) continue;
      if (!out.includes(p.symbol)) out.push(p.symbol);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ── Summary ──────────────────────────────────────────────────────────────

/**
 * Gun ozeti. Esit agirlikli ortalama — karne "bu oneriler ne yapti" sorusunu
 * cevaplar, bir portfoy getirisi iddia etmez.
 */
export function summarizeDay(rec) {
  const picks = Array.isArray(rec?.picks) ? rec.picks : [];
  const measured = picks.filter(p => Number.isFinite(p.result?.pct));
  const up = measured.filter(p => p.result.pct > 0).length;
  const down = measured.filter(p => p.result.pct < 0).length;
  const avg = measured.length ? measured.reduce((a, p) => a + p.result.pct, 0) / measured.length : null;
  const withD1 = measured.filter(p => Number.isFinite(p.result.follow?.[0]?.pct));
  const withD5 = measured.filter(p => Number.isFinite(p.result.follow?.[FOLLOW_SESSIONS - 1]?.pct));
  const avgOf = (arr, i) => (arr.length ? arr.reduce((a, p) => a + p.result.follow[i].pct, 0) / arr.length : null);
  let best = null;
  let worst = null;
  for (const p of measured) {
    if (!best || p.result.pct > best.result.pct) best = p;
    if (!worst || p.result.pct < worst.result.pct) worst = p;
  }
  const srcs = new Set(measured.map(p => p.result.src));
  const status = !measured.length ? 'pending'
    : srcs.has('live') ? 'live'
      : (srcs.size === 1 && srcs.has('bar') && measured.length === picks.length) ? 'final'
        : 'closing';
  const bench = Number.isFinite(rec?.bench?.pct) ? rec.bench.pct : null;
  return {
    n: picks.length,
    measured: measured.length,
    up,
    down,
    flat: measured.length - up - down,
    avgPct: r2(avg),
    avgD1: r2(avgOf(withD1, 0)),
    avgD5: r2(avgOf(withD5, FOLLOW_SESSIONS - 1)),
    nD5: withD5.length,
    best: best ? { symbol: best.symbol, pct: best.result.pct } : null,
    worst: worst ? { symbol: worst.symbol, pct: worst.result.pct } : null,
    benchPct: bench,
    vsBench: avg != null && bench != null ? r2(avg - bench) : null,
    status,
  };
}

/** Ekranda one cikacak gun: bugunun (ya da yarinin) kaydi, yoksa en yeni. */
export function featuredDay(days, now = Date.now()) {
  const list = pruneDays(days);
  if (!list.length) return null;
  const today = trtParts(now)?.day || '';
  return list.find(d => d.day === today) || list.find(d => d.day <= today && d.picks.length) || list[0];
}

export default {
  SCORECARD_KEY, MAX_DAYS, MAX_PICKS_PER_DAY, FOLLOW_SESSIONS,
  judgingSessionDay, pickTiming, isSessionOver,
  loadScorecard, persistScorecard, pruneDays,
  selectScorecardPicks, recordScan, seedFromHistory,
  resultFromBars, resultFromQuote, isDaySettleable,
  daysNeedingBars, daysNeedingQuotes, settleWithBars, settleWithQuotes, symbolsToSettle,
  summarizeDay, featuredDay,
};
