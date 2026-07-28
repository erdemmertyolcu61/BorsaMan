import { describe, it, expect } from 'vitest';
import { classifyBistRegime, regimeLabel, applyRegimeGate, ensureBestOfDay } from '../regimeGate.js';

// Helper: build a rising/falling/flat close series of length n
const rising = (n, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);
const falling = (n, start = 200, step = 1) => Array.from({ length: n }, (_, i) => start - i * step);
const flat = (n, v = 100) => Array.from({ length: n }, () => v);

describe('regimeGate.classifyBistRegime', () => {
  it('BULL when last > MA20 and 5-day slope > 1%', () => {
    const { regime, changePct } = classifyBistRegime(rising(30, 100, 2));
    expect(regime).toBe('BULL');
    expect(changePct).toBeGreaterThan(1);
  });

  it('BEAR when last < MA20 and 5-day slope < -1%', () => {
    const { regime, changePct } = classifyBistRegime(falling(30, 200, 2));
    expect(regime).toBe('BEAR');
    expect(changePct).toBeLessThan(-1);
  });

  it('NEUTRAL for a flat series (no trend)', () => {
    expect(classifyBistRegime(flat(30)).regime).toBe('NEUTRAL');
  });

  it('NEUTRAL when price rose above MA20 but slope is weak (<1%)', () => {
    // gentle uptrend: last just above MA20 but 5-day slope tiny
    const closes = [...flat(25, 100), 100.2, 100.3, 100.4, 100.5, 100.6];
    expect(classifyBistRegime(closes).regime).toBe('NEUTRAL');
  });

  it('falls back to single-day change when <25 bars', () => {
    expect(classifyBistRegime([100, 102]).regime).toBe('BULL');   // +2% day
    expect(classifyBistRegime([100, 99]).regime).toBe('BEAR');    // -1% day
    expect(classifyBistRegime([100, 100.2]).regime).toBe('NEUTRAL');
  });

  it('is defensive against empty/garbage input', () => {
    expect(classifyBistRegime([]).regime).toBe('NEUTRAL');
    expect(classifyBistRegime(null).regime).toBe('NEUTRAL');
    expect(classifyBistRegime([0, -5, NaN]).regime).toBe('NEUTRAL');
  });
});

describe('regimeGate.regimeLabel', () => {
  it('maps regimes to Turkish labels', () => {
    expect(regimeLabel('BULL')).toBe('YUKSELIS');
    expect(regimeLabel('BEAR')).toBe('DUSUS');
    expect(regimeLabel('NEUTRAL')).toBe('YATAY');
  });
});

describe('regimeGate.applyRegimeGate', () => {
  const picks = [
    { symbol: 'A', cls: 'buy', score: 80 },
    { symbol: 'B', cls: 'buy', score: 66 },
    { symbol: 'C', cls: 'buy', score: 50 },
    { symbol: 'D', cls: 'sell', score: 30 },
  ];

  it('BULL — passes all picks unchanged', () => {
    const out = applyRegimeGate(picks, 'BULL');
    expect(out).toHaveLength(4);
    expect(out).not.toBe(picks); // new array (pure)
  });

  it('NEUTRAL — sells + quality buys (score>=65) tagged counter-regime', () => {
    const out = applyRegimeGate(picks, 'NEUTRAL');
    // sell D + buys clearing the 65 floor (A=80, B=66); C=50 is cut
    expect(out.map(p => p.symbol)).toEqual(['D', 'A', 'B']);
    expect(out.filter(p => p.cls === 'buy').every(p => p._counterRegime === true)).toBe(true);
    expect(out.find(p => p.symbol === 'D')._counterRegime).toBeUndefined();
  });

  it('BEAR — sells + quality buys, tighter cap, tagged counter-regime', () => {
    const out = applyRegimeGate(picks, 'BEAR');
    expect(out.map(p => p.symbol)).toEqual(['D', 'A', 'B']);
    expect(out.filter(p => p.cls === 'buy').every(p => p._counterRegime === true)).toBe(true);
    expect(out.find(p => p.symbol === 'D')._counterRegime).toBeUndefined(); // sells not tagged
  });

  it('v31.4 quality floor: sub-65 buys are cut outside BULL but kept in BULL', () => {
    const weak = [{ symbol: 'W', cls: 'buy', score: 50 }];
    expect(applyRegimeGate(weak, 'NEUTRAL').map(p => p.symbol)).toEqual([]);
    expect(applyRegimeGate(weak, 'BEAR').map(p => p.symbol)).toEqual([]);
    expect(applyRegimeGate(weak, 'BULL').map(p => p.symbol)).toEqual(['W']); // BULL untouched
  });

  it('the floor is configurable (5th arg)', () => {
    const out = applyRegimeGate(picks, 'NEUTRAL', 8, 3, 40);
    expect(out.map(p => p.symbol)).toEqual(['D', 'A', 'B', 'C']); // C=50 now passes
  });

  it('BEAR — caps counter-regime buys via bearMaxBuys (4th arg)', () => {
    const out = applyRegimeGate(picks, 'BEAR', 8, 2);
    expect(out.map(p => p.symbol)).toEqual(['D', 'A', 'B']); // only top-2 buys
  });

  it('BEAR — bearMaxBuys=0 falls back to sells-only', () => {
    const out = applyRegimeGate(picks, 'BEAR', 8, 0);
    expect(out.map(p => p.symbol)).toEqual(['D']);
  });

  it('does not mutate the input array', () => {
    const copy = picks.map(p => ({ ...p }));
    applyRegimeGate(picks, 'BEAR');
    expect(picks).toEqual(copy);
  });

  it('NEUTRAL — caps counter-regime buys via neutralMaxBuys (3rd arg)', () => {
    const out = applyRegimeGate(picks, 'NEUTRAL', 2);
    expect(out.map(p => p.symbol)).toEqual(['D', 'A', 'B']); // sell + top-2 buys
  });

  it('is defensive against non-array input', () => {
    expect(applyRegimeGate(null, 'BEAR')).toEqual([]);
  });

  it('v31.13: BEAR buys are tagged _watchOnly (visible, not buy-now); NEUTRAL are not', () => {
    const bear = applyRegimeGate(picks, 'BEAR');
    const bearBuys = bear.filter(p => p.cls === 'buy');
    expect(bearBuys.length).toBeGreaterThan(0);
    expect(bearBuys.every(p => p._watchOnly === true)).toBe(true);
    expect(bear.find(p => p.cls === 'sell')._watchOnly).toBeUndefined(); // sells stay actionable
    const neutral = applyRegimeGate(picks, 'NEUTRAL');
    expect(neutral.filter(p => p.cls === 'buy').every(p => p._watchOnly)).toBe(false);
  });

  it('v31.5 defaults: quality floor is 58, NEUTRAL cap 6, BEAR cap 4', () => {
    // 7 buys straddling 58; NEUTRAL default keeps up to 6 that clear the floor.
    const many = Array.from({ length: 8 }, (_, i) => ({ symbol: `B${i}`, cls: 'buy', score: 60 + i }));
    many.push({ symbol: 'LOW', cls: 'buy', score: 50 }); // below 58 → cut
    const neutral = applyRegimeGate(many, 'NEUTRAL');
    expect(neutral.filter(p => p.cls === 'buy')).toHaveLength(6);
    expect(neutral.some(p => p.symbol === 'LOW')).toBe(false);
    const bear = applyRegimeGate(many, 'BEAR');
    expect(bear.filter(p => p.cls === 'buy')).toHaveLength(4);
  });
});

