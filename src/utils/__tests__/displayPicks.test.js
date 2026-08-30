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

  it('v31.6: does NOT pad from scanResults — shows genuine topPicks only (no filler)', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1 })];
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 500_000, atrPct: 1, confidence: 50 - i }));
    const out = deriveDisplayPicks(top, scan, false);
    expect(out.map(p => p.symbol)).toEqual(['T1']); // no "yarin umut" padding
    expect(out.some(p => p._emergencyPick)).toBe(false);
  });

  it('v31.6: counter-regime also shows only genuine picks, no filler', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1, _counterRegime: true })];
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 500_000, atrPct: 1, score: 70, confidence: 70 - i }));
    const out = deriveDisplayPicks(top, scan, true);
    expect(out.map(p => p.symbol)).toEqual(['T1']); // genuine only, not padded to 6
  });

  it('v31.6: the guaranteed ⭐ pick (_bestOfDay) is never dropped as unsafe', () => {
    // A best-of-day pick may have a mild pump; it must still show (upstream guarantee).
    const top = [pick({ symbol: 'STAR', todayPumpReal: 6, _bestOfDay: true, _counterRegime: true })];
    const out = deriveDisplayPicks(top, [], true);
    expect(out.map(p => p.symbol)).toEqual(['STAR']);
  });

  it('regimeRestrict=true with empty topPicks → only quality names, capped at 4', () => {
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 70, confidence: 70 - i }));
    const out = deriveDisplayPicks([], scan, true);
    expect(out.length).toBe(4); // v31.28: target 8 → 4, in step with the gate cap
    expect(out.every(p => p._counterRegime === true)).toBe(true); // all warned
    // and a sub-floor scan yields nothing rather than filling with junk
    const weak = Array.from({ length: 10 }, (_, i) => pick({ symbol: `W${i}`, avgVolumeTL: 2_000_000, score: 50 }));
    expect(deriveDisplayPicks([], weak, true)).toEqual([]);
  });

  it('v31.28: the filler floor is regime-specific and matches the gate', () => {
    // score 62 sits between the BEAR floor (58) and the NEUTRAL floor (70).
    // If this branch used one blended floor it would re-admit exactly the names
    // applyRegimeGate just removed — the v31.4 back door.
    const scan = Array.from({ length: 6 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 62, confidence: 62 - i }));
    expect(deriveDisplayPicks([], scan, true, 'NEUTRAL')).toEqual([]);        // cut
    expect(deriveDisplayPicks([], scan, true, 'BEAR').length).toBe(4);        // shown
    // omitted regime falls back to the STRICTER floor, never the weaker one
    expect(deriveDisplayPicks([], scan, true)).toEqual([]);
  });

  it('empty topPicks + scanResults (no restrict) → fresh fallback with _fallback flag', () => {
    const scan = Array.from({ length: 5 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 60 }));
    const out = deriveDisplayPicks([], scan, false);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(p => p._fallback)).toBe(true);
  });

  it('YATAY: buys in topPicks appear first, ahead of high-confidence sells', () => {
    // Sell-heavy sideways market. The "never all-sells" guarantee now lives upstream
    // (ensureBestOfDay injects a real buy into topPicks before dispatch), so here the
    // buy is already present in topPicks; the view just orders buys first.
    const mixed = [
      ...Array.from({ length: 8 }, (_, i) => pick({ symbol: `SELL${i}`, cls: 'sell', confidence: 90 - i })),
      pick({ symbol: 'STAR', cls: 'buy', _bestOfDay: true, _counterRegime: true, confidence: 55 }),
    ];
    const out = deriveDisplayPicks(mixed, [], true);
    expect(out[0].cls).toBe('buy');       // buy first (visible), despite lower confidence
    expect(out[0].symbol).toBe('STAR');
  });

  it('is deterministic — same inputs give same output (header/panel parity)', () => {
    const top = [pick({ symbol: 'A', confidence: 80 }), pick({ symbol: 'B', confidence: 70 })];
    const a = deriveDisplayPicks(top, [], false);
    const b = deriveDisplayPicks(top, [], false);
    expect(a.map(p => p.symbol)).toEqual(b.map(p => p.symbol));
  });
});
