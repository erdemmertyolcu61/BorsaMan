import { describe, it, expect } from 'vitest';
import { mergeDailyBars, BAR_FIELDS } from '../../../proxy/api/proxy.js';
import { parseBarsPayload } from '../fetchEngine.js';
import { istanbulDayKey } from '../signalPerfHistory.js';

// 12 consecutive weekdays of Is Yatirim rows; Yahoo skips the 5th one.
const days = [];
for (let d = new Date(Date.UTC(2026, 7, 26)); days.length < 12; d = new Date(d.getTime() + 86400000)) {
  const dow = d.getUTCDay();
  if (dow !== 0 && dow !== 6) days.push(d);
}
const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
const isy = days.map((d, i) => ({
  HGDG_TARIH: ddmmyyyy(d), HGDG_KAPANIS: 100 + i, HGDG_AOF: 99.6 + i, HGDG_MIN: 98 + i, HGDG_MAX: 102 + i, HGDG_HACIM: (100 + i) * 5000,
}));
const yahooDays = days.filter((_, i) => i !== 4);
const yahoo = {
  timestamp: yahooDays.map(d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 55) / 1000),
  indicators: { quote: [{
    open: yahooDays.map(d => 99 + days.indexOf(d)),
    close: yahooDays.map(d => 100 + days.indexOf(d)),
    high: [], low: [], volume: [],
  }] },
};

describe('bars payload round trip: proxy merge → client parse (v31.40)', () => {
  const { rows, openReal, openApprox } = mergeDailyBars(isy, yahoo);
  const payload = JSON.parse(JSON.stringify({ ok: true, fields: BAR_FIELDS, rows, openReal, openApprox }));
  const bars = parseBarsPayload(payload);

  it('keeps every Is Yatirim day on the right Istanbul date', () => {
    expect(bars).toHaveLength(12);
    expect(bars.map(b => istanbulDayKey(b.date))).toEqual(days.map(d => d.toISOString().slice(0, 10)));
  });

  it('real opens where Yahoo had the day, flagged approximation where it did not', () => {
    expect(bars[0].open).toBe(99);
    expect(bars[0]._openApprox).toBeUndefined();
    expect(bars[4].open).toBeCloseTo(103.6, 6);          // AOF of the skipped day
    expect(bars[4]._openApprox).toBe(true);
    expect(bars.filter(b => b._openApprox)).toHaveLength(1);
  });

  it('carries the weighted average price and lots', () => {
    expect(bars[0].vwap).toBe(99.6);
    expect(bars[0].volume).toBe(5000);
  });

  it('rejects payloads that are not a bars response or too short', () => {
    expect(parseBarsPayload({ ok: false })).toBeNull();
    expect(parseBarsPayload({ ok: true, fields: BAR_FIELDS, rows: rows.slice(0, 5) })).toBeNull();
    expect(parseBarsPayload({ error: 'Invalid source parameter' })).toBeNull();
  });
});

// v31.44: İş Yatırım's HisseTekil does not guarantee row order. Measured on the
// live route (2026-09-21, THYAO): days=1850 returned 165 out-of-order pairs with
// 2026-04-22 as the last row, days=60 returned 19 — while days=370 and 1825 were
// clean, so it is intermittent and invisible until an indicator reads it. The
// analyse screen showed MA-20 204.13 under a 285.50 price and a -11.75% day that
// never happened. Both layers sort now: the proxy at the source, the client
// because caches can still hold an unsorted response.
describe('bar ordering', () => {
  const shuffled = [isy[7], isy[2], isy[11], isy[0], isy[5], isy[9], isy[1], isy[3], isy[10], isy[4], isy[8], isy[6]];

  it('mergeDailyBars returns chronological rows whatever order the upstream used', () => {
    const merged = mergeDailyBars(shuffled, yahoo);
    const dates = merged.rows.map(r => r[0]);
    expect(dates).toEqual([...dates].sort());
    expect(merged.rows).toHaveLength(12);
    expect(merged.rows[11][4]).toBe(111);          // newest close is last
    expect(merged.rows[0][4]).toBe(100);
  });

  it('parseBarsPayload sorts a payload an older proxy left unsorted', () => {
    const rows = mergeDailyBars(isy, yahoo).rows;
    const outOfOrder = [rows[6], rows[0], rows[11], rows[3], rows[9], rows[1], rows[7], rows[2], rows[10], rows[4], rows[8], rows[5]];
    const bars = parseBarsPayload({ ok: true, fields: BAR_FIELDS, rows: outOfOrder });
    expect(bars).toHaveLength(12);
    for (let i = 1; i < bars.length; i++) expect(bars[i].date.getTime()).toBeGreaterThan(bars[i - 1].date.getTime());
    expect(bars[bars.length - 1].close).toBe(111);
  });
});
