import { describe, it, expect } from 'vitest';
import {
  planEntry, isEntryPending, resolveNextSessionFill, settlementView, decidePendingFill,
  nextWeekdayKey, applyEntrySlippage, ENTRY_BASIS, PENDING_MAX_AGE_MS,
} from '../sessionEntry.js';
import { simulatePlanReturn } from '../planSimulation.js';
import { backfillDailyPerf } from '../signalPerfHistory.js';

const at = (iso) => Date.parse(iso);
const FRI_1815 = at('2026-09-11T15:15:00Z');
const SUN_1300 = at('2026-09-13T10:00:00Z');
const MON_1130 = at('2026-09-14T08:30:00Z');
const bar = (key, o, h, l, c, extra = {}) => ({ date: `${key}T00:00:00.000Z`, open: o, high: h, low: l, close: c, volume: 1, ...extra });

describe('planEntry (v31.40)', () => {
  it('during the session the signal enters at the live price', () => {
    expect(planEntry({ marketOpen: true, now: MON_1130 })).toEqual({ entryBasis: 'live', entryAfterSession: null });
  });

  it('after the close / on the weekend it waits for the next session', () => {
    expect(planEntry({ marketOpen: false, now: FRI_1815 })).toEqual({ entryBasis: 'next_session', entryAfterSession: '2026-09-11' });
    expect(planEntry({ marketOpen: false, now: SUN_1300 }).entryAfterSession).toBe('2026-09-11');
    // The scan's own session day wins over the clock.
    expect(planEntry({ marketOpen: false, now: SUN_1300, sessionDay: '2026-09-10' }).entryAfterSession).toBe('2026-09-10');
  });

  it('nextWeekdayKey skips the weekend', () => {
    expect(nextWeekdayKey('2026-09-11')).toBe('2026-09-14');
    expect(nextWeekdayKey('2026-09-14')).toBe('2026-09-15');
    expect(nextWeekdayKey('bad')).toBe('');
  });
});

describe('signal settlement for after-hours signals', () => {
  // Friday: opened 100, dipped to 94 (BEFORE the evening signal existed), closed 104.
  // Monday: gapped up to 106, low 105, close 108. Stop 95.
  const bars = [bar('2026-09-10', 99, 101, 98, 100), bar('2026-09-11', 100, 105, 94, 104), bar('2026-09-14', 106, 109, 105, 108)];
  const eveningSignal = {
    cls: 'buy', entryPrice: 104.2, price: 104, stop: 95, target: 115, timestamp: '2026-09-11T15:15:00.000Z',
    entryBasis: ENTRY_BASIS.NEXT_SESSION, entryAfterSession: '2026-09-11', entrySlippagePct: 0.002,
  };

  it('fills at the next session\'s real open, not at the close it was generated from', () => {
    expect(resolveNextSessionFill(eveningSignal, bars)).toEqual({ day: '2026-09-14', price: 106, approx: false });
    const view = settlementView(eveningSignal, bars);
    expect(view.timestamp).toBe('2026-09-14');
    expect(view.entryPrice).toBeCloseTo(106 * 1.002, 6);
  });

  it('stays pending while the next session has no bar — nothing is computed', () => {
    expect(settlementView(eveningSignal, bars.slice(0, 2))).toBeNull();
    expect(isEntryPending(eveningSignal)).toBe(true);
    expect(isEntryPending({ ...eveningSignal, entryFillDay: '2026-09-14' })).toBe(false);
  });

  it('removes the look-back error: Friday\'s pre-signal dip no longer stops the trade', () => {
    const legacy = simulatePlanReturn({ ...eveningSignal, entryBasis: undefined }, bars);
    expect(legacy.exitReason).toMatch(/stop/i);                   // the old convention
    const fixed = simulatePlanReturn(settlementView(eveningSignal, bars), bars);
    expect(fixed.exitReason).not.toMatch(/stop/i);
  });

  it('the day-by-day series starts on the fill day', () => {
    const series = backfillDailyPerf(settlementView(eveningSignal, bars), bars);
    expect(series.map(p => p.d)).toEqual(['2026-09-14']);
  });

  it('live and legacy signals are untouched', () => {
    const live = { cls: 'buy', entryPrice: 100, timestamp: '2026-09-14T08:30:00Z', entryBasis: 'live' };
    expect(settlementView(live, bars)).toBe(live);
    const legacy = { cls: 'buy', entryPrice: 100, timestamp: '2026-09-14T08:30:00Z' };
    expect(settlementView(legacy, bars)).toBe(legacy);
  });

  it('an already recorded fill is reused as-is', () => {
    const filled = { ...eveningSignal, entryPrice: 106.21, entryFillDay: '2026-09-14' };
    expect(settlementView(filled, [])).toMatchObject({ entryPrice: 106.21, timestamp: '2026-09-14' });
  });

  it('slippage moves buys up and sells down', () => {
    expect(applyEntrySlippage(100, { cls: 'buy', entrySlippagePct: 0.005 })).toBeCloseTo(100.5, 6);
    expect(applyEntrySlippage(100, { cls: 'sell', entrySlippagePct: 0.005 })).toBeCloseTo(99.5, 6);
    expect(applyEntrySlippage(100, {})).toBe(100);
  });
});

describe('decidePendingFill — paper orders queued outside the session', () => {
  const order = { symbol: 'THYAO', createdAt: FRI_1815, afterSession: '2026-09-11', pick: { stop: 285 } };
  const quote = (sessionDate, open) => ({ sessionDate, open, price: open });

  it('waits while the quote still belongs to the signal\'s session (weekend, pre-open)', () => {
    expect(decidePendingFill(order, quote('2026-09-11T18:09:47.000+03', 299.25), SUN_1300)).toEqual({ action: 'wait' });
  });

  it('fills at the next session\'s open with the session open time', () => {
    const d = decidePendingFill(order, quote('2026-09-14T11:30:00.000+03', 302), MON_1130);
    expect(d).toMatchObject({ action: 'fill', price: 302, sessionKey: '2026-09-14' });
    expect(new Date(d.openedAt).toISOString()).toBe('2026-09-14T06:55:00.000Z');
  });

  it('cancels when the first session it can see is not the next one (missed day)', () => {
    const d = decidePendingFill(order, quote('2026-09-15T18:09:00.000+03', 301), at('2026-09-15T16:00:00Z'));
    expect(d).toMatchObject({ action: 'cancel', reason: 'missed_session', expected: '2026-09-14' });
  });

  it('cancels when the open gaps below the stop', () => {
    expect(decidePendingFill(order, quote('2026-09-14T10:00:00.000+03', 280), MON_1130)).toMatchObject({ action: 'cancel', reason: 'gap_below_stop' });
  });

  it('waits for the open to be published, expires old orders, rejects malformed ones', () => {
    expect(decidePendingFill(order, quote('2026-09-14T09:56:00.000+03', 0), MON_1130).action).toBe('wait');
    expect(decidePendingFill(order, quote('2026-09-14T10:00:00.000+03', 300), FRI_1815 + PENDING_MAX_AGE_MS + 1).reason).toBe('expired');
    expect(decidePendingFill({ symbol: 'X' }, quote('2026-09-14T10:00:00.000+03', 300), MON_1130).reason).toBe('invalid');
  });
});
