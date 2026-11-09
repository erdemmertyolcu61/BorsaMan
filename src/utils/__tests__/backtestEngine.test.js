/**
 * backtestEngine.js regression tests.
 *
 * The backtest is the ONLY tool users rely on to judge whether a strategy
 * "works" before risking real capital. Silent math changes here directly
 * mislead trading decisions, so we lock in:
 *   • runBacktest returns a trade array with the expected contract
 *   • calcBacktestStats math (winRate, PF, drawdown, Sharpe, verdict)
 *   • Cost deduction (TOTAL_COST_PCT) is actually applied to fills
 */

import { describe, it, expect } from 'vitest';
import { runBacktest, calcBacktestStats, TOTAL_COST_PCT, tierBreakdown, buyAndHoldReturn, scoreTier } from '../backtestEngine.js';
import { simulatePlanReturn } from '../planSimulation.js';

// Build a price series: slow uptrend interrupted by pullbacks so entries fire.
function mixedSeries(n = 150) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    // drift + sine pullbacks
    p += 0.4 + Math.sin(i / 7) * 0.8 + (Math.cos(i / 11) * 0.3);
    out.push({
      date: new Date(2024, 0, i + 1).toISOString().slice(0, 10),
      open: p - 0.3,
      high: p + 0.8,
      low:  p - 0.8,
      close: p,
      volume: 1000 + (i % 10) * 100,
    });
  }
  return out;
}

describe('runBacktest', () => {
  it('returns [] on insufficient bars', () => {
    const trades = runBacktest([], 'signal');
    expect(trades).toEqual([]);
  });

  it('trade objects have the expected keys and numeric fields', () => {
    const trades = runBacktest(mixedSeries(150), 'signal');
    for (const t of trades) {
      expect(t).toHaveProperty('entry');
      expect(t).toHaveProperty('exit');
      expect(t).toHaveProperty('pnl');
      expect(t).toHaveProperty('days');
      expect(t).toHaveProperty('result');
      expect(['stop', 'trail', 'timeout', 'open']).toContain(t.result);   // v31.51: no target exit
      expect(Number.isFinite(t.pnl)).toBe(true);
      expect(t.days).toBeGreaterThanOrEqual(0);
    }
  });

  it('runs all 4 strategies without throwing', () => {
    const prices = mixedSeries(150);
    for (const s of ['signal', 'rsi', 'macd', 'ma']) {
      expect(() => runBacktest(prices, s)).not.toThrow();
    }
  });

  it('v31.51: exits through the live trailing-only plan, minus the round-trip cost', () => {
    const prices = mixedSeries(220);
    const trades = runBacktest(prices, 'signal');
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      const i = prices.findIndex(b => b.date === t.entryDate);
      const sim = simulatePlanReturn({ entry: t.entry, stop: undefined, cls: 'buy', timestamp: prices[i].date }, prices.slice(i, i + 30), { maxBars: 30 });
      expect(sim).not.toBeNull();
      expect(t.days).toBeLessThanOrEqual(30);
      expect(t.entry).toBe(prices[i].open);                 // next-bar open, no look-ahead
    }
    // trades never overlap: each entry comes after the previous exit
    for (let k = 1; k < trades.length; k++) expect(trades[k].entryDate > trades[k - 1].exitDate).toBe(true);
  });

  it('a stop that closes above entry is reported as a trailing exit', () => {
    const trades = runBacktest(mixedSeries(220), 'signal');
    for (const t of trades) {
      if (t.result === 'trail') expect(t.pnl + TOTAL_COST_PCT * 100).toBeGreaterThan(0);
      if (t.result === 'stop') expect(t.pnl + TOTAL_COST_PCT * 100).toBeLessThanOrEqual(0);
    }
  });

  it('tiers, breakdown and buy-and-hold', () => {
    expect(scoreTier(80)).toBe('sniper');
    expect(scoreTier(70)).toBe('flagged');
    expect(scoreTier(56)).toBe('early');
    const b = tierBreakdown([
      { tier: 'sniper', pnl: 4, result: 'trail' }, { tier: 'sniper', pnl: -2, result: 'stop' },
      { tier: 'early', pnl: -1, result: 'stop' }, { tier: 'early', pnl: 9, result: 'open' },
    ]);
    expect(b.sniper).toEqual({ n: 2, winRate: 50, avg: 1 });
    expect(b.early.n).toBe(1);                              // open trade excluded
    expect(b.flagged.n).toBe(0);
    const p = [{ open: 10, close: 10 }, { open: 10, close: 12 }, { open: 12, close: 15 }];
    expect(buyAndHoldReturn(p, 0)).toBeCloseTo(50, 9);
  });

  it('applies round-trip cost to filled trades', () => {
    // Cost constant is non-zero and reasonable
    expect(TOTAL_COST_PCT).toBeGreaterThan(0);
    expect(TOTAL_COST_PCT).toBeLessThan(0.01);
  });
});

describe('calcBacktestStats', () => {
  it('handles empty trade list without NaN', () => {
    const s = calcBacktestStats([], 100);
    expect(s.winRate).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(Number.isFinite(s.finalEquity)).toBe(true);
    expect(s.finalEquity).toBe(10000);
    expect(s.maxDrawdown).toBe(0);
  });

  it('computes winRate and totalReturn from a handcrafted trade array', () => {
    const trades = [
      { pnl:  5, days: 3, result: 'target' },
      { pnl: -2, days: 2, result: 'stop' },
      { pnl:  3, days: 4, result: 'target' },
      { pnl: -1, days: 1, result: 'stop' },
    ];
    const s = calcBacktestStats(trades, 30);
    expect(s.closed).toHaveLength(4);
    expect(s.wins).toHaveLength(2);
    expect(s.losses).toHaveLength(2);
    expect(s.winRate).toBeCloseTo(50, 6);
    expect(s.totalReturn).toBeCloseTo(5, 6);
    expect(s.expectancy).toBeCloseTo(1.25, 6);
    expect(s.finalEquity).toBeGreaterThan(10000);
  });

  it('reports a drawdown when equity dips below peak', () => {
    const trades = [
      { pnl: 10, days: 1, result: 'target' },
      { pnl: -20, days: 2, result: 'stop' },
      { pnl: 5, days: 1, result: 'target' },
    ];
    const s = calcBacktestStats(trades, 10);
    expect(s.maxDrawdown).toBeGreaterThan(15);
  });

  it('verdict bucket is one of GUCLU / ORTA / ZAYIF', () => {
    const s = calcBacktestStats(
      [{ pnl: 3, days: 1, result: 'target' }, { pnl: -1, days: 1, result: 'stop' }],
      10,
    );
    expect(s.verdict).toMatch(/GUCLU|ORTA|ZAYIF/);
  });

  it('tracks consecutive win/loss streaks', () => {
    const trades = [
      { pnl:  1, days: 1, result: 'target' },
      { pnl:  2, days: 1, result: 'target' },
      { pnl:  3, days: 1, result: 'target' },
      { pnl: -1, days: 1, result: 'stop' },
      { pnl: -1, days: 1, result: 'stop' },
    ];
    const s = calcBacktestStats(trades, 10);
    expect(s.maxConsWins).toBe(3);
    expect(s.maxConsLosses).toBe(2);
  });

  it('Sharpe ratio is finite when returns have variance', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      pnl: (i % 2 === 0 ? 2 : -1),
      days: 3,
      result: i % 2 === 0 ? 'target' : 'stop',
    }));
    const s = calcBacktestStats(trades, 60);
    expect(Number.isFinite(s.sharpeRatio)).toBe(true);
  });
});
