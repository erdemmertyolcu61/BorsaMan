/**
 * Tarama karnesi (v31.47).
 *
 * The user scans in the morning and wants to see, after the close, how much each
 * recommended stock moved that day — and the same for every past scan. These
 * tests lock the three things that make that number honest:
 *   - a pick is judged by the session that follows it (an evening scan is a
 *     prediction for the NEXT session, not a second entry for today),
 *   - the first time a stock was recommended wins (the 18:15 scan used to
 *     overwrite the morning list in the forward journal),
 *   - the official daily bar replaces live / closing-list values when it arrives.
 */
import { describe, it, expect } from 'vitest';
import {
  judgingSessionDay, pickTiming, isSessionOver, recordScan, seedFromHistory,
  resultFromBars, resultFromQuote, settleWithBars, settleWithQuotes, summarizeDay,
  daysNeedingBars, daysNeedingQuotes, symbolsToSettle, featuredDay, selectScorecardPicks,
  MAX_PICKS_PER_DAY,
} from '../scanScorecard.js';

const at = (iso) => Date.parse(iso);
// 2026-09-14 is a Monday. TRT = UTC+3.
const MON_0930 = at('2026-09-14T06:30:00Z');  // before the open
const MON_1000 = at('2026-09-14T07:00:00Z');  // in session
const MON_1400 = at('2026-09-14T11:00:00Z');
const MON_1815 = at('2026-09-14T15:15:00Z');  // after the close
const MON_1840 = at('2026-09-14T15:40:00Z');  // close settled
const FRI_1900 = at('2026-09-18T16:00:00Z');
const SAT_1200 = at('2026-09-19T09:00:00Z');

const bar = (key, o, h, l, c) => ({ date: `${key}T00:00:00.000Z`, open: o, high: h, low: l, close: c, volume: 1 });
const pick = (symbol, price, extra = {}) => ({ symbol, price, cls: 'buy', score: 70, stop: price * 0.95, target: price * 1.08, ...extra });
const scan = (picks, extra = {}) => ({ topPicks: picks, results: picks, ...extra });

describe('judgingSessionDay', () => {
  it('a pre-open or in-session pick is judged by that day\'s close', () => {
    expect(judgingSessionDay(MON_0930)).toBe('2026-09-14');
    expect(judgingSessionDay(MON_1400)).toBe('2026-09-14');
  });

  it('an evening or weekend pick is judged by the next session', () => {
    expect(judgingSessionDay(MON_1815)).toBe('2026-09-15');
    expect(judgingSessionDay(FRI_1900)).toBe('2026-09-21');
    expect(judgingSessionDay(SAT_1200)).toBe('2026-09-21');
  });

  it('tells session picks from pre-session picks', () => {
    expect(pickTiming(MON_1000)).toBe('session');
    expect(pickTiming(MON_0930)).toBe('before');
    expect(pickTiming(MON_1815)).toBe('before');
  });

  it('knows when the judging session is over', () => {
    expect(isSessionOver('2026-09-14', MON_1400)).toBe(false);
    expect(isSessionOver('2026-09-14', MON_1815)).toBe(true);
    expect(isSessionOver('2026-09-15', MON_1815)).toBe(false);
  });
});

