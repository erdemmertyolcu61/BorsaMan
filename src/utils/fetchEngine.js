// Configurable self-hosted proxy URL (set to your Vercel deployment URL)
// Auto-detect: on Vercel (same origin has /api/proxy), use '' (same-origin).
// On localhost dev, Vite proxy handles /api/* routes.
// Manual override via localStorage still works.
export let PROXY_BASE_URL = '';
try {
  const stored = localStorage.getItem('bist_proxy_url');
  if (stored) {
    PROXY_BASE_URL = stored;
  } else if (typeof location !== 'undefined' && location.hostname.includes('vercel.app')) {
    PROXY_BASE_URL = location.origin;
  }
} catch {}
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

// ═══ L2 PERSISTENT CACHE — localStorage backed ═══
// Survives page reload. 30-min TTL for daily/weekly bars (BIST closes daily).
// On startup, hydrates _cache from localStorage so first scan is near-instant.
const L2_CACHE_KEY = 'bist_fetch_l2_cache_v1';
const L2_CACHE_TTL_MS = 30 * 60 * 1000; // 30 dakika
const L2_MAX_ENTRIES = 800;             // ~648 BIST + intraday buffers

function _hydrateL2Cache() {
  try {
    const raw = localStorage.getItem(L2_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && v._ts && (now - v._ts) < L2_CACHE_TTL_MS) {
        // Restore date objects on price bars
        // FORMING BAR GUARD: _isForming bars from previous sessions are stale —
        // a bar that was "forming" yesterday is now a complete closed candle.
        // Strip _isForming flag on hydration so the chart shows solid candles.
        if (Array.isArray(v.prices)) {
          for (const b of v.prices) {
            if (b && b.date && typeof b.date === 'string') b.date = new Date(b.date);
            if (b && b._isForming) delete b._isForming; // completed bars are never forming
          }
        }
        _cache[k] = v;
      }
    }
  } catch { /* corrupt cache → ignore */ }
}

let _l2WriteScheduled = false;
function _scheduleL2Persist() {
  if (_l2WriteScheduled) return;
  _l2WriteScheduled = true;
  // Throttle writes — coalesce multiple cache mutations into one localStorage write
  setTimeout(() => {
    _l2WriteScheduled = false;
    try {
      const entries = Object.entries(_cache);
      if (entries.length > L2_MAX_ENTRIES) {
        // Evict oldest by _ts
        entries.sort((a, b) => (b[1]._ts || 0) - (a[1]._ts || 0));
        for (const [k] of entries.slice(L2_MAX_ENTRIES)) delete _cache[k];
      }
      // Strip _isForming bars before persisting: forming bars are session-live only.
      // If saved with _isForming=true, they come back as hollow candles on next load.
      const cacheCopy = {};
      for (const [k, v] of Object.entries(_cache)) {
        if (!v || !Array.isArray(v.prices)) { cacheCopy[k] = v; continue; }
        const cleanPrices = v.prices.map(b => {
          if (!b || !b._isForming) return b;
          const { _isForming, ...rest } = b; // eslint-disable-line no-unused-vars
          return rest;
        });
        cacheCopy[k] = { ...v, prices: cleanPrices };
      }
      localStorage.setItem(L2_CACHE_KEY, JSON.stringify(cacheCopy));
    } catch { /* quota or unavailable */ }
  }, 2000);
}

if (typeof window !== 'undefined' && window.localStorage) {
  _hydrateL2Cache();
}

// ═══ SOURCE HEALTH TRACKING ═══
const _sourceHealth = {
  'bigpara': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'yahoo': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'isyatirim': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'foreks': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' },
  'borsajs': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' },
  'biquote': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' },
  'self-proxy': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'unknown' },
  'electron-direct': { success: 0, fail: 0, latencySum: 0, lastSuccess: null, status: 'online' }
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

