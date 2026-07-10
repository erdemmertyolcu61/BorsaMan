import { PROXY_BASE_URL } from './fetchEngine.js';
import { logError } from './errorLogger.js';

// Constants
const CACHE_KEY = 'bist_foreign_flow_cache';
const CACHE_TTL = 1000 * 60 * 60 * 4; // 4 hours

let _foreignCache = null;

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