describe('recordScan', () => {
  it('keeps the FIRST sighting of a stock — a later scan does not move its price', () => {
    let days = recordScan([], scan([pick('THYAO', 300, { _scanTs: MON_1000 })]), MON_1000);
    days = recordScan(days, scan([pick('THYAO', 306, { _scanTs: MON_1400 }), pick('ASELS', 120, { _scanTs: MON_1400 })]), MON_1400);
    expect(days).toHaveLength(1);
    const d = days[0];
    expect(d.day).toBe('2026-09-14');
    expect(d.scans).toBe(2);
    const thy = d.picks.find(p => p.symbol === 'THYAO');
    expect(thy.refPrice).toBe(300);
    expect(thy.seen).toBe(2);
    expect(thy.when).toBe('session');
    expect(d.picks.map(p => p.symbol)).toEqual(['THYAO', 'ASELS']);
  });

  it('files the evening scan under tomorrow instead of overwriting the morning', () => {
    let days = recordScan([], scan([pick('THYAO', 300)]), MON_1000);
    days = recordScan(days, scan([pick('KCHOL', 200)]), MON_1815);
    expect(days.map(d => d.day)).toEqual(['2026-09-15', '2026-09-14']);
    expect(days.find(d => d.day === '2026-09-14').picks.map(p => p.symbol)).toEqual(['THYAO']);
  });

  it('ignores sell picks and picks without a price', () => {
    const days = recordScan([], scan([pick('A', 10), { symbol: 'B', price: 5, cls: 'sell' }, { symbol: 'C', cls: 'buy' }]), MON_1000);
    expect(days[0].picks.map(p => p.symbol)).toEqual(['A']);
  });

  it('caps the picks collected in one day', () => {
    // The panel shows at most 10 per scan; the cap applies across the day's scans.
    const batch = (from) => Array.from({ length: 10 }, (_, i) => pick(`S${from + i}X`, 10 + i));
    let days = recordScan([], scan(batch(0)), MON_1000);
    days = recordScan(days, scan(batch(10)), MON_1400);
    expect(days[0].picks).toHaveLength(MAX_PICKS_PER_DAY);
    expect(days[0].picks[0].symbol).toBe('S0X');
  });

  it('records what the panel shows (deriveDisplayPicks), not the raw list', () => {
    // RSI 95 is unsafe for the panel — unless it is the guaranteed daily pick.
    const shown = selectScorecardPicks(scan([pick('OK', 10), pick('HOT', 10, { rsi: 95 }), pick('BEST', 10, { rsi: 95, _bestOfDay: true })]));
    expect(shown.map(p => p.symbol).sort()).toEqual(['BEST', 'OK']);
  });
});

describe('resultFromBars', () => {
  const bars = [
    bar('2026-09-11', 98, 101, 97, 100),
    bar('2026-09-14', 100, 106, 99, 104),
    bar('2026-09-15', 104, 108, 103, 107),
    bar('2026-09-16', 107, 109, 105, 106),
  ];

  it('measures the close against the price the pick was made at', () => {
    const r = resultFromBars({ refPrice: 102, target: 105, stop: 96 }, '2026-09-14', bars);
    expect(r.src).toBe('bar');
    expect(r.close).toBe(104);
    expect(r.pct).toBeCloseTo(1.96, 2);          // 102 → 104
    expect(r.dayPct).toBeCloseTo(4, 2);          // 100 → 104, the stock's own day
    expect(r.highPct).toBeCloseTo(3.92, 2);
    expect(r.hitTarget).toBe(true);
    expect(r.hitStop).toBe(false);
    expect(r.follow.map(f => f.d)).toEqual(['2026-09-15', '2026-09-16']);
    expect(r.follow[0].pct).toBeCloseTo(4.9, 1);
    expect(r.complete).toBe(false);
  });

  it('returns null when the judging day has no bar yet', () => {
    expect(resultFromBars({ refPrice: 100 }, '2026-09-17', bars)).toBeNull();
  });
});

describe('resultFromQuote', () => {
  const q = { price: 103, prevClose: 100, change: 3, high: 104, low: 99, sessionDate: '2026-09-14T14:00:00.000+03' };

  it('is live during the session and a closing value after 18:10', () => {
    expect(resultFromQuote({ refPrice: 100 }, '2026-09-14', q, MON_1400).src).toBe('live');
    const closed = resultFromQuote({ refPrice: 100 }, '2026-09-14', q, MON_1815);
    expect(closed.src).toBe('quote_close');
    expect(closed.pct).toBe(3);
    expect(closed.dayPct).toBe(3);
  });

  it('refuses a quote that belongs to another session (pre-open list shows yesterday)', () => {
    const stale = { ...q, sessionDate: '2026-09-11T18:09:00.000+03' };
    expect(resultFromQuote({ refPrice: 100 }, '2026-09-14', stale, MON_0930)).toBeNull();
  });
});

