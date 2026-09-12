import { PROXY_BASE_URL } from './fetchEngine.js';
import { DEFAULT_PROXY_URL } from './proxyTarget.js';
import { logError } from './errorLogger.js';

// Constants
const CACHE_KEY = 'bist_foreign_flow_cache';
const CACHE_TTL = 1000 * 60 * 60 * 4; // 4 hours

// ── CIRCUIT BREAKER (v29) ──────────────────────────────────────────────────
// BigPara and the old IsYatirim foreign-ratio page are dead (404/401). Rather
// than hammer dead endpoints on every scan, back off aggressively after total
// failures but keep retrying occasionally so the feature self-heals.
const BREAKER_KEY = 'bist_foreign_flow_breaker';
const BACKOFF_BASE_MS = 1000 * 60 * 60 * 6;   // 6h after first total failure
const BACKOFF_MAX_MS  = 1000 * 60 * 60 * 24;  // cap at 24h

// v31.38: a breaker record carries the version of the source list that opened
// it. A breaker opened by the old, dead sources would otherwise block the new
// working source for up to 24h without ever trying it — exactly the state a
// phone that had been scanning for weeks is in.
export const FOREIGN_SOURCES_VERSION = 2;

let _foreignCache = null;

function getBreaker() {
  try {
    const raw = localStorage.getItem(BREAKER_KEY);
    if (raw) {
      const b = JSON.parse(raw);
      if (b && b.v === FOREIGN_SOURCES_VERSION) return b;
    }
  } catch {}
  return { failures: 0, until: 0, v: FOREIGN_SOURCES_VERSION };
}

function recordFailure() {
  const b = getBreaker();
  b.failures = (b.failures || 0) + 1;
  // Exponential backoff, capped: 6h, 12h, 24h, 24h…
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, b.failures - 1));
  b.until = Date.now() + backoff;
  b.v = FOREIGN_SOURCES_VERSION;
  try { localStorage.setItem(BREAKER_KEY, JSON.stringify(b)); } catch {}
}

function recordSuccess() {
  try { localStorage.removeItem(BREAKER_KEY); } catch {}
}

/**
 * Feature availability for the UI. Returns { available, reason, retryAt }.
 * `available` is false while the breaker is open (all sources recently dead).
 */
export function getForeignFlowStatus() {
  const cached = getCache();
  if (cached?.ratios && Object.keys(cached.ratios).length > 0) {
    return { available: true, reason: 'ok' };
  }
  const b = getBreaker();
  if (b.until && Date.now() < b.until) {
    return { available: false, reason: 'no_source', retryAt: b.until };
  }
  return { available: false, reason: 'unknown' };
}

function getCache() {
  if (_foreignCache) return _foreignCache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CACHE_TTL) {
        _foreignCache = parsed.data;
        return _foreignCache;
      }
    }
  } catch (e) {}
  return null;
}

function setCache(data) {
  _foreignCache = data;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch (e) {}
}

