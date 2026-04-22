// BistUniverseManager.js — Dynamic BIST equity universe.
// Prefers live fetch (BigPara/Is Yatirim) → falls back to cleaned static list.
// Filters out warrants, certificates, ETF/varant codes, fon classes.

import { getStockList } from './constants.js';
import { getDataViaProxies } from './fetchEngine.js';

const LS_KEY = 'bist_universe_v1';
const TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

// ── Non-equity filter set ────────────────────────────────────────────
// Prefix/suffix patterns that indicate warrants, certificates, ETFs, funds, or pair codes.
const NON_EQUITY_PREFIXES = ['Z', 'A1', 'AP', 'OP', 'ZP', 'ZT', 'ZS', 'ZR', 'ZG', 'ZE'];
// Specific tickers to ALWAYS drop (warrants, cert classes, ETF listings, pair-tokens)
const NON_EQUITY_EXACT = new Set([
  // Warrants/Certs (Z-prefix)
  'Z30EA', 'Z30KE', 'Z30KP', 'ZPBDL', 'ZPLIB', 'ZPT10', 'ZPX30', 'ZRE20', 'ZRGYO', 'ZSR25',
  'ZTLRF', 'ZTLRK', 'ZTM25', 'ZEDUR', 'ZELOT', 'ZERGY', 'ZGOLD', 'ZGOLDF', 'ZGYO', 'ZOREN',
  // A1 / AP / OP indices
  'A1CAP', 'A1YEN', 'APBDL', 'APGLD', 'APLIB', 'APMDL', 'APX30',
  'OPK30', 'OPT25', 'OPTGY', 'OPTLR', 'OPX30',
  // ETF funds (F suffix = fon)
  'GLDTR', 'GMSTRF', 'USDTR', 'USDTRF',
]);
const NON_EQUITY_SUFFIX_RE = /(F|TR|TRF|TRK)$/; // fon/parite suffix — be selective

export function isEquityTicker(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!s || s.length < 3 || s.length > 6) return false;
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  if (NON_EQUITY_EXACT.has(s)) return false;
  // Z-prefix and 5+-char starting with Z → almost always warrant/cert
  if (s.startsWith('Z') && s.length >= 4 && !/^(ZRGYO|ZOREN)$/.test(s)) return false;
  // Common pair/fon suffixes only when combined with currency-like stems
  if (/^(USD|EUR|GBP|GLD|XAU)/.test(s)) return false;
  // Strict prefix blacklist for pair/warrant families
  for (const p of NON_EQUITY_PREFIXES) {
    if (p.length > 1 && s.startsWith(p)) {
      // allow individual real stocks that incidentally share prefix (whitelist as needed)
      if (['APLIB', 'APX30', 'APMDL', 'APBDL', 'APGLD'].includes(s)) return false;
    }
  }
  return true;
}

export function cleanUniverse(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    const s = String(raw || '').trim().toUpperCase().replace('.IS', '');
    if (isEquityTicker(s)) out.add(s);
  }
  return [...out].sort();
}

// ── Live fetch (best-effort via Is Yatirim) ──────────────────────────
async function _fetchLiveUniverse() {
  const url = 'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MarketData?language=tr-TR';
  const txt = await getDataViaProxies(url, 12000);
  let rows = [];
  try {
    const json = typeof txt === 'string' ? JSON.parse(txt) : txt;
    rows = json?.value || json?.data || [];
  } catch {
    // Not JSON — try to extract tickers from HTML by regex
    const re = /\b([A-Z0-9]{3,6})\.E\b/g;
    const m = new Set();
    let x;
    while ((x = re.exec(String(txt || '')))) m.add(x[1]);
    rows = [...m].map(s => ({ Symbol: s }));
  }
  const syms = rows.map(r => r?.Symbol || r?.symbol || r?.Ticker).filter(Boolean);
  return cleanUniverse(syms);
}

// ── Cache layer ──────────────────────────────────────────────────────
function _loadCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.ts || !Array.isArray(obj?.symbols)) return null;
    if (Date.now() - obj.ts > TTL_MS) return null;
    return obj;
  } catch { return null; }
}
function _saveCache(symbols, source) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), symbols, source })); } catch {}
}

// ── Public API ───────────────────────────────────────────────────────
export async function getUniverse({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const c = _loadCache();
    if (c?.symbols?.length) return { symbols: c.symbols, source: c.source || 'cache', cached: true };
  }
  try {
    const live = await _fetchLiveUniverse();
    if (live.length >= 200) {
      _saveCache(live, 'live');
      return { symbols: live, source: 'live', cached: false };
    }
  } catch {}

  // Fallback: clean static list
  const staticList = cleanUniverse(getStockList('bistall'));
  _saveCache(staticList, 'static');
  return { symbols: staticList, source: 'static', cached: false };
}

// Synchronous fallback (no network). Always returns the cleaned static universe.
export function getUniverseSync() {
  const c = _loadCache();
  if (c?.symbols?.length) return c.symbols;
  return cleanUniverse(getStockList('bistall'));
}

// Diff report (useful at app boot)
export function auditUniverse() {
  const raw = getStockList('bistall');
  const clean = cleanUniverse(raw);
  const removed = raw.filter(s => !clean.includes(String(s).toUpperCase()));
  return {
    total: raw.length,
    equities: clean.length,
    removedCount: removed.length,
    removed: [...new Set(removed)].sort(),
  };
}

export default {
  isEquityTicker,
  cleanUniverse,
  getUniverse,
  getUniverseSync,
  auditUniverse,
};
