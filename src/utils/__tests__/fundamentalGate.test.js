import { describe, it, expect } from 'vitest';
import { fundamentalQualityGate } from '../fundamentalEngine.js';

describe('fundamentalQualityGate', () => {
  it('passes cleanly when fundamentals are missing (data gap is not punished)', () => {
    expect(fundamentalQualityGate(null)).toEqual({ reject: false, penalty: 0, reasons: [], reason: null });
    expect(fundamentalQualityGate({})).toEqual({ reject: false, penalty: 0, reasons: [], reason: null });
    // partial data, all healthy-or-absent → no action
    const r = fundamentalQualityGate({ debtToEquity: 0.5 });
    expect(r.reject).toBe(false);
    expect(r.penalty).toBe(0);
  });

  it('does NOT reject a normal holding co (KCHOL-like current ratio ~0.86)', () => {
    const r = fundamentalQualityGate({ debtToEquity: 1.2, currentRatio: 0.86, netMargin: 8, profitTrend: 'IMPROVING' });
    expect(r.reject).toBe(false);
    expect(r.penalty).toBeLessThanOrEqual(4); // maybe a small liquidity nudge, never a reject
  });

  it('HARD-REJECTS extreme leverage (D/E > 5)', () => {
    const r = fundamentalQualityGate({ debtToEquity: 6.2 });
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/borc/i);
  });

  it('HARD-REJECTS severe illiquidity (current ratio < 0.4)', () => {
    const r = fundamentalQualityGate({ currentRatio: 0.3 });
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/likidite/i);
  });

  it('HARD-REJECTS heavy losses (net margin < -25%)', () => {
    const r = fundamentalQualityGate({ netMargin: -40 });
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/zarar/i);
  });

  it('SOFT-PENALIZES moderate weakness without rejecting', () => {
    const r = fundamentalQualityGate({ debtToEquity: 3, currentRatio: 0.7, netMargin: -5, profitTrend: 'DECLINING' });
    expect(r.reject).toBe(false);
    expect(r.penalty).toBeGreaterThan(0);
    expect(r.penalty).toBeLessThanOrEqual(15); // capped
    expect(r.reasons.length).toBeGreaterThan(1);
  });

  it('caps the penalty at 15', () => {
    const r = fundamentalQualityGate({ debtToEquity: 4.9, currentRatio: 0.5, netMargin: -10, profitTrend: 'DECLINING' });
    expect(r.penalty).toBe(15);
    expect(r.reject).toBe(false);
  });

  it('a boundary-healthy stock passes with zero penalty', () => {
    const r = fundamentalQualityGate({ debtToEquity: 1.0, currentRatio: 1.5, netMargin: 12, profitTrend: 'IMPROVING' });
    expect(r).toEqual({ reject: false, penalty: 0, reasons: [], reason: null });
  });
});
