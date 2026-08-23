import { describe, it, expect } from 'vitest';
import {
  appendDailyPerf, summarizeDailyPerf, backfillDailyPerf, mergeDailyPerf,
  istanbulDayKey, normalizeDailyPerf, lastSettledTradingDay,
  maxDrawdownPct, maxRunupPct, consistencyRatio, pathQuality, scoreSignalPath,
  aggregatePathQuality, derivePerfCheckpoints, selectBackfillTargets,
} from '../signalPerfHistory.js';

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

describe('backfillDailyPerf (v31.21)', () => {
  const bars = [
    { date: '2026-08-03T00:00:00Z', close: 100 },  // before entry
    { date: '2026-08-04T00:00:00Z', close: 102 },  // entry day
    { date: '2026-08-05T00:00:00Z', close: 104 },
    { date: '2026-08-06T00:00:00Z', close: 101 },
  ];
  const sig = { entryPrice: 100, timestamp: '2026-08-04T09:00:00Z', cls: 'buy' };

  it('rebuilds one point per trading day from the entry onward', () => {
    const out = backfillDailyPerf(sig, bars);
    expect(out.map(p => p.d)).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
    expect(out.map(p => p.pct)).toEqual([2, 4, 1]);   // vs entry 100
  });

  it('excludes bars before the signal date', () => {
    expect(backfillDailyPerf(sig, bars).some(p => p.d === '2026-08-03')).toBe(false);
  });

  it('inverts the direction for a sell signal', () => {
    const out = backfillDailyPerf({ ...sig, cls: 'sell' }, bars);
    expect(out.map(p => p.pct)).toEqual([-2, -4, -1]);
  });

  it('is defensive about bad input', () => {
    expect(backfillDailyPerf(null, bars)).toEqual([]);
    expect(backfillDailyPerf(sig, null)).toEqual([]);
    expect(backfillDailyPerf({ entryPrice: 0, timestamp: sig.timestamp }, bars)).toEqual([]);
  });
});

describe('mergeDailyPerf (v31.21)', () => {
  it('fills missing past days from the backfill', () => {
    const live = [{ d: '2026-08-06', pct: 1.5 }];
    const back = [{ d: '2026-08-04', pct: 2 }, { d: '2026-08-05', pct: 4 }, { d: '2026-08-06', pct: 1 }];
    const out = mergeDailyPerf(live, back);
    expect(out.map(p => p.d)).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
    expect(out.at(-1).pct).toBe(1.5);   // today's live value wins over the close
  });

  it('prefers official closes for completed past days', () => {
    const live = [{ d: '2026-08-04', pct: 99 }];   // stale intraday capture
    const back = [{ d: '2026-08-04', pct: 2 }, { d: '2026-08-05', pct: 4 }];
    expect(mergeDailyPerf(live, back).find(p => p.d === '2026-08-04').pct).toBe(2);
  });

  it('returns the existing series when there is nothing to backfill', () => {
    const live = [{ d: '2026-08-06', pct: 1 }];
    expect(mergeDailyPerf(live, [])).toEqual(live);
  });
});

// ══ v31.22 ════════════════════════════════════════════════════════════════

describe('istanbulDayKey (v31.22)', () => {
  it('keeps a normal BIST-hours instant on its own day', () => {
    expect(istanbulDayKey('2026-08-04T07:00:00Z')).toBe('2026-08-04');
  });

  it('files a 01:30 TRT instant under the CORRECT day (old UTC key got this wrong)', () => {
    // 22:30Z on the 3rd is 01:30 TRT on the 4th.
    expect(istanbulDayKey('2026-08-03T22:30:00Z')).toBe('2026-08-04');
  });

  it('maps a UTC-midnight bar date to that same calendar day', () => {
    expect(istanbulDayKey('2026-08-04T00:00:00Z')).toBe('2026-08-04');
  });

  it('is defensive about bad input', () => {
    expect(istanbulDayKey('not-a-date')).toBe('');
    expect(istanbulDayKey(NaN)).toBe('');
  });
});

