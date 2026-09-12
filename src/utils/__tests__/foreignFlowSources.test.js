import { describe, it, expect } from 'vitest';
import {
  parseIsyForeignPayload, summarizeForeignBreadth, topRelativeMomentum,
  parseEvdsWeeklyFlow, EVDS_FOREIGN_EQUITY_SERIES, ISY_FOREIGN_FIELDS,
} from '../foreignFlowEngine.js';

// Rows as measured live 2026-09-12 (İş Yatırım screener, criteria 40/44/45/8/22/23).
const RAW_ROWS = [
  { '8': '414345', '22': '-1.75', '23': '-5.15', '40': '23.68', '44': '3.06', '45': '0.7', Hisse: 'THYAO - Türk Hava Yolları' },
  { '8': '1795500', '22': '-1.77', '23': '0.8', '40': '55.7', '44': '0.92', '45': '1.98', Hisse: 'ASELS - Aselsan                       ' },
  { '8': '48444', '22': '2.43', '23': '-23.52', '40': '28.36', '44': '-10.25', '45': '-3.27', Hisse: 'EUPWR - Europower Enerji' },
];

describe('parseIsyForeignPayload', () => {
  it('parses the raw İş response (JSON string inside "d")', () => {
    const map = parseIsyForeignPayload({ d: JSON.stringify(RAW_ROWS) });
    expect(Object.keys(map)).toEqual(['THYAO', 'ASELS', 'EUPWR']);
    expect(map.THYAO).toMatchObject({ ratio: 23.68, changeWeek: 3.06, changeMonth: 0.7, mcapMnTL: 414345, rel1w: -1.75, rel1m: -5.15 });
  });

  it('parses the proxy compact form to the same map', () => {
    const rows = RAW_ROWS.map(r => [r.Hisse.split(' - ')[0].trim(), +r['40'], +r['44'], +r['45'], +r['8'], +r['22'], +r['23']]);
    const compact = parseIsyForeignPayload({ fields: ISY_FOREIGN_FIELDS, rows });
    expect(compact).toEqual(parseIsyForeignPayload({ d: JSON.stringify(RAW_ROWS) }));
  });

  it('leaves the daily change null — this source has none, and 0 would be a claim', () => {
    const map = parseIsyForeignPayload(RAW_ROWS);
    expect(map.ASELS.changeDay).toBeNull();
  });

  it('drops rows without a ticker or without any foreign data', () => {
    const map = parseIsyForeignPayload([{ Hisse: '— bozuk', '40': '1' }, { Hisse: 'AAAA - X' }, ...RAW_ROWS]);
    expect(map.AAAA).toBeUndefined();
    expect(Object.keys(map)).toHaveLength(3);
  });

  it('is defensive against garbage', () => {
    expect(parseIsyForeignPayload(null)).toEqual({});
    expect(parseIsyForeignPayload({ d: '{not json' })).toEqual({});
  });
});

describe('summarizeForeignBreadth', () => {
  const map = parseIsyForeignPayload(RAW_ROWS);

  it('counts rises vs falls and weights the average by market cap', () => {
    const b = summarizeForeignBreadth(map);
    expect(b).toMatchObject({ n: 3, up: 2, down: 1, flat: 0, medianChg1w: 0.92 });
    // (414345*3.06 + 1795500*0.92 + 48444*-10.25) / 2258289 = 1.0730 → 1.07
    expect(b.capWeightedChg1w).toBe(1.07);
    expect(b.topIn.map(r => r.symbol)).toEqual(['THYAO', 'ASELS']);
    expect(b.topOut.map(r => r.symbol)).toEqual(['EUPWR']);
  });

  it('applies a market-cap floor to the mover lists only', () => {
    const b = summarizeForeignBreadth(map, { minMcapMnTL: 100000 });
    expect(b.n).toBe(3);
    expect(b.topOut).toEqual([]);
  });

  it('returns an empty summary without data', () => {
    expect(summarizeForeignBreadth({})).toMatchObject({ n: 0, medianChg1w: null, capWeightedChg1w: null });
  });
});

describe('topRelativeMomentum', () => {
  it('ranks by relative return above the market-cap floor', () => {
    const map = parseIsyForeignPayload(RAW_ROWS);
    expect(topRelativeMomentum(map, { minMcapMnTL: 0 }).map(r => r.symbol)).toEqual(['EUPWR', 'THYAO', 'ASELS']);
    expect(topRelativeMomentum(map, { minMcapMnTL: 100000 }).map(r => r.symbol)).toEqual(['THYAO', 'ASELS']);
    expect(topRelativeMomentum(map, { key: 'rel1m', minMcapMnTL: 0, topN: 1 })[0].symbol).toBe('ASELS');
  });
});

describe('parseEvdsWeeklyFlow (TP.MKNETHAR.M7)', () => {
  it('reads the series under its underscore field name', () => {
    expect(EVDS_FOREIGN_EQUITY_SERIES).toBe('TP.MKNETHAR.M7');
    const r = parseEvdsWeeklyFlow({ items: [
      { Tarih: '14-08-2026', TP_MKNETHAR_M7: '120.5' },
      { Tarih: '21-08-2026', TP_MKNETHAR_M7: null },
      { Tarih: '28-08-2026', TP_MKNETHAR_M7: '329.1' },
      { Tarih: '04-09-2026', TP_MKNETHAR_M7: '-647.6' },
    ] });
    expect(r.flows).toHaveLength(3);
    expect(r).toMatchObject({ latestWeeklyFlow: -647.6, latestDate: '04-09-2026', fourWeekFlow: -198 });
  });

  it('returns null when EVDS sends nothing usable', () => {
    expect(parseEvdsWeeklyFlow({ items: [] })).toBeNull();
    expect(parseEvdsWeeklyFlow(null)).toBeNull();
  });
});
