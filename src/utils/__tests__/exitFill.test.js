import { describe, it, expect } from 'vitest';
import { resolveExitPrice, WATCHING_WINDOW_MS } from '../exitFill.js';

const FRESH = 30_000;              // 30s — the monitor's own tick
const BACKGROUNDED = 6 * 3600_000; // 6h — phone in a pocket

describe('exitFill.resolveExitPrice — while the app is watching', () => {
  it('fills at the live price when the last check was recent', () => {
    const r = resolveExitPrice({ level: 202.5, livePrice: 202.3, msSinceCheck: FRESH, kind: 'stop' });
    expect(r).toEqual({ price: 202.3, basis: 'live', stale: false });
  });

  it('treats the window edge as still watching', () => {
    const r = resolveExitPrice({ level: 202.5, livePrice: 190, msSinceCheck: WATCHING_WINDOW_MS, kind: 'stop' });
    expect(r.basis).toBe('live');
  });
});

describe('exitFill.resolveExitPrice — after a background gap', () => {
  it('falls back to the STOP level instead of the crashed price', () => {
    // The measured mobile case: entry 214, stop 202.5, price drifted to 190
    // while the WebView was frozen. Recording -11.2% claims a fill we never saw.
    const r = resolveExitPrice({ level: 202.5, livePrice: 190, msSinceCheck: BACKGROUNDED, kind: 'stop' });
    expect(r).toEqual({ price: 202.5, basis: 'level', stale: true });
  });

  it('falls back to the TARGET level instead of the spike price', () => {
    // Symmetric, and it costs us: without this the engine books a gain it could
    // not have taken. The rule is not tilted in the trader's favour.
    const r = resolveExitPrice({ level: 228, livePrice: 245, msSinceCheck: BACKGROUNDED, kind: 'target' });
    expect(r).toEqual({ price: 228, basis: 'level', stale: true });
  });

  it('keeps the live price when the level was not actually crossed', () => {
    // Closing for some other reason (e.g. time exit) - forcing the level here
    // would invent a worse or better price than reality.
    const r = resolveExitPrice({ level: 202.5, livePrice: 210, msSinceCheck: BACKGROUNDED, kind: 'stop' });
    expect(r).toEqual({ price: 210, basis: 'live', stale: false });
  });

  it('inverts the crossing test for short positions', () => {
    // Sell: the stop sits ABOVE entry, so "crossed" means live >= level.
    const hit = resolveExitPrice({ level: 105, livePrice: 118, msSinceCheck: BACKGROUNDED, kind: 'stop', isBuy: false });
    expect(hit).toEqual({ price: 105, basis: 'level', stale: true });
    const notHit = resolveExitPrice({ level: 105, livePrice: 99, msSinceCheck: BACKGROUNDED, kind: 'stop', isBuy: false });
    expect(notHit.basis).toBe('live');
  });

  it('treats a missing timestamp as "we were not watching"', () => {
    // First run after a cold start has no previous check — assuming we were
    // watching would be the optimistic reading, so we do not.
    const r = resolveExitPrice({ level: 202.5, livePrice: 190, msSinceCheck: undefined, kind: 'stop' });
    expect(r.stale).toBe(true);
    expect(r.price).toBe(202.5);
  });
});

describe('exitFill.resolveExitPrice — defensive', () => {
  it('uses the level when the live price is unusable', () => {
    for (const bad of [0, -5, NaN, null, undefined]) {
      expect(resolveExitPrice({ level: 202.5, livePrice: bad, msSinceCheck: FRESH, kind: 'stop' }).price)
        .toBe(202.5);
    }
  });

  it('uses the live price when the level is unusable', () => {
    const r = resolveExitPrice({ level: null, livePrice: 190, msSinceCheck: BACKGROUNDED, kind: 'stop' });
    expect(r).toEqual({ price: 190, basis: 'live', stale: false });
  });

  it('refuses to invent a price when BOTH inputs are unusable', () => {
    // A NaN price would silently poison P&L, so the answer is "unknown" and the
    // caller must not close the position on it.
    const r = resolveExitPrice({ level: NaN, livePrice: NaN, msSinceCheck: 0, kind: 'stop' });
    expect(r).toEqual({ price: null, basis: 'none', stale: true });
  });
});

describe('exitFill — the correction is symmetric, not favourable', () => {
  it('reduces a recorded loss AND reduces a recorded gain', () => {
    const entry = 214;
    const stop = resolveExitPrice({ level: 202.5, livePrice: 190, msSinceCheck: BACKGROUNDED, kind: 'stop' });
    const target = resolveExitPrice({ level: 228, livePrice: 245, msSinceCheck: BACKGROUNDED, kind: 'target' });
    const pct = (p) => ((p - entry) / entry) * 100;
    // loss improves from -11.2% to -5.4%
    expect(pct(stop.price)).toBeGreaterThan(pct(190));
    // gain shrinks from +14.5% to +6.5%
    expect(pct(target.price)).toBeLessThan(pct(245));
  });
});
