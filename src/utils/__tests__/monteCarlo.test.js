/**
 * monteCarlo.js hybrid (v31) regression tests — block-bootstrap + BIST limits +
 * signal drift + stop/target exit stats + cost-aware profit.
 */

import { describe, it, expect } from 'vitest';
import { runMonteCarlo, runMonteCarloAsync } from '../monteCarlo.js';

function gbmSeries(n = 120, start = 100, mu = 0.0005, sigma = 0.01) {
  let p = start;
  const out = [start];
  for (let i = 1; i < n; i++) {
    const z = Math.sin(i * 1.37) + Math.cos(i * 0.81);
    p = p * Math.exp(mu + sigma * z * 0.5);
    out.push(p);
  }
  return out;
}

describe('runMonteCarlo (hybrid)', () => {
  it('returns null for too-short inputs', () => {
    expect(runMonteCarlo([1, 2, 3])).toBeNull();
    expect(runMonteCarlo(null)).toBeNull();
  });

  it('returns well-formed interpolated percentiles with correct ordering', () => {
    const res = runMonteCarlo(gbmSeries(100), 10, 500);
    expect(res).not.toBeNull();
    expect(res.p5).toHaveLength(11);
    expect(res.p95).toHaveLength(11);
    const h = 10;
    expect(res.p5[h]).toBeLessThanOrEqual(res.p25[h]);
    expect(res.p25[h]).toBeLessThanOrEqual(res.p50[h]);
    expect(res.p50[h]).toBeLessThanOrEqual(res.p75[h]);
    expect(res.p75[h]).toBeLessThanOrEqual(res.p95[h]);
    // day 0 is exactly lastPrice for every band
    expect(res.p50[0]).toBeCloseTo(res.lastPrice, 6);
  });

  it('uses block-bootstrap with enough history, gaussian otherwise', () => {
    expect(runMonteCarlo(gbmSeries(100), 5, 50).method).toBe('bootstrap');
    expect(runMonteCarlo(gbmSeries(15), 5, 50).method).toBe('gaussian');
  });

  it('enforces the BIST ±10% daily limit — day-1 prices bounded', () => {
    // Extremely volatile input; every single-day move must still clamp to ±10%.
    const wild = gbmSeries(100, 100, 0, 0.06);
    const res = runMonteCarlo(wild, 5, 1000);
    expect(res.p95[1]).toBeLessThanOrEqual(res.lastPrice * 1.10 + 1e-6);
    expect(res.p5[1]).toBeGreaterThanOrEqual(res.lastPrice * 0.90 - 1e-6);
  });

  it('relaxed vol cap [0.005, 0.12]; mu is the raw estimate', () => {
    const res = runMonteCarlo(gbmSeries(100), 5, 50);
    expect(res.sigma).toBeGreaterThanOrEqual(0.005);
    expect(res.sigma).toBeLessThanOrEqual(0.12);
    expect(Number.isFinite(res.mu)).toBe(true);
  });

  it('cost-aware profit prob is <= gross profit prob', () => {
    const res = runMonteCarlo(gbmSeries(100), 20, 2000, { costPct: 0.01 });
    expect(res.profitProb).toBeGreaterThanOrEqual(0);
    expect(res.profitProb).toBeLessThanOrEqual(100);
    expect(res.profitProbNet).toBeLessThanOrEqual(res.profitProb);
  });

  it('bullish drift tilt lifts the median vs bearish tilt', () => {
    const prices = gbmSeries(100, 100, 0, 0.012);
    const up = runMonteCarlo(prices, 20, 3000, { driftBias: 0.01 });
    const down = runMonteCarlo(prices, 20, 3000, { driftBias: -0.01 });
    expect(up.median).toBeGreaterThan(down.median);
  });

  it('no stop/target → pNoExit 100, pStopFirst 0', () => {
    const res = runMonteCarlo(gbmSeries(100), 20, 500);
    expect(res.pNoExit).toBe(100);
    expect(res.pStopFirst).toBe(0);
    expect(res.pTargetFirst).toBe(0);
  });

  it('stop/target exits partition the paths (sum ~100%)', () => {
    const prices = gbmSeries(100, 100, 0, 0.02);
    const last = prices[prices.length - 1];
    const res = runMonteCarlo(prices, 30, 3000, { stop: last * 0.92, target: last * 1.08 });
    const sum = res.pStopFirst + res.pTargetFirst + res.pNoExit;
    expect(sum).toBeCloseTo(100, 4);
    expect(res.pStopFirst).toBeGreaterThan(0);
    expect(res.pTargetFirst).toBeGreaterThan(0);
    expect(res.avgHoldDays).toBeGreaterThan(0);
    expect(res.avgHoldDays).toBeLessThanOrEqual(30);
  });

  it('a near, easily-hit target raises pTargetFirst above pStopFirst', () => {
    const prices = gbmSeries(100, 100, 0, 0.015);
    const last = prices[prices.length - 1];
    const res = runMonteCarlo(prices, 30, 3000, { stop: last * 0.80, target: last * 1.02 });
    expect(res.pTargetFirst).toBeGreaterThan(res.pStopFirst);
  });
});

describe('runMonteCarloAsync', () => {
  it('resolves (falls back to sync under jsdom) without hanging', async () => {
    const res = await runMonteCarloAsync(gbmSeries(100), 10, 200, { driftBias: 0.005 });
    expect(res === null || typeof res === 'object').toBe(true);
    if (res) expect(res.method).toMatch(/bootstrap|gaussian/);
  }, 10000);
});
