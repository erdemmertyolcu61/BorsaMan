import { describe, it, expect } from 'vitest';
import { computeThematicAdjust, activeThemes, THEMES } from '../thematicMacro.js';

const brentUp = { brent: { change5d: 6 }, usdtry: { change5d: 0 } };
const brentDown = { brent: { change5d: -6 }, usdtry: { change5d: 0 } };
const liraWeak = { brent: { change5d: 0 }, usdtry: { change5d: 3 } };
const calm = { brent: { change5d: 1 }, usdtry: { change5d: 0.5 } };
const goldUp = { gold: { change5d: 5 } };
const silverUp = { silver: { change5d: 5 } };
const copperUp = { copper: { change5d: 5 } };
const liraStrong = { usdtry: { change5d: -3 } };
const riskOff = { vix: { value: 30 } };
const riskOn = { sp500: { change5d: 4 } };

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

  it('gold up → KOZAL/KOZAA (gold miners) get a boost', () => {
    expect(computeThematicAdjust(goldUp, 'KOZAL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(goldUp, 'KOZAA').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(goldUp, 'KOZAL').themes).toContain('gold_up');
  });

  it('silver up → precious-metals proxy boosts the gold miners', () => {
    expect(computeThematicAdjust(silverUp, 'KOZAL').delta).toBeGreaterThan(0);
  });

  it('copper up → SARKY (copper producer) gets a boost', () => {
    expect(computeThematicAdjust(copperUp, 'SARKY').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(copperUp, 'SARKY').themes).toContain('copper_up');
  });

  it('gold up does not boast copper/oil names, and vice-versa', () => {
    expect(computeThematicAdjust(goldUp, 'SARKY').delta).toBe(0);
    expect(computeThematicAdjust(copperUp, 'KOZAL').delta).toBe(0);
  });

  it('lira strong → FX-debt names (TTKOM/TCELL/TAVHL) benefit, exporters penalized', () => {
    expect(computeThematicAdjust(liraStrong, 'TTKOM').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(liraStrong, 'TAVHL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(liraStrong, 'EREGL').delta).toBeLessThan(0);
  });

  it('lira weak vs lira strong are opposite conditions (never both fire)', () => {
    // EREGL: boosted when lira weak, penalized when lira strong
    expect(computeThematicAdjust(liraWeak, 'EREGL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(liraStrong, 'EREGL').delta).toBeLessThan(0);
  });

  it('risk-off (VIX high) → gold miners bid as safe haven', () => {
    expect(computeThematicAdjust(riskOff, 'KOZAL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(riskOff, 'GARAN').delta).toBe(0);
  });

  it('risk-on (S&P strong) → high-beta holdings get a modest boost', () => {
    expect(computeThematicAdjust(riskOn, 'KCHOL').delta).toBeGreaterThan(0);
    expect(computeThematicAdjust(riskOn, 'SAHOL').delta).toBeGreaterThan(0);
  });

  it('calm macro → no adjustment for anyone', () => {
    expect(computeThematicAdjust(calm, 'TUPRS').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'EREGL').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'KOZAL').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'SARKY').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'TTKOM').delta).toBe(0);
    expect(computeThematicAdjust(calm, 'KCHOL').delta).toBe(0);
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
    const probe = {
      brent: { change5d: 99 }, usdtry: { change5d: 99 },
      gold: { change5d: 99 }, silver: { change5d: 99 }, copper: { change5d: 99 },
      vix: { value: 99 }, sp500: { change5d: 99 },
    };
    for (const t of THEMES) {
      expect(() => t.active(probe)).not.toThrow();
    }
  });
});
