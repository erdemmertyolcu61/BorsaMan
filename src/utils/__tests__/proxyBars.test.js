import { describe, it, expect } from 'vitest';
import { mergeDailyBars, barsFromYahoo, BAR_FIELDS } from '../../../proxy/api/proxy.js';

// Real THYAO rows (Is Yatirim HisseTekil, 09-11.09.2026). HGDG_AOF is the day's weighted average.
const isy = [
  { HGDG_TARIH: '09-09-2026', HGDG_KAPANIS: 301, HGDG_AOF: 303.864, HGDG_MIN: 300.75, HGDG_MAX: 306.75, HGDG_HACIM: 9030000000 },
  { HGDG_TARIH: '10-09-2026', HGDG_KAPANIS: 299.25, HGDG_AOF: 299.45, HGDG_MIN: 297, HGDG_MAX: 304, HGDG_HACIM: 8977500000 },
  { HGDG_TARIH: '11-09-2026', HGDG_KAPANIS: 300.25, HGDG_AOF: 300.517, HGDG_MIN: 298.25, HGDG_MAX: 302.75, HGDG_HACIM: 10874157352 },
];
// Yahoo daily timestamps sit at the BIST session start (~06:55 UTC).
const ts = (y, m, d) => Date.UTC(y, m - 1, d, 6, 55) / 1000;
const yahoo = (days) => ({
  timestamp: days.map(x => ts(...x.day)),
  indicators: { quote: [{ open: days.map(x => x.o), close: days.map(x => x.c), high: days.map(x => x.h ?? x.c), low: days.map(x => x.l ?? x.c), volume: days.map(() => 1000) }] },
});
const col = (name) => BAR_FIELDS.indexOf(name);

describe('proxy bars: Is Yatirim days + Yahoo opens (v31.40)', () => {
  it('uses the real Yahoo open where the day exists, AOF where Yahoo skipped the day', () => {
    const y = yahoo([
      { day: [2026, 9, 9], o: 305, c: 301 },
      // 10.09 missing on Yahoo — Is Yatirim still provides the day.
      { day: [2026, 9, 11], o: 299.25, c: 300.25 },
    ]);
    const { rows, openReal, openApprox } = mergeDailyBars(isy, y);
    expect(rows.map(r => r[col('d')])).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);
    expect(rows.map(r => r[col('o')])).toEqual([305, 299.45, 299.25]);
    expect(rows.map(r => r[col('of')])).toEqual(['y', 'a', 'y']);
    expect(openReal).toBe(2);
    expect(openApprox).toBe(1);
  });

  it('keeps closes, the weighted average and volume in lots from Is Yatirim', () => {
    const [row] = mergeDailyBars(isy.slice(2), null).rows;
    expect(row[col('c')]).toBe(300.25);
    expect(row[col('vwap')]).toBe(300.517);
    expect(row[col('v')]).toBe(Math.round(10874157352 / 300.25));
  });

  it('refuses an open from a differently adjusted series (closes disagree by more than 1%)', () => {
    const y = yahoo([{ day: [2026, 9, 11], o: 150.1, c: 150.12 }]);   // e.g. before a split adjustment
    expect(mergeDailyBars(isy.slice(2), y).rows[0][col('of')]).toBe('a');
  });

  it('refuses an open outside the day\'s own range', () => {
    const y = yahoo([{ day: [2026, 9, 11], o: 320, c: 300.25 }]);
    expect(mergeDailyBars(isy.slice(2), y).rows[0][col('of')]).toBe('a');
  });

  it('falls back to Yahoo-only rows when Is Yatirim is down', () => {
    const rows = barsFromYahoo(yahoo([{ day: [2026, 9, 11], o: 299.25, c: 300.25, h: 302.75, l: 298.25 }]));
    expect(rows).toEqual([['2026-09-11', 299.25, 302.75, 298.25, 300.25, 1000, null, 'y']]);
  });
});
