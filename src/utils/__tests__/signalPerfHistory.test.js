import { describe, it, expect } from 'vitest';
import { appendDailyPerf, summarizeDailyPerf } from '../signalPerfHistory.js';

describe('appendDailyPerf', () => {
  it('appends a new day point', () => {
    const out = appendDailyPerf([], '2026-08-01', 2.345);
    expect(out).toEqual([{ d: '2026-08-01', pct: 2.35 }]); // rounded to 2dp
  });

  it('replaces (not duplicates) the same-day point on intraday ticks', () => {
    let s = appendDailyPerf([], '2026-08-01', 1.0);
    s = appendDailyPerf(s, '2026-08-01', 1.8);
    s = appendDailyPerf(s, '2026-08-01', 2.4);
    expect(s).toEqual([{ d: '2026-08-01', pct: 2.4 }]); // one point, latest value
  });

  it('appends across days building the day-by-day series', () => {
    let s = appendDailyPerf([], '2026-08-01', 2);
    s = appendDailyPerf(s, '2026-08-02', -1);
    s = appendDailyPerf(s, '2026-08-03', 0.5);
    expect(s.map(p => p.pct)).toEqual([2, -1, 0.5]);
  });

  it('caps the series at maxDays (drops oldest)', () => {
    let s = [];
    for (let i = 1; i <= 35; i++) s = appendDailyPerf(s, `2026-09-${String(i).padStart(2, '0')}`, i, 30);
    expect(s).toHaveLength(30);
    expect(s[0].d).toBe('2026-09-06'); // oldest 5 dropped
  });

  it('ignores null/NaN/absent pct or dayKey and never mutates input', () => {
    const orig = [{ d: '2026-08-01', pct: 1 }];
    expect(appendDailyPerf(orig, '2026-08-02', null).map(p => p.pct)).toEqual([1]);  // no point added
    expect(appendDailyPerf(orig, '2026-08-02', NaN).map(p => p.pct)).toEqual([1]);
    expect(appendDailyPerf(orig, '', 5).map(p => p.pct)).toEqual([1]);
    expect(orig).toEqual([{ d: '2026-08-01', pct: 1 }]); // unchanged
  });
});

describe('summarizeDailyPerf', () => {
  it('returns an empty summary for no data', () => {
    expect(summarizeDailyPerf([])).toEqual({ days: 0, latest: null, best: null, worst: null, upDays: 0, downDays: 0 });
    expect(summarizeDailyPerf(null).days).toBe(0);
  });

  it('computes best/worst/latest and up/down day counts', () => {
    const s = [{ d: 'a', pct: 2 }, { d: 'b', pct: 3.5 }, { d: 'c', pct: 1 }];
    const sum = summarizeDailyPerf(s);
    expect(sum.days).toBe(3);
    expect(sum.latest).toBe(1);
    expect(sum.best.pct).toBe(3.5);
    expect(sum.worst.pct).toBe(1);
    // day1: 2 vs 0 = up; day2: 3.5 vs 2 = up; day3: 1 vs 3.5 = down
    expect(sum.upDays).toBe(2);
    expect(sum.downDays).toBe(1);
  });
});
