import { describe, it, expect } from 'vitest';
import {
  KAP_STATUS, isKapAvailable, kapUnavailableNote,
  kapUnavailableDisclosures, kapUnavailableInsider,
} from '../kapAvailability.js';

describe('kapAvailability', () => {
  it('records KAP as unavailable with the date and evidence that says why', () => {
    // The point of this module is that a dead layer stays VISIBLE. If someone
    // flips this to true without new measurements, these assertions are the
    // reminder that evidence is required.
    expect(isKapAvailable()).toBe(false);
    expect(KAP_STATUS.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(KAP_STATUS.reason.length).toBeGreaterThan(20);
    expect(KAP_STATUS.routes.length).toBeGreaterThanOrEqual(3);
    expect(KAP_STATUS.routes.every(r => typeof r.url === 'string' && r.status > 0)).toBe(true);
  });

  it('is frozen so a caller cannot silently flip availability at runtime', () => {
    expect(Object.isFrozen(KAP_STATUS)).toBe(true);
    expect(() => { 'use strict'; KAP_STATUS.available = true; }).toThrow();
    expect(isKapAvailable()).toBe(false);
  });

  it('gives a one-line note that names the measurement date', () => {
    const note = kapUnavailableNote();
    expect(note).toContain(KAP_STATUS.measuredAt);
    expect(note.toLowerCase()).toContain('kap');
  });

  it('disclosures placeholder stays array-shaped so existing callers do not break', () => {
    const d = kapUnavailableDisclosures();
    expect(Array.isArray(d)).toBe(true);
    expect(d).toHaveLength(0);
    expect(() => d.map(x => x)).not.toThrow();
    // ...but it is distinguishable from a genuine "no disclosures" answer.
    expect(d.unavailable).toBe(true);
    expect(d.reason).toBe(KAP_STATUS.reason);
  });

  it('insider placeholder matches the engine result shape and contributes nothing', () => {
    const r = kapUnavailableInsider();
    // Same keys the enrichment step reads, so no undefined leaks into scoring.
    for (const k of ['transactions', 'score', 'hasRecentInsiderBuy',
                     'hasRecentInsiderSell', 'insiderNetBuys']) {
      expect(r).toHaveProperty(k);
    }
    expect(r.score).toBe(0);                 // no phantom score contribution
    expect(r.hasRecentInsiderBuy).toBe(false);
    expect(r.hasRecentInsiderSell).toBe(false);
    expect(r.transactions).toEqual([]);
    expect(r.unavailable).toBe(true);
  });

  it('"unavailable" is never confused with "measured as negative"', () => {
    // A -1 insider score means measured selling. Unavailable must be 0 + flagged,
    // so the UI can say "no data" instead of implying a bearish reading.
    const r = kapUnavailableInsider();
    expect(r.score).toBe(0);
    expect(r.unavailable).toBe(true);
  });
});
