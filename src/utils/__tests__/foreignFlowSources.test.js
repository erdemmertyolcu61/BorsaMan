import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseIsyForeignPayload,
  parseEvdsWeeklyFlow, EVDS_FOREIGN_EQUITY_SERIES, ISY_FOREIGN_FIELDS, evdsErrorMessage,
} from '../foreignFlowEngine.js';
import proxyHandler from '../../../proxy/api/proxy.js';

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


// ── v31.48: EVDS key travels in a header; errors name the key, not the source ──
describe('EVDS key handling (v31.48)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // Measured against evds3 on 2026-11-08: no key header → 403, a wrong key → 401.
  it('maps 401 to "invalid key" and 403 to "key did not arrive"', () => {
    expect(evdsErrorMessage(401)).toMatch(/geçersiz/);
    expect(evdsErrorMessage(403)).toMatch(/ulaşmadı/);
    expect(evdsErrorMessage(200)).toBeNull();
    expect(evdsErrorMessage(500)).toBeNull();
  });

  it("the proxy forwards the X-Evds-Key header as TCMB's key header and never caches the reply", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', upstream);
    const res = {
      headers: {}, code: 0, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
      send(b) { this.body = b; return this; },
      end() { return this; },
    };
    await proxyHandler({
      method: 'GET',
      headers: { 'x-evds-key': 'test-key-123' },
      query: { source: 'tcmb_evds', series: 'TP.MKNETHAR.M7', startdate: '01-09-2026', enddate: '08-11-2026' },
    }, res);
    expect(res.code).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toContain('evds3.tcmb.gov.tr');
    expect(String(url)).not.toContain('test-key-123');
    expect(init.headers.key).toBe('test-key-123');
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.headers['Access-Control-Allow-Headers']).toMatch(/X-Evds-Key/);
  });
});
