import { describe, it, expect, beforeEach } from 'vitest';
import { getForeignFlowStatus, computeForeignFlowScore } from '../foreignFlowEngine.js';

describe('v29.4 computeForeignFlowScore (shared advisor/analyze scoring)', () => {
  it('strong weekly inflow → GUCLU GIRIS + positive confDelta', () => {
    const r = computeForeignFlowScore({ ratio: 30, changeWeek: 2.5, changeMonth: 3.5, changeDay: 0.6 });
    expect(r.score).toBeGreaterThanOrEqual(6);
    expect(r.label).toBe('GUCLU GIRIS');
    expect(r.confDelta).toBeGreaterThan(0);
  });

  it('strong weekly outflow → GUCLU CIKIS + negative confDelta', () => {
    const r = computeForeignFlowScore({ ratio: 55, changeWeek: -2.5, changeMonth: -3.5, changeDay: -0.6 });
    expect(r.score).toBeLessThanOrEqual(-6);
    expect(r.label).toBe('GUCLU CIKIS');
    expect(r.confDelta).toBeLessThan(0);
  });

  it('flat flow → NOTR, zero delta', () => {
    const r = computeForeignFlowScore({ ratio: 30, changeWeek: 0, changeMonth: 0, changeDay: 0 });
    expect(r.label).toBe('NOTR');
    expect(r.confDelta).toBe(0);
  });

  it('clamps score to [-15, +15]', () => {
    const hi = computeForeignFlowScore({ ratio: 10, changeWeek: 9, changeMonth: 9, changeDay: 9 });
    expect(hi.score).toBeLessThanOrEqual(15);
    const lo = computeForeignFlowScore({ ratio: 90, changeWeek: -9, changeMonth: -9, changeDay: -9 });
    expect(lo.score).toBeGreaterThanOrEqual(-15);
  });

  it('high ratio + exit is penalized; low ratio + entry is rewarded', () => {
    const highRatioExit = computeForeignFlowScore({ ratio: 60, changeWeek: -1.2 });
    const lowRatioEntry = computeForeignFlowScore({ ratio: 15, changeWeek: 1.2 });
    expect(lowRatioEntry.score).toBeGreaterThan(highRatioExit.score);
  });

  it('is defensive against null', () => {
    const r = computeForeignFlowScore(null);
    expect(r).toEqual({ score: 0, label: 'NOTR', confDelta: 0 });
  });
});

const CACHE_KEY = 'bist_foreign_flow_cache';
const BREAKER_KEY = 'bist_foreign_flow_breaker';

describe('v29 Foreign Flow circuit breaker — getForeignFlowStatus', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(BREAKER_KEY);
  });

  it('reports unknown when there is no cache and no breaker', () => {
    const s = getForeignFlowStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toBe('unknown');
  });

  it('reports no_source while the breaker is open', () => {
    const until = Date.now() + 1000 * 60 * 60; // 1h in the future
    localStorage.setItem(BREAKER_KEY, JSON.stringify({ failures: 1, until }));
    const s = getForeignFlowStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toBe('no_source');
    expect(s.retryAt).toBe(until);
  });

  it('reports unknown (retryable) once the breaker window has expired', () => {
    localStorage.setItem(BREAKER_KEY, JSON.stringify({ failures: 3, until: Date.now() - 1000 }));
    const s = getForeignFlowStatus();
    expect(s.reason).toBe('unknown'); // expired → will retry on next fetch
  });

  it('reports available when the cache holds ratios (overrides an open breaker)', () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      data: { ratios: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`SYM${i}`, { ratio: 30 }])) },
    }));
    localStorage.setItem(BREAKER_KEY, JSON.stringify({ failures: 1, until: Date.now() + 100000 }));
    const s = getForeignFlowStatus();
    expect(s.available).toBe(true);
    expect(s.reason).toBe('ok');
  });
});
