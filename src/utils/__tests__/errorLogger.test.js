/**
 * errorLogger.js — dedupe + surface tests.
 *
 * The logger is the backbone of our "no silent failures" policy. If dedupe
 * breaks, AlertLog will spam. If surface breaks, users trade on bad data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logError, safeAsync, safeSync } from '../errorLogger.js';

describe('logError', () => {
  let warnSpy, errorSpy, dispatchSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    dispatchSpy.mockRestore();
  });

  it('emits console.warn for warn severity and dispatches a bist-alert', () => {
    logError('fetch', 'unique-msg-' + Math.random(), new Error('boom'), { severity: 'warn' });
    expect(warnSpy).toHaveBeenCalled();
    const events = dispatchSpy.mock.calls.map(c => c[0]).filter(e => e.type === 'bist-alert');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].detail.severity).toBe('warn');
    expect(events[0].detail.source).toBe('errorLogger');
  });

  it('emits console.error for error severity and surfaces as error', () => {
    logError('ai', 'err-unique-' + Math.random(), 'oops', { severity: 'error' });
    expect(errorSpy).toHaveBeenCalled();
    const events = dispatchSpy.mock.calls.map(c => c[0]).filter(e => e.type === 'bist-alert');
    expect(events[0].detail.severity).toBe('error');
  });

  it('deduplicates identical messages within the dedupe window', () => {
    const unique = 'dedupe-msg-' + Math.random();
    logError('parse', unique, null, { severity: 'warn' });
    logError('parse', unique, null, { severity: 'warn' });
    logError('parse', unique, null, { severity: 'warn' });
    const events = dispatchSpy.mock.calls.map(c => c[0]).filter(e => e.type === 'bist-alert');
    expect(events.length).toBe(1);
  });

  it('silent=true suppresses surfacing even on first occurrence', () => {
    logError('persist', 'silent-' + Math.random(), null, { severity: 'warn', silent: true });
    const events = dispatchSpy.mock.calls.map(c => c[0]).filter(e => e.type === 'bist-alert');
    expect(events.length).toBe(0);
  });

  it('debug severity never dispatches', () => {
    logError('news', 'dbg-' + Math.random(), null, { severity: 'debug' });
    const events = dispatchSpy.mock.calls.map(c => c[0]).filter(e => e.type === 'bist-alert');
    expect(events.length).toBe(0);
  });
});

describe('safeAsync / safeSync', () => {
  it('safeAsync returns fallback on throw', async () => {
    const r = await safeAsync('fetch', 'saf-' + Math.random(), async () => {
      throw new Error('x');
    }, { fallback: 'FB', severity: 'debug' });
    expect(r).toBe('FB');
  });
  it('safeAsync returns fn result on success', async () => {
    const r = await safeAsync('fetch', 'ok-' + Math.random(), async () => 42);
    expect(r).toBe(42);
  });
  it('safeSync catches and returns fallback', () => {
    const r = safeSync('parse', 'syn-' + Math.random(), () => { throw new Error('y'); },
      { fallback: 'SYN', severity: 'debug' });
    expect(r).toBe('SYN');
  });
});
