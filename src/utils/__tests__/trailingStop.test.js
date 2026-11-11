import { describe, it, expect } from 'vitest';
import { ratchetStop, advanceTrail, initTrailState } from '../trailingStop.js';
import { simulatePlanReturn } from '../planSimulation.js';

describe('trailingStop.ratchetStop', () => {
  it('leaves the stop alone below +3%', () => {
    expect(ratchetStop({ entry: 100, stop: 95, peak: 102.9 })).toBe(95);
  });
  it('moves to breakeven from +3% and locks half the peak gain from +5%', () => {
    expect(ratchetStop({ entry: 100, stop: 95, peak: 103 })).toBe(100);
    expect(ratchetStop({ entry: 100, stop: 95, peak: 110 })).toBe(105);
  });
  it('never loosens', () => {
    expect(ratchetStop({ entry: 100, stop: 106, peak: 110 })).toBe(106);
    expect(ratchetStop({ entry: 100, stop: 101, peak: 103 })).toBe(101);
  });
  it('is defensive', () => {
    expect(ratchetStop({ entry: 0, stop: 95, peak: 110 })).toBe(95);
    expect(ratchetStop({ entry: 100, stop: null, peak: 110 })).toBe(105);
    expect(ratchetStop({ entry: 100, stop: null, peak: NaN })).toBeNull();
  });
});

describe('trailingStop.advanceTrail', () => {
  const q = (sessionKey, price, o = {}) => ({ entry: 100, price, sessionKey, wholeSession: true, ...o });

  it('a session high tightens the stop only from the NEXT session', () => {
    let { state, exit } = advanceTrail(initTrailState(100, 95), q('2026-11-02', 109, { open: 100, high: 110, low: 99 }));
    expect(exit).toBeNull();
    expect(state.stop).toBe(95);            // same session: unchanged
    expect(state.peak).toBe(110);
    // later the same day the price falls back to 101 — above the 95 stop, still open
    ({ state, exit } = advanceTrail(state, q('2026-11-02', 101, { open: 100, high: 110, low: 99 })));
    expect(exit).toBeNull();
    // next session: the 110 peak now locks 105
    ({ state, exit } = advanceTrail(state, q('2026-11-03', 106, { open: 106, high: 107, low: 105.5 })));
    expect(state.stop).toBe(105);
    expect(exit).toBeNull();
  });

  it('a session low that touched the stop exits at the level even if the price recovered', () => {
    // The mobile case: the app was frozen while the price dipped and came back.
    const { exit } = advanceTrail({ stop: 95, peak: 100, session: '2026-11-02', sessions: 1 },
      q('2026-11-02', 98, { open: 99, high: 99.5, low: 94 }));
    expect(exit).toEqual({ reason: 'stop', level: 95, basis: 'level' });
  });

  it('a session that opens below the stop fills at the open', () => {
    const { exit } = advanceTrail({ stop: 95, peak: 100, session: '2026-11-02', sessions: 1 },
      q('2026-11-03', 93, { open: 92, high: 94, low: 91 }));
    expect(exit).toEqual({ reason: 'stop', level: 92, basis: 'gap' });
  });

  it('a live cross is left to the caller\'s fill rule', () => {
    const { exit } = advanceTrail({ stop: 95, peak: 100, session: '2026-11-02', sessions: 1 },
      q('2026-11-02', 94.5, { open: 99, high: 99, low: 94.5 }));
    expect(exit).toEqual({ reason: 'stop', level: 95, basis: 'live' });
  });

  it('ignores the session range while the position was not open for the whole session', () => {
    // Bought intraday at 100 after the stock had already traded at 94 that morning.
    const { state, exit } = advanceTrail(initTrailState(100, 95),
      q('2026-11-02', 101, { open: 96, high: 112, low: 94, wholeSession: false }));
    expect(exit).toBeNull();
    expect(state.peak).toBe(101);           // not the pre-entry 112
  });

  it('times out when the session after the last allowed one begins', () => {
    let state = initTrailState(100, 90);
    let exit = null;
    for (let d = 1; d <= 3; d++) ({ state, exit } = advanceTrail(state, q(`2026-11-0${d}`, 101, { maxSessions: 3 })));
    expect(exit).toBeNull();
    ({ state, exit } = advanceTrail(state, q('2026-11-04', 101, { maxSessions: 3 })));
    expect(exit).toMatchObject({ reason: 'timeout' });
  });

  it('needs a session key and valid prices', () => {
    expect(advanceTrail(initTrailState(100, 95), { entry: 100, price: 90, sessionKey: '' }).exit).toBeNull();
    expect(advanceTrail(initTrailState(100, 95), { entry: 100, price: 0, sessionKey: '2026-11-02' }).exit).toBeNull();
  });

  it('replays daily bars to the same result as planSimulation', () => {
    // The whole point of this module: the forward test must run the measured rule.
    const bars = [
      { date: '2026-11-02', open: 100, high: 104, low: 99, close: 103.5 },   // +4% peak → breakeven next day
      { date: '2026-11-03', open: 103, high: 109, low: 102, close: 108 },    // +9% peak → lock 104.5 next day
      { date: '2026-11-04', open: 108, high: 112, low: 106, close: 111 },    // +12% → lock 106 next day
      { date: '2026-11-05', open: 110, high: 111, low: 105, close: 107 },    // low 105 <= 106 → out at 106
    ];
    const sim = simulatePlanReturn({ cls: 'buy', entryPrice: 100, stop: 95, timestamp: '2026-11-02' }, bars);
    let state = initTrailState(100, 95);
    let out = null;
    for (const b of bars) {
      const r = advanceTrail(state, { entry: 100, price: b.close, sessionKey: b.date, open: b.open, high: b.high, low: b.low, wholeSession: true });
      state = r.state;
      if (r.exit) { out = r.exit; break; }
    }
    expect(out).toMatchObject({ reason: 'stop', level: 106 });
    expect(sim.exitReason).toBe('stop');
    expect(sim.planReturn).toBeCloseTo((out.level / 100 - 1) * 100, 6);
  });
});
