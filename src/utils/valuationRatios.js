// valuationRatios.js — F/K (P/E) + PD/DD (P/B) for every BIST stock (v31.44)
//
// WHY A NEW SOURCE. The app already had F/K and PD/DD in the chart header, fed
// by Yahoo `quoteSummary`. Measured 2026-09-20 against Is Yatirim's own numbers:
//
//   symbol  IS F/K   IS PD/DD   Yahoo PE   Yahoo PB
//   THYAO   2.96     0.39       (missing)  17.97     <- 46x off, and it is the
//   GARAN   4.52     1.12       4.53       1.12         app's default symbol
//   EREGL   32.67    0.80       31.67      0.77
//   ASELS   41.21    5.54       47.36      5.54
//   SISE    10.34    0.45       10.71      0.29
//   KCHOL   14.34    0.69       23.46      0.69
//   TUPRS   11.05    1.76       11.90      1.76
//
// Yahoo is close for most large caps but has holes (THYAO trailing P/E absent)
// and occasional gross errors. Is Yatirim is the local authority, covers every
// traded stock in ONE request and needs no key.
//
// SOURCE. The same stock screener v31.38 already uses for foreign ratios, with
// its own criteria ids, verified numerically on THYAO (2026-09-20):
//   28  F/K   = mcap / trailing-12m net income  393.99B / 132.92B = 2.96  OK
//   30  PD/DD = mcap / equity                   393.99B / 1,018.45B = 0.39 OK
//
// It is a SEPARATE request on purpose: the screener returns the INTERSECTION of
// its criteria, so folding 28/30 into the foreign body silently drops stocks
// with no F/K (measured: 603 -> 601, ISKUR and MARMR vanish). The foreign map
// must not lose rows to buy a second metric.
//
// The browser cannot POST there cross-origin, so production goes through our
// own proxy (source=isy_valuation); local dev uses the Vite screener route.

import { PROXY_BASE_URL } from './fetchEngine.js';

const CACHE_KEY = 'bist_valuation_ratios';
const CACHE_TTL = 6 * 60 * 60 * 1000;   // valuation moves once a day at most

export const ISY_VALUATION_FIELDS = Object.freeze(['symbol', 'pe', 'pb', 'mcapMnTL']);

/** Criteria body for the direct (local dev) POST — mirrors handleIsyValuation. */
export const ISY_VALUATION_BODY = Object.freeze({
  sektor: '', endeks: '', takip: '', oneri: '', lang: '1055',
  criterias: [
    ['28', '-100000000', '100000000', 'False'],
    ['30', '-100000000', '100000000', 'False'],
    ['8', '0', '100000000', 'False'],
  ],
});

let _memory = null;   // { ratios, fetchedAt }

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts the proxy's compact form ({ fields, rows }), the raw Is response
 * ({ d: "[...]" }) or a raw row array. Returns { THYAO: { pe, pb, mcapMnTL } }.
 *
 * Reading by FIELD NAME (not index) keeps an older deployed proxy compatible:
 * a payload without `pe`/`pb` yields nulls instead of shifted numbers.
 */
export function parseIsyValuationPayload(payload) {
  const out = {};
  const put = (symbol, pe, pb, mcapMnTL) => {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{2,5}$/.test(sym)) return;
    if (pe == null && pb == null) return;      // nothing to show — do not invent a row
    out[sym] = { pe, pb, mcapMnTL, source: 'isyatirim' };
  };

  if (payload && Array.isArray(payload.rows)) {
    const fields = Array.isArray(payload.fields) ? payload.fields : ISY_VALUATION_FIELDS;
    const at = (row, name) => { const i = fields.indexOf(name); return i >= 0 ? row[i] : undefined; };
    for (const row of payload.rows) {
      if (!Array.isArray(row)) continue;
      put(at(row, 'symbol'), finiteOrNull(at(row, 'pe')), finiteOrNull(at(row, 'pb')), finiteOrNull(at(row, 'mcapMnTL')));
    }
    return out;
  }

  let list = null;
  if (payload && typeof payload.d === 'string') {
    try { list = JSON.parse(payload.d); } catch { list = null; }
  } else if (Array.isArray(payload?.d)) {
    list = payload.d;
  } else if (Array.isArray(payload)) {
    list = payload;
  }
  for (const it of list || []) {
    if (!it || typeof it !== 'object') continue;
    put(String(it.Hisse || '').split(' - ')[0], finiteOrNull(it['28']), finiteOrNull(it['30']), finiteOrNull(it['8']));
  }
  return out;
}

function loadCache() {
  if (_memory && Date.now() - _memory.fetchedAt < CACHE_TTL) return _memory;
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw && raw.ratios && Date.now() - raw.fetchedAt < CACHE_TTL) {
      _memory = raw;
      return raw;
    }
  } catch {}
  return null;
}

function saveCache(ratios) {
  _memory = { ratios, fetchedAt: Date.now() };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(_memory)); } catch {}
}

/**
 * The whole map, cached for 6h.
 *
 * Returns { ratios, fetchedAt, unavailable?, reason? }. `unavailable` is never
 * collapsed into an empty map: a deployment whose proxy predates this route
 * answers 400, and the caller must be able to say "proxy eski" rather than
 * "bu hissenin F/K'si yok" ([[silent-dead-layer-pattern]]).
 */
export async function fetchValuationRatios() {
  const cached = loadCache();
  if (cached) return { ratios: cached.ratios, fetchedAt: cached.fetchedAt };

  try {
    let payload;
    if (PROXY_BASE_URL) {
      const res = await fetch(`${PROXY_BASE_URL}/api/proxy?source=isy_valuation`, { signal: AbortSignal.timeout(12000) });
      if (res.status === 400) return { ratios: {}, unavailable: true, reason: 'proxy_outdated' };
      if (!res.ok) return { ratios: {}, unavailable: true, reason: `http_${res.status}` };
      payload = await res.json();
    } else {
      // Local dev: vite.config.js forwards /api/isyatirim-screener to the screener.
      const res = await fetch('/api/isyatirim-screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json' },
        body: JSON.stringify(ISY_VALUATION_BODY),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return { ratios: {}, unavailable: true, reason: `http_${res.status}` };
      payload = await res.json();
    }
    const ratios = parseIsyValuationPayload(payload);
    if (!Object.keys(ratios).length) return { ratios: {}, unavailable: true, reason: 'empty' };
    saveCache(ratios);
    return { ratios, fetchedAt: Date.now() };
  } catch (e) {
    return { ratios: {}, unavailable: true, reason: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/**
 * One symbol. Returns { pe, pb, mcapMnTL, source } or
 * { unavailable: true, reason } — never a bare null that hides the difference
 * between "no data for this stock" and "the source could not be reached".
 */
export async function fetchSymbolValuation(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  const { ratios, unavailable, reason, fetchedAt } = await fetchValuationRatios();
  if (unavailable) return { unavailable: true, reason };
  const hit = ratios[sym];
  if (!hit) return { unavailable: true, reason: 'symbol_missing' };
  return { ...hit, fetchedAt };
}

/** Test seam — drops the in-memory copy so a test can re-fetch. */
export function clearValuationCache() {
  _memory = null;
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}
