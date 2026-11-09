import { calcAll } from './indicators.js';
import { genSignal } from './signals.js';
import { TOTAL_COST_PCT } from './tradingCosts.js';
import { simulatePlanReturn, MAX_PLAN_BARS } from './planSimulation.js';

// Re-exported for backward compatibility — single source of truth lives in tradingCosts.js
export { TOTAL_COST_PCT };

/**
 * v31.51 — the single-stock backtest now exits the way the live system does.
 *
 * Before: a fixed target SOLD the whole position, a Chandelier stop trailed, and
 * the hold was capped at 25-60 bars. That is the staged / target exit the
 * replay measured as giving away more than half the return (26,855 signals,
 * 5 years: trailing-only +1.30% vs staged +0.27% net per trade) and that the
 * system stopped using in v31.30. Paper trading, the calibration and the
 * signal tracker all exit through planSimulation.simulatePlanReturn — trailing
 * stop only (+3% breakeven, above +5% half the gain locked), targets are
 * reference levels, at most MAX_PLAN_BARS (30) bars. The backtest now calls the
 * same function, so its numbers describe the rule the app actually follows.
 *
 * Entry is unchanged: the signal is computed on bars up to the day before and
 * the position opens at the next bar's open (no look-ahead). Round-trip cost
 * TOTAL_COST_PCT is deducted from every trade.
 */
export const BACKTEST_MIN_SCORE = 55;

export function scoreTier(score) {
  const s = Number(score) || 0;
  return s >= 75 ? 'sniper' : s >= 65 ? 'flagged' : 'early';
}

function entryFires(strategy, ind, sig) {
  const len = ind?.closes?.length || 0;
  if (strategy === 'signal') return sig.cls !== 'sell' && (sig.score || 0) >= BACKTEST_MIN_SCORE;
  if (strategy === 'rsi') {
    let enter = ind.lastRSI != null && ind.lastRSI < 35;
    if (enter && len >= 2 && ind.rsi[len - 2] != null) enter = ind.lastRSI >= ind.rsi[len - 2];
    return enter;
  }
  if (strategy === 'macd') {
    const m = ind.macd.macd[len - 1], s = ind.macd.signal[len - 1];
    const pm = len >= 2 ? ind.macd.macd[len - 2] : null, ps = len >= 2 ? ind.macd.signal[len - 2] : null;
    return m != null && s != null && pm != null && ps != null && m > s && pm <= ps;
  }
  if (strategy === 'ma') {
    const m20 = ind.ma20[len - 1], m50 = ind.ma50[len - 1];
    const pm20 = len >= 2 ? ind.ma20[len - 2] : null, pm50 = len >= 2 ? ind.ma50[len - 2] : null;
    return m20 != null && m50 != null && pm20 != null && pm50 != null && m20 > m50 && pm20 <= pm50;
  }
  return false;
}

/**
 * @param {Array} prices chronological daily bars
 * @param {'signal'|'rsi'|'macd'|'ma'} strategy
 * @param {{maxBars?: number, cost?: number}} [opts]
 * @returns {Array<{entry, exit, entryDate, exitDate, days, pnl, result: 'stop'|'trail'|'timeout'|'open', score, tier}>}
 */
export function runBacktest(prices, strategy = 'signal', { maxBars = MAX_PLAN_BARS, cost = TOTAL_COST_PCT } = {}) {
  const trades = [];
  if (!Array.isArray(prices) || prices.length < 25) return trades;
  const minBars = strategy === 'ma' ? 55 : strategy === 'macd' ? 40 : 20;

  for (let i = minBars; i < prices.length; i++) {
    const window = prices.slice(Math.max(0, i - 200), i);
    if (window.length < minBars) continue;
    const ind = calcAll(window);
    const sig = genSignal(ind, window);
    if (!entryFires(strategy, ind, sig)) continue;

    const bar = prices[i];
    const entry = bar.open > 0 ? bar.open : bar.close;
    if (!(entry > 0)) continue;
    let stop = sig.stop;
    if (!stop || stop >= entry) stop = entry * 0.95;
    if (stop < entry * 0.88) stop = entry * 0.92;

    const sim = simulatePlanReturn(
      { entry, stop, cls: 'buy', timestamp: bar.date },
      prices.slice(i, i + maxBars),
      { maxBars },
    );
    if (!sim) continue;
    const exitIdx = Math.min(prices.length - 1, i + sim.barsHeld - 1);
    const reachedEnd = sim.exitReason === 'timeout' && sim.barsHeld < maxBars && exitIdx >= prices.length - 1;
    const result = reachedEnd ? 'open'
      : sim.exitReason === 'stop' ? (sim.planReturn > 0 ? 'trail' : 'stop')
        : 'timeout';
    const pnl = sim.planReturn - cost * 100;
    trades.push({
      entry, exit: entry * (1 + sim.planReturn / 100),
      entryDate: bar.date, exitDate: prices[exitIdx].date,
      days: sim.barsHeld, pnl, result,
      score: Number(sig.score) || 0, tier: scoreTier(sig.score),
    });
    i = exitIdx;   // one position at a time; the next signal is read after the exit bar
  }
  return trades;
}

