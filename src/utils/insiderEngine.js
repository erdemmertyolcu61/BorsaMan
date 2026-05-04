// ============================================================
// INSIDER TRADING DETECTION ENGINE
// ------------------------------------------------------------
// KAP (Kamuyu Aydinlatma Platformu) uzerinden iceriden
// ogrenenlerin islemlerini tespit edip skorlayan motor.
//
// Veri kaynaklari:
//   1. KAP API  — /api/iceridiogrenenler/{oid} (JSON)
//   2. KAP HTML — /bildirim-sorgu-sonuc?member={oid}&type=IS
//   3. Fallback — fetchKAPDisclosures baslik analizi
//
// Cikti: insiderScore (-10..+10), transaction listesi,
//        hasRecentInsiderBuy/Sell, insiderNetBuys
// ============================================================

import { getDataViaProxies } from './fetchEngine.js';
import { fetchKAPDisclosures } from './kapEngine.js';

// ── Cache ────────────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 200;
const _insiderCache = new Map();

/**
 * LRU cache get — returns null if expired or missing
 * @param {string} key
 * @returns {*|null}
 */
function _cacheGet(key) {
  const entry = _insiderCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _insiderCache.delete(key);
    return null;
  }
  // Move to end for LRU
  _insiderCache.delete(key);
  _insiderCache.set(key, entry);
  return entry.data;
}

/**
 * LRU cache set — evicts oldest if over max size
 * @param {string} key
 * @param {*} data
 */
function _cacheSet(key, data) {
  if (_insiderCache.size >= MAX_CACHE_SIZE) {
    const oldest = _insiderCache.keys().next().value;
    _insiderCache.delete(oldest);
  }
  _insiderCache.set(key, { ts: Date.now(), data });
}

// ── OID Resolution (mirrors kapEngine.js pattern) ────────────
const OID_CACHE_KEY = 'kap_oid_map_v1';

const PRE_MAPPING = {
  'ASELS': '4028e4a140f2ed090140f3408f650041',
  'THYAO': '4028e4a140f2ed090140f33967060002',
  'TUPRS': '4028e4a140f2ed090140f340ba70004c',
  'EREGL': '4028e4a140f2ed090140f33bb694001c',
  'AKBNK': '4028e4a140f2ed090140f33887010001',
  'GARAN': '4028e4a140f2ed090140f33bce300021',
};

function _getOidCache() {
  try {
    const saved = localStorage.getItem(OID_CACHE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function _saveOidCache(map) {
  try { localStorage.setItem(OID_CACHE_KEY, JSON.stringify(map)); } catch {}
}

/**
 * Resolve KAP mkkMemberOid for a BIST symbol.
 * Uses PRE_MAPPING first, then localStorage cache, then fetches
 * the full member list from KAP HTML.
 * @param {string} symbol - BIST stock code (e.g. 'ASELS')
 * @returns {Promise<string|null>}
 */
async function resolveMemberOid(symbol) {
  if (PRE_MAPPING[symbol]) return PRE_MAPPING[symbol];

  const cache = _getOidCache();
  if (cache[symbol]) return cache[symbol];

  try {
    const listUrl = 'https://www.kap.org.tr/tr/bist-sirketler';
    const html = await getDataViaProxies(listUrl, 15000);
    if (!html) return null;

    const re = /"mkkMemberOid":"([^"]+)","[^"]*stockCode":"([^"]+)"/g;
    let match;
    let foundOid = null;
    const newMap = { ...cache };

    while ((match = re.exec(html)) !== null) {
      newMap[match[2]] = match[1];
      if (match[2] === symbol) foundOid = match[1];
    }

    _saveOidCache(newMap);
    return foundOid;
  } catch (err) {
    console.error('[insiderEngine] OID resolution failed:', err);
    return null;
  }
}

// ── Turkish Text Parsing Helpers ─────────────────────────────

/**
 * Detect transaction type from Turkish text.
 * @param {string} text
 * @returns {'buy'|'sell'|'unknown'}
 */
