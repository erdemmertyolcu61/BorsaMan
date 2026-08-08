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
