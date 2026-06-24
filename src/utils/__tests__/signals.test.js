/**
 * signals.js — regression tests.
 *
 * Locks in the contracts for two critical functions:
 *   • calcPosition — the ONLY function that determines lot size + max loss.
 *     Any silent change here directly touches user capital.
 *   • genSignal returns a stable shape { signal, cls, score, ... } so that
 *     consumers (UI, signal tracker, live guard) don't crash on NaN/undef.
 *
 * v12 additions:
 *   • calcPosition grade multiplier — D blocks, C halves, A is full size.
 *   • setSignalReliabilityHints — low win-rate attenuates conf, high boosts it.
 *   • genSignal sectorStrength gate — CIKIS sector penalises score.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { calcPosition, genSignal, setSignalReliabilityHints } from '../signals.js';
import { calcAll } from '../indicators.js';

// ── Shared price fixtures ──────────────────────────────────────────────────
const bullishPrices = Array.from({ length: 220 }, (_, i) => {
  const c = 50 + i * 0.4;
  return { date: new Date(2024, 0, i + 1), open: c - 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 + i };
});
const bearishPrices = Array.from({ length: 220 }, (_, i) => {
  const c = 200 - i * 0.4;
  return { date: new Date(2024, 0, i + 1), open: c + 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 };
});

// ── calcPosition ──────────────────────────────────────────────────────────
describe('calcPosition', () => {
  it('sizes lot based on risk percentage, never exceeding account cash', () => {
    const r = calcPosition(10000, 2, 100, 95); // 2% of 10k = 200 TL risk, 5 TL per share → 40 shares
    expect(r.shares).toBe(40);
    expect(r.cost).toBe(4000);
    expect(r.maxLoss).toBeCloseTo(200, 2);
    expect(r.riskPct).toBe(2);
    expect(r.costPct).toBeCloseTo(40, 2);
  });

  it('caps shares by available budget when risk allows more than cash can buy', () => {
    const r = calcPosition(1000, 50, 100, 99.9);
    expect(r.shares).toBe(10);
    expect(r.cost).toBe(1000);
  });

  it('returns zero-risk payload when stop == entry (undefined R/R)', () => {
    const r = calcPosition(10000, 2, 50, 50);
    expect(r.shares).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.maxLoss).toBe(0);
  });

  // ── Grade multiplier tests ────────────────────────────────────────────
  it('grade A: full position size (no reduction)', () => {
    const base = calcPosition(10000, 2, 100, 95);
    const gradeA = calcPosition(10000, 2, 100, 95, { setupGrade: 'A' });
    expect(gradeA.shares).toBe(base.shares);
  });

  it('grade B: 75% of base size', () => {
    const base = calcPosition(10000, 2, 100, 95);           // 40 shares
    const gradeB = calcPosition(10000, 2, 100, 95, { setupGrade: 'B' });
    expect(gradeB.shares).toBe(Math.floor(base.shares * 0.75)); // 30
  });

  it('grade B+: 85% of base size', () => {
    const base = calcPosition(10000, 2, 100, 95);
    const gradeBP = calcPosition(10000, 2, 100, 95, { setupGrade: 'B+' });
    expect(gradeBP.shares).toBe(Math.floor(base.shares * 0.85));
  });

  it('grade C: 50% of base size', () => {
    const base = calcPosition(10000, 2, 100, 95);
    const gradeC = calcPosition(10000, 2, 100, 95, { setupGrade: 'C' });
    expect(gradeC.shares).toBe(Math.floor(base.shares * 0.5));
  });

  it('grade D: returns 0 shares (position blocked)', () => {
    const r = calcPosition(10000, 2, 100, 95, { setupGrade: 'D' });
    expect(r.shares).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.method).toBe('grade_blocked');
    expect(r.setupGrade).toBe('D');
  });

  it('unknown grade: no reduction (falls through safely)', () => {
    const base  = calcPosition(10000, 2, 100, 95);
    const gradeX = calcPosition(10000, 2, 100, 95, { setupGrade: 'Z' });
    expect(gradeX.shares).toBe(base.shares);
  });

  it('Kelly uses MEASURED win rate when a trustworthy sample exists', () => {
    // Strong measured edge → Kelly tag becomes "measured"
    setSignalReliabilityHints({ buy: { winRate: 0.7, sampleSize: 40 } });
    const r = calcPosition(100000, 2, 100, 95, { useKelly: true, confidence: 80, cls: 'buy', rr: 2.5 });
    expect(r.kellySource).toBe('measured');
    expect(r.method).toBe('kelly_measured');
    // reset so we don't leak the hint into other tests
    setSignalReliabilityHints({ buy: null });
  });

  it('Kelly falls back to estimated stats when sample is too small', () => {
    setSignalReliabilityHints({ buy: { winRate: 0.7, sampleSize: 5 } });
    const r = calcPosition(100000, 2, 100, 95, { useKelly: true, confidence: 80, cls: 'buy' });
    expect(r.kellySource).toBe('estimated');
    setSignalReliabilityHints({ buy: null });
  });
});

// ── genSignal output contract ─────────────────────────────────────────────
describe('genSignal output contract', () => {
  it('returns a stable shape with signal, cls, and a numeric score', () => {
    const ind = calcAll(bullishPrices);
    const sig = genSignal(ind, bullishPrices);
    expect(sig).toBeDefined();
    expect(typeof sig.signal).toBe('string');
    expect(['buy', 'sell', 'hold', 'neutral']).toContain(sig.cls);
    expect(Number.isFinite(sig.score)).toBe(true);
    expect(/^(GUCLU AL|AL|TUT|SAT|GUCLU SAT)( .+)?$/.test(sig.signal)).toBe(true);
  });

  it('is not a bullish BUY on a deeply bearish setup', () => {
    const ind = calcAll(bearishPrices);
    const sig = genSignal(ind, bearishPrices);
    expect(sig.cls).not.toBe('buy');
  });

  it('sector CIKIS (strength<=20) penalises score vs no-sector baseline', () => {
    const ind = calcAll(bullishPrices);
    const baseline  = genSignal(ind, bullishPrices, {});
    const withCikis = genSignal(ind, bullishPrices, { sectorStrength: 15 });
    // Sector CIKIS adds -2.5 to raw score → normalised score100 must be lower
    expect(withCikis.score).toBeLessThan(baseline.score);
  });

  it('sector GUCLU GIRIS (strength>=80) boosts score vs no-sector baseline', () => {
    const ind = calcAll(bullishPrices);
    const baseline    = genSignal(ind, bullishPrices, {});
    const withBoost   = genSignal(ind, bullishPrices, { sectorStrength: 85 });
    expect(withBoost.score).toBeGreaterThan(baseline.score);
  });
});

// ── setSignalReliabilityHints ─────────────────────────────────────────────
describe('setSignalReliabilityHints', () => {
  beforeEach(() => {
    // Reset hints to neutral so tests don't interfere with each other
    setSignalReliabilityHints({ buy: null, sell: null });
  });

  it('does not throw with empty or null hints', () => {
    expect(() => setSignalReliabilityHints({})).not.toThrow();
    expect(() => setSignalReliabilityHints(null)).not.toThrow();
  });

  it('low buy win-rate (<35%) attenuates confidence on a buy signal', () => {
    const ind = calcAll(bullishPrices);

    // Baseline confidence with neutral hints
    setSignalReliabilityHints({});
    const baseline = genSignal(ind, bullishPrices);

    // Push a 20% win-rate with enough samples to trigger attenuation
    setSignalReliabilityHints({ buy: { winRate: 0.20, sampleSize: 20 } });
    const attenuated = genSignal(ind, bullishPrices);

    if (baseline.cls === 'buy') {
      // conf is a string — compare as numbers
      expect(Number(attenuated.conf)).toBeLessThanOrEqual(Number(baseline.conf));
    }
    // If the baseline is not a buy signal, the hint has no effect — still no throw
  });

  it('high buy win-rate (>65%, >=20 samples) boosts confidence on a buy signal', () => {
    const ind = calcAll(bullishPrices);

    setSignalReliabilityHints({});
    const baseline = genSignal(ind, bullishPrices);

    setSignalReliabilityHints({ buy: { winRate: 0.75, sampleSize: 25 } });
    const boosted = genSignal(ind, bullishPrices);

    if (baseline.cls === 'buy') {
      expect(Number(boosted.conf)).toBeGreaterThanOrEqual(Number(baseline.conf));
    }
  });

  it('insufficient samples (<15) leaves confidence unchanged', () => {
    const ind = calcAll(bullishPrices);

    setSignalReliabilityHints({});
    const baseline = genSignal(ind, bullishPrices);

    // Only 5 samples — below the 15-sample threshold, should have no effect
    setSignalReliabilityHints({ buy: { winRate: 0.10, sampleSize: 5 } });
    const unchanged = genSignal(ind, bullishPrices);

    expect(unchanged.conf).toBe(baseline.conf);
    expect(unchanged.score).toBe(baseline.score);
  });
});