function parseTransactionType(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase().replace(/[İı]/g, 'i').replace(/[Şş]/g, 's')
    .replace(/[Çç]/g, 'c').replace(/[Ğğ]/g, 'g').replace(/[Öö]/g, 'o')
    .replace(/[Üü]/g, 'u');
  if (/al[iı]m|alis|pay\s*al|satin\s*al/i.test(t)) return 'buy';
  if (/sat[iı]m|satis|pay\s*sat/i.test(t)) return 'sell';
  return 'unknown';
}

/**
 * Detect insider role from Turkish text.
 * Returns a normalized role and a weight multiplier.
 * @param {string} text
 * @returns {{ role: string, weight: number }}
 */
function parseInsiderRole(text) {
  if (!text) return { role: 'insider', weight: 1.0 };
  const t = text.toLowerCase().replace(/[İı]/g, 'i').replace(/[Şş]/g, 's')
    .replace(/[Çç]/g, 'c').replace(/[Ğğ]/g, 'g').replace(/[Öö]/g, 'o')
    .replace(/[Üü]/g, 'u');

  if (/genel\s*mudur|ceo|icra\s*kurulu\s*bask/i.test(t)) {
    return { role: 'CEO', weight: 2.0 };
  }
  if (/yonetim\s*kurulu|yk\s*uyesi|board/i.test(t)) {
    return { role: 'board_member', weight: 2.0 };
  }
  if (/hakim\s*ortak|%10.*pay\s*sahibi|buyuk\s*ortak|ana\s*ortak/i.test(t)) {
    return { role: 'major_shareholder', weight: 1.8 };
  }
  if (/mudur|direktor|baskan/i.test(t)) {
    return { role: 'executive', weight: 1.5 };
  }
  if (/es[i]|cocuk|yakini|aile/i.test(t)) {
    return { role: 'family_member', weight: 1.2 };
  }
  return { role: 'insider', weight: 1.0 };
}

/**
 * Parse a Turkish number string (e.g. "1.234.567,89") into a float.
 * @param {string} str
 * @returns {number}
 */
function parseTurkishNumber(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

/**
 * Parse a KAP date string. Handles multiple formats:
 *   "30.04.2026 14:30:00" or "2026-04-30T14:30:00" or "30/04/2026"
 * @param {string} dateStr
 * @returns {Date}
 */
function parseKAPDate(dateStr) {
  if (!dateStr) return new Date();
  try {
    // ISO format
    if (dateStr.includes('T') || dateStr.includes('-')) {
      return new Date(dateStr);
    }
    // Turkish format: DD.MM.YYYY or DD.MM.YYYY HH:mm:ss
    const parts = dateStr.trim().split(' ');
    const dp = parts[0].split(/[./]/);
    if (dp.length === 3) {
      const day = parseInt(dp[0], 10);
      const month = parseInt(dp[1], 10) - 1;
      const year = parseInt(dp[2], 10);
      if (parts[1]) {
        const tp = parts[1].split(':');
        return new Date(year, month, day,
          parseInt(tp[0], 10) || 0,
          parseInt(tp[1], 10) || 0,
          parseInt(tp[2], 10) || 0);
      }
      return new Date(year, month, day);
    }
  } catch { /* fall through */ }
  return new Date(dateStr);
}

// ── KAP API Fetchers ─────────────────────────────────────────

/**
 * Attempt to fetch insider transactions via KAP JSON API.
 * Endpoint: /tr/api/iceridiogrenenler/{oid}
 * @param {string} oid - mkkMemberOid
 * @returns {Promise<Array>} parsed transactions
 */
async function fetchInsiderFromAPI(oid) {
  try {
    const apiUrl = `https://www.kap.org.tr/tr/api/iceridiogrenenler/${oid}`;
    const text = await getDataViaProxies(apiUrl, 12000);
    if (!text) return [];

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    // KAP API may return array or object with a list property
    const items = Array.isArray(data) ? data : (data.islemler || data.list || data.items || []);
    if (!Array.isArray(items) || items.length === 0) return [];

    return items.map(item => {
      const type = parseTransactionType(
        item.islemTuru || item.islemTipi || item.tur || item.type || ''
      );
      const personName = item.adSoyad || item.kisiAd || item.isim || item.name || '';
      const roleText = item.gorevi || item.gorev || item.unvan || item.role || '';
      const { role, weight } = parseInsiderRole(roleText);

      const amount = parseTurkishNumber(item.adet || item.lot || item.miktar || item.shares || 0);
      const amountTL = parseTurkishNumber(item.tutar || item.hacimTL || item.deger || item.value || 0);
      const date = parseKAPDate(item.islemTarihi || item.tarih || item.date || '');

      return {
        type,
        person: personName,
        role,
        roleWeight: weight,
        amount,
        amountTL,
        date: date.toISOString(),
        daysAgo: Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000)),
        source: 'kap_api',
      };
    }).filter(t => t.type !== 'unknown');
  } catch (err) {
    console.warn('[insiderEngine] API fetch failed:', err.message);
    return [];
  }
}

