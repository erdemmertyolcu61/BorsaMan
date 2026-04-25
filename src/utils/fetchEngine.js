// Configurable self-hosted proxy URL (set to your Vercel deployment URL)
// Auto-load self-hosted proxy URL from localStorage
export let PROXY_BASE_URL = '';
try { PROXY_BASE_URL = localStorage.getItem('bist_proxy_url') || ''; } catch {}
export function setProxyBaseUrl(url) {
  PROXY_BASE_URL = (url || '').replace(/\/+$/, ''); // Remove trailing slashes
  try { localStorage.setItem('bist_proxy_url', PROXY_BASE_URL); } catch {}
}
import { fetchKAPSummaryFinancials } from './kapEngine.js';
import { logError } from './errorLogger.js';
import { traceFetch, recordFetchMetric, isTelemetryEnabled } from './telemetry.js';
import { fetchAsenaxList, fetchWithFallback, fetchBorsajsQuote } from './borsajsAdapter.js';
const _cache = {};
const _inflight = {}; // Request deduplication: prevent parallel fetches for same symbol

// ═══ SOURCE HEALTH TRACKING ═══
const _sourceHealth = {
  'bigpara': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'yahoo': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'isyatirim': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'foreks': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'borsajs': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' },
  'biquote': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' },
  'self-proxy': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' }
};

export function recordSourceSuccess(source, latency) {
  if (!_sourceHealth[source]) {
    _sourceHealth[source] = { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' };
  }
  _sourceHealth[source].success++;
  _sourceHealth[source].latencySum += latency;
  _sourceHealth[source].lastSuccess = Date.now();
  _sourceHealth[source].status = 'online';
}

export function recordSourceFailure(source) {
  if (!_sourceHealth[source]) {
    _sourceHealth[source] = { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' };
  }
  _sourceHealth[source].fail++;
  
  // Mark as degraded after 3 failures
  if (_sourceHealth[source].fail >= 3) {
    _sourceHealth[source].status = 'degraded';
  }
  // Mark as offline after 5 failures
  if (_sourceHealth[source].fail >= 5) {
    _sourceHealth[source].status = 'offline';
  }
}

export function getSourceHealth() {
  const now = Date.now();
  const result = {};
  
  for (const [source, data] of Object.entries(_sourceHealth)) {
    const total = data.success + data.fail;
    const successRate = total > 0 ? (data.success / total) * 100 : 0;
    const avgLatency = data.success > 0 ? data.latencySum / data.success : 0;
    
    // Update status based on last success time
    if (data.lastSuccess && now - data.lastSuccess > 300000) { // 5 min old
      data.status = data.status === 'offline' ? 'offline' : 'stale';
    }
    
    result[source] = {
      ...data,
      total,
      successRate: successRate.toFixed(1),
      avgLatency: avgLatency.toFixed(0),
      status: data.status
    };
  }
  
  return result;
}

export function resetSourceHealth(source) {
  if (source && _sourceHealth[source]) {
    _sourceHealth[source] = { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' };
  } else if (!source) {
    // Reset all
    for (const key of Object.keys(_sourceHealth)) {
      _sourceHealth[key] = { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' };
    }
  }
}

// ═══ DYNAMIC SOURCE PRIORITIZATION ═══
// Auto-reorder sources by reliability + speed
export function getSourcePriority() {
  const sources = Object.entries(_sourceHealth)
    .filter(([_, data]) => data.status !== 'offline')
    .map(([source, data]) => {
      const total = data.success + data.fail;
      const successRate = total > 0 ? data.success / total : 0.5;
      const avgLatency = data.success > 0 ? data.latencySum / data.success : 5000;
      // Priority score: higher is better (70% reliability, 30% speed)
      const priority = successRate * 70 + Math.max(0, (10000 - avgLatency) / 10000) * 30;
      return { source, priority, successRate, avgLatency, status: data.status };
    })
    .sort((a, b) => b.priority - a.priority);
  return sources;
}

// Track which source provided data last (for analytics) — uses original trackSource at line ~219
// ═══ BATCH BIGPARA PRICE FETCH (Scanner Optimization) ═══
let _batchPriceCache = { ts: 0, data: {} };
const BATCH_CACHE_TTL = 60000; // 1 minute

/**
 * fetchBigParaBatchPrices — fetches all BIST stock prices in one request
 * Returns Map<symbol, { price, change, volume, high, low }>
 */
export async function fetchBigParaBatchPrices() {
  if (Date.now() - _batchPriceCache.ts < BATCH_CACHE_TTL && Object.keys(_batchPriceCache.data).length > 0) {
    return _batchPriceCache.data;
  }
  try {
    const t0 = Date.now();
    const url = '/api/bigpara/borsa/canlilar/hpisinyal';
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('BigPara batch failed: ' + resp.status);
    const json = await resp.json();
    const prices = {};
    const list = json?.data || json || [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const sym = (item.kod || item.hpiKod || '').replace('.E', '').replace('.IS', '');
        if (!sym) continue;
        prices[sym] = {
          price: parseFloat(item.kapanis || item.son || item.fiyat || 0),
          change: parseFloat(item.yuzde || item.yuzdeDegisim || 0),
          volume: parseInt(item.hacim || item.hacimLot || 0),
          high: parseFloat(item.yuksek || 0),
          low: parseFloat(item.dusuk || 0),
          open: parseFloat(item.acilis || 0),
          prevClose: parseFloat(item.oncekiKapanis || 0),
        };
      }
    }
    if (Object.keys(prices).length > 50) {
      _batchPriceCache = { ts: Date.now(), data: prices };
      recordSourceSuccess('bigpara', Date.now() - t0);
    }
    return prices;
  } catch (e) {
    recordSourceFailure('bigpara');
    return {};
  }
}

/**
 * Stable day-key for an Istanbul calendar day.
 *
 * Yahoo returns timestamps at the session open (~07:00 UTC for BIST) and
 * IsYatirim/BigPara return local DD.MM.YYYY strings. Comparing with
 * `getFullYear/getMonth/getDate` uses the runtime's OS timezone, which
 * can drift a Yahoo bar onto "yesterday" for users outside Europe/Istanbul.
 * This helper normalizes every date to a YYYY-MM-DD string computed in
 * the Istanbul zone so the "same calendar day" check is TZ-independent.
 */
export function istanbulDayKey(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  try {
    // en-CA locale gives YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    // Fallback — Europe/Istanbul is UTC+3 year-round (TR dropped DST in 2016)
    const shifted = new Date(date.getTime() + 3 * 3600 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
}

export function isBistWeekend(d) {
  // Derive weekday from the Istanbul-zoned date key, not the runtime TZ.
  const key = istanbulDayKey(d);
  if (!key) return false;
  const [y, m, day] = key.split('-').map(n => parseInt(n, 10));
  // Construct a UTC midnight for that calendar day so getUTCDay() is stable.
  const utc = new Date(Date.UTC(y, m - 1, day));
  const dow = utc.getUTCDay();
  return dow === 0 || dow === 6;
}

function parseTurkishDate(str) {
  if (!str) return new Date();
  try {
    // DD.MM.YYYY HH:mm:ss
    const parts = str.split(' ');
    const dParts = parts[0].split('.');
    if (dParts.length !== 3) return new Date();
    const d = new Date(parseInt(dParts[2]), parseInt(dParts[1]) - 1, parseInt(dParts[0]));
    if (parts[1]) {
      const tParts = parts[1].split(':');
      if (tParts.length >= 2) {
        d.setHours(parseInt(tParts[0]), parseInt(tParts[1]), parseInt(tParts[2] || '0'));
      }
    }
    return isNaN(d.getTime()) ? new Date() : d;
  } catch { return new Date(); }
}
const _proxyStats = { total: 0, ok: 0, sources: {} };
export function getProxyStats() { return { ..._proxyStats }; }
export function clearCache() { Object.keys(_cache).forEach(k => delete _cache[k]); }

function trackSource(src) {
  _proxyStats.sources[src] = (_proxyStats.sources[src] || 0) + 1;
}

// Lightweight circuit-breaker per proxy source label
// Opens the circuit after a number of consecutive failures and backs off
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_BASE_BACKOFF_MS = 60000; // 60s base backoff
const _circuitState = {}; // { [label]: { failures, openedUntil } }

function _isCircuitOpen(label) {
  const s = _circuitState[label];
  if (!s) return false;
  // If still in backoff window, circuit is open
  if (s.openedUntil && Date.now() < s.openedUntil) return true;
  // Otherwise, allow a trial (semi-open)
  return false;
}

function _recordFailure(label) {
  if (!_circuitState[label]) _circuitState[label] = { failures: 0, openedUntil: 0 };
  const s = _circuitState[label];
  s.failures = (s.failures || 0) + 1;
  if (s.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    // Exponential backoff — keep accumulating failures so each additional failure
    // doubles the window: 3→60s, 4→120s, 5→240s, ...
    const backoff = CIRCUIT_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, s.failures - CIRCUIT_FAILURE_THRESHOLD));
    s.openedUntil = Date.now() + backoff;
    // Do NOT reset s.failures here — let them accumulate for exponential growth
  }
}

function _recordSuccess(label) {
  if (!_circuitState[label]) return;
  _circuitState[label].failures = 0;
  // A success could also reset the backoff timer, but we keep openedUntil as a guard
  // to avoid flapping; optional: clear if in backoff and success occurs later.
}

// Test exports for circuit-breaker
export { _isCircuitOpen, _recordFailure, _recordSuccess, _circuitState, CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_BASE_BACKOFF_MS };

export function quickFetch(url, ms = 10000) {
  return new Promise((res, rej) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; rej(new Error('Timeout')); } }, ms);
    fetch(url).then(r => { if (!done) { done = true; clearTimeout(t); res(r); } })
      .catch(e => { if (!done) { done = true; clearTimeout(t); rej(e); } });
  });
}

