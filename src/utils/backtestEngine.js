import { calcAll, calcChandelierExit } from './indicators.js';
import { genSignal } from './signals.js';

// Total round-trip cost (commission + spread + slippage estimate)
export const TOTAL_COST_PCT = 0.003;

const STRATEGY_DEFAULTS = {
  signal: { minBars: 20, maxHold: 25 },
  rsi: { minBars: 20, maxHold: 25 },
  macd: { minBars: 40, maxHold: 45 },
  ma: { minBars: 55, maxHold: 60 },
};

function asFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeBacktestOptions(strategyOrOptions = 'signal', overrides = {}) {
  const base = typeof strategyOrOptions === 'object' && strategyOrOptions !== null
    ? { ...strategyOrOptions, ...overrides }
    : { ...overrides, strategy: strategyOrOptions };

  const strategy = base.strategy || 'signal';
  const defaults = STRATEGY_DEFAULTS[strategy] || STRATEGY_DEFAULTS.signal;

  return {
    strategy,
    minBars: base.minBars ?? defaults.minBars,
    maxHold: base.maxHold ?? defaults.maxHold,
    maxLookback: base.maxLookback ?? 200,
    costPct: base.costPct ?? TOTAL_COST_PCT,

    // genSignal() now returns a normalized 0-100 score. Older backtests used
    // 2.5, which makes almost every non-empty signal eligible.
    signalThreshold: base.signalThreshold ?? 65,
    requireBuyClass: base.requireBuyClass ?? true,
    minRR: base.minRR ?? 0,

    rsiOversold: base.rsiOversold ?? 35,
    rsiRequireTurn: base.rsiRequireTurn ?? true,

    useSignalStops: base.useSignalStops ?? true,
    useSignalTargets: base.useSignalTargets ?? true,
    fallbackStopPct: base.fallbackStopPct ?? 0.05,
    maxStopPct: base.maxStopPct ?? 0.08,
    fallbackTargetPct: base.fallbackTargetPct ?? 0.05,
    minTargetPct: base.minTargetPct ?? 0.01,

    useChandelierTrail: base.useChandelierTrail ?? true,
    chandelierPeriod: base.chandelierPeriod ?? 22,
    chandelierMultiplier: base.chandelierMultiplier ?? 3,
  };
}

function shouldEnter(strategy, ind, sig, len, options) {
  if (strategy === 'signal') {
    const score = asFiniteNumber(sig.score, 0);
    if (score < options.signalThreshold) return false;
    if (options.requireBuyClass && sig.cls !== 'buy') return false;

    const rr = asFiniteNumber(sig.rr, null);
    if (rr != null && rr < options.minRR) return false;
    return true;
  }

  if (strategy === 'rsi') {
    let enter = ind.lastRSI != null && ind.lastRSI < options.rsiOversold;
    if (enter && options.rsiRequireTurn && len >= 2 && ind.rsi[len - 2] != null) {
      enter = ind.lastRSI >= ind.rsi[len - 2];
    }
    return enter;
  }

  if (strategy === 'macd') {
    const m = ind.macd.macd[len - 1];
    const s = ind.macd.signal[len - 1];
    const pm = len >= 2 ? ind.macd.macd[len - 2] : null;
    const ps = len >= 2 ? ind.macd.signal[len - 2] : null;
    return m != null && s != null && pm != null && ps != null && m > s && pm <= ps;
  }

  if (strategy === 'ma') {
    const m20 = ind.ma20[len - 1];
    const m50 = ind.ma50[len - 1];
    const pm20 = len >= 2 ? ind.ma20[len - 2] : null;
    const pm50 = len >= 2 ? ind.ma50[len - 2] : null;
    return m20 != null && m50 != null && pm20 != null && pm50 != null && m20 > m50 && pm20 <= pm50;
  }

  return false;
}

