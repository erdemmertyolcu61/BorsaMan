import { describe, it, expect, beforeEach } from 'vitest';
import { TRACKING_KEYS, clearTrackingLocalStorage } from '../resetStorage.js';
import { EOD_SCAN_DAY_KEY } from '../scanSchedule.js';

describe('resetStorage — scheduler stamps must be cleared', () => {
  // The drift this guards against actually happened: bist_last_eod_scan_day was
  // introduced in v31.25 while TRACKING_KEYS dated from v31.24, so after a reset
  // the app believed today's end-of-day close was already recorded and skipped it.
  // These import the REAL constants, so a renamed or new stamp fails the test
  // instead of silently escaping the reset.
  it('clears the end-of-day scan stamp', () => {
    expect(TRACKING_KEYS).toContain(EOD_SCAN_DAY_KEY);
  });

  it('clears the once-per-day scan stamp', () => {
    expect(TRACKING_KEYS).toContain('bist_last_scan_day');
  });

  it('has no duplicate keys', () => {
    expect(new Set(TRACKING_KEYS).size).toBe(TRACKING_KEYS.length);
  });

  it('every tracked key is namespaced', () => {
    expect(TRACKING_KEYS.every(k => k.startsWith('bist_'))).toBe(true);
  });
});

describe('resetStorage.clearTrackingLocalStorage', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });

  it('removes tracking keys and reports what it actually cleared', () => {
    localStorage.setItem('bist_signal_history_v2', '[]');
    localStorage.setItem(EOD_SCAN_DAY_KEY, '2026-09-05');
    const res = clearTrackingLocalStorage();
    expect(localStorage.getItem('bist_signal_history_v2')).toBeNull();
    expect(localStorage.getItem(EOD_SCAN_DAY_KEY)).toBeNull();
    // Only keys that were actually present get reported — no phantom counts.
    expect(res.cleared).toContain(EOD_SCAN_DAY_KEY);
    expect(res.cleared).not.toContain('bist_jarvis_memory');
  });

  it('preserves settings and real data — these are never tracking', () => {
    const keep = {
      bist_real_portfolio: '{"positions":[]}',
      bist_watchlist: '["THYAO"]',
      bist_evds_api_key: 'secret',
      bist_broker_config: '{}',
      bist_proxy_url: 'https://example.invalid',
      bist_notification_settings: '{}',
    };
    for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
    localStorage.setItem('bist_signal_history_v2', '[]');

    clearTrackingLocalStorage();

    for (const [k, v] of Object.entries(keep)) {
      expect(localStorage.getItem(k), `${k} korunmali`).toBe(v);
    }
    expect(localStorage.getItem('bist_signal_history_v2')).toBeNull();
  });

  it('is idempotent — running it twice is harmless', () => {
    localStorage.setItem('bist_signal_history_v2', '[]');
    clearTrackingLocalStorage();
    const second = clearTrackingLocalStorage();
    expect(second.cleared).toHaveLength(0);
  });
});