describe('normalizeDailyPerf (v31.22)', () => {
  it('de-dupes by day key keeping the LAST occurrence', () => {
    const out = normalizeDailyPerf([{ d: 'a', pct: 1 }, { d: 'b', pct: 2 }, { d: 'a', pct: 9 }]);
    expect(out).toEqual([{ d: 'a', pct: 9 }, { d: 'b', pct: 2 }]);
  });

  it('sorts an out-of-order series ascending', () => {
    const out = normalizeDailyPerf([{ d: '2026-08-05', pct: 2 }, { d: '2026-08-04', pct: 1 }]);
    expect(out.map(p => p.d)).toEqual(['2026-08-04', '2026-08-05']);
  });

  it('drops invalid points and caps at maxDays', () => {
    expect(normalizeDailyPerf([{ d: 'a', pct: NaN }, { pct: 1 }, null])).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ d: `2026-09-${String(i + 1).padStart(2, '0')}`, pct: i }));
    expect(normalizeDailyPerf(many, 30)).toHaveLength(30);
    expect(normalizeDailyPerf(null)).toEqual([]);
  });

  it('is idempotent and never mutates its input', () => {
    const orig = [{ d: 'b', pct: 2 }, { d: 'a', pct: 1.234 }];
    const once = normalizeDailyPerf(orig);
    expect(normalizeDailyPerf(once)).toEqual(once);
    expect(orig).toEqual([{ d: 'b', pct: 2 }, { d: 'a', pct: 1.234 }]);
  });
});

describe('lastSettledTradingDay (v31.22)', () => {
  // 2026-08-05 is a Wednesday.
  it('returns the PREVIOUS weekday before the settle hour', () => {
    expect(lastSettledTradingDay(Date.parse('2026-08-05T14:00:00Z'))).toBe('2026-08-04'); // 17:00 TRT
  });

  it('returns TODAY once the close is final', () => {
    expect(lastSettledTradingDay(Date.parse('2026-08-05T16:00:00Z'))).toBe('2026-08-05'); // 19:00 TRT
  });

  it('walks back over the weekend', () => {
    expect(lastSettledTradingDay(Date.parse('2026-08-08T16:00:00Z'))).toBe('2026-08-07'); // Sat -> Fri
    expect(lastSettledTradingDay(Date.parse('2026-08-09T16:00:00Z'))).toBe('2026-08-07'); // Sun -> Fri
    expect(lastSettledTradingDay(Date.parse('2026-08-10T06:00:00Z'))).toBe('2026-08-07'); // Mon 09:00 -> Fri
  });
});

describe('path metrics (v31.22)', () => {
  const mk = (...pcts) => pcts.map((pct, i) => ({ d: `2026-08-${String(i + 1).padStart(2, '0')}`, pct }));

  it('maxDrawdownPct measures peak-to-trough, peak floored at entry', () => {
    expect(maxDrawdownPct(mk(1, 2, 3))).toBe(0);
    expect(maxDrawdownPct(mk(5, 1))).toBe(4);
    expect(maxDrawdownPct(mk(-3, -8))).toBe(8);
    expect(maxDrawdownPct(mk(10, -2, 6))).toBe(12);
    expect(maxDrawdownPct(mk(4))).toBe(0);
    expect(maxDrawdownPct([])).toBe(0);
  });

  it('maxRunupPct floors at 0 for an all-negative series', () => {
    expect(maxRunupPct(mk(-2, -5))).toBe(0);
    expect(maxRunupPct(mk(2, 7, 3))).toBe(7);
  });

  it('consistencyRatio counts directional days only', () => {
    expect(consistencyRatio(mk(1, 2, 3, 4, 5, 6))).toBe(1);
    expect(consistencyRatio(mk(1, 0.5))).toBe(null);          // < 3 directional days
    expect(consistencyRatio(mk(2, 2, 2, 2))).toBe(null);      // flat days excluded
  });

  it('pathQuality reports the stop-then-recover shape', () => {
    const q = pathQuality(mk(-2, -9, -4, 3));
    expect(q.trough).toBe(-9);
    expect(q.troughIdx).toBe(1);
    expect(q.latest).toBe(3);
    expect(q.endedPositive).toBe(true);
    expect(q.postTroughGain).toBe(12);
  });

  it('scoreSignalPath ranks a steady climb ABOVE a crash-and-recover with the same endpoint', () => {
    const steady = mk(0.6, 1.2, 1.8, 2.4, 3);
    const volatile = mk(-4, -12, -6, -1, 3);
    const a = scoreSignalPath(steady);
    const b = scoreSignalPath(volatile);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBeGreaterThan(b);
  });

  it('scoreSignalPath refuses a thin series and stays inside [-1,1]', () => {
    expect(scoreSignalPath(mk(1, 2, 3, 4))).toBe(null);       // 4 points < MIN_PATH_DAYS
    expect(scoreSignalPath(mk(80, 80, 80, 80, 80))).toBeLessThanOrEqual(1);
    expect(scoreSignalPath(mk(-80, -80, -80, -80, -80))).toBeGreaterThanOrEqual(-1);
  });

  it('aggregatePathQuality ignores thin series and measures stop recovery', () => {
    const mkSig = (pcts, outcome) => ({ dailyPerf: mk(...pcts), outcome });
    const agg = aggregatePathQuality([
      mkSig([1, 2, 3], null),                     // too thin to score
      mkSig([1, 2, 3, 4, 5], null),
      mkSig([-5, -8, -2, 1, 4], 'STOP_HIT'),      // recovered above entry
      mkSig([-5, -8, -9, -7, -6], 'STOP_HIT'),
      mkSig([-2, -4, -6, -8, -9], 'STOP_HIT'),
    ]);
    expect(agg.n).toBe(4);                        // the 3-point series is excluded
    expect(agg.stopQuality.stopped).toBe(3);
    expect(agg.stopQuality.recovered).toBe(1);
    expect(agg.stopQuality.ratio).toBeCloseTo(1 / 3);
    expect(aggregatePathQuality([]).n).toBe(0);
    expect(aggregatePathQuality([]).avgPathScore).toBe(null);
  });
});

