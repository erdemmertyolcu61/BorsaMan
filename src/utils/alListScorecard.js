// ════════════════════════════════════════════════════════════════════
// alListScorecard.js — AL LISTESININ ileri olcumu, hareket listesi gibi (v31.59)
// ════════════════════════════════════════════════════════════════════
//
// Kullanici (22.11.2026): "AL listesini hareket listesi gibi iyilestirelim" — olculdu, ogrenen
// bir siralayici AL havuzunda tutmadi (scripts/swing-ranker-study.mjs). Bu yuzden degisen sey
// SIRA degil SUNUM: liste tek bir acik kuralla verilir ve telefonda o kuralla olculur.
//
// KURAL (urunun tek cikis kurali, planSimulation.simulatePlanReturn — paper motoru ve sinyal
// takibiyle ayni): kapanistan sonra kurulan listenin ilk 3'u, sonraki seansin ACILISINDA alinir;
// acilis stop'un altindaysa alinmaz (paper'in bekleyen emri de iptal olur, sessionEntry).
// Stop gecersizse (girisin ustunde ya da %12'den uzak) paper'daki gibi −%3. Hedefte satilmaz:
// +%3'te stop girise, +%5'ten sonra kazancin yarisina cekilir; en fazla 30 seans.
//
// Kayit: yalniz SEANS DISI taramalar (aksam kapanis taramasi, hafta sonu, acilis oncesi) —
// liste kapanmis barlardan kurulur, dayanak gunu icin ilk liste kalir. Seans icinde kurulan
// liste ertesi acilista alinacak listeyle ayni olmayabilir; olculmez.
// SAF: depolama yalniz load/persist icinde. Skora, siraya, paper motoruna geri donmez.
// ════════════════════════════════════════════════════════════════════

import { simulatePlanReturn, MAX_PLAN_BARS } from './planSimulation.js';
import { PLAN_CONST } from './tradePlan.js';
import { selectScorecardPicks, judgingSessionDay, pickTiming } from './scanScorecard.js';
import { nextWeekdayKey } from './sessionEntry.js';

export const AL_LIST_KEY = 'bist_al_list_scorecard_v1';
export const MAX_DAYS = 90;
/** Bar gelmesine ragmen giris seansi bulunamazsa kac geciste vazgecilir. */
export const MAX_TRIES = 40;

export const AL_RULE = Object.freeze({
  topN: 3,
  shownN: 8,
  maxSessions: MAX_PLAN_BARS,
  breakevenPct: PLAN_CONST.BREAKEVEN_PCT,
  trailActivePct: PLAN_CONST.TRAIL_ACTIVE_PCT,
  lockFraction: PLAN_CONST.LOCK_FRACTION,
  fallbackStopPct: 3,       // PaperTradeEngine STOP_LOSS_PCT
  maxStopPct: 12,           // paper: stop girisin %12'sinden uzaksa gecersiz
  costPct: 0.3,
});

/**
 * Ekranda alintilanan gecmis (tek yerden). Kaynak: scripts/feature-edge-report.mjs --only secim --k 3,
 * 22.11.2026: 586 hisse, 2022-09 → 2026-11, canli filtreden gecen adaylar, canli stop, yalniz-trailing,
 * %0,3 maliyet; gun ortalamasi. Rakamlari degistirmeden once raporu yeniden kos.
 */
export const AL_LIST_EVIDENCE = Object.freeze({
  period: '2022–2026',
  top3AvgNet: 0.46,        // canli liste ilk 3
  top3WinPct: 38,
  top3P5: -7.7,            // en kotu %5 islem
  poolAvgNet: 0.67,        // ayni gunlerin tum AL adaylari
  poolByYear: Object.freeze({ 2022: 3.83, 2025: 0.42, 2026: -0.21 }),
});

const isNum = Number.isFinite;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

function prevWeekdayKey(key) {
  if (!DAY_RE.test(String(key || ''))) return '';
  let t = Date.parse(`${key}T12:00:00Z`) - 864e5;
  for (let i = 0; i < 7; i++) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    t -= 864e5;
  }
  return new Date(t).toISOString().slice(0, 10);
}