function parseNum(str) {
  if (str == null) return 0;
  return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0;
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * v29.4: Pure foreign-flow scoring — extracted from useAIAdvisor AND AnalyzeTab
 * (the exact same block was duplicated in both, a DRY/bug risk). Weighs weekly +
 * monthly + daily foreign-ratio change plus a high-ratio-exit / low-ratio-entry
 * adjustment into a single [-15, +15] score, a label, and a confidence delta.
 * v31.38: whether the result may touch scoring is decided by dataLayerPolicy —
 * the label stays useful for display either way.
 * @param {{ ratio?: number, changeDay?: number, changeWeek?: number, changeMonth?: number }} fr
 * @returns {{ score: number, label: string, confDelta: number }}
 */
export function computeForeignFlowScore(fr) {
  if (!fr) return { score: 0, label: 'NOTR', confDelta: 0 };
  const cw = fr.changeWeek || 0;
  const cm = fr.changeMonth || 0;
  const cd = fr.changeDay || 0;
  const ratio = fr.ratio || 0;
  let s = 0;

  // Weekly change (primary signal)
  if (cw >= 2.0) s += 8;
  else if (cw >= 1.0) s += 5;
  else if (cw >= 0.3) s += 2;
  else if (cw <= -2.0) s -= 8;
  else if (cw <= -1.0) s -= 5;
  else if (cw <= -0.3) s -= 2;

  // Monthly trend (confirmation)
  if (cm >= 3.0) s += 4;
  else if (cm >= 1.0) s += 2;
  else if (cm <= -3.0) s -= 4;
  else if (cm <= -1.0) s -= 2;

  // Daily momentum (short-term)
  if (cd >= 0.5) s += 2;
  else if (cd <= -0.5) s -= 2;

  // High foreign ratio + exit = more dangerous; low ratio + entry = undiscovered
  if (ratio >= 50 && cw <= -1.0) s -= 3;
  if (ratio < 20 && cw >= 1.0) s += 3;

  const score = Math.max(-15, Math.min(15, s));
  const label = score >= 6 ? 'GUCLU GIRIS'
    : score >= 3 ? 'GIRIS'
    : score <= -6 ? 'GUCLU CIKIS'
    : score <= -3 ? 'CIKIS'
    : 'NOTR';
  const confDelta = Math.max(-8, Math.min(8, Math.round(score * 0.6)));
  return { score, label, confDelta };
}

// ── v31.38: İŞ YATIRIM HİSSE TARAMA — çalışan ücretsiz kaynak ────────────────
//
// MEASURED 2026-09-12: one POST to İş Yatırım's stock-screener endpoint returns
// all 603 BIST stocks with the requested criteria, no cookie needed (~150 ms).
// Criteria: 40 current foreign ratio %, 44 / 45 its 1-week / 1-month change,
// 8 market cap (mn TL), 22 / 23 relative return 1-week / 1-month %.
//
// UNITS (inferred, not documented): İş labels 44/45 "(Baz)", but the values
// behave like PERCENTAGE POINTS — across 603 rows no increase ever exceeds the
// current ratio (impossible for a relative %), and the typical magnitude GROWS
// with the ratio level (median |1w| 0.16 below 2 % ratio vs 0.45 at 10-30 %),
// the opposite of what relative change would show. Basis points would make a
// -23 % stock's foreign exit a meaningless -0.1 pp. Treat as pp; this matches
// the 0.3 / 1.0 / 2.0 weekly thresholds computeForeignFlowScore already used.
//
// The browser cannot POST there cross-origin, so production goes through our
// own proxy (source=isy_foreign); local dev goes through the Vite proxy.

export const ISY_FOREIGN_FIELDS = Object.freeze(['symbol', 'foreignRatio', 'foreignChg1w', 'foreignChg1m', 'mcapMnTL', 'rel1w', 'rel1m']);

const ISY_SCREENER_BODY = Object.freeze({
  sektor: '', endeks: '', takip: '', oneri: '', lang: '1055',
  criterias: [
    ['40', '0', '100', 'False'],
    ['44', '-100000', '100000', 'False'],
    ['45', '-100000', '100000', 'False'],
    ['8', '0', '100000000', 'False'],
    ['22', '-100000', '100000', 'False'],
    ['23', '-100000', '100000', 'False'],
  ],
});

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts the proxy's compact form ({ fields, rows }), the raw İş response
 * ({ d: "[...]" }) or the raw row array. Returns the fetchAllForeignRatios map:
 * { THYAO: { ratio, changeDay: null, changeWeek, changeMonth, mcapMnTL, rel1w, rel1m } }.
 * changeDay stays null: this source has no daily change, and 0 would be a lie.
 */
export function parseIsyForeignPayload(payload) {
  const out = {};
  const put = (symbol, ratio, week, month, mcap, rel1w, rel1m) => {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{2,5}$/.test(sym)) return;
    if (ratio == null && week == null && month == null) return;
    out[sym] = { ratio, changeDay: null, changeWeek: week, changeMonth: month, mcapMnTL: mcap, rel1w, rel1m, source: 'isyatirim' };
  };

  if (payload && Array.isArray(payload.rows)) {
    const fields = Array.isArray(payload.fields) ? payload.fields : ISY_FOREIGN_FIELDS;
    const at = (row, name) => { const i = fields.indexOf(name); return i >= 0 ? row[i] : undefined; };
    for (const row of payload.rows) {
      if (!Array.isArray(row)) continue;
      put(at(row, 'symbol'),
        finiteOrNull(at(row, 'foreignRatio')), finiteOrNull(at(row, 'foreignChg1w')), finiteOrNull(at(row, 'foreignChg1m')),
        finiteOrNull(at(row, 'mcapMnTL')), finiteOrNull(at(row, 'rel1w')), finiteOrNull(at(row, 'rel1m')));
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
    put(String(it.Hisse || '').split(' - ')[0],
      finiteOrNull(it['40']), finiteOrNull(it['44']), finiteOrNull(it['45']),
      finiteOrNull(it['8']), finiteOrNull(it['22']), finiteOrNull(it['23']));
  }
  return out;
}

async function fetchIsYatirimScreenerRatios() {
  if (PROXY_BASE_URL) {
    const res = await fetch(`${PROXY_BASE_URL}/api/proxy?source=isy_foreign`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`isy_foreign HTTP ${res.status}`);
    return parseIsyForeignPayload(await res.json());
  }
  // Local dev: vite.config.js forwards /api/isyatirim-screener to the screener.
  const res = await fetch('/api/isyatirim-screener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(ISY_SCREENER_BODY),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`isyatirim-screener HTTP ${res.status}`);
  return parseIsyForeignPayload(await res.json());
}

/**
 * Try BigPara JSON API for yabancı oranları.
 * Tries multiple possible endpoint patterns.
 */
async function fetchBigParaForeignRatios() {
  const baseUrl = PROXY_BASE_URL || DEFAULT_PROXY_URL;

  const endpoints = [
    `${baseUrl}/api/proxy?source=bigpara_yabanci`,
    `${baseUrl}/api/proxy?source=default&url=${encodeURIComponent('https://bigpara.hurriyet.com.tr/api/v1/borsa/yabanci-oranlari')}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const json = await res.json();

      const items = json?.data || json?.result || json?.items || json?.hisseler || (Array.isArray(json) ? json : []);
      if (!Array.isArray(items) || items.length < 10) continue;

      const ratios = {};
      for (const item of items) {
        const sym = item.kod || item.hpisin || item.hisse || item.symbol || item.code;
        if (!sym || !/^[A-Z]{3,6}$/.test(sym)) continue;

        const ratio = parseNum(item.ypisin ?? item.yabanci_oran ?? item.oran ?? item.yabanci);
        const changeDay = parseNum(item.gun_degisim ?? item.gunluk ?? item.d_degisim ?? item.fark);
        const changeWeek = parseNum(item.hafta_degisim ?? item.haftalik ?? item.h_degisim);
        const changeMonth = parseNum(item.ay_degisim ?? item.aylik ?? item.a_degisim);

        if (ratio > 0 || changeDay !== 0 || changeWeek !== 0) {
          ratios[sym] = { ratio, changeDay, changeWeek, changeMonth };
        }
      }
      if (Object.keys(ratios).length >= 10) return ratios;
    } catch (e) {
      // try next endpoint
    }
  }
  return {};
}

/**
 * Scrape BigPara yabancı oranları HTML page as fallback.
 */
async function fetchBigParaForeignHTML() {
  const baseUrl = PROXY_BASE_URL || DEFAULT_PROXY_URL;
  const pageUrl = 'https://bigpara.hurriyet.com.tr/borsa/yabanci-oranlari/';
  const url = `${baseUrl}/api/proxy?source=default&url=${encodeURIComponent(pageUrl)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`BigPara yabanci HTML fail: ${res.status}`);
  const html = await res.text();

  const ratios = {};
  // BigPara table pattern: stock code in link, then numeric cells
  const rowRe = /hisse=([A-Z0-9]{3,6})[^<]*<\/a>[\s\S]*?<td[^>]*>([\d.,%-]+)<\/td>\s*<td[^>]*>([\d.,%-]+)<\/td>\s*<td[^>]*>([\d.,%-]+)<\/td>/g;

  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const sym = m[1];
    const ratio = parseNum(m[2]);
    const changeDay = parseNum(m[3]);
    const changeWeek = parseNum(m[4]);
    ratios[sym] = { ratio, changeDay, changeWeek, changeMonth: 0 };
  }
  return ratios;
}

/**
 * IsYatirim HTML scraping fallback.
 */
async function fetchIsYatirimForeignRatios() {
  const baseUrl = PROXY_BASE_URL || DEFAULT_PROXY_URL;
  const url = `${baseUrl}/api/proxy?source=isyatirim_yabanci`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`IsYatirim yabanci fail: ${res.status}`);
  const html = await res.text();

  const ratios = {};
  const rowRegex = /<a href="[^"]+hisse=([A-Z0-9]+)">.*?<\/a>\s*<\/td>\s*<td[^>]*>([\d,.-]+)<\/td>\s*<td[^>]*>([\d,.-]+)<\/td>\s*<td[^>]*>([\d,.-]+)<\/td>\s*<td[^>]*>([\d,.-]+)<\/td>/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const sym = match[1];
    const ratio = parseFloat(match[2].replace(',', '.')) || 0;
    const changeDay = parseFloat(match[3].replace(',', '.')) || 0;
    const changeWeek = parseFloat(match[4].replace(',', '.')) || 0;
    const changeMonth = parseFloat(match[5].replace(',', '.')) || 0;
    ratios[sym] = { ratio, changeDay, changeWeek, changeMonth };
  }
  return ratios;
}

