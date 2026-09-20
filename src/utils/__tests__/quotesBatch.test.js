/**
 * fetchQuotesBatch — the live-price path (v31.45).
 *
 * It replaces `fetchBiquoteLatest`, which three hooks (live guard, signal
 * tracker, forward-test journal) called before every per-symbol fallback.
 * Measured 2026-09-21: biquote.io answers 200 `{}` for any BIST code and its
 * own /api/symbols lists NYSE / FOREX / CRYPTO / HKEX — no Borsa İstanbul at
 * all — so that call could never return a BIST price, it only spent a round
 * trip. These tests lock what replaced it: one list request when several
 * symbols are wanted, per-symbol quotes when only one or two are.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fetchQuotesBatch, clearCache } from '../fetchEngine.js';

// Real İş Yatırım TumHisseSenetleri shape (a bare array; the response carries
// its own session time in updateDate and the previous close in dayClose).
const isyRow = (symbol, last, open) => ({
  symbol, last, open, dayClose: last - 1, high: last + 2, low: last - 2,
  quantity: 1000, updateDate: '2026-09-18T18:09:59.000+03',
});
// fetchBigParaBatchPrices only caches a list of more than 50 symbols (a short
// answer means the upstream is broken), so the fixture has to look like the
// real 700-row response.
const FILLER = Array.from({ length: 60 }, (_, i) => isyRow(`FIL${String(i).padStart(2, '0')}`, 10 + i, 10 + i));
const LIST = [isyRow('THYAO', 285.5, 289), isyRow('GARAN', 129.9, 132), isyRow('EREGL', 36.42, 36.2), ...FILLER];

const bigParaBody = (price) => JSON.stringify({
  data: { hisseYuzeysel: {
    kapanis: price, acilis: price + 1, yuksek: price + 2, dusuk: price - 2,
    hacimlot: 500, yuzdedegisim: -1.3, dunkukapanis: price + 1,
    tarih: '2026-09-18T18:10:01+03:00',
  } },
});

let listCalls = 0;
let quoteCalls = [];

function stubFetch({ listRows = LIST, listFails = false, knownQuotes = null } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('TumHisseSenetleri')) {
      listCalls++;
      if (listFails) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => JSON.stringify(listRows) };
    }
    const m = /hisseyuzeysel\/([A-Z0-9]+)/.exec(u);
    if (m) {
      quoteCalls.push(m[1]);
      if (knownQuotes && !knownQuotes.includes(m[1])) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => bigParaBody(50) };
    }
    return { ok: false, status: 404, text: async () => '' };
  }));
}

describe('fetchQuotesBatch', () => {
  beforeEach(() => {
    listCalls = 0; quoteCalls = [];
    clearCache();                       // also resets the batch price cache
    localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks the list ONCE for several symbols and never per symbol', async () => {
    stubFetch();
    const map = await fetchQuotesBatch(['THYAO', 'GARAN', 'EREGL', 'A', 'B', 'C', 'D', 'E'], { maxAgeMs: 0 });
    expect(listCalls).toBe(1);
    expect(map.THYAO.price).toBe(285.5);
    expect(map.THYAO.open).toBe(289);          // the real open, not the AOF approximation
    expect(map.GARAN.price).toBe(129.9);
    expect(quoteCalls).toEqual(['A', 'B', 'C', 'D', 'E']);   // only the ones the list lacks
  });

  // A phone watching one position should not download a 423 KB list every 5 s.
  it('goes straight to per-symbol quotes for a short list with a cold cache', async () => {
    stubFetch();
    const map = await fetchQuotesBatch(['THYAO'], { maxAgeMs: 0 });
    expect(listCalls).toBe(0);
    expect(quoteCalls).toEqual(['THYAO']);
    expect(map.THYAO.price).toBe(50);
  });

  it('uses an already-fresh list even for a single symbol (it costs nothing)', async () => {
    stubFetch();
    await fetchQuotesBatch(['THYAO', 'GARAN', 'EREGL', 'A', 'B', 'C', 'D', 'E'], { maxAgeMs: 0 });
    listCalls = 0; quoteCalls = [];
    const map = await fetchQuotesBatch(['THYAO'], { maxAgeMs: 60_000 });
    expect(listCalls).toBe(0);               // served from the warm cache
    expect(quoteCalls).toEqual([]);          // and no per-symbol round trip
    expect(map.THYAO.price).toBe(285.5);
  });

  it('falls back per symbol when the list request fails', async () => {
    stubFetch({ listFails: true });
    const map = await fetchQuotesBatch(['THYAO', 'GARAN', 'X', 'Y', 'Z', 'Q', 'W', 'R'], { maxAgeMs: 0 });
    expect(Object.keys(map).sort()).toEqual(['GARAN', 'Q', 'R', 'THYAO', 'W', 'X', 'Y', 'Z']);
    expect(map.THYAO.price).toBe(50);
  });

  it('normalises and de-duplicates symbols', async () => {
    stubFetch();
    const map = await fetchQuotesBatch(['thyao', 'THYAO.IS', ' THYAO ', 'garan'], { maxAgeMs: 0, minBatchSymbols: 2 });
    expect(Object.keys(map).sort()).toEqual(['GARAN', 'THYAO']);
    expect(listCalls).toBe(1);
    expect(quoteCalls).toEqual([]);
  });

  it('returns an empty map for an empty request without touching the network', async () => {
    stubFetch();
    expect(await fetchQuotesBatch([], { maxAgeMs: 0 })).toEqual({});
    expect(await fetchQuotesBatch(null)).toEqual({});
    expect(listCalls + quoteCalls.length).toBe(0);
  });
});