// Try a direct fetch, return parsed JSON text or null
async function tryDirect(url, ms = 10000) {
  try {
    const r = await quickFetch(url, ms);
    if (!r.ok) return null;
    const text = await r.text();
    return (text && text.length > 50) ? text : null;
  } catch { return null; }
}

// No-cache direct fetch for freshest data (bypasses browser cache)
async function tryDirectNoCache(url, ms = 10000) {
  try {
    const sep = url.includes('?') ? '&' : '?';
    const bustUrl = url + sep + '_t=' + Date.now();
    const r = await quickFetch(bustUrl, ms);
    if (!r.ok) return null;
    const text = await r.text();
    return (text && text.length > 50) ? text : null;
  } catch { return null; }
}

export async function tryProxy(url, ms = 10000) {
  try {
    const r = await quickFetch(url, ms);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const t = await r.text();
    if (!t || t.length < 20) return null;
    if (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<head>') || t.includes('<body>') || t.startsWith('<')) {
      return null;
    }
    if (ct.indexOf('json') >= 0) {
      try {
        const j = JSON.parse(t);
        if (j && j.contents && j.contents.length > 50) return j.contents;
        if (j && (j.chart || j.length > 5)) return JSON.stringify(j);
      } catch {}
      return null;
    }
    return t.length > 50 ? t : null;
  } catch { return null; }
}

// ── Parallel race pattern (Promise.any) ────────────────────────────────────
// All candidates (self-hosted proxy + public CORS proxies) fire SIMULTANEOUSLY.
// Each racer has a STRICT 5-second per-request timeout (default). The fastest
// successful non-empty response wins; slow probes are abandoned immediately.
// Result: 100-ticker scans finish in ~seconds instead of stalling on a single
// slow public proxy.
//
// Contract: resolves with text payload, OR null if every racer fails within 5.5s.
const RACE_PER_REQUEST_MS = 7000;   // per-probe timeout (was 5s — increased to reduce false negatives)
const RACE_CEILING_MS     = 7500;   // absolute resolve-or-null bound