/**
 * Fetches foreign ratios: İş Yatırım screener (v31.38, works) → BigPara API →
 * BigPara HTML → old IsYatirim HTML (the last three measured dead 2026-07-11).
 * Returns a map: { "THYAO": { ratio: 23.68, changeDay: null, changeWeek: 3.06, changeMonth: 0.7, ... }, ... }
 */
export async function fetchAllForeignRatios() {
  const cached = getCache();
  if (cached && cached.ratios && Object.keys(cached.ratios).length > 0) return cached.ratios;

  // Circuit breaker: all sources recently dead → skip network until backoff expires.
  const breaker = getBreaker();
  if (breaker.until && Date.now() < breaker.until) return {};

  let ratios = {};
  const sources = [
    ['IsYatirimScreener', fetchIsYatirimScreenerRatios],
    ['BigParaAPI', fetchBigParaForeignRatios],
    ['BigParaHTML', fetchBigParaForeignHTML],
    ['IsYatirim', fetchIsYatirimForeignRatios],
  ];

  for (const [name, fn] of sources) {
    try {
      const result = await fn();
      if (Object.keys(result).length >= 10) {
        ratios = result;
        break;
      }
    } catch (e) {
      logError(e, `fetchForeignRatios_${name}`);
    }
  }

  if (Object.keys(ratios).length > 0) {
    const data = getCache() || {};
    data.ratios = ratios;
    data.ratiosFetchedAt = Date.now();
    setCache(data);
    recordSuccess(); // sources alive again → reset breaker
  } else {
    recordFailure(); // total failure → open breaker, back off
  }
  return ratios;
}

