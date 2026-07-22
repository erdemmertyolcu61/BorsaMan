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

  it('regimeRestrict=true fills only to 4 and tags fillers _counterRegime (v31.4)', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1 })];
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 500_000, atrPct: 1, score: 70, confidence: 70 - i }));
    const out = deriveDisplayPicks(top, scan, true);
    expect(out.length).toBe(4); // counter-regime target, NOT 8
    expect(out[0].symbol).toBe('T1'); // real pick first
    expect(out.slice(1).every(p => p._counterRegime === true)).toBe(true); // fillers warned
  });

  it('regimeRestrict=true cuts sub-65 fillers (quality floor, no back door)', () => {
    const top = [pick({ symbol: 'T1', todayPumpReal: 1 })];
    const weakScan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `W${i}`, avgVolumeTL: 500_000, atrPct: 1, score: 50 }));
    const out = deriveDisplayPicks(top, weakScan, true);
    expect(out.map(p => p.symbol)).toEqual(['T1']); // nothing weak sneaks in
  });

  it('regimeRestrict=true with empty topPicks → only quality names, capped at 4', () => {
    const scan = Array.from({ length: 10 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 70, confidence: 70 - i }));
    const out = deriveDisplayPicks([], scan, true);
    expect(out.length).toBe(4);
    expect(out.every(p => p._counterRegime === true)).toBe(true); // all warned
    // and a sub-65 scan yields nothing rather than filling with junk
    const weak = Array.from({ length: 10 }, (_, i) => pick({ symbol: `W${i}`, avgVolumeTL: 2_000_000, score: 50 }));
    expect(deriveDisplayPicks([], weak, true)).toEqual([]);
  });

  it('empty topPicks + scanResults (no restrict) → fresh fallback with _fallback flag', () => {
    const scan = Array.from({ length: 5 }, (_, i) =>
      pick({ symbol: `S${i}`, avgVolumeTL: 2_000_000, score: 60 }));
    const out = deriveDisplayPicks([], scan, false);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(p => p._fallback)).toBe(true);
  });

  it('YATAY bug: 8+ sells in topPicks must NOT crowd out buys — buys still shown, first', () => {
    // Sell-heavy sideways market: topPicks full of high-confidence sells, buys only
    // in the scan. Regression for "YATAY rejimde AL gozukmedi".
    const sells = Array.from({ length: 8 }, (_, i) =>
      pick({ symbol: `SELL${i}`, cls: 'sell', confidence: 90 - i }));
    const scan = Array.from({ length: 5 }, (_, i) =>
      pick({ symbol: `BUY${i}`, cls: 'buy', avgVolumeTL: 2_000_000, atrPct: 1, score: 70, confidence: 60 - i }));
    const out = deriveDisplayPicks(sells, scan, true);
    const buys = out.filter(p => p.cls === 'buy');
    expect(buys.length).toBeGreaterThan(0);        // AL must appear
    expect(out[0].cls).toBe('buy');                // buys first (visible)
    expect(buys.every(p => p._counterRegime)).toBe(true); // warned in YATAY
  });

  it('is deterministic — same inputs give same output (header/panel parity)', () => {
    const top = [pick({ symbol: 'A', confidence: 80 }), pick({ symbol: 'B', confidence: 70 })];
    const a = deriveDisplayPicks(top, [], false);
    const b = deriveDisplayPicks(top, [], false);
    expect(a.map(p => p.symbol)).toEqual(b.map(p => p.symbol));
  });
});
