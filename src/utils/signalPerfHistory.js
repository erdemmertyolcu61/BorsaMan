// ── DAY-BY-DAY SIGNAL PERFORMANCE HISTORY (v31.14) — pure, testable ────────
// The signal tracker captured fixed d1/d3/d5/d7 checkpoints + an instant return,
// but not a per-day series. The user wants "hisseleri gün gün arttı azaldı" — a
// day-by-day record of each recommended stock's gain/loss — saved into Sinyal
// Takibi. This appends ONE point per calendar day (entry-relative, direction-
// adjusted return), updating today's point on each intraday tick.

/**
 * Append/update a daily performance point (idempotent within a calendar day).
 * @param {Array<{d:string,pct:number}>} existing - prior daily series
 * @param {string} dayKey - 'YYYY-MM-DD' for the current point
 * @param {number} pct - direction-adjusted entry-relative return (%)
 * @param {number} [maxDays=30] - cap the series length
 * @returns {Array<{d:string,pct:number}>} new array (never mutates input)
 */
export function appendDailyPerf(existing, dayKey, pct, maxDays = 30) {
  const arr = Array.isArray(existing) ? existing.filter(p => p && typeof p.d === 'string') : [];
  if (pct == null || !Number.isFinite(pct) || !dayKey) return arr;
  const point = { d: dayKey, pct: Math.round(pct * 100) / 100 };
  const last = arr[arr.length - 1];
  if (last && last.d === dayKey) {
    return [...arr.slice(0, -1), point]; // same day → replace today's point
  }
  return [...arr, point].slice(-maxDays); // new day → append (capped)
}

/**
 * Summarize a daily series for compact UI: best/worst day, up/down day counts,
 * latest return, and net day-over-day deltas.
 * @param {Array<{d:string,pct:number}>} dailyPerf
 */
export function summarizeDailyPerf(dailyPerf) {
  const arr = Array.isArray(dailyPerf) ? dailyPerf.filter(p => p && Number.isFinite(p.pct)) : [];
  if (!arr.length) return { days: 0, latest: null, best: null, worst: null, upDays: 0, downDays: 0 };
  let best = arr[0], worst = arr[0], upDays = 0, downDays = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].pct > best.pct) best = arr[i];
    if (arr[i].pct < worst.pct) worst = arr[i];
    // Day-over-day direction (first day compares to 0 = entry).
    const prev = i === 0 ? 0 : arr[i - 1].pct;
    const delta = arr[i].pct - prev;
    if (delta > 0) upDays++;
    else if (delta < 0) downDays++;
  }
  return { days: arr.length, latest: arr[arr.length - 1].pct, best, worst, upDays, downDays };
}

// ── BACKFILL FROM HISTORICAL BARS (v31.21) ────────────────────────────────
// appendDailyPerf only captures a point while the app is OPEN. A signal recorded
// 3 days ago therefore had an empty history — but the user wants to see each day's
// change for it. Daily closes are already available from the price engine, so the
// series can be reconstructed exactly: for every trading day at/after the entry,
// the direction-adjusted return of that day's CLOSE vs the entry price.

const dayKeyOf = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};

/**
 * Rebuild the day-by-day series for a signal from its symbol's daily bars.
 * @param {object} signal - { entryPrice|price, timestamp, cls }
 * @param {Array<{date:any, close:number}>} bars - daily bars, oldest → newest
 * @param {number} [maxDays=30]
 * @returns {Array<{d:string,pct:number}>}
 */
export function backfillDailyPerf(signal, bars, maxDays = 30) {
  const entry = signal?.entryPrice ?? signal?.price;
  if (!entry || !(entry > 0) || !Array.isArray(bars) || !bars.length) return [];
  const startKey = dayKeyOf(signal?.timestamp);
  if (!startKey) return [];
  const dir = signal?.cls === 'sell' ? -1 : 1;
  const out = [];
  for (const b of bars) {
    const k = dayKeyOf(b?.date);
    if (!k || k < startKey) continue;                       // before the signal
    const close = b?.close;
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({ d: k, pct: Math.round(((close - entry) / entry) * 100 * dir * 100) / 100 });
  }
  return out.slice(-maxDays);
}

/**
 * Merge a backfilled series with the live-captured one.
 * Backfill supplies missing past days (using official closes); any day already
 * captured live is kept ONLY for the most recent day (today's intraday value),
 * because a completed day's close is the more accurate record.
 */
export function mergeDailyPerf(existing, backfilled, maxDays = 30) {
  const cur = Array.isArray(existing) ? existing.filter(p => p && typeof p.d === 'string') : [];
  const back = Array.isArray(backfilled) ? backfilled.filter(p => p && typeof p.d === 'string') : [];
  if (!back.length) return cur.slice(-maxDays);
  const byDay = new Map();
  for (const p of back) byDay.set(p.d, p);                  // closes first
  const latestLive = cur.length ? cur[cur.length - 1] : null;
  for (const p of cur) if (!byDay.has(p.d)) byDay.set(p.d, p); // keep live-only days
  if (latestLive) {
    const latestBackKey = back[back.length - 1].d;
    if (latestLive.d >= latestBackKey) byDay.set(latestLive.d, latestLive); // today = live
  }
  return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-maxDays);
}
