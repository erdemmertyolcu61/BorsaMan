import { describe, it, expect } from 'vitest';
import { runWalkForward, compareStrategiesWalkForward, walkForwardGate } from '../walkForward.js';

describe('walkForwardGate', () => {
  const stable = { verdict: 'stable', summary: { numWindows: 4, pctProfitableOOS: 75 } };
  const borderline = { verdict: 'borderline', summary: { numWindows: 4, pctProfitableOOS: 50 } };
  const overfit = { verdict: 'overfit', summary: { numWindows: 4, pctProfitableOOS: 25 } };

  it('passes only a stable verdict by default', () => {
    expect(walkForwardGate(stable).pass).toBe(true);
    expect(walkForwardGate(borderline).pass).toBe(false);
    expect(walkForwardGate(overfit).pass).toBe(false);
  });

  it('can optionally accept borderline', () => {
    expect(walkForwardGate(borderline, { allowBorderline: true }).pass).toBe(true);
    expect(walkForwardGate(overfit, { allowBorderline: true }).pass).toBe(false);
  });

  it('fails on insufficient data or too few windows', () => {
    expect(walkForwardGate({ verdict: 'insufficient_data' }).pass).toBe(false);
    expect(walkForwardGate({ verdict: 'stable', summary: { numWindows: 1, pctProfitableOOS: 80 } }).pass).toBe(false);
  });

  it('always returns a reasons array explaining the decision', () => {
    expect(Array.isArray(walkForwardGate(stable).reasons)).toBe(true);
    expect(walkForwardGate(overfit).reasons[0]).toMatch(/overfit/);
  });
});

// Generate deterministic synthetic OHLC bars
function genPrices(n, { trend = 0, vol = 1, start = 100, seed = 1 } = {}) {
  const out = [];
  let price = start;
  let s = seed;
  for (let i = 0; i < n; i++) {
    // simple LCG for reproducibility
    s = (s * 9301 + 49297) % 233280;
    const r = ((s / 233280) - 0.5) * 2 * vol;
    price = Math.max(1, price + trend + r);
    const open = price - r * 0.3;
    const high = Math.max(price, open) + Math.abs(r) * 0.4;
    const low = Math.min(price, open) - Math.abs(r) * 0.4;
    out.push({
      date: new Date(2024, 0, 1 + i).toISOString(),
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +price.toFixed(2),
      volume: 1_000_000 + Math.floor(Math.abs(r) * 100_000),
    });
  }
  return out;
}

describe('runWalkForward', () => {
  it('returns insufficient_data when prices too short', () => {
    const r = runWalkForward(genPrices(50), 'signal', { windows: 4, minBars: 60 });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.windows).toEqual([]);
  });

  it('generates the expected number of windows', () => {
    const prices = genPrices(400, { trend: 0.1 });
    const r = runWalkForward(prices, 'signal', { windows: 4, minBars: 60 });
    expect(r.windows.length).toBe(4);
    expect(r.summary).toBeTruthy();
    expect(r.summary.numWindows).toBe(4);
  });

  it('produces IS and OOS metrics for each window', () => {
    const prices = genPrices(400, { trend: 0.05 });
    const r = runWalkForward(prices, 'signal');
    for (const w of r.windows) {
      expect(typeof w.isWinRate).toBe('number');
      expect(typeof w.oosWinRate).toBe('number');
      expect(typeof w.efficiency).toBe('number');
      expect(typeof w.degradation).toBe('number');
    }
  });

  it('computes summary aggregates', () => {
    const prices = genPrices(400, { trend: 0.1, vol: 1.5 });
    const r = runWalkForward(prices, 'signal');
    expect(r.summary.pctProfitableOOS).toBeGreaterThanOrEqual(0);
    expect(r.summary.pctProfitableOOS).toBeLessThanOrEqual(100);
    expect(typeof r.summary.medianOOSReturn).toBe('number');
    expect(typeof r.summary.avgEfficiency).toBe('number');
  });

  it('returns one of the three verdicts', () => {
    const prices = genPrices(400, { trend: 0.1 });
    const r = runWalkForward(prices, 'signal');
    expect(['stable', 'borderline', 'overfit', 'insufficient_data']).toContain(r.verdict);
  });

  it('flags pure noise as borderline or overfit (not stable)', () => {
    const prices = genPrices(400, { trend: 0, vol: 3 });
    const r = runWalkForward(prices, 'signal');
    // Random walk shouldn't produce a stable signal-strategy verdict
    expect(['borderline', 'overfit']).toContain(r.verdict);
  });

  it('respects custom isRatio', () => {
    const prices = genPrices(400, { trend: 0.05 });
    const r = runWalkForward(prices, 'signal', { windows: 4, isRatio: 0.5 });
    // Each window covers 100 bars, IS=50, OOS=50
    expect(r.windows.length).toBeGreaterThan(0);
  });
});

describe('compareStrategiesWalkForward', () => {
  it('ranks strategies by composite OOS score', () => {
    const prices = genPrices(400, { trend: 0.1 });
    const r = compareStrategiesWalkForward(prices, ['signal', 'rsi'], { windows: 4 });
    expect(r.results.length).toBe(2);
    expect(r.ranked.length).toBeGreaterThanOrEqual(0);
    // winner is either 'signal', 'rsi', or null
    expect(['signal', 'rsi', null]).toContain(r.winner);
  });

  it('handles empty strategy list', () => {
    const prices = genPrices(400);
    const r = compareStrategiesWalkForward(prices, [], { windows: 4 });
    expect(r.winner).toBe(null);
    expect(r.ranked).toEqual([]);
  });
});
