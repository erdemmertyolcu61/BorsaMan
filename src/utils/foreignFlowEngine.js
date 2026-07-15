import { PROXY_BASE_URL } from './fetchEngine.js';
import { logError } from './errorLogger.js';

// Constants
const CACHE_KEY = 'bist_foreign_flow_cache';
const CACHE_TTL = 1000 * 60 * 60 * 4; // 4 hours

// ── CIRCUIT BREAKER (v29) ──────────────────────────────────────────────────
// Turkish free foreign-investor-ratio sources are all dead: BigPara removed its
// public section, IsYatirim removed the endpoint (404/401). Rather than hammer
// three dead endpoints on every scan, back off aggressively after total failures
// but keep retrying occasionally so the feature self-heals if a source returns.
const BREAKER_KEY = 'bist_foreign_flow_breaker';
const BACKOFF_BASE_MS = 1000 * 60 * 60 * 6;   // 6h after first total failure
const BACKOFF_MAX_MS  = 1000 * 60 * 60 * 24;  // cap at 24h

let _foreignCache = null;

function getBreaker() {
  try {
    const raw = localStorage.getItem(BREAKER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { failures: 0, until: 0 };
}

function recordFailure() {
  const b = getBreaker();
  b.failures = (b.failures || 0) + 1;
  // Exponential backoff, capped: 6h, 12h, 24h, 24h…
  const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, b.failures - 1));
  b.until = Date.now() + backoff;
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

/**
 * v29.4: Pure foreign-flow scoring — extracted from useAIAdvisor AND AnalyzeTab
 * (the exact same block was duplicated in both, a DRY/bug risk). Weighs weekly +
 * monthly + daily foreign-ratio change plus a high-ratio-exit / low-ratio-entry
 * adjustment into a single [-15, +15] score, a label, and a confidence delta.
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

/**
 * Try BigPara JSON API for yabancı oranları.
 * Tries multiple possible endpoint patterns.
 */
async function fetchBigParaForeignRatios() {
  const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';

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
  const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';
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
  const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';
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
 * Fetches foreign ratios: BigPara API → BigPara HTML → IsYatirim HTML.
 * Returns a map: { "THYAO": { ratio: 34.2, changeDay: 0.1, changeWeek: 1.2, changeMonth: -0.5 }, ... }
 */
export async function fetchAllForeignRatios() {
  const cached = getCache();
  if (cached && cached.ratios && Object.keys(cached.ratios).length > 0) return cached.ratios;

  // Circuit breaker: all sources recently dead → skip network until backoff expires.
  const breaker = getBreaker();
  if (breaker.until && Date.now() < breaker.until) return {};

  let ratios = {};
  const sources = [
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

// EVDS API Key Management
export function getEvdsApiKey() {
  return localStorage.getItem('bist_evds_api_key') || '';
}

export function setEvdsApiKey(key) {
  if (!key) localStorage.removeItem('bist_evds_api_key');
  else localStorage.setItem('bist_evds_api_key', key);
}

/**
 * Fetches Yurt Dışı Yerleşikler Hisse Senedi Net Alım/Satım (Milyon Dolar) from TCMB EVDS
 */
export async function fetchMarketForeignFlow() {
  const cached = getCache();
  if (cached && cached.marketFlow) return cached.marketFlow;

  const evdsKey = getEvdsApiKey();
  if (!evdsKey) return null;

  try {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    const start = `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    const end = `${String(new Date().getDate()).padStart(2,'0')}-${String(new Date().getMonth()+1).padStart(2,'0')}-${new Date().getFullYear()}`;

    const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';
    const url = `${baseUrl}/api/proxy?source=tcmb_evds&series=TP.SI.YABANCI.HS.NET&startdate=${start}&enddate=${end}&evds_key=${evdsKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`EVDS fail: ${res.status}`);
    const json = await res.json();

    if (json.items && json.items.length > 0) {
      const flows = json.items
        .filter(i => i.TP_SI_YABANCI_HS_NET !== null)
        .map(i => ({
          date: i.Tarih,
          valueUSD: parseFloat(i.TP_SI_YABANCI_HS_NET) || 0
        }));

      const marketFlow = {
        flows,
        latestWeeklyFlow: flows.length > 0 ? flows[flows.length - 1].valueUSD : 0,
        fourWeekFlow: flows.slice(-4).reduce((acc, curr) => acc + curr.valueUSD, 0)
      };

      const data = getCache() || {};
      data.marketFlow = marketFlow;
      setCache(data);
      return marketFlow;
    }
    return { error: 'EVDS veri dondurmedi.' };
  } catch (err) {
    logError(err, 'fetchMarketForeignFlow');
    return { error: 'TCMB EVDS engeli (WAF) veya yanit alinamadi.' };
  }
}