/** Closed trades split by the live conviction tiers (≥75 / 65–75 / 55–65). */
export function tierBreakdown(trades) {
  const out = {};
  for (const key of ['sniper', 'flagged', 'early']) {
    const t = (trades || []).filter(x => x.result !== 'open' && x.tier === key);
    const wins = t.filter(x => x.pnl > 0).length;
    out[key] = {
      n: t.length,
      winRate: t.length ? (wins / t.length) * 100 : null,
      avg: t.length ? t.reduce((s, x) => s + x.pnl, 0) / t.length : null,
    };
  }
  return out;
}

/** Al-tut getirisi, ilk işlem fırsatının barından son kapanışa (karşılaştırma için). */
export function buyAndHoldReturn(prices, fromIdx = 20) {
  if (!Array.isArray(prices) || prices.length <= fromIdx + 1) return null;
  const start = prices[fromIdx].open > 0 ? prices[fromIdx].open : prices[fromIdx].close;
  const end = prices[prices.length - 1].close;
  return start > 0 ? ((end - start) / start) * 100 : null;
}

export function calcBacktestStats(trades, totalDays) {
  const closed = trades.filter(t => t.result !== 'open');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const totalReturn = closed.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length || 1)) : 0;
  const expectancy = closed.length > 0 ? totalReturn / closed.length : 0;

  const equity = [10000];
  let peak = 10000;
  let maxDrawdown = 0;
  let curDDDur = 0;
  let maxDDDuration = 0;
  let inDD = false;

  for (let i = 0; i < closed.length; i++) {
    const next = equity[equity.length - 1] * (1 + closed[i].pnl / 100);
    equity.push(next);
    if (next > peak) {
      peak = next;
      if (inDD) {
        maxDDDuration = Math.max(maxDDDuration, curDDDur);
        inDD = false;
        curDDDur = 0;
      }
    } else {
      if (!inDD) {
        inDD = true;
        curDDDur = 0;
      }
      curDDDur += closed[i].days || 1;
    }
    const dd = ((peak - next) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  if (inDD) maxDDDuration = Math.max(maxDDDuration, curDDDur);

  const finalEquity = equity[equity.length - 1];
  const returns = closed.map(t => t.pnl / 100);
  const meanR = returns.length > 0 ? returns.reduce((a, v) => a + v, 0) / returns.length : 0;
  const stdR = returns.length > 1
    ? Math.sqrt(returns.reduce((a, v) => a + Math.pow(v - meanR, 2), 0) / returns.length)
    : 0;
  const avgDays = closed.length > 0 ? closed.reduce((a, t) => a + t.days, 0) / closed.length : 1;
  const annualizer = 252 / Math.max(1, avgDays);
  const annRet = meanR * annualizer;
  const annStd = stdR * Math.sqrt(annualizer);
  const rf = 0.25;
  const sharpeRatio = annStd > 0 ? (annRet - rf) / annStd : 0;
  const negReturns = returns.filter(v => v < 0);
  const downStd = (negReturns.length > 0
    ? Math.sqrt(negReturns.reduce((a, v) => a + Math.pow(v, 2), 0) / returns.length)
    : 0) * Math.sqrt(annualizer);
  const sortinoRatio = downStd > 0 ? (annRet - rf) / downStd : 0;
  const calmarRatio = maxDrawdown > 0 ? annRet / (maxDrawdown / 100) : 0;

  let maxConsWins = 0;
  let maxConsLosses = 0;
  let curW = 0;
  let curL = 0;
  for (const t of closed) {
    if (t.pnl > 0) {
      curW++;
      curL = 0;
      maxConsWins = Math.max(maxConsWins, curW);
    } else {
      curL++;
      curW = 0;
      maxConsLosses = Math.max(maxConsLosses, curL);
    }
  }
  const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  let verdict, verdictColor;
  if (winRate >= 55 && profitFactor >= 1.5 && expectancy > 0.5) {
    verdict = 'GUCLU — geçmişte pozitif beklenti, kazanma ve kâr faktörü yüksek';
    verdictColor = 'var(--green)';
  } else if (winRate >= 45 && expectancy > 0) {
    verdict = 'ORTA — geçmişte küçük pozitif beklenti';
    verdictColor = 'var(--yellow)';
  } else {
    verdict = 'ZAYIF — geçmişte beklenti negatif ya da kazanma düşük';
    verdictColor = 'var(--red)';
  }

  return {
    closed, wins, losses, winRate, totalReturn, avgWin, avgLoss,
    profitFactor, expectancy, equity, maxDrawdown, maxDDDuration,
    finalEquity, sharpeRatio, sortinoRatio, calmarRatio,
    maxConsWins, maxConsLosses, payoffRatio, verdict, verdictColor,
    totalDays,
  };
}