/**
 * Attempt to fetch insider transactions via KAP HTML (bildirim-sorgu with type=IS).
 * @param {string} oid - mkkMemberOid
 * @returns {Promise<Array>} parsed transactions
 */
async function fetchInsiderFromHTML(oid) {
  try {
    const url = `https://www.kap.org.tr/tr/bildirim-sorgu-sonuc?member=${oid}&type=IS`;
    const html = await getDataViaProxies(url, 12000);
    if (!html || typeof html !== 'string') return [];

    const transactions = [];

    // Try to parse JSON-like structures in the HTML response
    // KAP often embeds JSON data in HTML pages
    const jsonMatch = html.match(/\[[\s\S]*?"publishDate"[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const items = JSON.parse(jsonMatch[0]);
        for (const item of items) {
          const title = (item.title || item.baslik || '').toLowerCase();
          const type = parseTransactionType(title);
          if (type === 'unknown') continue;

          const dateStr = item.publishDate || item.tarih || '';
          const date = parseKAPDate(dateStr);

          transactions.push({
            type,
            person: item.kisiAd || item.adSoyad || '',
            role: 'insider',
            roleWeight: 1.0,
            amount: 0,
            amountTL: 0,
            date: date.toISOString(),
            daysAgo: Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000)),
            source: 'kap_html',
            disclosureId: item.disclosureIndex || item.id || null,
          });
        }
      } catch { /* JSON parse failed, try regex below */ }
    }

    // Regex fallback for HTML table rows or structured data
    // Pattern: look for insider transaction disclosure entries
    const discRe = /"publishDate":"([^"]+)".*?"disclosureIndex":(\d+).*?"title":"([^"]+)"/g;
    let match;
    let count = 0;

    while ((match = discRe.exec(html)) !== null && count < 20) {
      const dateStr = match[1];
      const discId = match[2];
      const title = match[3];
      const type = parseTransactionType(title);
      if (type === 'unknown') continue;

      const date = parseKAPDate(dateStr);
      transactions.push({
        type,
        person: '',
        role: 'insider',
        roleWeight: 1.0,
        amount: 0,
        amountTL: 0,
        date: date.toISOString(),
        daysAgo: Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000)),
        source: 'kap_html',
        disclosureId: discId,
      });
      count++;
    }

    return transactions;
  } catch (err) {
    console.warn('[insiderEngine] HTML fetch failed:', err.message);
    return [];
  }
}

/**
 * Fallback: parse general KAP disclosures looking for insider transaction patterns.
 * Uses fetchKAPDisclosures from kapEngine.js and scans titles.
 * @param {string} symbol - BIST stock code
 * @returns {Promise<Array>} parsed transactions (limited detail)
 */
