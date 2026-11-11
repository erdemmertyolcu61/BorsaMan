import { describe, it, expect } from 'vitest';
import {
  CALM_FEATURES, realizedVol, entryQualityOf, calmRanks, stampCalmRank, byCalmRankDesc,
} from '../candidateRank.js';

const cand = (o = {}) => ({ realizedVol20: 2, adx: 25, distFromMA50: 3, entryQuality: 60, ...o });

describe('candidateRank.realizedVol', () => {
  const series = (changes, start = 100) => {
    const out = [{ close: start }];
    for (const c of changes) out.push({ close: out[out.length - 1].close * (1 + c / 100) });
    return out;
  };

  it('is the standard deviation of the last 20 daily % changes', () => {
    const flat = series(Array(20).fill(1));
    expect(realizedVol(flat)).toBeCloseTo(0, 6);
    const zigzag = series(Array.from({ length: 20 }, (_, i) => (i % 2 ? 2 : -2)));
    expect(realizedVol(zigzag)).toBeCloseTo(2, 6);
  });

  it('looks only at the last n changes', () => {
    const calmAfterStorm = series([...Array(30).fill(0).map((_, i) => (i % 2 ? 9 : -9)), ...Array(20).fill(0.5)]);
    expect(realizedVol(calmAfterStorm)).toBeCloseTo(0, 6);
  });

  it('returns null rather than a guess when history is short or broken', () => {
    expect(realizedVol(series(Array(10).fill(1)))).toBeNull();
    expect(realizedVol(null)).toBeNull();
    const holes = series(Array(20).fill(1)).map((b, i) => (i > 12 ? { close: 0 } : b));
    expect(realizedVol(holes)).toBeNull();
  });
});

describe('candidateRank.entryQualityOf', () => {
  it('rewards a quiet name sitting on its MA20', () => {
    expect(entryQualityOf({ recentPump: 0.5, distFromMA20: 1 })).toBe(98);
  });

  it('punishes chasing: a recent jump and distance from MA20', () => {
    expect(entryQualityOf({ recentPump: 6, distFromMA20: 1 })).toBe(23);
    expect(entryQualityOf({ recentPump: 0.5, distFromMA20: 11 })).toBe(55);
    expect(entryQualityOf({ todayPumpReal: 8, recentPump: 1, distFromMA20: 12 })).toBe(5);
  });

  it('punishes a rally on distribution and a rally on thin volume', () => {
    const base = { recentPump: 1.5, distFromMA20: 2.5 };
    expect(entryQualityOf(base)).toBe(85);
    expect(entryQualityOf({ ...base, obvTrend: 'distribution', change: 1.2, rsi: 60 })).toBe(50);
    expect(entryQualityOf({ ...base, volRatio: 0.6, change: 1.5 })).toBe(65);
  });

  it('blends the entry-timing score 60/40 for buys only', () => {
    const p = { recentPump: 0.5, distFromMA20: 2.5, entryTimingScore: 60 };
    expect(entryQualityOf(p)).toBe(Math.round(95 * 0.6 + 80 * 0.4));
    expect(entryQualityOf(p, true)).toBe(95);
  });

  it('is defensive', () => {
    expect(entryQualityOf(null)).toBe(50);
    expect(entryQualityOf({})).toBe(98);
  });
});

describe('candidateRank.calmRanks', () => {
  it('ranks the calm, un-extended, well-timed name first and its opposite last', () => {
    const calm = cand({ realizedVol20: 1, adx: 12, distFromMA50: -2, entryQuality: 95 });
    const mid = cand();
    const hot = cand({ realizedVol20: 4, adx: 45, distFromMA50: 18, entryQuality: 10 });
    const r = calmRanks([hot, calm, mid]);
    expect(r[1]).toBe(100);
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(50);
  });

  it('every feature pulls in its measured direction', () => {
    for (const [field, dir] of CALM_FEATURES) {
      const lo = cand({ [field]: 1 });
      const hi = cand({ [field]: 99 });
      const [rLo, rHi] = calmRanks([lo, hi]);
      if (dir > 0) expect(rHi).toBeGreaterThan(rLo);
      else expect(rLo).toBeGreaterThan(rHi);
    }
  });

  it('is relative to the list, not absolute', () => {
    const a = cand({ realizedVol20: 3 });
    const b = cand({ realizedVol20: 5 });
    expect(calmRanks([a, b])[0]).toBeGreaterThan(calmRanks([a, cand({ realizedVol20: 1 })])[0]);
  });

  it('a missing feature is neutral, never a free pass', () => {
    const unknown = cand({ realizedVol20: null });
    const [u, lo, hi] = calmRanks([unknown, cand({ realizedVol20: 1 }), cand({ realizedVol20: 9 })]);
    expect(u).toBeLessThan(lo);
    expect(u).toBeGreaterThan(hi);
  });

  it('ties share a rank; one candidate or no information is 50', () => {
    expect(calmRanks([cand(), cand()])).toEqual([50, 50]);
    expect(calmRanks([cand()])).toEqual([50]);
    expect(calmRanks([{}, {}])).toEqual([50, 50]);
    expect(calmRanks([])).toEqual([]);
    expect(calmRanks(null)).toEqual([]);
  });

  it('derives entry quality from the row when it is not stamped yet', () => {
    const quiet = { realizedVol20: 2, adx: 25, distFromMA50: 3, recentPump: 0.5, distFromMA20: 1 };
    const chased = { realizedVol20: 2, adx: 25, distFromMA50: 3, recentPump: 6, distFromMA20: 9 };
    const [q, c] = calmRanks([quiet, chased]);
    expect(q).toBeGreaterThan(c);
  });
});

describe('candidateRank.stampCalmRank / byCalmRankDesc', () => {
  it('stamps without mutating and sorts calm-first', () => {
    const hot = cand({ symbol: 'HOT', realizedVol20: 5, adx: 50 });
    const calm = cand({ symbol: 'CALM', realizedVol20: 1, adx: 10 });
    const stamped = stampCalmRank([hot, calm]);
    expect(hot._calmRank).toBeUndefined();
    expect(stamped.map((s) => s.symbol)).toEqual(['HOT', 'CALM']);
    expect(stamped.slice().sort(byCalmRankDesc).map((s) => s.symbol)).toEqual(['CALM', 'HOT']);
  });

  it('unstamped rows sort after stamped ones', () => {
    const list = [{ symbol: 'X' }, { symbol: 'A', _calmRank: 10 }, { symbol: 'B', _calmRank: 90 }];
    expect(list.sort(byCalmRankDesc).map((s) => s.symbol)).toEqual(['B', 'A', 'X']);
  });
});