export function getDataViaProxies(targetUrl, ms = RACE_PER_REQUEST_MS) {
  _proxyStats.total++;
  const perProbe = Math.min(ms, RACE_PER_REQUEST_MS);
  const racers = _buildRacers(targetUrl, perProbe);
  if (racers.length === 0) return Promise.resolve(null);

  const probes = racers.map(({ label, url, timeout }) =>
    tryProxy(url, timeout)
      .then((text) => {
        if (!text) throw new Error(label + ' empty');
        // Mark a successful probe for circuit breaker fast-path
        _recordSuccess(label);
        return { text, source: label };
      })
      .catch((e) => {
        // Record failure on each probe failure
        _recordFailure(label);
        throw e;
      })
  );

  // Absolute ceiling — bail out even if every probe hangs
  const ceiling = new Promise((resolve) => setTimeout(() => resolve(null), RACE_CEILING_MS));

  return Promise.race([
    Promise.any(probes).then(({ text, source }) => {
      _proxyStats.ok++;
      trackSource(source);
      return text;
    }).catch(() => null),
    ceiling,
  ]);
}

function _buildRacers(targetUrl, ms) {
  const racers = [];
  // Gate self-proxy with circuit breaker
  if (PROXY_BASE_URL && !_isCircuitOpen('self-proxy')) {
    racers.push({
      label: 'self-proxy',
      url: PROXY_BASE_URL + '/api/proxy?url=' + encodeURIComponent(targetUrl),
      timeout: ms,
    });
  }

  // Public proxies: 3 fastest/most-reliable only — corsproxy.org and codetabs
  // removed (high latency / rate-limited, slowed BIST50 scan by ~40%).
  const publicProxies = [
    { label: 'allorigins-get', url: 'https://api.allorigins.win/get?url=' + encodeURIComponent(targetUrl), timeout: ms },
    { label: 'corsproxy.io',   url: 'https://corsproxy.io/?' + encodeURIComponent(targetUrl),            timeout: ms },
    { label: 'allorigins-raw', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), timeout: ms },
  ];
  for (const p of publicProxies) {
    if (!_isCircuitOpen(p.label)) racers.push({ ...p, label: p.label });
  }
  return racers;
}

// ==========================================
// LOCAL PROXY ROUTING (Vite dev server)
// Routes requests through Vite proxy to bypass CORS entirely
// ==========================================

function isLocalDev() {
  try {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  } catch { return false; }
}

// Try Vite dev server proxy for Yahoo Finance
async function tryLocalYahoo(targetUrl, ms = 8000) {
  try {
    const parsed = new URL(targetUrl);
    let localPath = null;

    if (parsed.hostname.includes('query1.finance.yahoo.com') && parsed.pathname.startsWith('/v8')) {
      localPath = '/yahoo/v8' + parsed.pathname.slice(3) + '?' + parsed.searchParams.toString();
    } else if (parsed.hostname.includes('query2.finance.yahoo.com') && parsed.pathname.startsWith('/v7')) {
      localPath = '/yahoo/v7' + parsed.pathname.slice(3) + '?' + parsed.searchParams.toString();
    } else if (parsed.hostname.includes('query1.finance.yahoo.com') && parsed.pathname.startsWith('/v10')) {
      localPath = '/yahoo/v10' + parsed.pathname.slice(4) + '?' + parsed.searchParams.toString();
    }

    if (!localPath) return null;
    return await tryDirect(localPath, ms);
  } catch { return null; }
}

// ==========================================
// DATA SOURCE: BigPara (real-time quotes)
// ==========================================

export async function fetchBigParaQuote(symbol) {
  const code = symbol.toUpperCase();
  const localUrl = '/api/bigpara/borsa/hisseyuzeysel/' + code;
  const remoteUrl = 'https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/' + code;

  let text = null;

  // Strategy 1: Vite dev proxy
  if (isLocalDev()) {
    text = await tryDirect(localUrl, 6000);
  }

  // Strategy 2: Electron IPC Bridge (Production .exe) - Bypasses CORS/Origin blocks
  if (!text && typeof window !== 'undefined' && window.electronAPI?.remoteFetch) {
    try {
      const res = await window.electronAPI.remoteFetch(remoteUrl + '?_t=' + Date.now(), {
        method: 'GET'
      });
      if (res.success && res.text) text = res.text;
    } catch (e) { logError('fetch', 'Electron remoteFetch failed', e, { symbol: code, severity: 'debug' }); }
  }

  // Strategy 3: Direct fetch with proper browser headers (Web fallback)
  if (!text) {
    try {
      const fetchOptions = {
        method: 'GET',
        headers: { 'Accept': 'application/json, text/plain, */*' }
      };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOptions.signal = AbortSignal.timeout(8000);
      }
      
      const r = await fetch(remoteUrl + '?_t=' + Date.now(), fetchOptions);
      if (r.ok) {
        const t = await r.text();
        if (t && t.length > 20 && !t.includes('<!DOCTYPE')) text = t;
      }
    } catch (e) { logError('fetch', 'BigPara direct fetch failed', e, { symbol: code, severity: 'debug' }); }
  }

  // Strategy 3: CORS proxies as fallback
  if (!text) {
    text = await getDataViaProxies(remoteUrl, 8000);
  }