// ═══ ELECTRON-FIRST UNIVERSAL FETCH HELPER ═══
// Tek satirlik veri cekme: once Electron IPC, sonra getDataViaProxies fallback.
// Tum data source fonksiyonlarinin (BigPara/Yahoo/IsYatirim/KAP/News) ortak girisi.
// Returns text body (string) on success, null on total failure.
export async function smartFetch(targetUrl, ms = 9000) {
  // Electron fast path
  if (typeof window !== 'undefined' && window.electronAPI?.remoteFetch) {
    try {
      const ipc = window.electronAPI.remoteFetch(targetUrl, { method: 'GET' });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('ipc-timeout')), ms));
      const res = await Promise.race([ipc, timeout]);
      if (res?.success && res?.text && res.text.length >= 20) {
        const t = res.text;
        // HTML guard
        if (!t.startsWith('<') && !t.includes('<!DOCTYPE') && !t.includes('<html')) {
          return t;
        }
      }
    } catch { /* fall through */ }
  }
  // Browser/web fallback: proxy zinciri
  return await getDataViaProxies(targetUrl, ms);
}

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

  // 1. IsYatirim is the new primary for batch fetching (BigPara hpisinyal is dead/403)
  const isyatirimUrl = 'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/TumHisseSenetleri';
  let text = null;
  const t0 = Date.now();

  try {
    // Strategy 1: Vite dev proxy
    if (isLocalDev()) {
      const resp = await fetch('/api/isyatirim/TumHisseSenetleri', {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
      });
      if (resp.ok) {
        const t = await resp.text();
        if (t && t.length > 100 && !t.includes('<!DOCTYPE')) text = t;
      }
    }

    // Strategy 2: Electron IPC Bridge
    if (!text && typeof window !== 'undefined' && window.electronAPI?.remoteFetch) {
      try {
        const res = await window.electronAPI.remoteFetch(isyatirimUrl + '?_t=' + Date.now(), { method: 'GET' });
        if (res.success && res.text && res.text.length > 100) text = res.text;
      } catch { }
    }

    // Strategy 3: Direct fetch
    if (!text) {
      try {
        const resp = await fetch(isyatirimUrl + '?_t=' + Date.now(), {
          headers: { 'Accept': 'application/json' },
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
        });
        if (resp.ok) {
          const t = await resp.text();
          if (t && t.length > 100 && !t.includes('<!DOCTYPE')) text = t;
        }
      } catch { }
    }

    // Strategy 4: CORS proxy chain
    if (!text) {
      text = await getDataViaProxies(isyatirimUrl, 10000);
    }

    if (!text) throw new Error('All batch sources failed');

    const json = JSON.parse(text);
    const prices = {};
    const list = json?.data || json || [];
    let attempted = 0, skipped = 0;
    if (Array.isArray(list)) {
      for (const item of list) {
        attempted++;
        const sym = (item.symbol || item.kod || item.hpiKod || '').replace('.E', '').replace('.IS', '');
        if (!sym) { skipped++; continue; }

        let priceObj;
        // IsYatirim format
        if (item.symbol) {
          const sonFiyat = parseFloat(item.last || item.dayClose || 0);
          const kapanisFiy = parseFloat(item.dayClose || 0);
          const liveF = sonFiyat > 0 ? sonFiyat : 0;
          let change = 0;
          if (kapanisFiy > 0 && sonFiyat > 0) {
            change = ((sonFiyat - kapanisFiy) / kapanisFiy) * 100;
          }
          priceObj = {
            price: liveF,
            son: sonFiyat,
            prevClose: kapanisFiy,
            change: change,
            volume: parseInt(item.quantity || item.volume || 0),
            high: parseFloat(item.high || 0),
            low: parseFloat(item.low || 0),
            open: parseFloat(item.open || 0),
          };
        } else {
          // BigPara format (fallback if another proxy returned it)
          const sonFiyat   = parseFloat(item.son || 0);
          const kapanisFiy = parseFloat(item.kapanis || 0);
          const liveF = sonFiyat > 0 ? sonFiyat : 0;
          priceObj = {
            price:     liveF,
            son:       sonFiyat,
            prevClose: kapanisFiy,
            change:    parseFloat(item.yuzde || item.yuzdeDegisim || item.degisim || 0),
            volume:    parseInt(item.hacim || item.hacimLot || 0),
            high:      parseFloat(item.yuksek || 0),
            low:       parseFloat(item.dusuk || 0),
            open:      parseFloat(item.acilis || 0),
          };
        }
        if (!Number.isFinite(priceObj.price) || priceObj.price <= 0) { skipped++; continue; }
        prices[sym] = priceObj;
      }
    }
    if (attempted > 0 && skipped / attempted > 0.10) {
      console.warn(`[fetchEngine] Batch: ${skipped}/${attempted} sembol atlandı (${(skipped/attempted*100).toFixed(1)}%)`);
    }
    prices._meta = { attempted, succeeded: attempted - skipped, skipped, ts: Date.now() };
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

/**
 * isBistOpenNow — true if BIST market is currently in active trading.
 * BIST continuous session: 09:55–18:10 TRT (Europe/Istanbul), Mon–Fri.
 * Uses Intl.DateTimeFormat to resolve the correct offset regardless of host TZ.
 */
export function isBistOpenNow() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Istanbul',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now);
    const get = (t) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[parts.find(p => p.type === 'weekday')?.value] ?? -1;
    if (dow < 1 || dow > 5) return false;        // weekend
    const t = get('hour') * 60 + get('minute');
    return t >= 595 && t < 1090;                 // 09:55 – 18:10
  } catch { return false; }
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
export function clearCache() {
  Object.keys(_cache).forEach(k => delete _cache[k]);
  // L2 persistent cache da temizle — bayat localStorage verisinin scan'a karismasin
  try { localStorage.removeItem(L2_CACHE_KEY); } catch {}
  // BigPara batch cache da reset
  try { _batchPriceCache = { ts: 0, data: {} }; } catch {}
}

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
    
    // Bypass HTML guard for KAP (because KAP natively returns HTML)
    const isKap = url.includes('kap.org.tr') || url.includes('/api/kap');
    if (!isKap && (t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('<head>') || t.includes('<body>') || t.startsWith('<'))) {
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
// PRIORITY 1: Electron IPC direct fetch (NO CORS, no rate limit) — instant
// PRIORITY 2: Self-hosted Vercel proxy (if configured) — reliable + cached
// PRIORITY 3: Public CORS proxies (LAST RESORT — heavily rate-limited)
//
// In Electron, racers[0] is electron-direct which always wins because the main
// process fetches directly with full Node.js networking — no CORS, no proxy.
// Public proxies only used in browser/web mode where Electron IPC is unavailable.
//
// Contract: resolves with text payload, OR null if every racer fails.
const RACE_PER_REQUEST_MS = 5000;   // per-probe timeout
const RACE_CEILING_MS     = 5500;   // absolute resolve-or-null bound
const ELECTRON_FAST_MS    = 5000;   // Electron-direct gets shorter timeout (faster fail to fallback)

// Electron-direct fast path — bypasses ALL CORS proxies in desktop mode.
// Returns { text, source } on success, null on failure.
async function _electronDirectFetch(targetUrl, ms = ELECTRON_FAST_MS) {
  if (typeof window === 'undefined' || !window.electronAPI?.remoteFetch) return null;
  try {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeoutHandle = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;

    // Race the IPC call against an explicit timeout — IPC itself doesn't honor signals
    const ipcPromise = window.electronAPI.remoteFetch(targetUrl, { method: 'GET' });
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('electron-timeout')), ms + 500));
    const res = await Promise.race([ipcPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (res?.success && res?.text && res.text.length >= 20) {
      // Check for HTML error pages
      const t = res.text;
      const isKap = targetUrl.includes('kap.org.tr') || targetUrl.includes('/api/kap');
      if (!isKap && (t.startsWith('<') || t.includes('<!DOCTYPE') || t.includes('<html'))) {
        _recordFailure('electron-direct');
        return null;
      }
      _recordSuccess('electron-direct');
      return { text: t, source: 'electron-direct' };
    }
    _recordFailure('electron-direct');
    return null;
  } catch {
    _recordFailure('electron-direct');
    return null;
  }
}

