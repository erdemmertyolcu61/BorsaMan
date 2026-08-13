import { describe, it, expect } from 'vitest';
import { normalizeSectorTilt, SECTOR_TILT_CLAMP } from '../sectorEngine.js';

// Regression guard for the v31.20 unit-mismatch bug: enhancePick fed a raw
// centred-at-50 sector metric (avgScore ~40-60 / strength 0-100) into a formula
// designed for a -3..+3 tilt, inflating the sector component ~7x so it dominated
// the composite confidence. Measured symptom: a score-46 'neutral' stock scored
// confidence 97 / grade A (sector component 42) and outranked a score-62 genuine buy
// (sector component 5). These tests keep the sector influence small and centred.

// The formula enhancePick applies to the tilt.
const component = (tilt) => (50 + tilt * 8) * 0.10;

describe('normalizeSectorTilt', () => {
  it('treats 50 as neutral (zero tilt)', () => {
    expect(normalizeSectorTilt(50)).toBe(0);
  });

  it('returns 0 for missing / non-numeric input', () => {
    expect(normalizeSectorTilt(null)).toBe(0);
    expect(normalizeSectorTilt(undefined)).toBe(0);
    expect(normalizeSectorTilt(NaN)).toBe(0);
  });

  it('maps a strong sector above 50 to a positive tilt, weak to negative', () => {
    expect(normalizeSectorTilt(60)).toBeGreaterThan(0);
    expect(normalizeSectorTilt(40)).toBeLessThan(0);
  });

  it('clamps to +/-3 for any 0-100 scale input', () => {
    expect(normalizeSectorTilt(100)).toBe(SECTOR_TILT_CLAMP);
    expect(normalizeSectorTilt(0)).toBe(-SECTOR_TILT_CLAMP);
    expect(normalizeSectorTilt(1000)).toBe(SECTOR_TILT_CLAMP);
  });

  it('keeps the sector component inside its designed ~2.6-7.4 band', () => {
    // across the realistic avgScore range and the full 0-100 strength range
    for (const raw of [0, 30, 40, 45, 50, 55, 60, 70, 100]) {
      const c = component(normalizeSectorTilt(raw));
      expect(c).toBeGreaterThanOrEqual(2.6);
      expect(c).toBeLessThanOrEqual(7.4);
    }
  });

  it('REGRESSION: a raw avgScore no longer produces a dominating component', () => {
    // Before the fix: component(52) === (50 + 52*8)*0.10 === 46.6 → drowned the composite
    expect(component(52)).toBeCloseTo(46.6, 1);           // the old, broken magnitude
    expect(component(normalizeSectorTilt(52))).toBeLessThan(6); // the fixed magnitude
  });
});