/**
 * Fetches a single symbol's foreign ratio
 */
export async function fetchForeignRatio(symbol) {
  const ratios = await fetchAllForeignRatios();
  return ratios[symbol] || null;
}

/** When the ratio map in the cache was fetched (ms), or null. */
export function getForeignRatiosFetchedAt() {
  return getCache()?.ratiosFetchedAt || null;
}

// ── v31.38: MARKET BREADTH + RELATIVE MOMENTUM (pure) ──────────────────────

/**
 * Market-wide picture from the per-stock map: how many stocks saw foreign
 * ownership rise vs fall this week, the median and market-cap-weighted average
 * change (percentage points), and the largest movers.
 */
export function summarizeForeignBreadth(ratios, { flatBandPp = 0.05, topN = 5, minMcapMnTL = 0 } = {}) {
  const rows = [];
  for (const [symbol, v] of Object.entries(ratios || {})) {
    if (!v || typeof v.changeWeek !== 'number' || !Number.isFinite(v.changeWeek)) continue;
    rows.push({ symbol, ratio: v.ratio, changeWeek: v.changeWeek, changeMonth: v.changeMonth, mcapMnTL: v.mcapMnTL, rel1w: v.rel1w });
  }
  if (!rows.length) {
    return { n: 0, up: 0, down: 0, flat: 0, medianChg1w: null, capWeightedChg1w: null, topIn: [], topOut: [] };
  }
  let up = 0, down = 0, flat = 0, capSum = 0, capWeighted = 0;
  for (const r of rows) {
    if (r.changeWeek > flatBandPp) up++;
    else if (r.changeWeek < -flatBandPp) down++;
    else flat++;
    if (Number.isFinite(r.mcapMnTL) && r.mcapMnTL > 0) {
      capSum += r.mcapMnTL;
      capWeighted += r.mcapMnTL * r.changeWeek;
    }
  }
  const sorted = rows.map((r) => r.changeWeek).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const eligible = minMcapMnTL > 0 ? rows.filter((r) => (r.mcapMnTL || 0) >= minMcapMnTL) : rows;
  const topIn = eligible.filter((r) => r.changeWeek > 0).sort((a, b) => b.changeWeek - a.changeWeek).slice(0, topN);
  const topOut = eligible.filter((r) => r.changeWeek < 0).sort((a, b) => a.changeWeek - b.changeWeek).slice(0, topN);
  return {
    n: rows.length, up, down, flat,
    medianChg1w: round2(median),
    capWeightedChg1w: capSum > 0 ? round2(capWeighted / capSum) : null,
    topIn, topOut,
  };
}