async function fetchInsiderFromDisclosures(symbol) {
  try {
    const disclosures = await fetchKAPDisclosures(symbol);
    if (!disclosures || disclosures.length === 0) return [];

    const INSIDER_PATTERNS = [
      /i[cç]eriden\s+[oö][gğ]renenlerin\s+i[sş]lemleri/i,
      /y[oö]netici\s+i[sş]lemleri/i,
      /pay\s+al[iı]m/i,
      /pay\s+sat[iı]m/i,
      /ortakl[iı]k\s+yap[iı]s[iı]/i,
      /y[oö]netim\s+kurulu.*al[iı]m/i,
      /y[oö]netim\s+kurulu.*sat[iı]m/i,
      /i[cç]eriden.*al[iı]m/i,
      /i[cç]eriden.*sat[iı]m/i,
    ];

    const transactions = [];

    for (const disc of disclosures) {
      const title = disc.title || '';
      const titleLower = title.toLowerCase();

      const isInsiderRelated = INSIDER_PATTERNS.some(pat => pat.test(title));
      if (!isInsiderRelated) continue;

      // Determine type from title
      let type = 'unknown';
      if (/al[iı]m/i.test(titleLower)) type = 'buy';
      else if (/sat[iı]m/i.test(titleLower)) type = 'sell';
      else if (/ortakl[iı]k\s+yap[iı]s[iı]/i.test(titleLower)) {
        // Ownership structure changes are ambiguous; skip scoring but record
        type = 'unknown';
      }

      const date = disc.date ? new Date(disc.date) : new Date();

      // Try to extract role from title
      const { role, weight } = parseInsiderRole(title);

      transactions.push({
        type,
        person: '',
        role,
        roleWeight: weight,
        amount: 0,
        amountTL: 0,
        date: date.toISOString(),
        daysAgo: Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000)),
        source: 'kap_disclosure',
        disclosureId: disc.id || null,
        title,
      });
    }

    return transactions;
  } catch (err) {
    console.warn('[insiderEngine] Disclosure fallback failed:', err.message);
    return [];
  }
}

// ── Scoring ──────────────────────────────────────────────────

/**
 * Score a list of insider transactions.
 *
 * Scoring rules:
 *   - Each buy in last 30 days:  +2 base (board/CEO: +4)
 *   - Each sell in last 30 days: -2 base (board/CEO: -4)
 *   - Large transactions (>1M TL): additional +/-1.5
 *   - Multiple buys cluster bonus: +2 if >= 3 buys in 30 days
 *   - Recency boost: transactions in last 7 days get 1.5x
 *   - Result clamped to [-10, +10]
 *
 * @param {Array} transactions - parsed insider transaction list
 * @returns {number} score from -10 to +10
 */
export function getInsiderScore(transactions) {
  if (!transactions || transactions.length === 0) return 0;

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 86400000;
  const SEVEN_DAYS_MS = 7 * 86400000;
  const LARGE_TL_THRESHOLD = 1_000_000;

  let score = 0;
  let recentBuyCount = 0;

  for (const tx of transactions) {
    if (tx.type !== 'buy' && tx.type !== 'sell') continue;

    const txDate = new Date(tx.date).getTime();
    const age = now - txDate;
    if (age > THIRTY_DAYS_MS) continue; // Only score last 30 days

    const direction = tx.type === 'buy' ? 1 : -1;
    const roleWeight = tx.roleWeight || 1.0;
    const recencyMul = age <= SEVEN_DAYS_MS ? 1.5 : 1.0;

    // Base score per transaction
    let txScore = 2 * direction * roleWeight * recencyMul;

    // Large transaction bonus
    if (tx.amountTL > LARGE_TL_THRESHOLD) {
      txScore += 1.5 * direction * recencyMul;
    } else if (tx.amountTL > 500_000) {
      txScore += 0.75 * direction * recencyMul;
    }

    score += txScore;

    if (tx.type === 'buy' && age <= THIRTY_DAYS_MS) {
      recentBuyCount++;
    }
  }

  // Cluster bonus: multiple insider buys signal strong conviction
  if (recentBuyCount >= 3) {
    score += 2;
  }

  return Math.max(-10, Math.min(10, Math.round(score * 10) / 10));
}

// ── Main Public API ──────────────────────────────────────────

/**
 * Fetch and analyze insider transactions for a single BIST symbol.
 *
 * Tries three sources in order:
 *   1. KAP JSON API (/api/iceridiogrenenler)
 *   2. KAP HTML (bildirim-sorgu type=IS)
 *   3. Fallback: general KAP disclosures title matching
 *
 * @param {string} symbol - BIST stock code (e.g. 'THYAO')
 * @returns {Promise<{
 *   transactions: Array<{type: 'buy'|'sell'|'unknown', person: string, role: string,
 *     amount: number, amountTL: number, date: string, daysAgo: number}>,
 *   score: number,
 *   hasRecentInsiderBuy: boolean,
 *   hasRecentInsiderSell: boolean,
 *   insiderNetBuys: number
 * }>}
 */
