import { describe, it, expect } from 'vitest';
import { computeThematicAdjust, activeThemes, THEMES } from '../thematicMacro.js';

const brentUp = { brent: { change5d: 6 }, usdtry: { change5d: 0 } };
const brentDown = { brent: { change5d: -6 }, usdtry: { change5d: 0 } };
const liraWeak = { brent: { change5d: 0 }, usdtry: { change5d: 3 } };
const calm = { brent: { change5d: 1 }, usdtry: { change5d: 0.5 } };

describe('computeThematicAdjust', () => {
  it('Brent up → TUPRS gets a positive boost (the reported use case)', () => {
    const r = computeThematicAdjust(brentUp, 'TUPRS');
    expect(r.delta).toBeGreaterThan(0);
    expect(r.themes).toContain('brent_up');
    expect(r.reasons[0]).toMatch(/Brent/i);
  });

  it('Brent up → airlines (THYAO/PGSUS) get a headwind penalty', () => {
    expect(computeThematicAdjust(brentUp, 'THYAO').delta).toBeLessThan(0);
    expect(computeThematicAdjust(brentUp, 'PGSUS').delta).toBeLessThan(0);
  });

  it('Brent down flips: airlines benefit, TUPRS headwind', () => {
    expect(computeThematicAdjust(brentDown, 'THYAO').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(brentDown, 'TUPRS').delta).toBeLessThan(0);
  });

  it('weak lira → exporters (EREGL) get a boost', () => {
    expect(computeThematicAdjust(liraWeak, 'EREGL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(liraWeak, 'KRDMD').delta).toBeGreaterThan(0);
  });

  it('calm macro → no adjustment for anyone', () => {
    expect(computeThematicAdjust(calm, 'TUPRS').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'EREGL').delta).toBe(0);
  });

  it('unrelated symbol → zero even when a theme is active', () => {
    expect(computeThematicAdjust(brentUp, 'GARAN').delta).toBe(0);
  });

  it('is case-insensitive and trims symbols', () => {
    expect(computeThematicAdjust(brentUp, ' tuprs ').delta).toBeGreaterThan(0);
  });

  it('clamps to [-12, +12]', () => {
    const r = computeThematicAdjust(brentUp, 'TUPRS');
    expect(r.delta).toBeLessThanOrEqual(12);
    expect(r.delta).toBeGreaterThanOrEqual(-12);
  });

  it('is defensive against null macro / null symbol', () => {
    expect(computeThematicAdjust(null, 'TUPRS')).toEqual({ delta: 0, reasons: [], themes: [] });
    expect(computeThematicAdjust(brentUp, null)).toEqual({ delta: 0, reasons: [], themes: [] });
  });

  it('does not throw on a macro ctx missing the driver series', () => {
    expect(() => computeThematicAdjust({}, 'TUPRS')).not.toThrow();
    expect(computeThematicAdjust({}, 'TUPRS').delta).toBe(0);
  });
});

describe('activeThemes', () => {
  it('lists the active theme labels', () => {
    expect(activeThemes(brentUp).some(l => /Brent/i.test(l))).toBe(true);
    expect(activeThemes(calm)).toEqual([]);
    expect(activeThemes(null)).toEqual([]);
  });

  it('THEMES only reference the fetched macro series (brent/usdtry)', () => {
    // guard: a theme whose driver isn't fetched would silently never fire
    const probe = { brent: { change5d: 99 }, usdtry: { change5d: 99 } };
    for (const t of THEMES) {
      expect(() => t.active(probe)).not.toThrow();
    }
  });
});
