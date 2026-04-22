// NewsEngine.js — Lightweight RSS/news fetcher for BIST symbols.
// Uses existing proxy pipeline (no extra deps). Parses RSS/XML + Yahoo JSON.

import { getDataViaProxies } from './fetchEngine.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const _cache = new Map(); // key → { ts, data }  (insertion-ordered → LRU via re-set)

function _cacheGet(k) {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) { _cache.delete(k); return null; }
  // Refresh recency: move to end
  _cache.delete(k); _cache.set(k, v);
  return v.data;
}
function _cacheSet(k, data) {
  if (_cache.has(k)) _cache.delete(k);
  _cache.set(k, { ts: Date.now(), data });
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

function _stripTags(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
function _cdata(s) { const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(String(s || '').trim()); return m ? m[1] : s; }

function _parseRss(xml) {
  const items = [];
  if (!xml || typeof xml !== 'string') return items;
  const re = /<item[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 20) {
    const block = m[0];
    const title = _stripTags(_cdata((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block) || [])[1]));
    const link = _stripTags(_cdata((/<link[^>]*>([\s\S]*?)<\/link>/i.exec(block) || [])[1]));
    const pub = _stripTags(_cdata((/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block) || [])[1]));
    const desc = _stripTags(_cdata((/<description[^>]*>([\s\S]*?)<\/description>/i.exec(block) || [])[1]));
    if (!title) continue;
    items.push({
      title,
      link,
      date: pub ? new Date(pub).toISOString() : null,
      summary: desc.slice(0, 300),
    });
  }
  return items;
}

// ── Yahoo Finance news (returns JSON via query1) ─────────────────────
export async function fetchYahooNews(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return [];
  const key = 'yahoo:' + sym;
  const c = _cacheGet(key); if (c) return c;

  const yahooSym = sym.endsWith('.IS') ? sym : `${sym}.IS`;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSym)}&newsCount=10&quotesCount=0`;
  try {
    const txt = await getDataViaProxies(url, 10000);
    const json = typeof txt === 'string' ? JSON.parse(txt) : txt;
    const rawNews = json?.news || [];
    const items = rawNews.slice(0, 10).map(n => ({
      title: n.title || '',
      link: n.link || '',
      date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      summary: (n.summary || n.title || '').slice(0, 300),
      source: n.publisher || 'Yahoo',
    })).filter(x => x.title);
    _cacheSet(key, items);
    return items;
  } catch { return []; }
}

// ── KAP bildirimleri (HTML scrape via proxy, best-effort) ────────────
export async function fetchKapNews(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return [];
  const key = 'kap:' + sym;
  const c = _cacheGet(key); if (c) return c;

  const url = `https://www.kap.org.tr/tr/api/memberDisclosures?mkkMemberOid=&fromDate=&toDate=&year=&prd=&term=&ruleType=&bdkReview=&disclosureClass=&index=&market=&mainSector=&sector=&subSector=&memberType=IGS&inactiveMkkMemberOidList=&bdkMemberOidList=&noOfRowsPerPage=10&submittingSubsidiaryType=TR&ticker=${encodeURIComponent(sym)}`;
  try {
    const txt = await getDataViaProxies(url, 10000);
    const json = typeof txt === 'string' ? JSON.parse(txt) : txt;
    const rows = Array.isArray(json) ? json : (json?.data || []);
    const items = rows.slice(0, 10).map(r => {
      const b = r.basic || r;
      return {
        title: b.summary || b.subject || b.title || '',
        link: b.disclosureIndex ? `https://www.kap.org.tr/tr/Bildirim/${b.disclosureIndex}` : '',
        date: b.publishDate || b.kapPublishDate || null,
        summary: (b.summary || b.subject || '').slice(0, 300),
        source: 'KAP',
      };
    }).filter(x => x.title);
    _cacheSet(key, items);
    return items;
  } catch { return []; }
}

// ── Generic RSS (e.g., bloomberght, mynet finans) ────────────────────
export async function fetchRss(rssUrl) {
  if (!rssUrl) return [];
  const key = 'rss:' + rssUrl;
  const c = _cacheGet(key); if (c) return c;
  try {
    const txt = await getDataViaProxies(rssUrl, 10000);
    const items = _parseRss(typeof txt === 'string' ? txt : '').map(i => ({ ...i, source: 'RSS' }));
    _cacheSet(key, items);
    return items;
  } catch { return []; }
}

// ── Naive Turkish sentiment scoring ──────────────────────────────────
const POS = ['kar', 'rekor', 'buyume', 'artis', 'yukselis', 'basari', 'ihracat', 'anlasma', 'yatirim', 'temettu', 'sozlesme', 'tesvik', 'onay'];
const NEG = ['zarar', 'dusus', 'kayip', 'ceza', 'dava', 'iflas', 'risk', 'uyari', 'soru sturma', 'sorusturma', 'geri cagirma', 'satis', 'dustu', 'azaldi'];

function _score(text) {
  const t = String(text || '').toLocaleLowerCase('tr-TR');
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return s;
}

export function scoreSentiment(items) {
  if (!Array.isArray(items) || !items.length) return { score: 0, label: 'neutral' };
  let total = 0;
  for (const it of items) total += _score(`${it.title} ${it.summary}`);
  const avg = total / items.length;
  const label = avg >= 0.5 ? 'positive' : avg <= -0.5 ? 'negative' : 'neutral';
  return { score: Number(avg.toFixed(2)), label, total };
}

// ── Unified fetch + JARVIS context formatter ─────────────────────────
export async function fetchSymbolNews(symbol, { includeKap = true } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const [yahoo, kap] = await Promise.all([
    fetchYahooNews(sym),
    includeKap ? fetchKapNews(sym) : Promise.resolve([]),
  ]);
  const all = [...kap, ...yahoo]
    .filter(Boolean)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 12);
  return all;
}

export function formatForJarvis(symbol, items) {
  const sym = String(symbol || '').toUpperCase();
  const arr = Array.isArray(items) ? items : [];
  const sent = scoreSentiment(arr);
  const ctx = arr.slice(0, 6).map((n, i) => {
    const d = n.date ? new Date(n.date).toLocaleDateString('tr-TR') : '—';
    return `${i + 1}. [${n.source || '—'} ${d}] ${n.title}`;
  }).join('\n');
  return {
    symbol: sym,
    count: arr.length,
    sentiment: sent,
    items: arr.map(n => ({ date: n.date, title: n.title, summary: n.summary, source: n.source })),
    ragContext: arr.length
      ? `HABER AKISI (${sym}) — duyarlilik: ${sent.label} (skor ${sent.score})\n${ctx}`
      : `HABER AKISI (${sym}): anlamli haber yok.`,
  };
}

export default {
  fetchYahooNews,
  fetchKapNews,
  fetchRss,
  fetchSymbolNews,
  scoreSentiment,
  formatForJarvis,
};
