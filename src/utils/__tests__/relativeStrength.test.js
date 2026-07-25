import { describe, it, expect } from 'vitest';
import { pctReturn, computeRelativeStrength } from '../relativeStrength.js';

// Build a series that compounds at a fixed daily rate (oldest → newest).
const geom = (n, start, dailyPct) =>
  Array.from({ length: n }, (_, i) => start * Math.pow(1 + dailyPct / 100, i));

describe('pctReturn', () => {
  it('computes the N-bar percent return', () => {
    const c = [100, 101, 102, 110];
    expect(pctReturn(c, 3)).toBeCloseTo(10, 5); // (110-100)/100
    expect(pctReturn(c, 1)).toBeCloseTo((110 - 102) / 102 * 100, 5);
  });

  it('returns null when the series is too short', () => {
    expect(pctReturn([100, 101], 5)).toBeNull();
    expect(pctReturn([], 1)).toBeNull();
    expect(pctReturn(null, 1)).toBeNull();
  });

  it('ignores non-finite / non-positive values defensively', () => {
    expect(pctReturn([0, -5, NaN, 100, 110], 1)).toBeCloseTo(10, 5);
  });
});

describe('computeRelativeStrength', () => {
  it('flags a leader when the stock outpaces the index', () => {
    const stock = geom(70, 100, 0.5);   // +0.5%/day
    const index = geom(70, 100, 0.1);   // +0.1%/day
    const rs = computeRelativeStrength(stock, index);
    expect(rs.outperf).toBeGreaterThan(2);
    expect(rs.leading).toBe(true);
    expect(rs.lagging).toBe(false);
    expect(rs.rsScore).toBeGreaterThan(0);
    expect(rs.rsScore).toBeLessThanOrEqual(8);
  });

  it('flags a laggard when the stock trails the index', () => {
    const stock = geom(70, 100, -0.3);
    const index = geom(70, 100, 0.2);
    const rs = computeRelativeStrength(stock, index);
    expect(rs.outperf).toBeLessThan(-2);
    expect(rs.lagging).toBe(true);
    expect(rs.leading).toBe(false);
    expect(rs.rsScore).toBeLessThan(0);
    expect(rs.rsScore).toBeGreaterThanOrEqual(-8);
  });

  it('is roughly neutral when stock tracks the index', () => {
    const s = geom(70, 100, 0.2);
    const rs = computeRelativeStrength(s, s.slice());
    expect(Math.abs(rs.outperf)).toBeLessThan(0.5);
    expect(rs.leading).toBe(false);
    expect(rs.lagging).toBe(false);
  });

  it('caps rsScore at +/-8 for extreme divergence', () => {
    const stock = geom(70, 100, 2);    // explosive
    const index = geom(70, 100, -1);   // crashing
    expect(computeRelativeStrength(stock, index).rsScore).toBe(8);
    expect(computeRelativeStrength(index, stock).rsScore).toBe(-8);
  });

  it('falls back to the short horizon when long history is missing', () => {
    const stock = geom(25, 100, 0.5);  // only 25 bars → 60d unavailable, 20d ok
    const index = geom(25, 100, 0.1);
    const rs = computeRelativeStrength(stock, index);
    expect(rs.opShort).not.toBeNull();
    expect(rs.opLong).toBeNull();
    expect(rs.outperf).toBeCloseTo(rs.opShort, 5); // outperf == short leg alone
  });

  it('returns a null/zero result when neither horizon is computable', () => {
    const rs = computeRelativeStrength([100, 101], [100, 101]);
    expect(rs.outperf).toBeNull();
    expect(rs.rsScore).toBe(0);
    expect(rs.leading).toBe(false);
  });
});
