import { describe, it, expect } from 'vitest';
import { classifyBistRegime, regimeLabel, applyRegimeGate } from '../regimeGate.js';

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
});
