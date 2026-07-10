import { calcAll, calcChandelierExit } from './indicators.js';
import { genSignal } from './signals.js';
import { TOTAL_COST_PCT } from './tradingCosts.js';

// Re-exported for backward compatibility — single source of truth lives in tradingCosts.js
export { TOTAL_COST_PCT };

export function runBacktest(prices, strategy = 'signal') {
  const trades = [];
  const minBars = strategy === 'ma' ? 55 : strategy === 'macd' ? 40 : 20;
  const maxHold = strategy === 'ma' ? 60 : strategy === 'macd' ? 45 : 25;
  let inPos = false;
  let pos = null;

  for (let i = minBars; i < prices.length; i++) {
    const window = prices.slice(Math.max(0, i - 200), i);
    if (window.length < minBars) continue;
    const ind = calcAll(window);
    const sig = genSignal(ind, window);
    const close = prices[i].close;
    const len = window.length;

    if (inPos) {
      const trailWindow = prices.slice(Math.max(0, i - 200), i);
      const ch = calcChandelierExit(trailWindow, 22, 3);
      if (ch.longStop && ch.longStop > pos.stop && ch.longStop < prices[i].close) {
        pos.stop = ch.longStop;
      }
      const hitStop = prices[i].low <= pos.stop;
      const hitTarget = prices[i].high >= pos.target;
      const held = i - pos.idx;
      if (hitStop) {
        const exit = pos.stop * (1 - TOTAL_COST_PCT);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: prices[i].date, days: held, pnl, result: 'stop' });
        inPos = false;
      } else if (hitTarget) {
        const exit = pos.target * (1 - TOTAL_COST_PCT);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: prices[i].date, days: held, pnl, result: 'target' });
        inPos = false;
      } else if (held > maxHold) {
        const exit = close * (1 - TOTAL_COST_PCT);
        const pnl = ((exit - pos.price) / pos.price) * 100;
        trades.push({ entry: pos.price, exit, entryDate: pos.date, exitDate: prices[i].date, days: held, pnl, result: 'timeout' });
        inPos = false;
      }
    } else {
      let enter = false;
      if (strategy === 'signal') {
        enter = sig.score >= 55;
      } else if (strategy === 'rsi') {
        enter = ind.lastRSI != null && ind.lastRSI < 35;
        if (enter && len >= 2 && ind.rsi[len - 2] != null) enter = ind.lastRSI >= ind.rsi[len - 2];
      } else if (strategy === 'macd') {
        const m = ind.macd.macd[len - 1];
        const s = ind.macd.signal[len - 1];
        const pm = len >= 2 ? ind.macd.macd[len - 2] : null;
        const ps = len >= 2 ? ind.macd.signal[len - 2] : null;
        enter = m != null && s != null && pm != null && ps != null && m > s && pm <= ps;
      } else if (strategy === 'ma') {
        const m20 = ind.ma20[len - 1];
        const m50 = ind.ma50[len - 1];
        const pm20 = len >= 2 ? ind.ma20[len - 2] : null;
        const pm50 = len >= 2 ? ind.ma50[len - 2] : null;
        enter = m20 != null && m50 != null && pm20 != null && pm50 != null && m20 > m50 && pm20 <= pm50;
      }
      if (enter) {
        const entryPrice = prices[i].open * (1 + TOTAL_COST_PCT);
        let stop = sig.stop;
        if (!stop || stop >= entryPrice) stop = entryPrice * 0.95;
        if (stop < entryPrice * 0.88) stop = entryPrice * 0.92;
        let target = sig.t1;
        if (!target || target <= entryPrice * 1.01) target = entryPrice * 1.05;
        pos = { idx: i, price: entryPrice, date: prices[i].date, stop, target };
        inPos = true;
      }
    }
  }

  if (inPos) {
    const exit = prices[prices.length - 1].close * (1 - TOTAL_COST_PCT);
    trades.push({
      entry: pos.price,
      exit,
      entryDate: pos.date,
      exitDate: prices[prices.length - 1].date,
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
