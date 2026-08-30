import { describe, it, expect } from 'vitest';
import { evaluateOutcomeFromBars, isClosingOutcome, SOFT_WIN_PCT } from '../signalOutcome.js';

const bar = (day, close, high, low) => ({
  date: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`,
  close, high: high ?? close, low: low ?? close,
});

const buy = {
  entryPrice: 100, target: 107.5, stop: 95, cls: 'buy',
  timestamp: '2026-08-04T09:00:00Z',
};

describe('evaluateOutcomeFromBars (v31.26)', () => {
  it('closes the BAHKM case: target cleared while the app was shut', () => {
    // Real shape from the user's screenshot: entry 127.90, target 137.49,
    // price ran to +24.5% — yet the signal still showed as open.
    const sig = { entryPrice: 127.90, target: 137.49, stop: 120, cls: 'buy', timestamp: '2026-08-04T09:00:00Z' };
    const out = evaluateOutcomeFromBars(sig, [
      bar(4, 128.5, 129), bar(5, 144.3, 145.1), bar(6, 159.2, 160),
    ]);
    expect(out.outcome).toBe('TARGET_HIT');
    expect(out.date).toBe('2026-08-05');   // the day it actually happened
    expect(out.price).toBe(137.49);
  });

  it('uses intraday high/low, not just the close', () => {
    // Touched the target intraday and closed back below: the order would fill.
    const out = evaluateOutcomeFromBars(buy, [bar(4, 101), bar(5, 103, 108, 100)]);
    expect(out.outcome).toBe('TARGET_HIT');
  });

  it('detects a stop-out', () => {
    const out = evaluateOutcomeFromBars(buy, [bar(4, 99), bar(5, 96, 99, 94)]);
    expect(out.outcome).toBe('STOP_HIT');
    expect(out.price).toBe(95);
  });

  it('assumes STOP first when one bar spans both levels', () => {
    // A daily bar cannot say which came first; claiming the win would be
    // asserting something we cannot prove.
    const out = evaluateOutcomeFromBars(buy, [bar(4, 102, 110, 90)]);
    expect(out.outcome).toBe('STOP_HIT');
  });

  it('takes the FIRST hit chronologically, not the biggest', () => {
    const out = evaluateOutcomeFromBars(buy, [
      bar(4, 96, 97, 94),      // stop first
      bar(5, 120, 130, 118),   // target later — must not win retroactively
    ]);
    expect(out.outcome).toBe('STOP_HIT');
    expect(out.date).toBe('2026-08-04');
  });

  it('ignores bars before the signal was recorded', () => {
    const out = evaluateOutcomeFromBars(buy, [
      bar(1, 90, 90, 88),      // pre-entry crash must not count as a stop
      bar(4, 101), bar(5, 102),
    ]);
    expect(out).toBe(null);
  });

  it('applies the soft thresholds to the last close when no level was touched', () => {
    const noLevels = { entryPrice: 100, cls: 'buy', timestamp: '2026-08-04T09:00:00Z' };
    expect(evaluateOutcomeFromBars(noLevels, [bar(4, 101), bar(5, 106)]).outcome).toBe('WIN');
    expect(evaluateOutcomeFromBars(noLevels, [bar(4, 99), bar(5, 96)]).outcome).toBe('LOSS');
    expect(evaluateOutcomeFromBars(noLevels, [bar(4, 101), bar(5, 102)])).toBe(null);
    expect(SOFT_WIN_PCT).toBe(5);
  });

  it('inverts direction for a sell signal', () => {
    const sell = { entryPrice: 100, target: 92, stop: 105, cls: 'sell', timestamp: '2026-08-04T09:00:00Z' };
    expect(evaluateOutcomeFromBars(sell, [bar(4, 95, 96, 91)]).outcome).toBe('TARGET_HIT');
    expect(evaluateOutcomeFromBars(sell, [bar(4, 103, 106, 102)]).outcome).toBe('STOP_HIT');
    // A sell that fell 6% is a WIN, which the buy-side sign would have called a loss.
    const naked = { entryPrice: 100, cls: 'sell', timestamp: '2026-08-04T09:00:00Z' };
    expect(evaluateOutcomeFromBars(naked, [bar(4, 94)]).outcome).toBe('WIN');
  });

  it('falls back to close when the source gives no high/low', () => {
    const out = evaluateOutcomeFromBars(buy, [{ date: '2026-08-05T00:00:00Z', close: 108 }]);
    expect(out.outcome).toBe('TARGET_HIT');
  });

  it('is defensive about bad input', () => {
    expect(evaluateOutcomeFromBars(null, [bar(4, 100)])).toBe(null);
    expect(evaluateOutcomeFromBars(buy, null)).toBe(null);
    expect(evaluateOutcomeFromBars(buy, [])).toBe(null);
    expect(evaluateOutcomeFromBars({ ...buy, entryPrice: 0, price: 0 }, [bar(4, 100)])).toBe(null);
    expect(evaluateOutcomeFromBars(buy, [{ date: 'bad', close: 200 }])).toBe(null);
  });
});

describe('isClosingOutcome', () => {
  it('recognises every terminal outcome', () => {
    for (const o of ['TARGET_HIT', 'STOP_HIT', 'WIN', 'LOSS']) {
      expect(isClosingOutcome(o)).toBe(true);
    }
    expect(isClosingOutcome('OPEN')).toBe(false);
    expect(isClosingOutcome(null)).toBe(false);
  });
});
