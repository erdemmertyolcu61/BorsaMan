import { describe, it, expect } from 'vitest';
import {
  mergeLiveQuote, resolveLiveSession, latestSessionDayKey, parseSessionDate, dateFromDayKey,
} from '../liveSession.js';
import { istanbulDayKey } from '../signalPerfHistory.js';

// Real THYAO numbers from 2026-09-09..11 (Is Yatirim HisseTekil + TumHisseSenetleri).
const bar = (key, close, extra = {}) => ({
  date: new Date(`${key}T00:00:00Z`), open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000, ...extra,
});
const throughFriday = () => [
  bar('2026-09-09', 301),
  bar('2026-09-10', 299.25),
  // Is Yatirim has no open: the parser puts AOF (the day's weighted average) there.
  bar('2026-09-11', 300.25, { open: 300.517, high: 302.75, low: 298.25 }),
];
const fridayQuote = {
  price: 300.25, open: 299.25, high: 302.75, low: 298.25, volume: 36184804,
  prevClose: 299.25, sessionDate: '2026-09-11T18:09:47.000+03',
};
const at = (iso) => Date.parse(iso);
const SUN_1329 = at('2026-09-13T10:29:00Z');
const MON_0800 = at('2026-09-14T05:00:00Z');
const MON_1130 = at('2026-09-14T08:30:00Z');
const MON_1820 = at('2026-09-14T15:20:00Z');
const TUE_0800 = at('2026-09-15T05:00:00Z');
const lastKey = (prices) => istanbulDayKey(prices[prices.length - 1].date);

describe('mergeLiveQuote — the quote belongs to its SESSION, not to today (v31.40)', () => {
  it('weekend scan: the Friday quote updates the Friday bar instead of adding a "Sunday" copy', () => {
    const prices = throughFriday();
    const r = mergeLiveQuote(prices, fridayQuote, { now: SUN_1329, marketOpen: false });
    expect(r.action).toBe('merge');
    expect(prices).toHaveLength(3);
    expect(lastKey(prices)).toBe('2026-09-11');
    // The old calendar check duplicated the session and "today's change" read 0.00%.
    expect(r.changePct).toBeCloseTo(0.334, 2);
  });

  it('pre-open Monday and the next-morning catch-up scan behave the same way', () => {
    const mon = throughFriday();
    expect(mergeLiveQuote(mon, fridayQuote, { now: MON_0800 }).action).toBe('merge');
    expect(mon).toHaveLength(3);

    const tue = [...throughFriday(), bar('2026-09-14', 303)];
    const monQuote = { price: 303, open: 300.5, high: 304, low: 300, volume: 1, prevClose: 300.25, sessionDate: '2026-09-14T18:09:51.000+03' };
    expect(mergeLiveQuote(tue, monQuote, { now: TUE_0800 }).action).toBe('merge');
    expect(tue).toHaveLength(4);
  });

  it('a limit-up day keeps its real change (BAHKM, Friday +10%)', () => {
    const prices = [bar('2026-09-10', 167), bar('2026-09-11', 183.7)];
    const q = { price: 183.7, open: 167.5, high: 183.7, low: 167.5, volume: 5, prevClose: 167, sessionDate: '2026-09-11T18:09:40.000+03' };
    expect(mergeLiveQuote(prices, q, { now: SUN_1329 }).changePct).toBeCloseTo(10, 5);
  });

  it('replaces the approximate open with the real session open', () => {
    const prices = throughFriday();
    mergeLiveQuote(prices, fridayQuote, { now: SUN_1329 });
    expect(prices[2].open).toBe(299.25);
  });

  it('during the session a newer quote appends a forming bar dated by the session', () => {
    const prices = throughFriday();
    const q = { price: 303, open: 300.5, high: 304, low: 300, volume: 9, prevClose: 300.25, sessionDate: '2026-09-14T11:30:00.000+03' };
    const r = mergeLiveQuote(prices, q, { now: MON_1130, marketOpen: true });
    expect(r.action).toBe('append');
    expect(prices).toHaveLength(4);
    expect(lastKey(prices)).toBe('2026-09-14');
    expect(prices[3]._isForming).toBe(true);
    expect(r.changePct).toBeCloseTo(0.916, 2);
  });

  it('after the close, before the daily bar is published, the bar is appended as completed', () => {
    const prices = throughFriday();
    const q = { price: 303, open: 300.5, high: 304, low: 300, volume: 9, prevClose: 300.25, sessionDate: '2026-09-14T18:09:51.000+03' };
    expect(mergeLiveQuote(prices, q, { now: MON_1820, marketOpen: false }).action).toBe('append');
    expect(prices[3]._isForming).toBeUndefined();
  });

  it('is idempotent: a second call merges into the bar it appended', () => {
    const prices = throughFriday();
    const q = { price: 303, open: 300.5, high: 304, low: 300, volume: 9, prevClose: 300.25, sessionDate: '2026-09-14T11:30:00.000+03' };
    mergeLiveQuote(prices, q, { now: MON_1130, marketOpen: true });
    const again = mergeLiveQuote(prices, { ...q, price: 304 }, { now: MON_1130 + 60000, marketOpen: true });
    expect(again.action).toBe('merge');
    expect(prices).toHaveLength(4);
    expect(prices[3].close).toBe(304);
  });

  it('ignores a quote older than the bars', () => {
    const prices = [...throughFriday(), bar('2026-09-14', 303)];
    const before = JSON.stringify(prices);
    expect(mergeLiveQuote(prices, fridayQuote, { now: TUE_0800 }).action).toBe('ignore');
    expect(JSON.stringify(prices)).toBe(before);
  });

  it('never fabricates a zero-range bar', () => {
    const noOhlc = throughFriday();
    const q = { price: 303, open: 0, high: 0, low: 0, prevClose: 300.25, sessionDate: '2026-09-14T11:30:00.000+03' };
    expect(mergeLiveQuote(noOhlc, q, { now: MON_1130, marketOpen: true }).action).toBe('ignore');
    expect(noOhlc).toHaveLength(3);

    // A dated limit-locked day (O=H=L=C) is real data and is kept.
    const locked = throughFriday();
    const lq = { price: 330.25, open: 330.25, high: 330.25, low: 330.25, volume: 3, prevClose: 300.25, sessionDate: '2026-09-14T18:09:00.000+03' };
    expect(mergeLiveQuote(locked, lq, { now: MON_1820 }).action).toBe('append');
  });
});