if (!text) {
    console.error('[BigPara] Failed to fetch quote for', code);
    return null;
  }

  try {
    if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head>') || text.includes('<body>') || text.startsWith('<')) {
      console.warn('[BigPara] HTML response for', code, text.slice(0, 100));
      recordSourceFailure('bigpara');
      return null;
    }
    const data = JSON.parse(text);
    const h = data?.data?.hisseYuzeysel;
    if (!h || !h.kapanis) return null;
    const result = {
      price: parseFloat(h.kapanis),
      open: parseFloat(h.acilis),
      high: parseFloat(h.yuksek),
      low: parseFloat(h.dusuk),
      volume: parseFloat(h.hacimlot),
      change: parseFloat(h.yuzdedegisim),
      prevClose: parseFloat(h.dunkukapanis),
      date: parseTurkishDate(h.tarih)
    };
    console.log(`[BigPara] ${code}: ${result.price} TL (${h.tarih})`);
    return result;
  } catch (e) { logError('parse', 'BigPara quote JSON parse failed', e, { symbol: code, severity: 'warn' }); return null; }
}

// Fetch all BIST stock list from BigPara (useful for scanner)
export async function fetchBigParaList() {
  const localUrl = '/api/bigpara/hisse/list';
  const remoteUrl = 'https://bigpara.hurriyet.com.tr/api/v1/hisse/list';
  const altUrls = [
    'https://bigpara.hurriyet.com.tr/api/v1/hisse/list',
    'https://www.bigpara.com.tr/api/v1/hisse/list',
  ];

  let text = null;
  let lastError = null;
  let successSource = null;

  // Try local dev first
  if (isLocalDev()) {
    try {
      text = await tryDirect(localUrl, 8000);
      if (text && text.length > 100) {
        successSource = 'local-dev';
        recordSourceSuccess('bigpara', 0);
      }
    } catch (e) {
      lastError = e;
    }
  }

  // Try each URL with race pattern
  if (!text) {
    for (const url of altUrls) {
      try {
        const r = await quickFetch(url + '?_t=' + Date.now(), 8000);
        if (r.ok) {
          text = await r.text();
          if (text && text.length > 100) {
            successSource = 'direct';
            recordSourceSuccess('bigpara', Date.now() - Date.now());
            break;
          }
        }
      } catch (e) {
        lastError = e;
      }
    }
  }

  // Fallback to CORS proxies
  if (!text) {
    try {
      text = await getDataViaProxies(remoteUrl, 12000);
      if (text && text.length > 100) {
        successSource = 'proxies';
        recordSourceSuccess('bigpara', 8000);
      }
    } catch (e) {
      lastError = e;
      recordSourceFailure('bigpara');
    }
  }

  // If still no text, try alternative endpoints
  if (!text) {
    try {
      // Try Midas as fallback
      const midasUrl = 'https://www.getmidas.com/wp-json/midas-api/v1/midas_table_data';
      text = await getDataViaProxies(midasUrl, 15000);
    } catch (e) {
      lastError = e;
      recordSourceFailure('bigpara');
    }
  }

  if (!text) {
    console.error('[BigParaList] All sources failed:', lastError?.message);
    return null;
  }

  if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head>') || text.includes('<body>') || text.startsWith('<')) {
    console.warn('[BigParaList] HTML response received, not JSON:', text.slice(0, 120));
    recordSourceFailure('bigpara');
    return null;
  }

  try {
    const data = JSON.parse(text);
    // Handle different response structures
    let stocks = [];
    
    if (Array.isArray(data)) {
      stocks = data;
    } else if (data?.data?.length > 0) {
      stocks = data.data;
    } else if (data?.hisse_detay?.length > 0) {
      stocks = data.hisse_detay;
    } else if (data?.stocks?.length > 0) {
      stocks = data.stocks;
    }
    
    if (stocks.length === 0) {
      console.warn('[BigParaList] No stock data found in response');
      return null;
    }

    const result = stocks.map(h => ({
      symbol: h.kod || h.symbol || h.code || h.hisse_kod || '',
      name: h.ad || h.name || h.hisse_ad || '',
      price: parseFloat(h.kapanis || h.price || h.last || h.son_fiyat || 0),
      change: parseFloat(h.yuzdeDegisim || h.changePercent || h.yuzde_degisim || 0),
      volume: parseFloat(h.hacimLot || h.volume || h.hacim || 0),
    })).filter(s => s.symbol && s.symbol.length > 0 && s.symbol.length <= 6);

    if (result.length === 0) {
      console.warn('[BigParaList] No valid stocks parsed');
      return null;
    }

    console.log(`[BigParaList] Loaded ${result.length} stocks (source: ${successSource})`);
    setFetchTimestamp('bigpara');
    return result;
  } catch (e) {
    console.error('[BigParaList] Parse error:', e.message, text?.slice(0, 200));
    recordSourceFailure('bigpara');
    return null;
  }
}

// ==========================================
// DATA SOURCE: biquote.io (real-time quotes)
// ==========================================

const BIQUOTE_BASE = 'https://biquote.io';

export async function fetchBiquoteQuote(symbol) {
  const code = symbol.toUpperCase();
  const url = `${BIQUOTE_BASE}/api/${code}`;

  const startTime = Date.now();

  try {
    const r = await quickFetch(url, 8000);
    if (!r.ok) {
      recordSourceFailure('biquote');
      return null;
    }

    const t = await r.text();
    if (!t || t.length < 20) return null;

    if (t.includes('<!DOCTYPE') || t.includes('<html') || t.startsWith('<')) {
      console.warn('[biquote] HTML response:', t.slice(0, 80));
      recordSourceFailure('biquote');
      return null;
    }

    const data = JSON.parse(t);
    if (!data || !data.last) {
      return null;
    }

    const latency = Date.now() - startTime;
    recordSourceSuccess('biquote', latency);

    const result = {
      price: parseFloat(data.last),
      open: parseFloat(data.open),
      high: parseFloat(data.high),
      low: parseFloat(data.low),
      volume: parseFloat(data.volume),
      change: parseFloat(data.changePercent) || parseFloat(data.change),
      prevClose: parseFloat(data.previousClose) || parseFloat(data.prevClose),
      date: new Date(),
      bid: parseFloat(data.bid),
      ask: parseFloat(data.ask)
    };

    console.log(`[biquote] ${code}: ${result.price} TL (${latency}ms)`);
    return result;
  } catch (e) {
    recordSourceFailure('biquote');
    return null;
  }
}