export async function fetchInsiderTransactions(symbol) {
  if (!symbol) {
    return _emptyResult();
  }

  const sym = symbol.toUpperCase().replace('.IS', '').replace('.E', '');

  // Check cache first
  const cached = _cacheGet(sym);
  if (cached) return cached;

  let transactions = [];

  try {
    // Step 1: Resolve OID
    const oid = await resolveMemberOid(sym);

    if (oid) {
      // Step 2: Try KAP JSON API
      transactions = await fetchInsiderFromAPI(oid);

      // Step 3: If API returned nothing, try HTML
      if (transactions.length === 0) {
        transactions = await fetchInsiderFromHTML(oid);
      }
    }

    // Step 4: If still nothing, try disclosure title fallback
    if (transactions.length === 0) {
      transactions = await fetchInsiderFromDisclosures(sym);
    }
  } catch (err) {
    console.error(`[insiderEngine] Failed for ${sym}:`, err);
  }

  // Deduplicate by date + type + person (approximate)
  transactions = _deduplicateTransactions(transactions);

  // Sort by date descending (newest first)
  transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Compute derived fields
  const score = getInsiderScore(transactions);
  const FOURTEEN_DAYS = 14;
  const THIRTY_DAYS = 30;

  const hasRecentInsiderBuy = transactions.some(
    t => t.type === 'buy' && t.daysAgo <= FOURTEEN_DAYS
  );
  const hasRecentInsiderSell = transactions.some(
    t => t.type === 'sell' && t.daysAgo <= FOURTEEN_DAYS
  );

  const recentBuys = transactions.filter(
    t => t.type === 'buy' && t.daysAgo <= THIRTY_DAYS
  ).length;
  const recentSells = transactions.filter(
    t => t.type === 'sell' && t.daysAgo <= THIRTY_DAYS
  ).length;

  const result = {
    transactions,
    score,
    hasRecentInsiderBuy,
    hasRecentInsiderSell,
    insiderNetBuys: recentBuys - recentSells,
  };

  _cacheSet(sym, result);
  return result;
}

/**
 * Batch-fetch insider data for multiple symbols.
 * Limits concurrency to avoid overwhelming KAP endpoints.
 *
 * @param {string[]} symbols - array of BIST stock codes
 * @param {number} [concurrency=5] - max parallel requests
 * @returns {Promise<Map<string, {transactions: Array, score: number,
 *   hasRecentInsiderBuy: boolean, hasRecentInsiderSell: boolean, insiderNetBuys: number}>>}
 */
export async function fetchInsiderBatch(symbols, concurrency = 5) {
  if (!symbols || symbols.length === 0) return new Map();

  const results = new Map();
  const queue = [...symbols];

  /**
   * Process items from the queue with limited concurrency.
   */
  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) break;
      try {
        const data = await fetchInsiderTransactions(sym);
        results.set(sym.toUpperCase(), data);
      } catch (err) {
        console.warn(`[insiderEngine] Batch item ${sym} failed:`, err.message);
        results.set(sym.toUpperCase(), _emptyResult());
      }
    }
  }

  // Spawn concurrent workers
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Return an empty insider result object.
 * @returns {{ transactions: [], score: 0, hasRecentInsiderBuy: false,
 *   hasRecentInsiderSell: false, insiderNetBuys: 0 }}
 */
function _emptyResult() {
  return {
    transactions: [],
    score: 0,
    hasRecentInsiderBuy: false,
    hasRecentInsiderSell: false,
    insiderNetBuys: 0,
  };
}

/**
 * Deduplicate transactions by matching date (same day) + type + person name.
 * Keeps the entry with more detail (higher amountTL or non-empty person).
 * @param {Array} txs
 * @returns {Array}
 */
function _deduplicateTransactions(txs) {
  if (!txs || txs.length === 0) return [];

  const seen = new Map();
  const deduped = [];

  for (const tx of txs) {
    const dayKey = tx.date ? tx.date.slice(0, 10) : 'unknown';
    const key = `${dayKey}|${tx.type}|${(tx.person || '').toLowerCase().trim()}`;

    if (seen.has(key)) {
      // Keep the one with more detail
      const existing = seen.get(key);
      if ((tx.amountTL > existing.amountTL) || (tx.person && !existing.person)) {
        // Replace
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = tx;
        seen.set(key, tx);
      }
    } else {
      seen.set(key, tx);
      deduped.push(tx);
    }
  }

  return deduped;
}