describe('derivePerfCheckpoints (v31.22)', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ d: `d${i}`, pct: i }));

  it('indexes by TRADING day with series[0] as the entry day', () => {
    expect(derivePerfCheckpoints(mk(9))).toEqual({ d1: 1, d3: 3, d5: 5, d7: 7 });
  });

  it('returns null for checkpoints the series does not reach', () => {
    expect(derivePerfCheckpoints(mk(4))).toEqual({ d1: 1, d3: 3, d5: null, d7: null });
    expect(derivePerfCheckpoints([])).toEqual({ d1: null, d3: null, d5: null, d7: null });
  });
});

describe('selectBackfillTargets (v31.22)', () => {
  const NOW = Date.parse('2026-08-05T16:00:00Z');   // Wed 19:00 TRT -> settled = 2026-08-05
  const ago = (days) => new Date(NOW - days * 86400000).toISOString();
  const sig = (o) => ({ symbol: 'AAA', entryPrice: 10, timestamp: ago(5), status: 'active', ...o });

  it('includes a CLOSED signal still inside the 30-day window', () => {
    const { targets } = selectBackfillTargets([sig({ id: 1, status: 'closed', timestamp: ago(12) })], NOW);
    expect(targets.map(t => t.id)).toEqual([1]);
  });

  it('excludes a signal past the tracking window', () => {
    expect(selectBackfillTargets([sig({ id: 1, timestamp: ago(40) })], NOW).targets).toEqual([]);
  });

  it('excludes an already-settled signal and one at the try cap', () => {
    expect(selectBackfillTargets([sig({ id: 1, dailyPerfSettledThrough: '2026-08-05' })], NOW).targets).toEqual([]);
    expect(selectBackfillTargets([sig({ id: 2, dailyPerfTries: 3 })], NOW).targets).toEqual([]);
  });

  it('collapses several signals on one symbol into a SINGLE fetch', () => {
    const out = selectBackfillTargets([sig({ id: 1 }), sig({ id: 2 }), sig({ id: 3 })], NOW);
    expect(out.symbols).toEqual(['AAA']);
    expect(out.targets).toHaveLength(3);
  });

  it('applies the limit to SYMBOLS, and orders active before closed', () => {
    const many = ['A', 'B', 'C', 'D'].map((sym, i) => sig({ id: i, symbol: sym }));
    expect(selectBackfillTargets(many, NOW, { limit: 2 }).symbols).toHaveLength(2);

    const mixed = [sig({ id: 1, symbol: 'ZZZ', status: 'closed' }), sig({ id: 2, symbol: 'YYY', status: 'active' })];
    expect(selectBackfillTargets(mixed, NOW).targets[0].id).toBe(2);
  });

  it('rejects signals with no usable entry price', () => {
    expect(selectBackfillTargets([sig({ id: 1, entryPrice: 0, price: 0 })], NOW).targets).toEqual([]);
    expect(selectBackfillTargets(null, NOW).targets).toEqual([]);
  });
});
