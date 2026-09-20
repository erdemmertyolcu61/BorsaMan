import { describe, it, expect, vi, beforeEach } from 'vitest';

// PROXY_BASE_URL is a live binding in fetchEngine; a getter lets each test pick
// the environment (deployed proxy vs. local Vite dev server).
let proxyBase = 'https://proxy.example';
vi.mock('../fetchEngine.js', () => ({ get PROXY_BASE_URL() { return proxyBase; } }));

const {
  parseIsyValuationPayload, fetchValuationRatios, fetchSymbolValuation,
  clearValuationCache, ISY_VALUATION_BODY,
} = await import('../valuationRatios.js');

// The proxy's compact shape (api/proxy.js handleIsyValuation), with the real
// numbers measured on 2026-09-20.
const COMPACT = {
  ok: true, source: 'isyatirim', fetchedAt: 1,
  fields: ['symbol', 'pe', 'pb', 'mcapMnTL'],
  rows: [['THYAO', 2.96, 0.39, 393990], ['GARAN', 4.52, 1.12, 545580], ['EREGL', 32.67, 0.8, 254940]],
};

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe('parseIsyValuationPayload', () => {
  it('reads the proxy compact form', () => {
    const map = parseIsyValuationPayload(COMPACT);
    expect(map.THYAO).toMatchObject({ pe: 2.96, pb: 0.39, mcapMnTL: 393990 });
    expect(Object.keys(map)).toHaveLength(3);
  });

  it('reads the raw İş response (local dev posts straight to the screener)', () => {
    const raw = { d: JSON.stringify([{ Hisse: 'THYAO - Türk Hava Yolları', 28: '2,96', 30: '0,39', 8: '393990' }]) };
    expect(parseIsyValuationPayload(raw).THYAO).toMatchObject({ pe: 2.96, pb: 0.39 });
  });

  // An older deployed proxy answers isy_valuation with whatever fields it knows.
  // Reading by NAME means missing columns become null instead of shifted numbers.
  it('does not shift columns when the payload has different fields', () => {
    const older = { fields: ['symbol', 'foreignRatio', 'mcapMnTL'], rows: [['THYAO', 22.91, 393990]] };
    expect(parseIsyValuationPayload(older)).toEqual({});
  });

  it('skips junk rows and rows with no ratio at all', () => {
    const map = parseIsyValuationPayload({
      fields: COMPACT.fields,
      rows: [['xx', 1, 1, 1], ['TOPLAM 100', 1, 1, 1], ['ABCDE', null, null, 500], ['SASA', null, 1.5, 100], 'nope'],
    });
    expect(Object.keys(map)).toEqual(['SASA']);
    expect(map.SASA.pe).toBeNull();
  });
});

describe('fetchValuationRatios', () => {
  beforeEach(() => {
    proxyBase = 'https://proxy.example';
    clearValuationCache();
    localStorage.clear();
  });

  it('asks the proxy route and caches the map', async () => {
    const f = vi.fn(async () => okResponse(COMPACT));
    vi.stubGlobal('fetch', f);
    const first = await fetchValuationRatios();
    expect(first.ratios.THYAO.pe).toBe(2.96);
    expect(f.mock.calls[0][0]).toContain('source=isy_valuation');
    await fetchValuationRatios();
    expect(f).toHaveBeenCalledTimes(1);          // second call served from cache
  });

  // v31.44: a proxy deployed before this route answers 400 "invalid source".
  // That is NOT "this stock has no F/K" — the UI must be able to say which.
  it('reports an outdated proxy instead of an empty map', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })));
    const res = await fetchValuationRatios();
    expect(res).toMatchObject({ unavailable: true, reason: 'proxy_outdated' });
    expect(res.ratios).toEqual({});
  });

  it('reports network failure rather than swallowing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchValuationRatios()).toMatchObject({ unavailable: true, reason: 'network' });
  });

  it('posts the screener criteria directly on a local dev server', async () => {
    proxyBase = '';
    const f = vi.fn(async () => okResponse({ d: JSON.stringify([{ Hisse: 'THYAO - x', 28: 2.96, 30: 0.39, 8: 393990 }]) }));
    vi.stubGlobal('fetch', f);
    const res = await fetchValuationRatios();
    expect(f.mock.calls[0][0]).toBe('/api/isyatirim-screener');
    expect(JSON.parse(f.mock.calls[0][1].body).criterias).toEqual(ISY_VALUATION_BODY.criterias);
    expect(res.ratios.THYAO.pb).toBe(0.39);
  });
});

describe('fetchSymbolValuation', () => {
  beforeEach(() => {
    proxyBase = 'https://proxy.example';
    clearValuationCache();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(COMPACT)));
  });

  it('returns one symbol', async () => {
    expect(await fetchSymbolValuation('thyao')).toMatchObject({ pe: 2.96, pb: 0.39 });
  });

  it('separates "not in the list" from "source unreachable"', async () => {
    expect(await fetchSymbolValuation('ZZZZ')).toMatchObject({ unavailable: true, reason: 'symbol_missing' });
    clearValuationCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    expect(await fetchSymbolValuation('THYAO')).toMatchObject({ unavailable: true, reason: 'http_502' });
  });
});
