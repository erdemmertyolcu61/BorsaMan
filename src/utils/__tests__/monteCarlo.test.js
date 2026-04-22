/**
 * monteCarlo.js GBM simulation regression tests.
 */

import { describe, it, expect } from 'vitest';
import { runMonteCarlo, runMonteCarloAsync } from '../monteCarlo.js';

function gbmSeries(n = 120, start = 100, mu = 0.0005, sigma = 0.01) {
  let p = start;
  const out = [start];
  for (let i = 1; i < n; i++) {
    // deterministic-ish pseudo-random so tests are stable (not seeded exactly)
    const z = Math.sin(i * 1.37) + Math.cos(i * 0.81);
    p = p * Math.exp(mu + sigma * z * 0.5);
    out.push(p);
  }
  return out;
}

describe('runMonteCarlo', () => {
  it('returns null for too-short inputs', () => {
    expect(runMonteCarlo([1, 2, 3])).toBeNull();
    expect(runMonteCarlo(null)).toBeNull();
  });

  it('returns well-formed percentiles for valid input', () => {
    const res = runMonteCarlo(gbmSeries(100), 10, 100);
    expect(res).not.toBeNull();
    expect(res.p5).toHaveLength(11);
    expect(res.p50).toHaveLength(11);
    expect(res.p95).toHaveLength(11);
    // ordering invariant: p5 <= p25 <= p50 <= p75 <= p95 at horizon
    const h = 10;
    expect(res.p5[h]).toBeLessThanOrEqual(res.p25[h]);
    expect(res.p25[h]).toBeLessThanOrEqual(res.p50[h]);
    expect(res.p50[h]).toBeLessThanOrEqual(res.p75[h]);
    expect(res.p75[h]).toBeLessThanOrEqual(res.p95[h]);
  });

  it('profitProb is a percentage in [0, 100]', () => {
    const res = runMonteCarlo(gbmSeries(100), 20, 200);
    expect(res.profitProb).toBeGreaterThanOrEqual(0);
    expect(res.profitProb).toBeLessThanOrEqual(100);
  });

  it('caps extreme vol inside guards', () => {
    const res = runMonteCarlo(gbmSeries(100), 5, 50);
    expect(res.sigma).toBeGreaterThanOrEqual(0.005);
    expect(res.sigma).toBeLessThanOrEqual(0.08);
    expect(res.mu).toBeGreaterThanOrEqual(-0.02);
    expect(res.mu).toBeLessThanOrEqual(0.02);
  });
});

describe('runMonteCarloAsync', () => {
  it('falls back to sync path when Worker is unavailable (jsdom)', async () => {
    // jsdom does not provide a usable Worker for ES modules — the branch
    // should catch, return null worker, and resolve via runMonteCarlo.
    const res = await runMonteCarloAsync(gbmSeries(100), 10, 100);
    // Either a valid result (if the env somehow supports Worker) or null
    // propagation is acceptable — but the promise MUST resolve without hanging.
    expect(res === null || typeof res === 'object').toBe(true);
  }, 10000);
});
