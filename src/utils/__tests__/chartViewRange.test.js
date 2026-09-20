/**
 * clampViewRange — the chart's visible window (v31.45).
 *
 * Measured in the running app: analyse a symbol with the default 5-year range
 * (1252 bars, view = bars 1052-1251), then press 3A (64 bars). The old code set
 * the view once and never revisited it, so the draw sliced 1052..1252 out of a
 * 64-bar array, found fewer than 2 bars and returned — leaving the canvas
 * completely BLANK (0% ink, verified with getImageData before and after).
 */
import { describe, it, expect } from 'vitest';
import { clampViewRange } from '../../components/Chart/chartDraw.js';

describe('clampViewRange', () => {
  it('keeps a window that fits', () => {
    expect(clampViewRange({ start: 1052, end: 1251 }, 1252)).toEqual({ startIdx: 1052, endIdx: 1251 });
  });

  it('shows the whole series when no window is set', () => {
    expect(clampViewRange(null, 64)).toEqual({ startIdx: 0, endIdx: 63 });
    expect(clampViewRange(undefined, 300)).toEqual({ startIdx: 0, endIdx: 299 });
  });

  // The blank-chart case: a window left over from a longer series.
  it('never returns an empty slice for a stale window', () => {
    const { startIdx, endIdx } = clampViewRange({ start: 1052, end: 1251 }, 64);
    expect(endIdx).toBe(63);
    expect(startIdx).toBeLessThan(endIdx);
    expect(endIdx - startIdx + 1).toBeGreaterThanOrEqual(2);
  });

  it('handles partial overlap by pulling the end back into range', () => {
    expect(clampViewRange({ start: 10, end: 400 }, 100)).toEqual({ startIdx: 10, endIdx: 99 });
  });

  it('survives junk input without blanking the chart', () => {
    for (const bad of [{ start: NaN, end: NaN }, { start: -50, end: 1e9 }, { start: 5, end: 5 }, {}]) {
      const { startIdx, endIdx } = clampViewRange(bad, 120);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeLessThanOrEqual(119);
      expect(endIdx - startIdx).toBeGreaterThanOrEqual(1);
    }
  });

  it('degrades quietly on a series too short to draw', () => {
    const { startIdx, endIdx } = clampViewRange({ start: 4, end: 9 }, 1);
    expect(startIdx).toBe(0);
    expect(endIdx).toBe(0);            // drawChart still refuses to draw a single bar
  });
});
