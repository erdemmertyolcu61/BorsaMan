import { describe, it, expect, beforeEach } from 'vitest';
import { getForeignFlowStatus } from '../foreignFlowEngine.js';

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
