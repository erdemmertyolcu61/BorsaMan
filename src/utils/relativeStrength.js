// ── RELATIVE STRENGTH vs BENCHMARK (v31.9) — pure, testable ───────────────
// A 25yr desk truth: in any market the leaders are the names OUTPERFORMING the
// index, and the laggards underperform even in a rally. The daily advisor scan
// scored stocks in isolation (RSI/OBV/…) with no notion of leadership vs XU100.
// This adds a bounded "am I leading or lagging the index?" signal that feeds the
// composite confidence — leaders get a small boost, laggards a small penalty.

/** N-bar percent return of a close series (oldest → newest). null if too short. */
export function pctReturn(closes, lookback) {
  const c = (closes || []).filter(x => Number.isFinite(x) && x > 0);
  if (c.length < lookback + 1) return null;
  const now = c[c.length - 1];
  const then = c[c.length - 1 - lookback];
  if (!(then > 0)) return null;
  return ((now - then) / then) * 100;
}

/**
 * Relative strength of a stock vs a benchmark index over two horizons.
 * Outperformance = stockReturn − indexReturn (percentage points). The short
 * horizon (recency) is weighted higher than the long one.
 * @param {number[]} stockCloses - stock close series, oldest → newest
 * @param {number[]} indexCloses - benchmark (XU100) close series
 * @param {{short?: number, long?: number}} [opts]
 * @returns {{ outperf: number|null, rsScore: number, leading: boolean,
 *            lagging: boolean, opShort: number|null, opLong: number|null }}
 *   rsScore is a bounded confidence modifier in [-8, +8].
 */
export function computeRelativeStrength(stockCloses, indexCloses, opts = {}) {
  const short = opts.short || 20;
  const long = opts.long || 60;
  const sShort = pctReturn(stockCloses, short);
  const iShort = pctReturn(indexCloses, short);
  const sLong = pctReturn(stockCloses, long);
  const iLong = pctReturn(indexCloses, long);
  const opShort = (sShort != null && iShort != null) ? sShort - iShort : null;
  const opLong = (sLong != null && iLong != null) ? sLong - iLong : null;

  let outperf;
  if (opShort != null && opLong != null) outperf = opShort * 0.6 + opLong * 0.4;
  else if (opShort != null) outperf = opShort;
  else if (opLong != null) outperf = opLong;
  else return { outperf: null, rsScore: 0, leading: false, lagging: false, opShort: null, opLong: null };

  // Map outperformance (pp) to a bounded modifier. ~13pp ahead → +8 cap.
  const rsScore = Math.max(-8, Math.min(8, outperf * 0.6));
  return {
    outperf: Math.round(outperf * 10) / 10,
    rsScore: Math.round(rsScore * 10) / 10,
    leading: outperf > 2,   // >2pp ahead of the index = leader
    lagging: outperf < -2,  // >2pp behind = laggard
    opShort: opShort == null ? null : Math.round(opShort * 10) / 10,
    opLong: opLong == null ? null : Math.round(opLong * 10) / 10,
  };
}
