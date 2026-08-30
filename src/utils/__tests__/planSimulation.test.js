import { describe, it, expect } from 'vitest';
import { simulatePlanReturn, learningReturn, PLAN_FRACTIONS } from '../planSimulation.js';

// bar helper — dates are plain ISO days; istanbulDayKey normalises them.
const bar = (date, high, low, close) => ({ date, high, low, close });

const buySig = (over = {}) => ({
  cls: 'buy', entryPrice: 100, stop: 95, target: 107,
  timestamp: '2026-08-03T09:00:00Z', ...over,
});

describe('planSimulation.simulatePlanReturn', () => {
  it('stages out at T1 then exits the rest on the trailing stop', () => {
    // The scenario that motivated this module: a signal that looks MEDIOCRE at
    // the raw d-day close but is clearly PROFITABLE if the stated plan is followed.
    const bars = [
      bar('2026-08-03', 105, 99, 104),   // +5% peak -> lock stop at 102.5
      bar('2026-08-04', 108, 103, 107),  // T1 (107) hit -> sell 40%; peak 108 -> stop 104
      bar('2026-08-05', 109, 102, 103),  // low 102 <= 104 -> trailing stop takes the rest
    ];
    const out = simulatePlanReturn(buySig(), bars);
    // 40% at +7%  = 2.8   |   60% at +4% (stop 104) = 2.4
    expect(out.planReturn).toBeCloseTo(5.2, 6);
    expect(out.exitReason).toBe('stop');
    expect(out.barsHeld).toBe(3);
    // The raw close on the final day is only +3% — the two metrics genuinely differ,
    // which is exactly why calibration was learning the wrong number.
    expect(out.planReturn).toBeGreaterThan(3);
  });

  it('a plain stop-out loses the full initial risk', () => {
    const out = simulatePlanReturn(buySig({ target: 120 }), [bar('2026-08-03', 101, 94, 96)]);
    expect(out.planReturn).toBeCloseTo(-5, 6);
    expect(out.exitReason).toBe('stop');
  });

  it('stop wins when one bar spans both stop and target (same convention as signalOutcome)', () => {
    // A daily bar cannot tell us which came first. Recording an unprovable gain
    // would flatter the model, so the loss is recorded instead.
    const out = simulatePlanReturn(buySig({ target: 105 }), [bar('2026-08-03', 106, 94, 100)]);
    expect(out.planReturn).toBeCloseTo(-5, 6);
    expect(out.exitReason).toBe('stop');
  });

  it('takes all three legs when T1/T2/T3 are all reached', () => {
    const sig = buySig({ target: 107, t2: 112, t3: 120 });
    const out = simulatePlanReturn(sig, [bar('2026-08-03', 125, 99, 124)]);
    // 40%*7 + 30%*12 + 30%*20 = 2.8 + 3.6 + 6.0
    expect(out.planReturn).toBeCloseTo(12.4, 6);
    expect(out.exitReason).toBe('targets');
    expect(out.legs.map(l => l.key)).toEqual(['t1', 't2', 't3']);
    expect(PLAN_FRACTIONS.t1 + PLAN_FRACTIONS.t2 + PLAN_FRACTIONS.t3).toBeCloseTo(1, 6);
  });

  it('closes the remainder at the last close when nothing else triggers', () => {
    const out = simulatePlanReturn(buySig({ target: 200, stop: 1 }), [
      bar('2026-08-03', 102, 99, 101),
      bar('2026-08-04', 104, 100, 103),
    ]);
    expect(out.planReturn).toBeCloseTo(3, 6);   // full position at +3%
    expect(out.exitReason).toBe('timeout');
  });

  it('moves the stop to breakeven above +3% and never loosens it', () => {
    const out = simulatePlanReturn(buySig({ target: 200 }), [
      bar('2026-08-03', 104, 99, 103),   // +4% peak -> breakeven stop at 100
      bar('2026-08-04', 101, 98, 99),    // low 98 <= 100 -> exit flat, NOT at -5
    ]);
    expect(out.planReturn).toBeCloseTo(0, 6);
    expect(out.exitReason).toBe('stop');
  });

  it('a trailing level set from a bar only applies to LATER bars (no lookahead)', () => {
    // The +5% lock computed from this bar's own high must not retroactively stop
    // us out inside the same bar — that level did not exist when the bar opened.
    const out = simulatePlanReturn(buySig({ target: 200 }), [
      bar('2026-08-03', 110, 96, 97),    // peak +10% -> stop becomes 105 AFTER close
      bar('2026-08-04', 106, 104, 105),  // low 104 <= 105 -> exit here at +5%
    ]);
    expect(out.planReturn).toBeCloseTo(5, 6);
    expect(out.barsHeld).toBe(2);
  });

  it('inverts every comparison for sell signals', () => {
    const sell = { cls: 'sell', entryPrice: 100, stop: 105, target: 93,
                   timestamp: '2026-08-03T09:00:00Z' };
    const out = simulatePlanReturn(sell, [bar('2026-08-03', 102, 92, 94)]);
    // 40% at +7% (price fell to 93) + 60% at +6% (close 94) = 2.8 + 3.6
    expect(out.planReturn).toBeCloseTo(6.4, 6);
  });

  it('ignores bars dated before the signal', () => {
    const out = simulatePlanReturn(buySig({ target: 200, stop: 1 }), [
      bar('2026-07-01', 300, 290, 295),  // pre-entry spike must not count
      bar('2026-08-03', 102, 99, 101),
    ]);
    expect(out.planReturn).toBeCloseTo(1, 6);
    expect(out.barsHeld).toBe(1);
  });

  it('honours the maxBars window', () => {
    const bars = Array.from({ length: 10 }, (_, i) =>
      bar(`2026-08-${String(3 + i).padStart(2, '0')}`, 101, 99, 100 + i * 0.1));
    const out = simulatePlanReturn(buySig({ target: 200, stop: 1 }), bars, { maxBars: 3 });
    expect(out.barsHeld).toBe(3);
  });

  it('falls back to close when a bar has no high/low', () => {
    const out = simulatePlanReturn(buySig({ target: 107, stop: 95 }),
      [{ date: '2026-08-03', close: 108 }]);
    expect(out.planReturn).toBeCloseTo(0.4 * 7 + 0.6 * 8, 6);
  });

  it('is defensive: missing entry, empty bars, or no post-entry bar → null', () => {
    expect(simulatePlanReturn(buySig({ entryPrice: 0 }), [bar('2026-08-03', 1, 1, 1)])).toBeNull();
    expect(simulatePlanReturn(buySig(), [])).toBeNull();
    expect(simulatePlanReturn(buySig(), null)).toBeNull();
    expect(simulatePlanReturn(null, [bar('2026-08-03', 1, 1, 1)])).toBeNull();
    // bars exist but all predate the signal
    expect(simulatePlanReturn(buySig(), [bar('2026-07-01', 110, 90, 100)])).toBeNull();
  });
});

describe('planSimulation.learningReturn', () => {
  it('prefers the plan return when present', () => {
    expect(learningReturn({ planReturn: 5.2 }, -1.4)).toBe(5.2);
  });

  it('falls back to the supplied checkpoint return — no data is lost', () => {
    expect(learningReturn({}, -1.4)).toBe(-1.4);
    expect(learningReturn({ planReturn: null }, -1.4)).toBe(-1.4);
  });

  it('treats a genuine 0 as data, not as missing', () => {
    expect(learningReturn({ planReturn: 0 }, 9)).toBe(0);
  });

  it('returns null when neither source has a number', () => {
    expect(learningReturn({}, null)).toBeNull();
    expect(learningReturn(null, undefined)).toBeNull();
  });
});
