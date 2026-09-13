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
