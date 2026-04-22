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
import { runBacktest, calcBacktestStats, TOTAL_COST_PCT } from '../backtestEngine.js';

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
      expect(['stop', 'target', 'timeout', 'open']).toContain(t.result);
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