describe('settlement', () => {
  const bars = {
    THYAO: [bar('2026-09-11', 98, 101, 97, 100), bar('2026-09-14', 100, 106, 99, 104)],
    ASELS: [bar('2026-09-11', 50, 51, 49, 50), bar('2026-09-14', 50, 50.5, 47, 48)],
  };
  const xu = [bar('2026-09-11', 1, 1, 1, 10000), bar('2026-09-14', 1, 1, 1, 10100)];

  it('live quotes during the day, then official bars after 18:30', () => {
    let days = recordScan([], scan([pick('THYAO', 100), pick('ASELS', 50)]), MON_1000);
    expect(daysNeedingQuotes(days, MON_1400)).toHaveLength(1);
    expect(daysNeedingBars(days, MON_1400)).toHaveLength(0);   // close not final yet

    let r = settleWithQuotes(days, { THYAO: { price: 102, prevClose: 100, sessionDate: '2026-09-14T14:00:00+03' } }, MON_1400);
    expect(r.changed).toBe(true);
    days = r.days;
    expect(summarizeDay(days[0]).status).toBe('live');

    expect(symbolsToSettle(days, MON_1840)).toEqual(['THYAO', 'ASELS']);
    r = settleWithBars(days, bars, xu, MON_1840);
    days = r.days;
    const s = summarizeDay(days[0]);
    expect(s.status).toBe('final');
    expect(s.up).toBe(1);
    expect(s.down).toBe(1);
    expect(s.avgPct).toBeCloseTo((4 + -4) / 2, 2);
    expect(s.benchPct).toBeCloseTo(1, 2);
    expect(s.vsBench).toBeCloseTo(-1, 2);
    expect(s.best.symbol).toBe('THYAO');
    // a bar result is never replaced by a later quote
    r = settleWithQuotes(days, { THYAO: { price: 90, sessionDate: '2026-09-14T18:09:00+03' } }, MON_1840);
    expect(r.days[0].picks[0].result.src).toBe('bar');
  });

  it('counts a try when a bar is missing so a holiday cannot loop forever', () => {
    const days = recordScan([], scan([pick('THYAO', 100)]), MON_1000);
    const noBar = { THYAO: [bar('2026-09-11', 1, 1, 1, 100)] };
    // Same evening: the source may publish the bar late — not a failed try yet.
    expect(settleWithBars(days, noBar, null, MON_1840).changed).toBe(false);
    const r = settleWithBars(days, noBar, null, at('2026-09-15T07:00:00Z'));
    expect(r.days[0].settleTries).toBe(1);
    expect(r.days[0].picks[0].result).toBeNull();
  });
});

describe('seedFromHistory', () => {
  it('rebuilds past days from the signal history and the forward journal', () => {
    const signals = [
      { source: 'advisor', cls: 'buy', symbol: 'THYAO', price: 100, timestamp: new Date(MON_1400).toISOString(), score100: 72 },
      { source: 'advisor', cls: 'buy', symbol: 'THYAO', price: 99, timestamp: new Date(MON_1000).toISOString() },
      { source: 'manual', cls: 'buy', symbol: 'XXX', price: 5, timestamp: new Date(MON_1000).toISOString() },
      { source: 'advisor', cls: 'sell', symbol: 'YYY', price: 5, timestamp: new Date(MON_1000).toISOString() },
    ];
    const journal = [{ date: '2026-09-14', timestamp: MON_1815, predictions: [{ symbol: 'KCHOL', entryPrice: 200, score: 66 }] }];
    const days = seedFromHistory([], { signals, journal }, MON_1840);
    const mon = days.find(d => d.day === '2026-09-14');
    expect(mon.picks).toHaveLength(1);
    expect(mon.picks[0].refPrice).toBe(99);            // the earlier sighting
    expect(mon.picks[0].seeded).toBe('signals');
    expect(days.find(d => d.day === '2026-09-15').picks[0].symbol).toBe('KCHOL');
    // idempotent
    expect(seedFromHistory(days, { signals, journal }, MON_1840)).toBe(days);
  });

  it('does not reach past the seed window', () => {
    const old = [{ source: 'advisor', cls: 'buy', symbol: 'OLD', price: 1, timestamp: '2026-01-05T08:00:00Z' }];
    expect(seedFromHistory([], { signals: old }, MON_1840)).toEqual([]);
  });
});

describe('featuredDay', () => {
  it('prefers today, else the latest day that already happened', () => {
    let days = recordScan([], scan([pick('A', 10)]), MON_1000);
    days = recordScan(days, scan([pick('B', 10)]), MON_1815);   // → Tuesday
    expect(featuredDay(days, MON_1840).day).toBe('2026-09-14');
    expect(featuredDay(days, at('2026-09-15T08:00:00Z')).day).toBe('2026-09-15');
  });
});
