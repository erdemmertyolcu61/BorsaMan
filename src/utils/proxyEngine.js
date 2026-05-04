/**
 * proxyEngine.js - Proxy status and configuration
 */

// Configuration
export let PROXY_BASE_URL = 'http://localhost:3001';
export let WS_URL = 'ws://localhost:8080';

export function setProxyBaseUrl(url) {
  PROXY_BASE_URL = url;
}

export function setWebSocketUrl(url) {
  WS_URL = url;
}

// Proxy stats tracking
export const _proxyStats = {
  selfProxy: { success: 0, fail: 0, avg: 0 },
  yahoo: { success: 0, fail: 0, avg: 0 },
  cors: { success: 0, fail: 0, avg: 0 },
};

export function isProxyAvailable() {
  return true;
}

export function isElectron() {
  return typeof window !== 'undefined' && window.electronAPI;
}

export function getProxyStats() {
  return _proxyStats;
}

export function trackSource(source, success, duration) {
  if (_proxyStats[source]) {
    _proxyStats[source].success += success ? 1 : 0;
    _proxyStats[source].fail += success ? 0 : 1;
  }
}

export async function getDataViaProxies(url, options = {}) {
  try {
    const fetchOptions = options && typeof options === 'object' ? options : {};
    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Proxy fetch failed:', error);
    return null;
  }
}

export async function quickFetch(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Quick fetch failed:', error);
    return null;
  }
}

export async function tryProxy(proxyUrl, targetUrl, options = {}) {
  try {
    const response = await fetch(proxyUrl + '?url=' + encodeURIComponent(targetUrl), options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return null;
  }
}

export async function _racePublicProxies(url) {
  const proxies = [
    'https://api.allorigins.win/get?url=',
    'https://corsproxy.io/?',
    'https://thingproxy.freeboard.io/fetch/',
    'https://cors-anywhere.herokuapp.com/', // Note: Needs opt-in sometimes, but good as fallback
    'https://api.codetabs.com/v1/proxy?quest='
  ];

  const results = await Promise.allSettled(
    proxies.map(proxy =>
      fetch(proxy + encodeURIComponent(url)).then(r => r.json())
    )
  );

  const successful = results.find(r => r.status === 'fulfilled' && r.value);
  return successful?.value || null;
}

export async function checkProxyHealth() {
  try {
    const response = await fetch(`${PROXY_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchViaSelfProxy(symbol, interval = '1d') {
  try {
    const url = `${PROXY_BASE_URL}/api/yahoo/${symbol}?interval=${interval}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Self proxy fetch failed:', error);
    return null;
  }
}

export async function fetchBatchQuotesViaProxy(symbols) {
  try {
    const response = await fetch(`${PROXY_BASE_URL}/api/quotes/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Batch quotes fetch failed:', error);
    return null;
  }
}
