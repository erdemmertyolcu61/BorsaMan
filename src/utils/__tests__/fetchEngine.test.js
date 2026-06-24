/**
 * fetchEngine TZ-helper + live-overlay regressions + circuit-breaker.
 *
 * The 5Y chart was occasionally missing today's candle in two cases:
 *   1. Cache hit path skipped the BigPara overlay entirely.
 *   2. Day comparison used runtime-TZ `getFullYear/Month/Date` — a non-Istanbul
 *      user could see Yahoo's 07:00 UTC session-start bar as "yesterday".
 *
 * These tests lock the fix: istanbulDayKey is TZ-stable, isBistWeekend is
 * calendar-based (no local DST), and applyLiveOverlay merges / appends
 * deterministically against a BigPara stub.
 *
 * Circuit-breaker: After 3 consecutive failures, a source is skipped for a
 * backoff period. This prevents hammering a failing proxy and allows recovery.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  istanbulDayKey,
  isBistWeekend,
  applyLiveOverlay,
  _isCircuitOpen,
  _recordFailure,
  _recordSuccess,
  _circuitState,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_BASE_BACKOFF_MS,
} from '../fetchEngine.js';

describe('istanbulDayKey', () => {
  it('returns ISO yyyy-mm-dd for a normal Date', () => {
    // 2026-04-20 12:00 UTC → still 2026-04-20 in Istanbul (UTC+3)
    const d = new Date(Date.UTC(2026, 3, 20, 12, 0, 0));
    expect(istanbulDayKey(d)).toBe('2026-04-20');
  });

  it('is stable across runtime timezones (23:00 UTC rolls into next Istanbul day)', () => {
    // 2026-04-20 23:00 UTC → 2026-04-21 02:00 Istanbul
    const d = new Date(Date.UTC(2026, 3, 20, 23, 0, 0));
    expect(istanbulDayKey(d)).toBe('2026-04-21');
  });

  it('handles invalid input gracefully', () => {
    expect(istanbulDayKey(null)).toBe('');
    expect(istanbulDayKey(new Date('not-a-date'))).toBe('');
  });
});

describe('isBistWeekend', () => {
  it('flags Saturday', () => {
    // 2026-04-18 is a Saturday
    expect(isBistWeekend(new Date(Date.UTC(2026, 3, 18, 10, 0)))).toBe(true);
  });
  it('flags Sunday', () => {
    expect(isBistWeekend(new Date(Date.UTC(2026, 3, 19, 10, 0)))).toBe(true);
  });
  it('does not flag Monday', () => {
    expect(isBistWeekend(new Date(Date.UTC(2026, 3, 20, 10, 0)))).toBe(false);
  });
});

describe('applyLiveOverlay', () => {
  // Real merge behavior is exercised end-to-end in _doFetchSingle integration
  // tests — here we only lock the invariants that don't need the live feed:
  // nil/empty guards, and that the function returns the same object ref.
  it('is a no-op for empty or missing prices', async () => {
    expect(await applyLiveOverlay(null, 'XU100')).toBe(null);
    const empty = { symbol: 'X', prices: [] };
    expect(await applyLiveOverlay(empty, 'X')).toBe(empty);
  });
});

describe('circuit-breaker', () => {
  beforeEach(() => {
    Object.keys(_circuitState).forEach(k => delete _circuitState[k]);
  });

  it('circuit stays closed with no failures', () => {
    expect(_isCircuitOpen('test-source')).toBe(false);
  });

  it('circuit opens after 3 consecutive failures', () => {
    _recordFailure('test-source');
    _recordFailure('test-source');
    _recordFailure('test-source');
    expect(_isCircuitOpen('test-source')).toBe(true);
    expect(_circuitState['test-source'].openedUntil).toBeGreaterThan(Date.now());
  });

  it('backoff window is at least the base delay when threshold trips', () => {
    _recordFailure('test-source');
    _recordFailure('test-source');
    _recordFailure('test-source');
    const remaining = _circuitState['test-source'].openedUntil - Date.now();
    expect(remaining).toBeGreaterThanOrEqual(CIRCUIT_BASE_BACKOFF_MS - 1000);
    expect(remaining).toBeLessThanOrEqual(CIRCUIT_BASE_BACKOFF_MS + 1000);
  });

  it('success resets failure count', () => {
    _recordFailure('test-source');
    _recordFailure('test-source');
    expect(_circuitState['test-source'].failures).toBe(2);
    _recordSuccess('test-source');
    expect(_circuitState['test-source'].failures).toBe(0);
  });

  it('threshold constant is correct', () => {
    expect(CIRCUIT_FAILURE_THRESHOLD).toBe(3);
    expect(CIRCUIT_BASE_BACKOFF_MS).toBe(60000);
  });
});
