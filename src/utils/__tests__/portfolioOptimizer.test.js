import { describe, it, expect } from 'vitest';
import {
  buildReturnMatrix,
  highCorrelationPairs,
  correlationCapFilter,
} from '../portfolioOptimizer.js';

// Synthetic price series generator
function genSeries(n, { drift = 0.001, vol = 0.02, start = 100, seed = 1 } = {}) {
  const out = [start];
  let s = seed;
  for (let i = 1; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = ((s / 233280) - 0.5) * 2;
    out.push(out[i - 1] * (1 + drift + r * vol));
  }
  return out;
}

describe('highCorrelationPairs', () => {
  it('flags a perfectly correlated pair and ignores an independent one', () => {
    // 2x2 covariance: A and B perfectly correlated (corr=1), C independent.
    const symbols = ['A', 'B'];
    const cov = [[0.04, 0.04], [0.04, 0.04]]; // corr = 0.04 / sqrt(0.04*0.04) = 1
    const pairs = highCorrelationPairs(symbols, cov, 0.8);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].corr).toBeCloseTo(1, 5);
  });

  it('returns nothing below threshold and handles bad input', () => {
    const cov = [[0.04, 0.004], [0.004, 0.04]]; // corr = 0.1
    expect(highCorrelationPairs(['A', 'B'], cov, 0.8)).toHaveLength(0);
    expect(highCorrelationPairs(null, null)).toEqual([]);
  });
});

describe('correlationCapFilter', () => {
  it('drops a candidate that duplicates an already-kept bet', () => {
    const base = genSeries(60, { seed: 7 });
    const candidates = [
      { symbol: 'AAA', series: base },
      { symbol: 'BBB', series: base.map(x => x * 1.0001) }, // ~identical → correlated
      { symbol: 'CCC', series: genSeries(60, { seed: 99, drift: -0.001 }) },
    ];
    const { kept, dropped } = correlationCapFilter(candidates, 0.9);
    expect(kept.find(k => k.symbol === 'AAA')).toBeTruthy();
    expect(dropped.find(d => d.symbol === 'BBB')).toBeTruthy();
  });

  it('keeps candidates with too-short series rather than dropping them', () => {
    const { kept } = correlationCapFilter([{ symbol: 'X', series: [1, 2] }], 0.9);
    expect(kept).toHaveLength(1);
  });
});

describe('buildReturnMatrix', () => {
  it('produces aligned returns of equal length', () => {
    const data = {
      A: genSeries(120, { drift: 0.001, seed: 1 }),
      B: genSeries(100, { drift: 0.0008, seed: 2 }),
      C: genSeries(150, { drift: 0.0012, seed: 3 }),
    };
    const m = buildReturnMatrix(data);
    expect(m.symbols).toEqual(['A', 'B', 'C']);
    const lengths = m.symbols.map(s => m.alignedReturns[s].length);
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(99); // shortest is B with 100 prices = 99 returns
  });

  it('returns annualized expected returns', () => {
    const data = { A: genSeries(252, { drift: 0.001, vol: 0.01, seed: 1 }) };
    const m = buildReturnMatrix(data);
    expect(m.expectedReturns.length).toBe(1);
    // Drift 0.001/day × 252 ≈ 0.25 annual; allow wide band due to noise
    expect(m.expectedReturns[0]).toBeGreaterThan(0);
  });

  it('produces square symmetric covariance matrix', () => {
    const data = {
      A: genSeries(100, { seed: 1 }),
      B: genSeries(100, { seed: 2 }),
      C: genSeries(100, { seed: 3 }),
    };
    const m = buildReturnMatrix(data);
    expect(m.covMatrix.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(m.covMatrix[i].length).toBe(3);
      for (let j = 0; j < 3; j++) {
        expect(Math.abs(m.covMatrix[i][j] - m.covMatrix[j][i])).toBeLessThan(1e-10);
      }
    }
  });

  it('handles empty input', () => {
    const m = buildReturnMatrix({});
    expect(m.symbols).toEqual([]);
  });
});