/** Strongest relative performers (vs the index) above a market-cap floor. */
export function topRelativeMomentum(ratios, { key = 'rel1w', topN = 5, minMcapMnTL = 3000 } = {}) {
  const rows = [];
  for (const [symbol, v] of Object.entries(ratios || {})) {
    const value = v?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (minMcapMnTL > 0 && !((v.mcapMnTL || 0) >= minMcapMnTL)) continue;
    rows.push({ symbol, value, rel1w: v.rel1w, rel1m: v.rel1m, changeWeek: v.changeWeek, ratio: v.ratio, mcapMnTL: v.mcapMnTL });
  }
  return rows.sort((a, b) => b.value - a.value).slice(0, topN);
}

// EVDS API Key Management
export function getEvdsApiKey() {
  return localStorage.getItem('bist_evds_api_key') || '';
}

export function setEvdsApiKey(key) {
  if (!key) localStorage.removeItem('bist_evds_api_key');
  else localStorage.setItem('bist_evds_api_key', key);
}

// ── TCMB EVDS — weekly net equity purchases by non-residents ───────────────
// v31.38: this was broken three ways — the evds2 /service/evds URL now 302s to
// the EVDS3 SPA, the key must travel in a `key` header (TCMB, 2024-04-05), and
// the series code `TP.SI.YABANCI.HS.NET` does not exist. The real series, read
// from the anonymous EVDS3 catalogue (data group bie_mknethar, weekly/Friday):
//   TP.MKNETHAR.M7 — "2.1.1. Hisse Senedi" net change, million USD.
// The proxy moves the key into the header. Parsing below is NOT yet verified
// against a live keyed response (no key on this machine) — it follows the
// long-standing EVDS JSON shape: items[] with `Tarih` and dots→underscores.
export const EVDS_FOREIGN_EQUITY_SERIES = 'TP.MKNETHAR.M7';

export function parseEvdsWeeklyFlow(json, series = EVDS_FOREIGN_EQUITY_SERIES) {
  const field = String(series).replace(/\./g, '_');
  const items = Array.isArray(json?.items) ? json.items : [];
  const flows = [];
  for (const it of items) {
    const value = parseFloat(it?.[field]);
    if (!it?.Tarih || !Number.isFinite(value)) continue;
    flows.push({ date: it.Tarih, valueUSD: value });
  }
  if (!flows.length) return null;
  const last = flows[flows.length - 1];
  return {
    flows,
    latestWeeklyFlow: last.valueUSD,
    latestDate: last.date,
    fourWeekFlow: Math.round(flows.slice(-4).reduce((acc, f) => acc + f.valueUSD, 0) * 10) / 10,
  };
}

/**
 * Fetches weekly net equity purchases by non-residents (million USD) from TCMB EVDS.
 * Returns null without a key, { error } on failure.
 */
export async function fetchMarketForeignFlow() {
  const cached = getCache();
  if (cached && cached.marketFlow) return cached.marketFlow;

  const evdsKey = getEvdsApiKey();
  if (!evdsKey) return null;

  try {
    const fmt = (dt) => `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
    const start = fmt(new Date(Date.now() - 70 * 24 * 60 * 60 * 1000));
    const end = fmt(new Date());

    const baseUrl = PROXY_BASE_URL || DEFAULT_PROXY_URL;
    const url = `${baseUrl}/api/proxy?source=tcmb_evds&series=${EVDS_FOREIGN_EQUITY_SERIES}&startdate=${start}&enddate=${end}&evds_key=${encodeURIComponent(evdsKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (res.status === 403) {
      return { error: 'EVDS anahtarı reddedildi (403). Anahtarı kontrol et; proxy eskiyse yeniden deploy et.' };
    }
    if (!res.ok) throw new Error(`EVDS fail: ${res.status}`);
    const json = await res.json();
    const marketFlow = parseEvdsWeeklyFlow(json);
    if (marketFlow) {
      const data = getCache() || {};
      data.marketFlow = marketFlow;
      setCache(data);
      return marketFlow;
    }
    return { error: 'EVDS veri döndürmedi.' };
  } catch (err) {
    logError(err, 'fetchMarketForeignFlow');
    return { error: 'TCMB EVDS yanıt vermedi.' };
  }
}
