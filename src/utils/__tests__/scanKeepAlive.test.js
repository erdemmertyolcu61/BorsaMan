/**
 * "Hisseler taranırken ekran kapanınca gitmesin" (v31.48).
 * A locked phone freezes the page: the scan's wall-clock budget kept running and
 * cut the scan on return, and symbols in flight during the freeze were counted
 * as failures (read by the throttle as rate-limiting).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createVisibilityClock, createScanWakeLock, markScanRunning, clearScanRunning,
  readUnfinishedScan, RESUME_MAX_AGE_MS, SCAN_MARKER_KEY,
} from '../scanKeepAlive.js';

function fakeDoc(state = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: state,
    addEventListener: (t, fn) => { if (t === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (t, fn) => { listeners.delete(fn); },
    set(s) { this.visibilityState = s; for (const fn of [...listeners]) fn(); },
  };
}

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

describe('createVisibilityClock', () => {
  it('does not count hidden time against the scan budget', () => {
    let t = 0;
    const doc = fakeDoc();
    const clock = createVisibilityClock(doc, () => t);
    t = 60_000;
    doc.set('hidden');           // screen locked
    t = 60_000 + 25 * 60_000;    // 25 minutes later
    expect(clock.activeElapsed(0)).toBe(60_000);
    doc.set('visible');
    t += 30_000;
    expect(clock.activeElapsed(0)).toBe(90_000);
    expect(clock.pausedMs()).toBe(25 * 60_000);
  });

  it('bumps the epoch on each hide so in-flight failures can be re-queued', () => {
    const doc = fakeDoc();
    const clock = createVisibilityClock(doc, () => 0);
    const before = clock.epoch;
    doc.set('hidden');
    doc.set('hidden');          // repeated event, same hide
    doc.set('visible');
    expect(clock.epoch).toBe(before + 1);
  });

  it('waitVisible resolves immediately when visible, otherwise on return', async () => {
    const doc = fakeDoc('hidden');
    const clock = createVisibilityClock(doc, () => 0);
    let done = false;
    const p = clock.waitVisible().then(v => { done = v; });
    await Promise.resolve();
    expect(done).toBe(false);
    doc.set('visible');
    await p;
    expect(done).toBe(true);
    expect(await clock.waitVisible()).toBe(false);
  });
});

describe('createScanWakeLock', () => {
  it('keeps the screen on during a scan and re-acquires after the page returns', async () => {
    const doc = fakeDoc();
    const releases = [];
    const request = vi.fn(async () => {
      const handlers = {};
      const s = {
        addEventListener: (t, fn) => { handlers[t] = fn; },
        release: async () => { handlers.release?.(); },
      };
      releases.push(() => handlers.release?.());
      return s;
    });
    const lock = createScanWakeLock({ wakeLock: { request } }, doc);
    expect(await lock.start()).toBe('active');
    // the OS drops the lock when the page hides
    doc.set('hidden');
    releases[0]();
    expect(lock.status).toBe('paused');
    doc.set('visible');
    await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.status).toBe('active');
    await lock.stop();
    expect(lock.status).toBe('off');
  });

  it('reports unsupported browsers instead of failing', async () => {
    const lock = createScanWakeLock({}, fakeDoc());
    expect(await lock.start()).toBe('unsupported');
    await lock.stop();
  });

  it('reports a refused lock', async () => {
    const lock = createScanWakeLock({ wakeLock: { request: async () => { throw new Error('NotAllowed'); } } }, fakeDoc());
    expect(await lock.start()).toBe('denied');
  });
});

describe('unfinished scan marker', () => {
  it('survives a killed page and is picked up on the next start', () => {
    const st = memStorage();
    markScanRunning({ total: 623, done: 0 }, st, 1000);
    markScanRunning({ done: 312 }, st, 61_000);
    const m = readUnfinishedScan(st, 120_000);
    expect(m).toMatchObject({ total: 623, done: 312, startedAt: 1000, updatedAt: 61_000 });
    clearScanRunning(st);
    expect(readUnfinishedScan(st, 120_000)).toBeNull();
  });

  it('ignores and clears a marker that is too old to resume', () => {
    const st = memStorage();
    markScanRunning({ total: 623, done: 10 }, st, 0);
    expect(readUnfinishedScan(st, RESUME_MAX_AGE_MS + 1)).toBeNull();
    expect(st.getItem(SCAN_MARKER_KEY)).toBeNull();
  });
});