function resolveRiskLevels(entryPrice, sig, options) {
  let stop = options.useSignalStops ? asFiniteNumber(sig.stop, null) : null;
  if (!stop || stop >= entryPrice) stop = entryPrice * (1 - options.fallbackStopPct);
  if (stop < entryPrice * (1 - options.maxStopPct)) stop = entryPrice * (1 - options.maxStopPct);

  let target = options.useSignalTargets ? asFiniteNumber(sig.t1, null) : null;
  if (!target || target <= entryPrice * (1 + options.minTargetPct)) {
    target = entryPrice * (1 + options.fallbackTargetPct);
  }

  return { stop, target };
}

export function runBacktest(prices, strategyOrOptions = 'signal', overrides = {}) {
  if (!Array.isArray(prices) || prices.length === 0) return [];

  const options = normalizeBacktestOptions(strategyOrOptions, overrides);
  const { strategy } = options;
  const trades = [];
  let inPos = false;
  let pos = null;

  for (let i = options.minBars; i < prices.length; i++) {
    const bar = prices[i];
    const close = asFiniteNumber(bar.close, null);
    if (close == null) continue;

    const window = prices.slice(Math.max(0, i - options.maxLookback), i);
    if (window.length < options.minBars) continue;
    const ind = calcAll(window);
    const sig = genSignal(ind, window);
    const len = window.length;

    if (inPos) {
      if (options.useChandelierTrail) {
        const trailWindow = prices.slice(Math.max(0, i - options.maxLookback), i);
        const ch = calcChandelierExit(trailWindow, options.chandelierPeriod, options.chandelierMultiplier);
        if (ch.longStop && ch.longStop > pos.stop && ch.longStop < close) {
          pos.stop = ch.longStop;
        }
      }
      const low = asFiniteNumber(bar.low, close);
      const high = asFiniteNumber(bar.high, close);
      const hitStop = low <= pos.stop;
      const hitTarget = high >= pos.target;
      const held = i - pos.idx;
      if (hitStop) {
        const exit = pos.stop * (1 - options.costPct);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: bar.date, days: held, pnl, result: 'stop' });
        inPos = false;
      } else if (hitTarget) {
        const exit = pos.target * (1 - options.costPct);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: bar.date, days: held, pnl, result: 'target' });
        inPos = false;
      } else if (held > options.maxHold) {
        const exit = close * (1 - options.costPct);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: bar.date, days: held, pnl, result: 'timeout' });
        inPos = false;
      }
    } else {
      const enter = shouldEnter(strategy, ind, sig, len, options);
      if (enter) {
        const rawEntry = asFiniteNumber(bar.open, close);
        if (rawEntry == null) continue;
        const entryPrice = rawEntry * (1 + options.costPct);
        const { stop, target } = resolveRiskLevels(entryPrice, sig, options);
        pos = { idx: i, price: entryPrice, date: bar.date, stop, target };
        inPos = true;
      }
    }
  }

  if (inPos) {
    const last = prices[prices.length - 1];
    const exitClose = asFiniteNumber(last.close, pos.price);
    const exit = exitClose * (1 - options.costPct);
    trades.push({
      entry: pos.price,
      exit,
      entryDate: pos.date,
      exitDate: last.date,
      days: prices.length - 1 - pos.idx,
      pnl: ((exit - pos.price) / pos.price) * 100,
      result: 'open',
    });
  }

  return trades;
}

export function calcBacktestStats(trades, totalDays) {
  const closed = trades.filter(t => t.result !== 'open');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const totalReturn = closed.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const grossWin = wins.reduce((a, t) => a + Math.max(0, t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + Math.min(0, t.pnl), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? 99 : 0;
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
    verdict = 'GUCLU — Bu strateji calisiyor';
    verdictColor = 'var(--green)';
  } else if (winRate >= 45 && expectancy > 0) {
    verdict = 'ORTA — Disiplinle marjinal kar mumkun';
    verdictColor = 'var(--yellow)';
  } else {
    verdict = 'ZAYIF — Farkli strateji dene';
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
