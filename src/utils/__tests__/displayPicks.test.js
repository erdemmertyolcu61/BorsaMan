import { describe, it, expect } from 'vitest';
import { deriveDisplayPicks } from '../displayPicks.js';

const pick = (o) => ({ confidence: 60, score: 60, cls: 'buy', ...o });

describe('deriveDisplayPicks', () => {
  it('returns [] for empty inputs', () => {
    expect(deriveDisplayPicks([], [])).toEqual([]);
  });

  it('sorts topPicks by confidence (highest first)', () => {
    const out = deriveDisplayPicks([
      pick({ symbol: 'A', confidence: 60 }),
      pick({ symbol: 'B', confidence: 90 }),
      pick({ symbol: 'C', confidence: 75 }),
    ], []);
    expect(out.map(p => p.symbol)).toEqual(['B', 'C', 'A']);
  });

  it('ranks non-pump picks ahead of high-pump (>=7%) picks', () => {
    const out = deriveDisplayPicks([
      pick({ symbol: 'PUMP', confidence: 95, todayPumpReal: 9, continuationProbability: 40 }),
      pick({ symbol: 'CALM', confidence: 60, todayPumpReal: 1 }),
    ], []);
    expect(out[0].symbol).toBe('CALM'); // calm ahead of pump despite lower confidence
  });

  it('filters out unsafe picks (gap-up >=12%) unless emergency', () => {
    const out = deriveDisplayPicks([
      pick({ symbol: 'GAP', todayPumpReal: 13 }),
      pick({ symbol: 'OK', todayPumpReal: 1 }),
    ], []);
    expect(out.map(p => p.symbol)).toEqual(['OK']);
  });

  it('fills up to 8 from scanResults when topPicks < 8 (BULL, no regimeRestrict)', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1 })];
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 500_000, atrPct: 1, confidence: 50 - i }));
    const out = deriveDisplayPicks(top, scan, false);
    expect(out.length).toBe(8);
    expect(out[0].symbol).toBe('T1');
    expect(out.slice(1).every(p => p._emergencyPick)).toBe(true);
  });

  it('regimeRestrict=true skips emergency fillers — only real topPicks', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1 })];
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 500_000, atrPct: 1 }));
    const out = deriveDisplayPicks(top, scan, true);
    expect(out.map(p => p.symbol)).toEqual(['T1']);
  });

  it('regimeRestrict=true with empty topPicks → [] (no fallback, DUSUS empty state)', () => {
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 60 }));
    expect(deriveDisplayPicks([], scan, true)).toEqual([]);
  });

  it('empty topPicks + scanResults (no restrict) → fresh fallback with _fallback flag', () => {
    const scan = Array.from({ length: 5 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 60 }));
    const out = deriveDisplayPicks([], scan, false);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(p => p._fallback)).toBe(true);
  });

  it('is deterministic — same inputs give same output (header/panel parity)', () => {
    const top = [pick({ symbol: 'A', confidence: 80 }), pick({ symbol: 'B', confidence: 70 })];
    const a = deriveDisplayPicks(top, [], false);
    const b = deriveDisplayPicks(top, [], false);
    expect(a.map(p => p.symbol)).toEqual(b.map(p => p.symbol));
  });
});