export function getDataViaProxies(targetUrl, ms = RACE_PER_REQUEST_MS) {
  _proxyStats.total++;

  // ── ELECTRON FAST PATH ──
  // In desktop mode, main process fetches directly. Skip ALL CORS proxies.
  // Only fall back to proxies if Electron-direct fails (rare — usually network/server side).
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.remoteFetch;
  if (isElectron && !_isCircuitOpen('electron-direct')) {
    return _electronDirectFetch(targetUrl, Math.min(ms, ELECTRON_FAST_MS))
      .then((result) => {
        if (result?.text) {
          _proxyStats.ok++;
          trackSource(result.source);
          return result.text;
        }
        // Electron-direct failed — fall back to proxies (rare)
        return _raceProxies(targetUrl, ms);
      })
      .catch(() => _raceProxies(targetUrl, ms));
  }

  return _raceProxies(targetUrl, ms);
}

function _raceProxies(targetUrl, ms = RACE_PER_REQUEST_MS) {
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
  // Self-hosted Vercel proxy — ONCE öncelikli (rate limit yok, edge cache var)
  if (PROXY_BASE_URL && !_isCircuitOpen('self-proxy')) {
    racers.push({
      label: 'self-proxy',
      url: PROXY_BASE_URL + '/api/proxy?url=' + encodeURIComponent(targetUrl),
      timeout: ms,
    });
  }

  // Public CORS proxies — son çare (sıkça rate-limited)
  // 7 farklı sağlayıcı paralel: birinin çalışma şansı yüksek, ayrıca yükü dağıtır.
  const publicProxies = [
    { label: 'corsproxy.io',   url: 'https://corsproxy.io/?' + encodeURIComponent(targetUrl) },
    { label: 'codetabs',       url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(targetUrl) },
  ];
  for (const p of publicProxies) {
    if (!_isCircuitOpen(p.label)) racers.push({ ...p, timeout: ms });
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
  const t0 = Date.now();

  // Strategy 1: Vite dev proxy (localhost only)
  if (isLocalDev()) {
    text = await tryDirect(localUrl, 8000);
  }

  // Strategy 2: Electron IPC Bridge (Production .exe — bypasses CORS entirely)
  if (!text && typeof window !== 'undefined' && window.electronAPI?.remoteFetch) {
    try {
      const res = await window.electronAPI.remoteFetch(remoteUrl, { method: 'GET' });
      if (res.success && res.text && res.text.length > 50 && !res.text.includes('<!DOCTYPE')) {
        text = res.text;
        recordSourceSuccess('isyatirim', Date.now() - t0);
      }
    } catch (e) { logError('fetch', 'Electron remoteFetch IsYatirim failed', e, { symbol, severity: 'debug' }); }
  }

  // Strategy 3: Direct fetch with proper headers
  if (!text) {
    try {
      const r = await quickFetch(remoteUrl, 8000);
      if (r.ok) {
        const t = await r.text();
        if (t && t.length > 50 && !t.includes('<!DOCTYPE')) {
          text = t;
          recordSourceSuccess('isyatirim', Date.now() - t0);
        }
      }
    } catch (e) { logError('fetch', 'IsYatirim direct fetch failed', e, { symbol, severity: 'debug' }); }
  }

  // Strategy 4: CORS proxies as fallback
  if (!text) {
    text = await getDataViaProxies(remoteUrl, 8000);
    if (text) recordSourceSuccess('isyatirim', Date.now() - t0);
    else recordSourceFailure('isyatirim');
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

// Yahoo-aware fetch: tries Electron IPC → crumb-auth direct → CORS proxies
async function fetchYahooDirect(symbol, range, interval, ms = 10000) {
  const t0 = Date.now();

  // Strategy 1: Electron IPC Bridge (Production .exe — fastest, bypasses CORS)
  if (typeof window !== 'undefined' && window.electronAPI?.remoteFetch) {
    const urls = [
      yahooChartUrl(symbol, range, interval, '', 'v8'),
      `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}`,
    ];
    for (const url of urls) {
      try {
        const res = await window.electronAPI.remoteFetch(url, { method: 'GET' });
        if (res.success && res.text && res.text.length > 100 && !res.text.startsWith('<')) {
          recordSourceSuccess('yahoo', Date.now() - t0);
          return res.text;
        }
      } catch { continue; }
    }
  }

  // Strategy 2: Crumb-auth direct (browser / Vite dev)
  const crumbCtx = await ensureYahooCrumb();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(crumbCtx.cookie ? { 'Cookie': crumbCtx.cookie } : {}),
  };

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
        _yahooCrumb.value = null;
        continue;
      }
      if (!r.ok) continue;
      const text = await r.text();
      if (text && text.length > 100 && !text.startsWith('<')) {
        recordSourceSuccess('yahoo', Date.now() - t0);
        return text;
      }
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
    // NON-BLOCKING: overlay is enrichment — return cached data immediately,
    // overlay updates the object in-place (React re-renders on state change).
    if (!scanMode && (interval === '1d' || interval === '1wk')) {
      applyLiveOverlay(c, symbol).catch(() => { /* non-fatal */ });
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

// Hedge delay — Tail-at-Scale: IsYatirim head-start, fire Yahoo as backup if slow.
// 800ms is aggressive but user-initiated single analysis needs speed. In Electron
// with IPC bridge, IsYatirim typically responds in 300-500ms; 800ms catches the
// 80th percentile before firing the hedge.
const HEDGE_DELAY_MS = 600;

async function _doFetchSingle(symbol, range, interval, ck, ms, scanMode) {
  let p = null;
  let source = '';

  // ══════════════════════════════════════════════
  // HEDGED PARALLEL FETCH — IsYatirim primary + Yahoo backup (1.5s delayed)
  // Worst-case latency drops from sequential 4×7s = 28s to ~7s.
  // Best-case (IsYatirim fast <1.5s) burns no extra quota.
  // ══════════════════════════════════════════════
  if (interval === '1d' || interval === '1wk') {
    const result = await _hedgedDailyFetch(symbol, range, interval, ms);
    if (result) { p = result.p; source = result.source; }
  }

  // ---- Intraday (15m / 60m) or daily fallback path ----
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

  // ---- Yahoo v7 last-resort ----
  if (!p) {
    const url7 = `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&events=div%2Csplits`;
    const text = await getDataViaProxies(url7, ms);
    p = text ? parseYahoo(text) : null;
    if (p) source = 'Yahoo-v7';
  }

  if (p) {
    trackSource(source);
    // Sanitize BEFORE overlay so ghost bars from historical sources are stripped first.
    // applyLiveOverlay then appends a clean BigPara forming bar (_isForming: true).
    // _stripGhostCandle skips _isForming bars, so the subsequent sanitizePrices call
    // in fetchData won't accidentally strip the overlay bar.
    const r = { symbol, prices: sanitizePrices(p), source, _ts: Date.now(), dataConfidence: 'high', divergencePct: 0 };
    _cache[ck] = r;
    _scheduleL2Persist();

    // BIGPARA LIVE OVERLAY:
    //   - Non-scan single analysis: await with 6s timeout (need fresh price for chart).
    //     Batch cache makes this ~0ms typically; 6s gives per-symbol fallback enough
    //     headroom when batch cache is cold (önceki 3s timeout 5Y ilk açılışta sık
    //     fire ediyordu → bugünkü mum eklenemiyordu).
    //   - Scan mode: SKIP per-symbol overlay; scan uses batch BigPara prices instead.
    //     This saves 648 × ~400ms = ~4 dakika per scan.
    if ((interval === '1d' || interval === '1wk') && !scanMode) {
      await Promise.race([
        applyLiveOverlay(r, symbol),
        new Promise(resolve => setTimeout(resolve, 6000)),
      ]);
    }
    return r;
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Hedged daily/weekly fetch — IsYatirim head-start, Yahoo as backup hedge.
// Pattern from Google's "Tail at Scale" — 95th percentile latency drops dramatically.
// ══════════════════════════════════════════════════════════════════════════════
async function _hedgedDailyFetch(symbol, range, interval, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (p, source) => {
      if (settled) return;
      settled = true;
      resolve(p && p.length > 0 ? { p, source } : null);
    };

    // Primary: IsYatirim (typically fastest after market close)
    fetchIsYatirimHistorical(symbol, range)
      .then(p => { if (p && p.length > 0) finish(p, 'IsYatirim'); })
      .catch(() => {});

    // Hedge: Yahoo, fired only if primary doesn't resolve within HEDGE_DELAY_MS
    const hedgeTimer = setTimeout(async () => {
      if (settled) return;
      try {
        let text = await fetchYahooDirect(symbol, range, interval, ms);
        if (!text && !settled) {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false`;
          text = await getDataViaProxies(url, ms);
        }
        if (settled) return;
        const yp = text ? parseYahoo(text) : null;
        if (yp && yp.length > 0) finish(yp, 'Yahoo-Hedge');
      } catch { /* swallow */ }
    }, HEDGE_DELAY_MS);

    // Hard ceiling: prevents indefinite pending (cap at 8s regardless of caller's ms)
    setTimeout(() => {
      clearTimeout(hedgeTimer);
      finish(null, '');
    }, Math.min(ms, 8000));
  });
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
    // OPTIMIZATION: Try batch cache first (populated by advisor scan / live guard)
    // This avoids a per-symbol HTTP round-trip (~400-8000ms) when batch data is fresh.
    let live = null;
    const batchData = _batchPriceCache.data;
    const batchAge = Date.now() - _batchPriceCache.ts;
    const sym = symbol.toUpperCase().replace('.IS', '');
    if (batchAge < 120000 && batchData[sym] && batchData[sym].price > 0) {
      const bd = batchData[sym];
      live = {
        price: bd.price,
        open: bd.open || 0,
        high: bd.high || 0,
        low: bd.low || 0,
        volume: bd.volume || 0,
        change: bd.change || 0,
        prevClose: bd.prevClose || 0,
        date: new Date(),
      };
    }
    // Fallback: per-symbol fetch if batch cache miss or stale
    if (!live || !(live.price > 0)) {
      live = await fetchBigParaQuote(symbol);
    }
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
      // Newer Istanbul day — append a fresh bar ONLY if we have real OHLC data.
      // A raw quote with no open/high/low (H=L=C) creates a zero-range candle that
      // distorts ATR, Bollinger Bands, and can generate false buy signals.
      if (!isBistWeekend(live.date)) {
        const marketOpen = isBistOpenNow();
        const hasRealOpen = live.open > 0;
        const hasRealHL = live.high > 0 && live.low > 0 && live.high > live.low;

        // ── v23 FIX: Market kapaliyken bile gercek OHLC varsa append et ──
        // Onceden: market kapali ise hicbir sey yapmiyordu → Yahoo/IsYatirim 1-2 gun
        // gecikmeli olunca yeni gun mumu (orn. 14 Mayis) kayip kaliyordu.
        // Yeni: gercek OHLC varsa append; market acik → forming, kapali → completed.
        if (hasRealOpen && hasRealHL) {
          const isForming = marketOpen; // Market acikken forming, kapaliyken tamamlanmis
          const prevLast = r.prices[r.prices.length - 1];
          const prevKey = prevLast ? istanbulDayKey(prevLast.date) : null;
          if (prevLast?._isForming && prevKey === liveKey) {
            // Ayni gunun forming bar'i zaten var → guncelle
            prevLast.close = live.price;
            if (live.high > prevLast.high) prevLast.high = live.high;
            if (live.low < prevLast.low) prevLast.low = live.low;
            if (live.volume > 0) prevLast.volume = live.volume;
            // Market kapandi ise forming bayragini kaldir (tamamlanmis bar)
            if (!isForming) delete prevLast._isForming;
            r.lastPriceSource = isForming ? 'BigPara+Update' : 'BigPara+Finalize';
          } else {
            const [y, m, day] = liveKey.split('-').map(n => parseInt(n, 10));
            const newBar = {
              date: new Date(Date.UTC(y, m - 1, day)),
              open: live.open,
              high: live.high,
              low: live.low,
              close: live.price,
              volume: live.volume || 0,
            };
            if (isForming) newBar._isForming = true; // Sadece market acikken forming
            r.prices.push(newBar);
            r.lastPriceSource = isForming ? 'BigPara+New' : 'BigPara+Completed';
          }
        }
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
// BIST ghost candle filter — drop incomplete "today" daily candle before market close (18:10 TRT)
function _stripGhostCandle(bars) {
  if (!bars.length) return bars;
  const last = bars[bars.length - 1];
  // Never strip bars added by applyLiveOverlay — they carry real BigPara OHLC
  if (last._isForming) return bars;
  const lastDate = new Date(last.date);
  const nowTRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  const todayStr = nowTRT.getFullYear() + '-' +
    String(nowTRT.getMonth() + 1).padStart(2, '0') + '-' +
    String(nowTRT.getDate()).padStart(2, '0');
  const barDateTRT = new Date(lastDate.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
  const barStr = barDateTRT.getFullYear() + '-' +
    String(barDateTRT.getMonth() + 1).padStart(2, '0') + '-' +
    String(barDateTRT.getDate()).padStart(2, '0');
  if (barStr !== todayStr) return bars;
  const trtMinutes = nowTRT.getHours() * 60 + nowTRT.getMinutes();
  // 18:10 TRT = 1090 minutes — BIST continuous session fully closed
  if (trtMinutes >= 1090) return bars;
  bars.pop();
  return bars;
}

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
  // Ghost candle filter: strip incomplete "today" candle before BIST close
  return _stripGhostCandle(out);
}

export async function fetchData(symbol, range, interval, logFn) {
  const log = logFn || (() => {});
  log(symbol + '.IS cekiliyor...', 'info');
  const ck = symbol + '_' + range + '_' + (interval === '1h' ? '60m' : interval);

  // CIRCUIT BREAKER RECOVERY: Single analysis is user-initiated and high-priority.
  // If circuit breakers were tripped by a previous batch scan, allow trial requests
  // so single analysis isn't stuck behind stale backoff windows.
  for (const label of Object.keys(_circuitState)) {
    const s = _circuitState[label];
    if (s && s.openedUntil && Date.now() >= s.openedUntil) {
      // Backoff window expired — reset for trial
      s.failures = Math.max(0, s.failures - 1);
      s.openedUntil = 0;
    }
  }

  let d = await fetchSingle(symbol, range, interval, false);
  if (d) d.prices = sanitizePrices(d.prices);
  if (d && d.prices?.length >= 20) { log(d.prices.length + ' bar (' + d.source + ')', 'ok'); return d; }

  // Retry with cache clear + alternative range IN PARALLEL
  log('Tekrar deneniyor...', 'warn');
  delete _cache[ck];
  const alt = range === 'max' ? '5y' : range === '5y' ? '2y' : range === '2y' ? '1y' : range === '6mo' ? '1y' : range === '3mo' ? '6mo' : range === '1mo' ? '3mo' : range;
  const retryPromises = [
    fetchSingle(symbol, range, interval, false).catch(() => null),
  ];
  if (alt !== range) {
    retryPromises.push(fetchSingle(symbol, alt, interval, false).catch(() => null));
  }
  const retryResults = await Promise.all(retryPromises);
  for (const rd of retryResults) {
    if (rd) rd.prices = sanitizePrices(rd.prices);
    if (rd && rd.prices?.length >= 20) {
      log(rd.prices.length + ' bar (retry/' + rd.source + ')', 'ok');
      return rd;
    }
  }

  // LAST RESORT: Try L2 (localStorage) stale cache — better than showing nothing
  try {
    const raw = localStorage.getItem(L2_CACHE_KEY);
    if (raw) {
      const l2Store = JSON.parse(raw);
      const l2 = l2Store?.[ck];
      if (l2?.prices?.length >= 20) {
        log(l2.prices.length + ' bar (L2-stale/' + (l2.source || '?') + ')', 'warn');
        // Restore date objects
        for (const b of l2.prices) {
          if (b && b.date && typeof b.date === 'string') b.date = new Date(b.date);
          if (b && b._isForming) delete b._isForming;
        }
        l2.dataConfidence = 'low';
        l2._stale = true;
        l2._ts = Date.now();
        _cache[ck] = l2;
        applyLiveOverlay(l2, symbol).catch(() => {});
        return l2;
      }
    }
  } catch { /* localStorage unavailable */ }

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