describe('resolveLiveSession — sources without a session date', () => {
  it('prevClose equal to the previous bar close → the quote is the last bar\'s session', () => {
    const r = resolveLiveSession(throughFriday(), { price: 300.25, prevClose: 299.25 }, { now: SUN_1329 });
    expect(r).toEqual({ sessionKey: '2026-09-11', basis: 'prev_close' });
  });

  it('prevClose equal to the last close → the next session, if one has started', () => {
    expect(resolveLiveSession(throughFriday(), { price: 303, prevClose: 300.25 }, { now: MON_1820 }))
      .toEqual({ sessionKey: '2026-09-14', basis: 'prev_close' });
    // On Sunday no newer session exists: contradiction → unknown, nothing is added.
    expect(resolveLiveSession(throughFriday(), { price: 303, prevClose: 300.25 }, { now: SUN_1329 }).sessionKey).toBe('');
  });

  it('no date and no prevClose → unknown', () => {
    expect(resolveLiveSession(throughFriday(), { price: 303 }, { now: MON_1130 }).basis).toBe('unknown');
  });
});

describe('date helpers', () => {
  it('parses Is Yatirim "+03" offsets (Safari rejects the short form)', () => {
    const d = parseSessionDate('2026-09-11T18:09:47.000+03');
    expect(d).toBeInstanceOf(Date);
    expect(istanbulDayKey(d)).toBe('2026-09-11');
    expect(istanbulDayKey(parseSessionDate('2026-09-11T23:59:00+0300'))).toBe('2026-09-11');
    expect(parseSessionDate('2026-09-11')).toBeInstanceOf(Date);
    expect(parseSessionDate('garbage')).toBeNull();
    expect(parseSessionDate(null)).toBeNull();
  });

  it('latestSessionDayKey skips weekends and the pre-open hours', () => {
    expect(latestSessionDayKey(at('2026-09-12T09:00:00Z'))).toBe('2026-09-11'); // Saturday
    expect(latestSessionDayKey(MON_0800)).toBe('2026-09-11');
    expect(latestSessionDayKey(at('2026-09-14T07:00:00Z'))).toBe('2026-09-14'); // Mon 10:00
    expect(latestSessionDayKey(at('2026-09-11T20:00:00Z'))).toBe('2026-09-11'); // Fri 23:00
  });

  it('dateFromDayKey maps to the same Istanbul day', () => {
    expect(istanbulDayKey(dateFromDayKey('2026-09-14'))).toBe('2026-09-14');
    expect(dateFromDayKey('14.09.2026')).toBeNull();
  });
});
