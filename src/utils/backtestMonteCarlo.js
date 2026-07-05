/**
 * backtestMonteCarlo.js — Bootstrap Monte Carlo for backtest robustness
 *
 * Takes completed backtest trades and resamples them N times (with replacement)
 * to produce confidence intervals for equity, win rate, drawdown, and return.
 *
 * This answers: "If the same trades happened in a different random order
 * (or slightly different market), how reliable is this strategy?"
 */

const DEFAULT_SIMS = 1000;
const INITIAL_CAPITAL = 10000;

/**
 * @param {Array} trades - from runBacktest(), each with { pnl (%), days, result }
 * @param {number} simulations - number of bootstrap resamples
 * @returns {Object} mc result with confidence bands and risk metrics
 */
export function runBacktestMonteCarlo(trades, simulations = DEFAULT_SIMS) {
  const closed = trades.filter(t => t.result !== 'open');
  if (closed.length < 5) return null;

  const n = closed.length;
  const finalEquities = new Float64Array(simulations);
  const maxDrawdowns = new Float64Array(simulations);
  const winRates = new Float64Array(simulations);
  const sharpes = new Float64Array(simulations);
  const profitFactors = new Float64Array(simulations);

  // Equity curves at each trade step — for percentile bands
  const equityMatrix = []; // [tradeIdx] = Float64Array(simulations)
  for (let t = 0; t <= n; t++) equityMatrix.push(new Float64Array(simulations));

  for (let s = 0; s < simulations; s++) {
    let equity = INITIAL_CAPITAL;
    let peak = INITIAL_CAPITAL;
    let maxDD = 0;
    let wins = 0;
    let sumWinPnl = 0;
    let sumLossPnl = 0;
    const returns = [];

    equityMatrix[0][s] = equity;

    for (let t = 0; t < n; t++) {
      // Bootstrap: random trade with replacement
      const idx = Math.floor(Math.random() * n);
      const trade = closed[idx];
      const r = trade.pnl / 100;
      returns.push(r);

      equity = equity * (1 + r);
      equityMatrix[t + 1][s] = equity;

      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;

      if (trade.pnl > 0) {
        wins++;
        sumWinPnl += trade.pnl;
      } else {
        sumLossPnl += Math.abs(trade.pnl);
      }
    }

    finalEquities[s] = equity;
    maxDrawdowns[s] = maxDD * 100;
    winRates[s] = (wins / n) * 100;
    profitFactors[s] = sumLossPnl > 0 ? sumWinPnl / sumLossPnl : sumWinPnl > 0 ? 99 : 0;

    const meanR = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdR = returns.length > 1
      ? Math.sqrt(returns.reduce((a, v) => a + (v - meanR) ** 2, 0) / returns.length)
      : 0;
    sharpes[s] = stdR > 0 ? (meanR / stdR) * Math.sqrt(252 / 5) : 0;
  }

  const pct = (arr, p) => {
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  };

  const mean = (arr) => {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  };

  // Equity percentile bands at each trade step
  const equityBands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
  for (let t = 0; t <= n; t++) {
    equityBands.p5.push(pct(equityMatrix[t], 5));
    equityBands.p25.push(pct(equityMatrix[t], 25));
    equityBands.p50.push(pct(equityMatrix[t], 50));
    equityBands.p75.push(pct(equityMatrix[t], 75));
    equityBands.p95.push(pct(equityMatrix[t], 95));
  }

  const profitCount = Array.from(finalEquities).filter(e => e > INITIAL_CAPITAL).length;
  const ruinCount = Array.from(finalEquities).filter(e => e < INITIAL_CAPITAL * 0.8).length;

  return {
    simulations,
    tradeCount: n,
    equityBands,
    finalEquity: {
      p5: pct(finalEquities, 5),
      p25: pct(finalEquities, 25),
      median: pct(finalEquities, 50),
      p75: pct(finalEquities, 75),
      p95: pct(finalEquities, 95),
      mean: mean(finalEquities),
    },
    maxDrawdown: {
      p5: pct(maxDrawdowns, 5),
      median: pct(maxDrawdowns, 50),
      p95: pct(maxDrawdowns, 95),
    },
    winRate: {
      p5: pct(winRates, 5),
      median: pct(winRates, 50),
      p95: pct(winRates, 95),
    },
    sharpe: {
      p5: pct(sharpes, 5),
      median: pct(sharpes, 50),
      p95: pct(sharpes, 95),
    },
    profitFactor: {
      p5: pct(profitFactors, 5),
      median: pct(profitFactors, 50),
      p95: pct(profitFactors, 95),
    },
    profitProb: (profitCount / simulations) * 100,
    ruinProb: (ruinCount / simulations) * 100,
  };
}