export async function fetchBiquoteLatest(symbols) {
  if (!symbols || symbols.length === 0) return [];

  const codes = symbols.map(s => s.toUpperCase()).join('&symbols=');
  const url = `${BIQUOTE_BASE}/api/latest?symbols=${codes}`;

  try {
    const r = await quickFetch(url, 10000);
    if (!r.ok) return [];

    const t = await r.text();
    if (!t || t.includes('<!DOCTYPE') || t.startsWith('<')) return [];

    const data = JSON.parse(t);
    if (!Array.isArray(data)) return [];

    const results = [];
    for (const d of data) {
      if (!d.last) continue;
      results.push({
        symbol: d.symbol,
        price: parseFloat(d.last),
        change: parseFloat(d.changePercent) || 0,
        volume: parseFloat(d.volume) || 0
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ==========================================
// DATA SOURCE: İş Yatırım HisseTekil (historical daily)
// ==========================================

function formatDateISY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

function rangeToDays(range) {
  switch (range) {
    case '5d': return 7;
    case '1mo': return 35;
    case '3mo': return 100;
    case '6mo': return 200;
    case '1y': return 370;
    case '2y': return 740;
    case '5y': return 1850;
    case 'max': return 7300; // ~20 years
    default: return 370;
  }
}

async function fetchIsYatirimHistorical(symbol, range) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - rangeToDays(range));

  const params = `hisse=${symbol}&startdate=${formatDateISY(startDate)}&enddate=${formatDateISY(endDate)}`;
  const localUrl = '/api/isyatirim-hisse?' + params;
  const remoteUrl = 'https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?' + params;

  let text = null;
  if (isLocalDev()) {
    text = await tryDirect(localUrl, 10000);
  }
  // In Electron production, try direct fetch with proper headers
  if (!text) {
    try {
      const r = await quickFetch(remoteUrl, 10000);
      if (r.ok) {
        const t = await r.text();
        if (t && t.length > 50 && !t.includes('<!DOCTYPE')) text = t;
      }
    } catch (e) { logError('fetch', 'IsYatirim direct fetch failed', e, { symbol, severity: 'debug' }); }
  }
  // Fallback to CORS proxies
  if (!text) {
    text = await getDataViaProxies(remoteUrl, 12000);
  }
  if (!text) return null;

  return parseIsYatirim(text);
}

export function parseIsYatirim(text) {
  try {
    const t = typeof text === 'string' ? text : '';
    if (!t || t.length < 20) return null;
    if (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<head>') || t.includes('<body>') || t.startsWith('<')) {
      console.warn('[IsYatirim] HTML response detected, not JSON:', t.slice(0, 120));
      return null;
    }
    const data = JSON.parse(t);
    const values = data?.value;
    if (!values || !Array.isArray(values) || values.length < 5) return null;

    const prices = [];
    for (const v of values) {
      const close = parseFloat(v.HGDG_KAPANIS);
      if (!close || close <= 0) continue;
      const high = parseFloat(v.HGDG_MAX) || close;
      const low = parseFloat(v.HGDG_MIN) || close;
      // AOF is volume-weighted average, use as open proxy
      const open = parseFloat(v.HGDG_AOF) || close;
      // Volume is in TL, convert to approximate lots
      const volTL = parseFloat(v.HGDG_HACIM) || 0;
      const volume = close > 0 ? Math.round(volTL / close) : 0;

      // Parse date: dd-mm-yyyy format
      const parts = (v.HGDG_TARIH || '').split('-');
      if (parts.length !== 3) continue;
      const date = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      if (isNaN(date.getTime())) continue;

      prices.push({
        date,
        open: Math.min(Math.max(open, low), high), // clamp AOF within H-L
        high: Math.max(high, close),
        low: Math.min(low, close),
        close,
        volume
      });
    }

    // Sort by date ascending
    prices.sort((a, b) => a.date - b.date);
    return prices.length >= 10 ? prices : null;
  } catch (e) { logError('parse', 'IsYatirim response parse failed', e, { severity: 'warn' }); return null; }
}

// ==========================================
// DATA SOURCE: Foreks/ParaGaranti (historical OHLCV)
// ==========================================

async function fetchForeksHistorical(symbol, range, interval) {
  const period = interval === '60m' || interval === '1h' ? 60 : 1440;
  let last;
  if (period === 60) {
    // Hourly bars
    last = range === '5d' ? 40 : range === '1mo' ? 160 : range === '3mo' ? 480 : 960;
  } else {
    // Daily bars
    last = range === '5d' ? 5 : range === '1mo' ? 22 : range === '3mo' ? 66 :
           range === '6mo' ? 132 : range === '1y' ? 252 : range === '2y' ? 504 :
           range === '5y' ? 1260 : 2520;
  }

  const params = `userName=undefined&name=${symbol}&exchange=BIST&market=N&group=E&last=${last}&period=${period}&intraPeriod=null&isLast=false`;
  const localUrl = '/api/foreks/historical-data?' + params;
  const remoteUrl = 'https://web-paragaranti-pubsub.foreks.com/web-services/historical-data?' + params;

  let text = null;
  if (isLocalDev()) {
    text = await tryDirect(localUrl, 10000);
  }
  if (!text) {
    text = await getDataViaProxies(remoteUrl, 12000);
  }
  if (!text) return null;

  return parseForeks(text);
}

// ==========================================
// PARSERS
// ==========================================

export function parseYahoo(text) {
  try {
    const t = typeof text === 'string' ? text : '';
    if (!t || t.length < 20) return null;
    if (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<head>') || t.includes('<body>') || t.startsWith('<')) {
      console.warn('[Yahoo] HTML response detected, not JSON:', t.slice(0, 120));
      return null;
    }
    const data = JSON.parse(t);
    const r = data?.chart?.result?.[0];
    if (!r || !r.timestamp || r.timestamp.length < 5) return null;
    const q = r.indicators?.quote?.[0];
    if (!q || !q.close) return null;
    const ts = r.timestamp, prices = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.close[i] <= 0) continue;
      let o = q.open[i] ?? q.close[i], h = q.high[i] ?? q.close[i], l = q.low[i] ?? q.close[i], c = q.close[i];
      h = Math.max(h, o, c); l = Math.min(l, o, c);
      if (h < l) continue;
      prices.push({ date: new Date(ts[i] * 1000), open: o, high: h, low: l, close: c, volume: q.volume[i] || 0 });
    }
    return prices.length >= 10 ? prices : null;
  } catch (e) { logError('parse', 'Yahoo chart parse failed', e, { severity: 'warn' }); return null; }
}

export function parseForeks(text) {
  try {
    const t = typeof text === 'string' ? text : '';
    if (!t || t.length < 20) return null;
    if (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<head>') || t.includes('<body>') || t.startsWith('<')) {
      console.warn('[Foreks] HTML response detected, not JSON:', t.slice(0, 120));
      return null;
    }
    const data = JSON.parse(t);
    if (!data || !data.length || data.length < 10) return null;
    const prices = [];
    for (const d of data) {
      if (!d.c || d.c <= 0) continue;
      let o = d.o || d.c, h = d.h || d.c, l = d.l || d.c, c = d.c;
      h = Math.max(h, o, c); l = Math.min(l, o, c);
      if (h < l) continue;
      prices.push({ date: new Date(d.d), open: o, high: h, low: l, close: c, volume: d.v || 0 });
    }
    return prices.length >= 10 ? prices : null;
  } catch (e) { logError('parse', 'Foreks response parse failed', e, { severity: 'warn' }); return null; }
}

// ==========================================
// MAIN FETCH PIPELINE
// ==========================================

// ─── Yahoo crumb/cookie cache ───────────────────────────────────────────────
// Yahoo Finance now requires a crumb token (fetched after accepting cookies).
// We cache the crumb for 55 minutes (Yahoo rotates ~1h) to avoid hammering fc.yahoo.com.
const _yahooCrumb = { value: null, ts: 0, cookie: '' };
const CRUMB_TTL_MS = 55 * 60 * 1000;

async function ensureYahooCrumb() {
  if (_yahooCrumb.value && Date.now() - _yahooCrumb.ts < CRUMB_TTL_MS) return _yahooCrumb;
  try {
    // Step 1: Touch fc.yahoo.com to get the consent cookie
    const consentResp = await fetch('https://fc.yahoo.com', {
      credentials: 'include', redirect: 'follow',
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    const setCookie = consentResp.headers.get('set-cookie') || '';
    const cookie = (setCookie.match(/\bA3=[^;]+/) || setCookie.match(/\bGUC=[^;]+/) || [])[0] || '';

    // Step 2: Fetch the crumb
    const crumbResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      credentials: 'include',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    if (crumbResp.ok) {
      const crumb = (await crumbResp.text()).trim();
      if (crumb && crumb.length > 4 && !crumb.includes('<')) {
        _yahooCrumb.value = crumb;
        _yahooCrumb.cookie = cookie;
        _yahooCrumb.ts = Date.now();
        return _yahooCrumb;
      }
    }
  } catch { /* crumb fetch is best-effort */ }
  return _yahooCrumb; // return whatever we have (may be empty)
}

// Build Yahoo chart URL with optional crumb
function yahooChartUrl(symbol, range, interval, crumb = '', version = 'v8') {
  const base = `https://query1.finance.yahoo.com/${version}/finance/chart/${symbol}.IS`;
  const params = new URLSearchParams({
    range, interval, includePrePost: 'false',
    events: 'div,splits', useYfid: 'true',
  });
  if (crumb) params.set('crumb', crumb);
  return base + '?' + params.toString();
}

// Yahoo-aware fetch: tries crumb-auth direct, then CORS proxies
async function fetchYahooDirect(symbol, range, interval, ms = 10000) {
  const crumbCtx = await ensureYahooCrumb();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(crumbCtx.cookie ? { 'Cookie': crumbCtx.cookie } : {}),
  };

  // Try v8 with crumb first, then v8 without, then v7
  const urls = [
    crumbCtx.value ? yahooChartUrl(symbol, range, interval, crumbCtx.value, 'v8') : null,
    yahooChartUrl(symbol, range, interval, '', 'v8'),
    `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false&_t=${Date.now()}`,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
      const r = await fetch(url, { headers, credentials: 'include', ...(signal ? { signal } : {}) });
      if (r.status === 401 || r.status === 403) {
        // Invalidate crumb so next call re-fetches
        _yahooCrumb.value = null;
        continue;
      }
      if (!r.ok) continue;
      const text = await r.text();
      if (text && text.length > 100 && !text.startsWith('<')) return text;
    } catch { continue; }
  }
  return null;
}

// Primary fetch: tries Vite proxy → Yahoo direct (crumb) → public CORS proxies
async function getData(targetUrl, ms = 10000) {
  const directResult = await tryDirect(targetUrl, ms);
  if (directResult) return directResult;

  const localResult = await tryLocalYahoo(targetUrl, ms);
  if (localResult) {
    _proxyStats.total++;
    _proxyStats.ok++;
    return localResult;
  }
  return getDataViaProxies(targetUrl, ms);
}

// Fresh fetch with cache-busting
async function getDataFresh(targetUrl, ms = 10000) {
  const directResult = await tryDirectNoCache(targetUrl, ms);
  if (directResult) return directResult;
  const localResult = await tryLocalYahoo(targetUrl, ms);
  if (localResult) { _proxyStats.total++; _proxyStats.ok++; return localResult; }
  return getDataViaProxies(targetUrl, ms);
}

export async function fetchSingle(symbol, range, interval, scanMode = false) {
  if (interval === '1h') interval = '60m';
  if (interval === '30m' || interval === '60m') {
    if (range === 'max' || range === '5y' || range === '2y' || range === '1y') range = '6mo';
    if (interval === '30m' && range === '6mo') range = '3mo';
  }
  if ((range === 'max' || range === '5y' || range === '2y') && interval !== '1d' && interval !== '1wk') {
    interval = '1d';
  }
  const ck = symbol + '_' + range + '_' + interval;
  const c = _cache[ck];
  // Smart cache TTL: scan mode uses shorter (60s), full analysis uses longer (5min for historical)
  const cacheTTL = scanMode ? 60000 : (range === 'max' || range === '5y' || range === '2y' ? 300000 : 120000);
  if (c && (Date.now() - c._ts < cacheTTL)) {
    // Daily/weekly cache hits: refresh today's candle via BigPara overlay
    // so pre-open / mid-day re-opens always merge the latest live bar.
    if (!scanMode && (interval === '1d' || interval === '1wk')) {
      try { await applyLiveOverlay(c, symbol); } catch { /* non-fatal */ }
    }
    return c;
  }
  if (!scanMode) delete _cache[ck];

  // Request deduplication: if same request is already in-flight, wait for it
  if (_inflight[ck]) {
    try { return await _inflight[ck]; } catch { /* fall through to retry */ }
  }
  const ms = scanMode ? 10000 : 12000;

  // Wrap in inflight tracker
  const fetchPromise = _doFetchSingle(symbol, range, interval, ck, ms, scanMode);
  _inflight[ck] = fetchPromise;
  try {
    const result = await fetchPromise;
    delete _inflight[ck];
    return result;
  } catch (e) {
    delete _inflight[ck];
    throw e;
  }
}

async function _doFetchSingle(symbol, range, interval, ck, ms, scanMode) {
  let p = null;
  let source = '';

  // ══════════════════════════════════════════════
  // SOURCE PRIORITY — optimized for after-hours freshness
  // İş Yatırım updates fastest after market close, Yahoo can lag by hours
  // ══════════════════════════════════════════════

  // ---- SOURCE 1: İş Yatırım HisseTekil (daily/weekly — fastest after close) ----
  if (interval === '1d' || interval === '1wk') {
    p = await fetchIsYatirimHistorical(symbol, range);
    if (p) source = 'IsYatirim';
  }

  // ---- SOURCE 2: Yahoo Finance (crumb-auth direct → CORS proxy fallback) ----
  if (!p) {
    // Try crumb-authenticated direct fetch first (bypasses CORS proxy rate limits)
    let text = await fetchYahooDirect(symbol, range, interval, ms);
    if (!text) {
      // Fallback: CORS proxy chain with v8 URL
      const url8 = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false`;
      text = scanMode ? await getData(url8, ms) : await getDataFresh(url8, ms);
    }
    p = text ? parseYahoo(text) : null;
    if (p) source = 'Yahoo';
  }

  // ---- SOURCE 3: Yahoo v7 fallback (different endpoint, sometimes works when v8 fails) ----
  if (!p) {
    const url7 = `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&events=div%2Csplits`;
    const text = await getDataViaProxies(url7, ms);
    p = text ? parseYahoo(text) : null;
    if (p) source = 'Yahoo-v7';
  }

  // ---- SOURCE 4: Foreks/ParaGaranti ----
  if (!p) {
    p = await fetchForeksHistorical(symbol, range, interval);
    if (p) source = 'Foreks';
  }

  if (p) {
    trackSource(source);
    const r = { symbol, prices: p, source, _ts: Date.now(), dataConfidence: 'high', divergencePct: 0 };
    _cache[ck] = r;

    // BIGPARA LIVE OVERLAY — only meaningful for daily/weekly; skip for intraday intervals
    // (15m/5m bars already contain the live bar, and a day-level overlay would corrupt them)
    if (interval === '1d' || interval === '1wk') {
      await applyLiveOverlay(r, symbol);
    }
    return r;
  }

  return null;
}

/**
 * applyLiveOverlay — merges/appends today's live BigPara bar onto a price result.
 *
 * Uses `istanbulDayKey()` for day comparison so a BIST-open US user running the
 * app at 02:00 local doesn't miss today's candle because of timezone drift.
 * Mutates `r` in place and is safe to call on both fresh fetches AND cache hits.
 *
 * Silent on failure — overlay is best-effort enrichment, never blocking.
 */
export async function applyLiveOverlay(r, symbol) {
  if (!r || !r.prices || r.prices.length === 0) return r;
  try {
    const live = await fetchBigParaQuote(symbol);
    if (!live || !(live.price > 0)) return r;

    const lastBar = r.prices[r.prices.length - 1];
    if (!lastBar || typeof lastBar.close !== 'number') return r;

    const liveKey = istanbulDayKey(live.date);
    const lastKey = istanbulDayKey(lastBar.date);
    if (!liveKey || !lastKey) return r;

    const delta = Math.abs(live.price - lastBar.close) / lastBar.close * 100;
    r.divergencePct = delta;

    if (liveKey === lastKey) {
      // Same Istanbul day — merge live quote into last bar
      lastBar.close = live.price;
      if (live.high && live.high > lastBar.high) lastBar.high = live.high;
      if (live.low && live.low < lastBar.low) lastBar.low = live.low;
      if (live.open && live.open > 0) lastBar.open = live.open;
      if (live.volume && live.volume > 0) lastBar.volume = live.volume;
      r.lastPriceSource = 'BigPara';
    } else if (liveKey > lastKey) {
      // Newer Istanbul day — append a fresh bar unless it's a weekend
      if (!isBistWeekend(live.date)) {
        const [y, m, day] = liveKey.split('-').map(n => parseInt(n, 10));
        r.prices.push({
          date: new Date(Date.UTC(y, m - 1, day)),
          open: live.open || live.prevClose || live.price,
          high: live.high || live.price,
          low: live.low || live.price,
          close: live.price,
          volume: live.volume || 0
        });
        r.lastPriceSource = 'BigPara+New';
      }
    }
    if (delta > 5 && liveKey >= lastKey) r.dataConfidence = 'low';
  } catch (e) {
    logError('fetch', 'BigPara overlay failed', e, { severity: 'warn', silent: true });
  }
  return r;
}

/**
 * sanitizePrices — Ham fiyat verisindeki bozuk/duplicate bar'lari temizler.
 * Wall Street kalitesinde bir feed bu kontrollerden gecmek zorundadir.
 */
function sanitizePrices(prices) {
  if (!Array.isArray(prices)) return [];
  const out = [];
  let lastDate = 0;
  for (const b of prices) {
    if (!b || b.close == null || !isFinite(b.close) || b.close <= 0) continue;
    const ts = new Date(b.date || b.time || 0).getTime();
    if (!ts || ts === lastDate) continue; // drop duplicate timestamps
    // OHLC integrity fix
    const h = Math.max(b.high ?? b.close, b.open ?? b.close, b.close);
    const l = Math.min(b.low ?? b.close, b.open ?? b.close, b.close);
    out.push({
      ...b,
      date: new Date(ts).toISOString(),
      high: h,
      low: l,
      volume: Math.max(0, Number(b.volume) || 0),
    });
    lastDate = ts;
  }
  // Outlier filter: reject isolated >50% single-bar moves (bad print)
  for (let i = 1; i < out.length - 1; i++) {
    const pre = out[i - 1].close;
    const cur = out[i].close;
    const nxt = out[i + 1].close;
    const jump = Math.abs(cur - pre) / pre;
    const snapback = Math.abs(nxt - cur) / cur;
    if (jump > 0.5 && snapback > 0.4) {
      out[i] = { ...out[i], close: (pre + nxt) / 2, _corrected: true };
    }
  }
  return out;
}

export async function fetchData(symbol, range, interval, logFn) {
  const log = logFn || (() => {});
  log(symbol + '.IS cekiliyor...', 'info');
  const ck = symbol + '_' + range + '_' + (interval === '1h' ? '60m' : interval);

  let d = await fetchSingle(symbol, range, interval, false);
  if (d) d.prices = sanitizePrices(d.prices);
  if (d && d.prices?.length >= 20) { log(d.prices.length + ' bar (' + d.source + ')', 'ok'); return d; }

  log('Tekrar deneniyor (2/3)...', 'warn');
  delete _cache[ck];
  await new Promise(r => setTimeout(r, 2000));
  d = await fetchSingle(symbol, range, interval, false);
  if (d) d.prices = sanitizePrices(d.prices);
  if (d && d.prices?.length >= 20) { log(d.prices.length + ' bar (R2/' + d.source + ')', 'ok'); return d; }

  const alt = range === 'max' ? '5y' : range === '5y' ? '2y' : range === '2y' ? '1y' : range === '6mo' ? '1y' : range === '3mo' ? '6mo' : range === '1mo' ? '3mo' : range;
  if (alt !== range) {
    log('Farkli aralik deneniyor (' + alt + ')...', 'warn');
    d = await fetchSingle(symbol, alt, interval, false);
    if (d) d.prices = sanitizePrices(d.prices);
    if (d && d.prices?.length >= 20) { log(d.prices.length + ' bar (R3/' + d.source + ')', 'ok'); return d; }
  }

  log(symbol + ' gercek veri alinamadi.', 'err');
  return null;
}

export async function fetchFundamentals(symbol) {
  // 1. Try Yahoo Finance first
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + symbol + '.IS?modules=defaultKeyStatistics,financialData,summaryDetail,incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly';
  const text = await getData(url, 10000);
  
  let yahooData = null;
  if (text) {
    try {
      const data = JSON.parse(text);
      const result = data?.quoteSummary?.result?.[0];
      if (result) {
        const stats = result.defaultKeyStatistics || {}, fin = result.financialData || {}, sum = result.summaryDetail || {};
        yahooData = {
          pe: sum.trailingPE?.raw ?? null, pb: stats.priceToBook?.raw ?? null,
          divYield: sum.dividendYield?.raw != null ? sum.dividendYield.raw * 100 : null,
          marketCap: sum.marketCap?.raw ?? null, roe: fin.returnOnEquity?.raw != null ? fin.returnOnEquity.raw * 100 : null,
          debtToEquity: fin.debtToEquity?.raw ?? null, targetPrice: fin.targetMeanPrice?.raw ?? null,
          recommendation: fin.recommendationKey || null,
          revenueGrowth: fin.revenueGrowth?.raw != null ? fin.revenueGrowth.raw * 100 : null,
          profitMargin: fin.profitMargins?.raw != null ? fin.profitMargins.raw * 100 : null,
          incomeStatementHistoryQuarterly: result.incomeStatementHistoryQuarterly,
          balanceSheetHistoryQuarterly: result.balanceSheetHistoryQuarterly,
          source: 'Yahoo'
        };
      }
    } catch (e) { logError('parse', 'Yahoo fundamentals parse failed', e, { symbol, severity: 'warn' }); }
  }

  // 2. Try KAP Fallback for structured totals & growth
  const kapData = await fetchKAPSummaryFinancials(symbol);

  // Return both, letting the engine choose
  return { yahoo: yahooData, kap: kapData };
}
