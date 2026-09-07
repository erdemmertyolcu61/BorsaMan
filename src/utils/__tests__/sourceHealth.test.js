import { describe, it, expect } from 'vitest';
import { createSourceHealth, formatSilentWarning, SILENT_AFTER } from '../sourceHealth.js';

describe('sourceHealth.createSourceHealth', () => {
  it('stays quiet while a source is producing data', () => {
    const h = createSourceHealth();
    for (let i = 0; i < 10; i++) {
      const r = h.record('rss-haber', 25);
      expect(r.silent).toBe(false);
      expect(r.shouldWarn).toBe(false);
    }
    expect(h.silentSources()).toEqual([]);
  });

  it('flags a source only after the streak threshold, not on the first empty', () => {
    // A single empty scan is normal (a quiet news day). A run of them is not.
    const h = createSourceHealth();
    for (let i = 1; i < SILENT_AFTER; i++) {
      expect(h.record('rss-haber', 0).silent).toBe(false);
    }
    const r = h.record('rss-haber', 0);
    expect(r.silent).toBe(true);
    expect(r.streak).toBe(SILENT_AFTER);
  });

  it('warns EXACTLY once — visibility without per-scan noise', () => {
    const h = createSourceHealth({ silentAfter: 2 });
    h.record('kap-insider', 0);
    const first = h.record('kap-insider', 0);
    expect(first.shouldWarn).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(h.record('kap-insider', 0).shouldWarn).toBe(false);
      expect(h.record('kap-insider', 0).silent).toBe(true);
    }
  });

  it('re-arms the warning when a dead source comes back to life', () => {
    // This is the RSS case: it was dead for months, then a fix revived it. If it
    // dies again the operator has to be told again.
    const h = createSourceHealth({ silentAfter: 2 });
    h.record('rss-haber', 0);
    expect(h.record('rss-haber', 0).shouldWarn).toBe(true);

    expect(h.record('rss-haber', 80).silent).toBe(false);   // revived
    expect(h.silentSources()).toEqual([]);

    h.record('rss-haber', 0);
    expect(h.record('rss-haber', 0).shouldWarn).toBe(true); // warns again
  });

  it('tracks sources independently', () => {
    const h = createSourceHealth({ silentAfter: 2 });
    h.record('rss-haber', 25); h.record('rss-haber', 25);
    h.record('kap-insider', 0); h.record('kap-insider', 0);
    expect(h.silentSources()).toEqual(['kap-insider']);
  });

  it('treats a missing/invalid count as empty rather than assuming data', () => {
    const h = createSourceHealth({ silentAfter: 1 });
    expect(h.record('x', undefined).silent).toBe(true);
    h.reset();
    expect(h.record('y', NaN).silent).toBe(true);
    h.reset();
    expect(h.record('z', -5).silent).toBe(true);
  });

  it('snapshot reports counts for diagnostics', () => {
    const h = createSourceHealth({ silentAfter: 2 });
    h.record('a', 5); h.record('a', 0);
    h.record('b', 0); h.record('b', 0);
    const snap = h.snapshot().sort((x, y) => x.name < y.name ? -1 : 1);
    expect(snap).toEqual([
      { name: 'a', empty: 1, total: 2, lastItems: 0, silent: false },
      { name: 'b', empty: 2, total: 2, lastItems: 0, silent: true },
    ]);
  });
});

describe('sourceHealth.formatSilentWarning', () => {
  it('says the layer contributes nothing, and that empty is not bearish', () => {
    const msg = formatSilentWarning('kap-insider', 4);
    expect(msg).toContain('kap-insider');
    expect(msg).toContain('4');
    // The distinction that all three dead layers blurred.
    expect(msg.toLowerCase()).toContain('katki');
  });
});
