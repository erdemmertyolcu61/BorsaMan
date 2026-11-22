// ════════════════════════════════════════════════════════════════════
// moversScorecard.js — GUN ICI HAREKET LISTESININ ileri olcumu (v31.54)
// ════════════════════════════════════════════════════════════════════
//
// Hareket listesi (nextSession.rankMovers) gecmis veride olculdu; bu modul ayni
// seyi ILERIYE dogru olcer: her tarama listeyi dayanak gunuyle kaydeder, o gunden
// sonraki ilk seansin RESMI gunluk bari gelince kuralin sonucunu yazar
// (nextSession.settleDayTrade — olcumdeki ile ayni fonksiyon).
//
// SAF: depolama yalniz load/persist icinde. Skora, siraya, paper motoruna geri donmez.
// ════════════════════════════════════════════════════════════════════

import { DAYTRADE_RULE, settleDayTrade } from './nextSession.js';

export const MOVERS_KEY = 'bist_movers_scorecard_v1';
export const MAX_DAYS = 90;
/** Bar hic gelmezse (veri yok, islem durmus) kac geciste vazgecilir. */
export const MAX_TRIES = 40;

const isNum = Number.isFinite;

export function loadMovers() {
  try {
    const raw = JSON.parse(localStorage.getItem(MOVERS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function persistMovers(days) {
  try { localStorage.setItem(MOVERS_KEY, JSON.stringify(days)); } catch { /* kota */ }
  return days;
}

/**
 * Taramanin hareket listesini kaydet. Ayni dayanak gunu icin ILK liste kalir:
 * liste kapanmis barlardan uretildigi icin ayni gunun sonraki taramalari ayni
 * listeyi verir; ilkini tutmak kaydi degismez kilar.
 * @param {Array} days
 * @param {Array<{symbol,rank,pMove,pGreen,basisDay,limitUpClose}>} movers
 */
export function recordMovers(days, movers, now = Date.now()) {
  const list = Array.isArray(days) ? days : [];
  const picks = (Array.isArray(movers) ? movers : []).filter((m) => m && m.symbol && m.basisDay && isNum(m.pMove));
  if (!picks.length) return list;
  // Listenin dayanak gunu: en cok hissenin paylastigi gun (verisi geride kalan tek hisse gunu kaydirmasin).
  const count = new Map();
  for (const m of picks) count.set(m.basisDay, (count.get(m.basisDay) || 0) + 1);
  const basisDay = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0][0];
  if (list.some((d) => d.basisDay === basisDay)) return list;
  const rec = {
    basisDay, ts: now, tries: 0, settled: false,
    picks: picks.filter((m) => m.basisDay === basisDay).map((m, i) => ({
      symbol: String(m.symbol).toUpperCase(), rank: i + 1,
      pMove: m.pMove, pGreen: isNum(m.pGreen) ? m.pGreen : null, limitUpClose: !!m.limitUpClose, result: null,
    })),
  };
  return [rec, ...list].sort((a, b) => (a.basisDay < b.basisDay ? 1 : -1)).slice(0, MAX_DAYS);
}

/** Yerlesmemis gunlerin sembolleri (bar cekmek icin). */
export function moversToSettle(days) {
  const out = new Set();
  for (const d of Array.isArray(days) ? days : []) {
    if (d.settled) continue;
    for (const p of d.picks) if (!p.result) out.add(p.symbol);
  }
  return [...out];
}

/**
 * Resmi gunluk barlarla yerlestir: dayanak gununden SONRAKI ilk kapanmis bar yargilar.
 * @param {(d:any)=>string} dayKeyFn bar tarihi → 'YYYY-MM-DD'
 * @param {{today?:string, sessionOver?:boolean}} opts bugunun bari yalniz seans bittiyse kullanilir
 */
export function settleMovers(days, barsBySymbol, dayKeyFn, { today = '', sessionOver = false } = {}) {
  let changed = false;
  const next = (Array.isArray(days) ? days : []).map((d) => {
    if (d.settled) return d;
    let touched = false, sawBars = false;
    const picks = d.picks.map((p) => {
      if (p.result) return p;
      const bars = barsBySymbol?.[p.symbol];
      if (!Array.isArray(bars) || !bars.length) return p;
      sawBars = true;
      const prev = [...bars].reverse().find((b) => dayKeyFn(b?.date) === d.basisDay);
      const bar = bars.find((b) => {
        const k = dayKeyFn(b?.date);
        if (!k || k <= d.basisDay || b._isForming === true) return false;
        return !today || k < today || (k === today && sessionOver);
      });
      if (!bar) return p;
      const prevClose = Number(prev?.close);
      // v31.57: önceki kapanış kurala girer — açılış kâr-alı tavanın üstüne ittiyse işlem alınmaz.
      const res = settleDayTrade(bar, DAYTRADE_RULE, prevClose > 0 ? prevClose : null);
      if (!res) return p;
      touched = true;
      return { ...p, result: { ...res, day: dayKeyFn(bar.date), green: prevClose > 0 ? Number(bar.close) > prevClose : null } };
    });
    // Deneme yalniz bar GELDIGI halde yargilayan seans bulunamadiysa sayilir (ag hatasi sayilmaz).
    const tries = (d.tries || 0) + (sawBars && !touched ? 1 : 0);
    const done = picks.every((p) => p.result) || tries >= MAX_TRIES;
    if (!touched && tries === (d.tries || 0) && !done) return d;
    changed = true;
    return { ...d, picks, tries, settled: done };
  });
  return { days: changed ? next : days, changed };
}

/**
 * Ozet: kuralin olculdugu derinlik (ilk `topN`) ve gosterilen liste ayri.
 * Kilitli (tek fiyatli) seanslar alinamaz sayilir, ozete girmez.
 */
/** Kural bu seçimi gerçekten aldı mı? (Eski kayıtlarda `taken` yok: kilitli değilse alınmış sayılır.) */
export const wasTaken = (res) => !!res && !res.locked && !res.skipped && res.taken !== false;

export function summarizeMovers(days, rule = DAYTRADE_RULE) {
  const bucket = () => ({ n: 0, moved: 0, hit: 0, win: 0, green: 0, greenN: 0, net: 0, expMoved: 0, dayNets: [], locked: 0, skipped: 0 });
  const top = bucket(), shown = bucket();
  for (const d of Array.isArray(days) ? days : []) {
    const settled = (d.picks || []).filter((p) => p.result);
    for (const [b, set] of [[top, settled.filter((p) => p.rank <= rule.topN)], [shown, settled]]) {
      for (const p of set) { if (p.result.locked) b.locked++; else if (p.result.skipped) b.skipped++; }
    }
    const done = settled.filter((p) => wasTaken(p.result));
    for (const [b, set] of [[top, done.filter((p) => p.rank <= rule.topN)], [shown, done]]) {
      if (!set.length) continue;
      let s = 0;
      for (const p of set) {
        b.n++; b.expMoved += p.pMove;
        if (p.result.moved) b.moved++;
        if (p.result.hit) b.hit++;
        if (p.result.netPct > 0) b.win++;
        if (p.result.green != null) { b.greenN++; if (p.result.green) b.green++; }
        b.net += p.result.netPct; s += p.result.netPct;
      }
      b.dayNets.push(s / set.length);
    }
  }
  const fin = (b) => (b.n || b.locked || b.skipped ? {
    n: b.n, days: b.dayNets.length, locked: b.locked, skipped: b.skipped,
    movedPct: b.n ? (b.moved / b.n) * 100 : null, expMovedPct: b.n ? (b.expMoved / b.n) * 100 : null,
    hitPct: b.n ? (b.hit / b.n) * 100 : null, winPct: b.n ? (b.win / b.n) * 100 : null,
    wins: b.win,
    greenPct: b.greenN ? (b.green / b.greenN) * 100 : null,
    avgNet: b.n ? b.net / b.n : null,
    posDayPct: b.dayNets.length ? (b.dayNets.filter((x) => x > 0).length / b.dayNets.length) * 100 : null,
  } : null);
  return { top: fin(top), shown: fin(shown) };
}
