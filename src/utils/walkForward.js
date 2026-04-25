// ============================================================
// WALK-FORWARD BACKTEST ENGINE
// ------------------------------------------------------------
// Tek-period backtest yerine rolling in-sample / out-of-sample
// pencereleri ile strateji bozulmasını (overfitting) tespit eder.
//
// Yontem:
//   1. Veriyi N pencereye bol (in-sample + out-of-sample ardisik)
//   2. Her pencere icin in-sample uzerinde backtest cek (parametre
//      ayarlamak istesen burada yapardin — su an statik strateji)
//   3. Hemen ardindaki out-of-sample uzerinde ayni stratejiyi cek
//   4. IS/OOS performans farkini hesapla:
//      - degradation: |OOS_winRate - IS_winRate|
//      - efficiency: OOS_return / IS_return (1.0 = mukemmel)
//      - robustness: tum OOS pencerelerin medyanı
//   5. Final verdict: stable / borderline / overfit
//
// Pure module — runBacktest(prices, strategy) cagirir.
// ============================================================

import { runBacktest, calcBacktestStats } from './backtestEngine.js';

const DEFAULT_WINDOWS = 4;          // 4 ardisik IS/OOS pencere
const DEFAULT_IS_RATIO = 0.7;       // her pencerenin %70 IS, %30 OOS
const MIN_BARS_PER_WINDOW = 60;     // pencere basina minimum bar
const STABILITY_THRESHOLD = 0.5;    // OOS/IS efficiency >= 0.5 -> stable

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, v) => a + v, 0) / arr.length;
  const variance = arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * runWalkForward(prices, strategy, opts)
 * @returns {{ windows, summary, verdict }}
 *   windows: per-window IS/OOS metrics
 *   summary: aggregate stats (avg/median/stdev)
 *   verdict: 'stable' | 'borderline' | 'overfit' | 'insufficient_data'
 */
export function runWalkForward(prices, strategy = 'signal', opts = {}) {
  const numWindows = opts.windows || DEFAULT_WINDOWS;
  const isRatio = opts.isRatio || DEFAULT_IS_RATIO;
  const minBars = opts.minBars || MIN_BARS_PER_WINDOW;

  if (!Array.isArray(prices) || prices.length < numWindows * minBars) {
    return {
      windows: [],
      summary: null,
      verdict: 'insufficient_data',
      reason: `${numWindows * minBars} bar gerekli, ${prices?.length ?? 0} mevcut`,
    };
  }

  const windowSize = Math.floor(prices.length / numWindows);
  const isSize = Math.floor(windowSize * isRatio);
  // OOS spans from end-of-IS to start-of-next-IS

  const windows = [];
  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSize;
    const isEnd = start + isSize;
    const oosEnd = (w + 1) * windowSize;
    if (oosEnd > prices.length) break;

    const isPrices = prices.slice(start, isEnd);
    const oosPrices = prices.slice(isEnd, oosEnd);
    if (isPrices.length < minBars / 2 || oosPrices.length < minBars / 4) continue;

    const isTrades = runBacktest(isPrices, strategy);
    const oosTrades = runBacktest(oosPrices, strategy);
    const isStats = calcBacktestStats(isTrades, isPrices.length);
    const oosStats = calcBacktestStats(oosTrades, oosPrices.length);

    windows.push({
      window: w + 1,
      isStart: isPrices[0]?.date,
      isEnd: isPrices[isPrices.length - 1]?.date,
      oosStart: oosPrices[0]?.date,
      oosEnd: oosPrices[oosPrices.length - 1]?.date,
      isTrades: isTrades.length,
      oosTrades: oosTrades.length,
      isWinRate: isStats.winRate,
      oosWinRate: oosStats.winRate,
      isReturn: isStats.totalReturn,
      oosReturn: oosStats.totalReturn,
      isExpectancy: isStats.expectancy,
      oosExpectancy: oosStats.expectancy,
      isProfitFactor: isStats.profitFactor,
      oosProfitFactor: oosStats.profitFactor,
      degradation: Math.abs(oosStats.winRate - isStats.winRate),
      efficiency: isStats.totalReturn !== 0
        ? oosStats.totalReturn / isStats.totalReturn
        : (oosStats.totalReturn === 0 ? 1 : 0),
    });
  }

  if (!windows.length) {
    return { windows: [], summary: null, verdict: 'insufficient_data', reason: 'Hicbir gecerli pencere uretilemedi' };
  }

  const oosReturns = windows.map(w => w.oosReturn);
  const oosWinRates = windows.map(w => w.oosWinRate);
  const efficiencies = windows.map(w => w.efficiency);
  const degradations = windows.map(w => w.degradation);

  const summary = {
    numWindows: windows.length,
    medianOOSReturn: median(oosReturns),
    avgOOSReturn: oosReturns.reduce((a, v) => a + v, 0) / windows.length,
    stdevOOSReturn: stdev(oosReturns),
    medianOOSWinRate: median(oosWinRates),
    avgEfficiency: efficiencies.reduce((a, v) => a + v, 0) / efficiencies.length,
    medianEfficiency: median(efficiencies),
    avgDegradation: degradations.reduce((a, v) => a + v, 0) / degradations.length,
    profitableOOSWindows: windows.filter(w => w.oosReturn > 0).length,
    pctProfitableOOS: (windows.filter(w => w.oosReturn > 0).length / windows.length) * 100,
  };

  // ── Verdict ─────────────────────────────────────────────
  // stable: efficiency >= STABILITY_THRESHOLD AND >= 60% windows OOS-positive
  //         AND avg degradation < 20 percentage points
  // overfit: efficiency < 0.2 OR < 40% windows OOS-positive
  // borderline: everything else
  let verdict, color;
  if (
    summary.medianEfficiency >= STABILITY_THRESHOLD &&
    summary.pctProfitableOOS >= 60 &&
    summary.avgDegradation < 20
  ) {
    verdict = 'stable'; color = 'var(--green)';
  } else if (
    summary.medianEfficiency < 0.2 ||
    summary.pctProfitableOOS < 40 ||
    summary.avgDegradation > 35
  ) {
    verdict = 'overfit'; color = 'var(--red)';
  } else {
    verdict = 'borderline'; color = 'var(--yellow)';
  }

  return { windows, summary, verdict, color };
}

/**
 * compareStrategiesWalkForward — birden fazla stratejiyi
 * walk-forward ile karsilastirir, en saglam olani isaretler.
 */
export function compareStrategiesWalkForward(prices, strategies = ['signal', 'rsi', 'macd', 'ma'], opts = {}) {
  const results = strategies.map(s => ({ strategy: s, result: runWalkForward(prices, s, opts) }));
  // Score: medianOOSReturn × pctProfitableOOS / 100  (penalty for instability)
  const ranked = results
    .filter(r => r.result.summary)
    .map(r => ({
      ...r,
      compositeScore: r.result.summary.medianOOSReturn * (r.result.summary.pctProfitableOOS / 100),
    }))
    .sort((a, b) => b.compositeScore - a.compositeScore);
  return {
    results,
    ranked,
    winner: ranked[0]?.strategy || null,
  };
}
