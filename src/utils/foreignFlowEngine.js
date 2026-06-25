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

/**
 * Fetches and parses the entire Is Yatirim Yabanci Oranlari table.
 * Returns a map: { "THYAO": { ratio: 34.2, changeDay: 0.1, changeWeek: 1.2 }, ... }
 */
export async function fetchAllForeignRatios() {
  const cached = getCache();
  if (cached && cached.ratios) return cached.ratios;

  try {
    const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';
    const url = `${baseUrl}/api/proxy?source=isyatirim_yabanci`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IsYatirim yabanci fail: ${res.status}`);
    const html = await res.text();
    
    // We need to parse the HTML to extract the table. 
    // Usually the data is in a table with id 'DataTables_Table_0' or inside a specific script tag.
    // Instead of heavy DOM parsing, we'll try a fast regex on the table rows.
    // <tr ...> <td><a href="/tr-tr/analiz/hisse/Sayfalar/Hisse-Detay.aspx?hisse=THYAO">THYAO</a></td> <td class="text-right">34,25</td> <td class="text-right">0,12</td> ...
    
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
    
    // Fallback if IsYatirim HTML changes: return empty object so we don't crash.
    if (Object.keys(ratios).length > 0) {
      const data = getCache() || {};
      data.ratios = ratios;
      setCache(data);
    }
    return ratios;
  } catch (err) {
    logError(err, 'fetchForeignRatios');
    return {};
  }
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
  return localStorage.getItem('bist_evds_api_key') || '84B4bchcFt';
}

export function setEvdsApiKey(key) {
  if (!key) localStorage.removeItem('bist_evds_api_key');
  else localStorage.setItem('bist_evds_api_key', key);
}

/**
 * Fetches Yurt Dışı Yerleşikler Hisse Senedi Net Alım/Satım (Milyon Dolar) from TCMB EVDS
 * Series: TP.ODEMGZS.YURTDISI (or similar, default proxy uses bie_ypgircik)
 */
export async function fetchMarketForeignFlow() {
  const cached = getCache();
  if (cached && cached.marketFlow) return cached.marketFlow;

  const evdsKey = getEvdsApiKey();
  if (!evdsKey) return null;

  try {
    // Determine start date (last 60 days)
    const d = new Date();
    d.setDate(d.getDate() - 60);
    const start = `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    const end = `${String(new Date().getDate()).padStart(2,'0')}-${String(new Date().getMonth()+1).padStart(2,'0')}-${new Date().getFullYear()}`;
    
    // TP.ODEMGZS.YURTDISI is usually weekly net flow in USD millions.
    // The proxy maps series=...
    const baseUrl = PROXY_BASE_URL || 'https://proxy-delta-mocha-43.vercel.app';
    const url = `${baseUrl}/api/proxy?source=tcmb_evds&series=TP.SI.YABANCI.HS.NET&startdate=${start}&enddate=${end}&evds_key=${evdsKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`EVDS fail: ${res.status}`);
    const json = await res.json();
    
    if (json.items && json.items.length > 0) {
      // items array contains weekly data.
      // E.g. { "Tarih": "14-06-2024", "TP_SI_YABANCI_HS_NET": "125.4" }
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