describe('regimeGate.ensureBestOfDay', () => {
  const cand = (o) => ({ cls: 'buy', score: 60, rsi: 55, mfi: 50, todayPumpReal: 1, ...o });

  it('injects the best pre-pump candidate when the gate left zero buys', () => {
    const gated = [{ symbol: 'S', cls: 'sell', score: 80 }];
    const pool = [cand({ symbol: 'A', score: 62 }), cand({ symbol: 'B', score: 70 })];
    const out = ensureBestOfDay(gated, pool, 'NEUTRAL');
    expect(out[0].symbol).toBe('B');           // highest-ranked injected first
    expect(out[0]._bestOfDay).toBe(true);
    expect(out[0]._counterRegime).toBe(true);  // NEUTRAL → warned
    expect(out).toHaveLength(2);               // sell preserved
  });

  it('prefers early-accumulation (pre-pump coil) over a higher raw score', () => {
    const pool = [cand({ symbol: 'HI', score: 74 }), cand({ symbol: 'COIL', score: 60, _earlyPick: true, _earlyCount: 5 })];
    expect(ensureBestOfDay([], pool, 'NEUTRAL')[0].symbol).toBe('COIL');
  });

  it('excludes already-pumped and overbought names (not a FOMO chaser)', () => {
    const pool = [
      cand({ symbol: 'PUMPED', score: 90, todayPumpReal: 9 }),   // already popped
      cand({ symbol: 'HOT', score: 88, rsi: 85 }),               // overbought
      cand({ symbol: 'CALM', score: 61 }),                       // clean pre-pump
    ];
    expect(ensureBestOfDay([], pool, 'NEUTRAL')[0].symbol).toBe('CALM');
  });

  it('does nothing when a real buy already survived the gate', () => {
    const gated = [{ symbol: 'REAL', cls: 'buy', score: 80, _counterRegime: true }];
    const out = ensureBestOfDay(gated, [cand({ symbol: 'X' })], 'NEUTRAL');
    expect(out).toEqual(gated);
    expect(out.some(p => p._bestOfDay)).toBe(false);
  });

  it('does NOT tag _counterRegime in BULL', () => {
    const out = ensureBestOfDay([], [cand({ symbol: 'A' })], 'BULL');
    expect(out[0]._bestOfDay).toBe(true);
    expect(out[0]._counterRegime).toBeUndefined();
    expect(out[0]._watchOnly).toBeUndefined();
  });

  it('v31.13: the guaranteed pick is _watchOnly in BEAR (not buy-now), not in NEUTRAL', () => {
    const bear = ensureBestOfDay([], [cand({ symbol: 'A' })], 'BEAR');
    expect(bear[0]._bestOfDay).toBe(true);
    expect(bear[0]._watchOnly).toBe(true);
    const neutral = ensureBestOfDay([], [cand({ symbol: 'A' })], 'NEUTRAL');
    expect(neutral[0]._watchOnly).toBeUndefined();
  });

  it('returns the gate output unchanged when no eligible candidate exists', () => {
    const gated = [{ symbol: 'S', cls: 'sell', score: 80 }];
    expect(ensureBestOfDay(gated, [cand({ symbol: 'P', todayPumpReal: 11 })], 'BEAR')).toEqual(gated);
    expect(ensureBestOfDay([], [], 'BEAR')).toEqual([]);
    expect(ensureBestOfDay([], null, 'BEAR')).toEqual([]);
  });
});