export function loadAlList() {
  try {
    const raw = JSON.parse(localStorage.getItem(AL_LIST_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((d) => d && DAY_RE.test(d.basisDay) && Array.isArray(d.picks)) : [];
  } catch { return []; }
}

export function persistAlList(days) {
  try { localStorage.setItem(AL_LIST_KEY, JSON.stringify(days)); } catch { /* kota */ }
  return days;
}

/** Taramanin ekranda gosterdigi AL listesi (Tahmin karnesiyle ayni turetme: deriveDisplayPicks). */
export function selectAlList(detail, n = AL_RULE.shownN) {
  return selectScorecardPicks(detail).filter((p) => p.cls === 'buy' || p._bestOfDay).slice(0, n);
}

/**
 * Seans disi taramanin listesini kaydet. Dayanak gunu = verinin son KAPANMIS seansi
 * (picklerin `_sessionDay` cogunlugu; yoksa saatten). Ayni dayanak gunu icin ilk liste kalir.
 * @returns {Array} yeni liste (degismediyse ayni referans)
 */
export function recordAlList(days, detail, now = Date.now()) {
  const list = Array.isArray(days) ? days : [];
  if (pickTiming(now) !== 'before') return list;
  const shown = selectAlList(detail);
  if (!shown.length) return list;
  const count = new Map();
  for (const p of shown) if (DAY_RE.test(String(p._sessionDay || ''))) count.set(p._sessionDay, (count.get(p._sessionDay) || 0) + 1);
  const basisDay = count.size
    ? [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0][0]
    : prevWeekdayKey(judgingSessionDay(now));
  if (!basisDay || list.some((d) => d.basisDay === basisDay)) return list;
  const slim = (p, i) => ({
    symbol: String(p.symbol).toUpperCase(), rank: i + 1,
    ref: isNum(Number(p.price)) && Number(p.price) > 0 ? r2(Number(p.price)) : null,
    stop: Number(p.stop) > 0 ? r2(Number(p.stop)) : null,
    score: isNum(p.score) ? Math.round(p.score * 10) / 10 : null,
    watchOnly: !!p._watchOnly, bestOfDay: !!p._bestOfDay,
  });
  const all = shown.map(slim);
  const rec = {
    basisDay, ts: now, tries: 0, settled: false,
    regime: shown.find((p) => typeof p._regime === 'string')?._regime || null,
    picks: all.slice(0, AL_RULE.topN).map((p) => ({ ...p, result: null })),
    next: all.slice(AL_RULE.topN).map((p) => ({ symbol: p.symbol, watchOnly: p.watchOnly })),
  };
  return [rec, ...list].sort((a, b) => (a.basisDay < b.basisDay ? 1 : -1)).slice(0, MAX_DAYS);
}

/** Yerlesmemis gunlerin sembolleri (bar cekmek icin). Acik islemler de her geciste yenilenir.
 *  Izle-only hisseler kural geregi alinmaz — izlenmez. */
export function alListToSettle(days) {
  const out = new Set();
  for (const d of Array.isArray(days) ? days : []) {
    if (d.settled) continue;
    for (const p of d.picks) if (!p.watchOnly && (!p.result || p.result.status === 'open')) out.add(p.symbol);
  }
  return [...out];
}

/**
 * Bir hissenin kural sonucu, resmi gunluk barlardan. Giris = dayanak gununden sonraki ilk
 * kapanmis barin ACILISI. Pencere bitmemisse `status: 'open'` (anlik deger, kesin degil).
 * @param {{stop:number|null}} pick
 * @param {Array} bars kronolojik, yalniz kapanmis barlar
 */
export function settleAlPick(pick, bars, basisDay, dayKeyFn, rule = AL_RULE) {
  const after = (Array.isArray(bars) ? bars : []).filter((b) => {
    const k = dayKeyFn(b?.date);
    return k && k > basisDay && Number(b.close) > 0;
  });
  const first = after[0];
  if (!first) return null;
  const entryDay = dayKeyFn(first.date);
  // Yahoo'nun atladigi gunde acilis yaklasiktir (`_openApprox`, sessionEntry ile ayni): yine
  // kullanilir ama isaretlenir — o gun hic dogru acilis gelmeyecek, beklemek kaydi kilitlerdi.
  const approx = !(Number(first.open) > 0) || first._openApprox === true;
  const open = Number(first.open) > 0 ? Number(first.open) : Number(first.close);
  const stop0 = Number(pick?.stop);
  if (stop0 > 0 && open <= stop0) {
    return { status: 'skipped', reason: 'gap_below_stop', entryDay, entry: r2(open), stop: r2(stop0), approxEntry: approx };
  }
  const stopValid = stop0 > 0 && stop0 < open && stop0 > open * (1 - rule.maxStopPct / 100);
  const stop = stopValid ? stop0 : open * (1 - rule.fallbackStopPct / 100);
  const sim = simulatePlanReturn(
    { cls: 'buy', entryPrice: open, stop, timestamp: Date.parse(`${entryDay}T09:00:00Z`) },
    after,
    { maxBars: rule.maxSessions, breakevenPct: rule.breakevenPct, trailActivePct: rule.trailActivePct, lockFraction: rule.lockFraction },
  );
  if (!sim) return null;
  const done = sim.exitReason === 'stop' || sim.barsHeld >= rule.maxSessions;
  const lastBar = after[Math.min(after.length, sim.barsHeld) - 1];
  return {
    status: done ? 'closed' : 'open',
    entryDay, entry: r2(open), stop: r2(stop), stopFallback: !stopValid, approxEntry: approx,
    exitReason: done ? sim.exitReason : null,
    lastDay: lastBar ? dayKeyFn(lastBar.date) : entryDay,
    sessions: sim.barsHeld,
    grossPct: r2(sim.planReturn), netPct: r2(sim.planReturn - rule.costPct),
  };
}

/**
 * Resmi barlarla yerlestir / acik islemleri guncelle.
 * @param {{today?:string, sessionOver?:boolean}} opts bugunun bari yalniz seans bittiyse kullanilir
 */
export function settleAlList(days, barsBySymbol, dayKeyFn, { today = '', sessionOver = false } = {}) {
  let changed = false;
  const closedOnly = (bars) => (Array.isArray(bars) ? bars : []).filter((b) => {
    if (b?._isForming === true) return false;
    const k = dayKeyFn(b?.date);
    return k && (!today || k < today || (k === today && sessionOver));
  });
  const next = (Array.isArray(days) ? days : []).map((d) => {
    if (d.settled) return d;
    let touched = false, sawBars = false;
    const picks = d.picks.map((p) => {
      if (p.watchOnly || (p.result && p.result.status !== 'open')) return p;
      const raw = barsBySymbol?.[p.symbol];
      if (!Array.isArray(raw) || !raw.length) return p;
      sawBars = true;
      const res = settleAlPick(p, closedOnly(raw), d.basisDay, dayKeyFn);
      if (!res) return p;
      if (p.result && JSON.stringify(p.result) === JSON.stringify(res)) return p;
      touched = true;
      return { ...p, result: res };
    });
    // Deneme yalniz bar GELDIGI ve giris seansi BITMIS oldugu halde giris bulunamadiysa sayilir
    // (ag hatasi da, seansi suren giris gunu de sayilmaz — yoksa gun icinde deneme biterdi).
    const waiting = picks.some((p) => !p.watchOnly && !p.result);
    const due = nextWeekdayKey(d.basisDay);
    const entryDue = !today || today > due || (today === due && sessionOver);
    const tries = (d.tries || 0) + (sawBars && waiting && !touched && entryDue ? 1 : 0);
    const done = picks.every((p) => p.watchOnly || (p.result && p.result.status !== 'open')) || tries >= MAX_TRIES;
    if (!touched && tries === (d.tries || 0) && done === !!d.settled) return d;
    changed = true;
    return { ...d, picks, tries, settled: done };
  });
  return { days: changed ? next : days, changed };
}

/** Kural bu secimi aldi mi? (izle-only ve acilisi stop'un altinda olanlar alinmaz) */
export const alTaken = (p) => !!p?.result && !p.watchOnly && (p.result.status === 'closed' || p.result.status === 'open');

/** Ozet: ilk 3'ten alinanlar. Kapanan islemler kesin, acik olanlar anlik degerle ayri. */
export function summarizeAlList(days) {
  const s = { closed: 0, wins: 0, sumNet: 0, open: 0, sumOpen: 0, skipped: 0, watch: 0, days: 0 };
  for (const d of Array.isArray(days) ? days : []) {
    let any = false;
    const entered = (d.picks || []).some((p) => !p.watchOnly && p.result);
    for (const p of d.picks || []) {
      if (p.watchOnly) { if (entered) s.watch++; continue; }
      if (!p.result) continue;
      if (p.result.status === 'skipped') { s.skipped++; continue; }
      any = true;
      if (p.result.status === 'closed') { s.closed++; s.sumNet += p.result.netPct; if (p.result.netPct > 0) s.wins++; }
      else if (p.result.status === 'open') { s.open++; s.sumOpen += p.result.netPct; }
    }
    if (any) s.days++;
  }
  if (!s.closed && !s.open && !s.skipped && !s.watch) return null;
  return {
    closed: s.closed, wins: s.wins, avgNet: s.closed ? s.sumNet / s.closed : null,
    open: s.open, avgOpen: s.open ? s.sumOpen / s.open : null,
    skipped: s.skipped, watch: s.watch, days: s.days,
  };
}
