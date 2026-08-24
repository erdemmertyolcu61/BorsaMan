import { describe, it, expect } from 'vitest';
import { shouldRunEndOfDayScan, isEodCatchUp } from '../scanSchedule.js';
import { createThrottleController, isThrottleSignal, THROTTLE_STATUSES } from '../adaptiveThrottle.js';

// 2026-08-05 is a Wednesday. Times below are given as absolute UTC instants and
// converted by the schedule helpers, so these assertions are timezone-independent.
const WED_1700_TRT = Date.parse('2026-08-05T14:00:00Z');
const WED_1900_TRT = Date.parse('2026-08-05T16:00:00Z');
const THU_0800_TRT = Date.parse('2026-08-06T05:00:00Z');
const SAT_1200_TRT = Date.parse('2026-08-08T09:00:00Z');

describe('shouldRunEndOfDayScan (v31.25)', () => {
  it('runs for a day whose close has not been recorded yet', () => {
    const r = shouldRunEndOfDayScan(WED_1900_TRT, null);
    expect(r.should).toBe(true);
    expect(r.targetDay).toBe('2026-08-05');
  });

  it('does not run twice for the same trading day', () => {
    expect(shouldRunEndOfDayScan(WED_1900_TRT, '2026-08-05').should).toBe(false);
  });

  it('CATCHES UP when the app was closed at 18:15 and opened much later', () => {
    // The old scheduler fired only inside a one-minute window, so this was lost.
    const late = Date.parse('2026-08-05T19:00:00Z'); // 22:00 TRT, same day
    const r = shouldRunEndOfDayScan(late, '2026-08-04');
    expect(r.should).toBe(true);
    expect(r.targetDay).toBe('2026-08-05');
  });

  it('still catches yesterday when opened the next morning before the open', () => {
    // The daily close bar has not changed, so recording it now is honest.
    const r = shouldRunEndOfDayScan(THU_0800_TRT, '2026-08-04');
    expect(r.should).toBe(true);
    expect(r.targetDay).toBe('2026-08-05');
  });

  it('targets the last settled day, not the calendar day, before the close', () => {
    // 17:00 TRT Wednesday — Wednesday has not settled yet, so Tuesday is the target.
    expect(shouldRunEndOfDayScan(WED_1700_TRT, null).targetDay).toBe('2026-08-04');
  });

  it('targets Friday over a weekend', () => {
    expect(shouldRunEndOfDayScan(SAT_1200_TRT, null).targetDay).toBe('2026-08-07');
  });

  it('is defensive about bad input', () => {
    expect(shouldRunEndOfDayScan(NaN, null).should).toBe(false);
  });
});

describe('isEodCatchUp', () => {
  it('flags a record taken for an earlier day', () => {
    expect(isEodCatchUp(THU_0800_TRT, '2026-08-05')).toBe(true);
  });
  it('is false for same-day recording', () => {
    expect(isEodCatchUp(WED_1900_TRT, '2026-08-05')).toBe(false);
  });
});

describe('isThrottleSignal', () => {
  it('treats upstream rate-limit statuses as throttling, not failure', () => {
    // Measured: BigPara answers 401 to bursts and 200 after a pause.
    for (const s of THROTTLE_STATUSES) expect(isThrottleSignal(s)).toBe(true);
    expect(isThrottleSignal(200)).toBe(false);
    expect(isThrottleSignal(404)).toBe(false);
    expect(isThrottleSignal(500)).toBe(false);
  });
});

describe('createThrottleController', () => {
  it('starts at the configured base pace', () => {
    const c = createThrottleController({ baseDelayMs: 60, baseConcurrency: 20 });
    expect(c.current()).toEqual({ delayMs: 60, concurrency: 20 });
  });

  it('slows down immediately when a batch is throttled', () => {
    const c = createThrottleController();
    c.onBatch({ throttled: 3, ok: 17 });
    const cur = c.current();
    expect(cur.delayMs).toBeGreaterThan(60);
    expect(cur.concurrency).toBeLessThan(20);
  });

  it('keeps slowing on repeated throttling but respects the bounds', () => {
    const c = createThrottleController({ maxDelayMs: 1500, minConcurrency: 4 });
    for (let i = 0; i < 20; i++) c.onBatch({ throttled: 5 });
    const cur = c.current();
    expect(cur.delayMs).toBe(1500);
    expect(cur.concurrency).toBe(4);
  });

  it('recovers only after several clean batches, and gradually', () => {
    const c = createThrottleController({ recoverAfterCleanBatches: 3 });
    c.onBatch({ throttled: 4 });
    const slowed = c.current();
    c.onBatch({ ok: 20 });
    c.onBatch({ ok: 20 });
    expect(c.current()).toEqual(slowed);          // not yet — recovery is deliberate
    c.onBatch({ ok: 20 });
    const recovered = c.current();
    expect(recovered.delayMs).toBeLessThan(slowed.delayMs);
    expect(recovered.concurrency).toBeGreaterThan(slowed.concurrency);
  });

  it('never recovers past the base pace', () => {
    const c = createThrottleController({ baseDelayMs: 60, baseConcurrency: 20, recoverAfterCleanBatches: 1 });
    for (let i = 0; i < 30; i++) c.onBatch({ ok: 20 });
    expect(c.current()).toEqual({ delayMs: 60, concurrency: 20 });
  });

  it('reports what happened so the scan can log it honestly', () => {
    const c = createThrottleController();
    c.onBatch({ throttled: 2 });
    c.onBatch({ ok: 20 });
    const s = c.stats();
    expect(s.throttleEvents).toBe(2);
    expect(s.batches).toBe(2);
  });
});
