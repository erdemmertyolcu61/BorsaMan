import { describe, it, expect } from 'vitest';
import { createPhaseTracker, formatPhaseSummary, SLOW_PHASE_MS } from '../scanPhases.js';

// Injectable clock so timings are exact, not wall-clock flaky.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('scanPhases.createPhaseTracker', () => {
  it('attributes elapsed time to the phase that was open', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    tr.mark('tarama'); c.advance(1000);
    tr.mark('haber'); c.advance(3000);
    const s = tr.finish();
    expect(s.totalMs).toBe(4000);
    expect(s.phases).toEqual([
      { name: 'haber', ms: 3000, pct: 75 },
      { name: 'tarama', ms: 1000, pct: 25 },
    ]);
  });

  it('sorts slowest first — the point is finding where the time went', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    tr.mark('a'); c.advance(100);
    tr.mark('b'); c.advance(9000);
    tr.mark('c'); c.advance(500);
    const s = tr.finish();
    expect(s.phases.map(p => p.name)).toEqual(['b', 'c', 'a']);
  });

  it('merges repeated phase names instead of listing them twice', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    tr.mark('deneme'); c.advance(1000);
    tr.mark('ara'); c.advance(200);
    tr.mark('deneme'); c.advance(2000);
    const s = tr.finish();
    expect(s.phases.find(p => p.name === 'deneme').ms).toBe(3000);
    expect(s.phases.filter(p => p.name === 'deneme')).toHaveLength(1);
  });

  it('flags phases at or over the slow threshold', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    tr.mark('hizli'); c.advance(SLOW_PHASE_MS - 1);
    tr.mark('yavas'); c.advance(SLOW_PHASE_MS);
    const s = tr.finish();
    expect(s.slow.map(p => p.name)).toEqual(['yavas']);
  });

  it('exposes the current phase so the UI can show it', () => {
    const tr = createPhaseTracker(fakeClock().now);
    expect(tr.current).toBeNull();
    tr.mark('zenginlestirme');
    expect(tr.current).toBe('zenginlestirme');
    tr.mark(null);
    expect(tr.current).toBeNull();
  });

  it('is defensive: finishing without any phase yields an empty report', () => {
    const s = createPhaseTracker(fakeClock().now).finish();
    expect(s.phases).toEqual([]);
    expect(s.slow).toEqual([]);
    expect(s.totalMs).toBe(0);
  });
});

describe('scanPhases.formatPhaseSummary', () => {
  it('renders the slowest phases with readable units', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    tr.mark('tarama'); c.advance(92_000);
    tr.mark('claude'); c.advance(25_000);
    tr.mark('kayit'); c.advance(300);
    const out = formatPhaseSummary(tr.finish());
    expect(out).toContain('Tarama 117.3s');
    expect(out).toContain('tarama 92.0s');
    expect(out).toContain('claude 25.0s');
    expect(out).toContain('kayit 300ms');
  });

  it('caps how many phases it lists', () => {
    const c = fakeClock();
    const tr = createPhaseTracker(c.now);
    for (const n of ['a', 'b', 'c', 'd', 'e']) { tr.mark(n); c.advance(1000); }
    const out = formatPhaseSummary(tr.finish(), 2);
    expect(out.split('·')).toHaveLength(2);
  });

  it('is defensive against an empty or missing summary', () => {
    expect(formatPhaseSummary(null)).toBe('');
    expect(formatPhaseSummary({ totalMs: 0, phases: [] })).toBe('');
  });
});
