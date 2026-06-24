// ============================================================
// MARKET NEWS ENGINE — Turkish stock-news aggregator
// ------------------------------------------------------------
// KAP haricinde gercek haber sitelerinden RSS/HTML cekip:
//   1. Sembol tespiti (BIST ticker mention'larini regex ile)
//   2. Kategori siniflandirma:
//        - fund_inflow:        para girisi, yabanci alimi, kurumsal alim
//        - fundamental_rank:   "en karli", "cari oran", siralama haberleri
//        - buyback:            geri alim programi, hisse geri alim
//        - insider_buy:        yonetici alimi, iceriden alim
//        - dividend:           temettu, kar payi
//        - upgrade:            hedef fiyat yukseltildi, AL tavsiyesi, agirlik artirildi
//        - downgrade:          hedef fiyat dusuruldu, SAT tavsiyesi
//        - risk:               dava, sorusturma, ceza, uyari
//   3. Sentiment skoru (-10..+10) + recency carpani
//   4. Per-symbol haber ozeti — Claude prompt'una direkt enjekte edilebilir
//
// Kaynaklar: borsaningundemi.com, bigpara.com, mynet finans, dunya, bloomberght
// (RSS endpoint'leri bilinmiyorsa best-effort HTML scrape, yoksa atlar.)
// ============================================================

import { fetchRss } from './NewsEngine.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
// High-impact fast path (#9): when the last pull contained a high-impact catalyst
// (insider_buy / buyback / contract / risk ...), the news environment is "hot" —
// expire the cache much sooner so a fresh catalyst is picked up in ~1 min instead
// of being masked for 5. RSS latency is independent of price-feed latency, so
// reacting to fresh catalysts faster is a real, cheap edge.
const HIGH_IMPACT_TTL_MS = 60 * 1000;
const _cache = new Map();

export function _hasHighImpact(data) {
  return Array.isArray(data) && data.some(it => it && it.impact === 'high');
}

function _cacheGet(k) {
  const v = _cache.get(k);
  if (!v) return null;
  const ttl = v.hasHighImpact ? HIGH_IMPACT_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - v.ts > ttl) { _cache.delete(k); return null; }
  return v.data;
}
function _cacheSet(k, data) {
  _cache.set(k, { ts: Date.now(), data, hasHighImpact: _hasHighImpact(data) });
}

// ──────────────────────────────────────────────────────────────
// RSS source registry — eklenip cikarilabilir.
// Her kaynak: { name, url, weight } — weight kategori sentiment carpani.
// ──────────────────────────────────────────────────────────────
export const DEFAULT_NEWS_SOURCES = [
  { name: 'BorsaninGundemi', url: 'https://www.borsaningundemi.com/rss', weight: 1.0 },
  { name: 'BigPara',          url: 'https://www.bigpara.com/rss/borsa-haberleri.xml', weight: 1.0 },
  { name: 'MynetFinans',      url: 'https://www.mynet.com/rss/finans.xml', weight: 0.8 },
  { name: 'BloombergHT',      url: 'https://www.bloomberght.com/rss', weight: 1.1 },
  { name: 'Dunya',            url: 'https://www.dunya.com/rss?dunya/borsa-finans', weight: 0.9 },
  { name: 'Sabah',            url: 'https://www.sabah.com.tr/rss/ekonomi.xml', weight: 0.7 },
];

// ──────────────────────────────────────────────────────────────
// Category lexicon — Turkish stock-news patterns
// Each entry: { pattern: RegExp, weight: -10..+10, label: string }
// ──────────────────────────────────────────────────────────────
const CATEGORY_RULES = [
  // FUND INFLOW — kurumsal/yabanci para girisi
  { cat: 'fund_inflow', label: 'Para Girisi',
    pat: /(yabanci\s+alim|kurumsal\s+alim|para\s+giris|fon\s+akis|net\s+giris|alim\s+yogunla|net\s+alimci|portfoy\s+girisi)/i,
    weight: 5 },
  // FUNDAMENTAL RANKINGS — "en karli", "cari oran", siralama
  { cat: 'fundamental_rank', label: 'Temel Siralama',
    pat: /(en\s+karli|en\s+yuksek|cari\s+oran|f\/k\s+oran|roe\s+siral|brut\s+kar|net\s+kar.*siral|en\s+iyi\s+\d+|likidite\s+oran|borc.*ozkayn)/i,
    weight: 3 },
  // BUYBACK
  { cat: 'buyback', label: 'Geri Alim',
    pat: /(geri\s+alim|hisse\s+geri.*alim|buyback|pay\s+geri.*alim)/i,
    weight: 6 },
  // INSIDER BUY
  { cat: 'insider_buy', label: 'Iceriden Alim',
    pat: /(iceriden\s+alim|yonetici\s+alim|yonetim\s+kurulu.*alim|sirket\s+ortagi.*alim|hakim\s+ortak.*alim)/i,
    weight: 7 },
  // DIVIDEND
  { cat: 'dividend', label: 'Temettu',
    pat: /(temettu|kar\s+payi|nakit\s+kar\s+payi|brüt\s+kar\s+payi)/i,
    weight: 4 },
  // ANALYST UPGRADE
  { cat: 'upgrade', label: 'Tavsiye Yukseldi',
    pat: /(hedef\s+fiyat.*yukselt|hedef\s+fiyat.*art|al\s+tavsiy|agirlik\s+art|onerild|tavsiye\s+yukselt)/i,
    weight: 5 },
  // ANALYST DOWNGRADE
  { cat: 'downgrade', label: 'Tavsiye Dustu',
    pat: /(hedef\s+fiyat.*dusur|hedef\s+fiyat.*indir|sat\s+tavsiy|agirlik\s+azal|tavsiye\s+dusur)/i,
    weight: -5 },
  // CONTRACT / ORDER
  { cat: 'contract', label: 'Sozlesme',
    pat: /(sozlesme\s+imzala|ihale\s+kazand|yeni\s+siparis|anlasma\s+imzala|kontrat\s+imzala)/i,
    weight: 4 },
  // RISK / NEGATIVE
  { cat: 'risk', label: 'Risk',
    pat: /(sorusturma|ceza\s+kesi|dava\s+acil|haciz|iflas|konkordato|uretim\s+durdu|temerrut|kredi.*indir)/i,
    weight: -7 },
  // SECTOR-WIDE BULL
  { cat: 'sector_bull', label: 'Sektorel Yukselis',
    pat: /(sektor.*pozitif|sektor.*rekor|sektor.*yukselis|hisselerinde\s+rali)/i,
    weight: 2 },
];

// Strip Turkish diacritics + lowercase for tolerant matching
function _normalize(s) {
  return String(s || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

// ──────────────────────────────────────────────────────────────
// Symbol detection — match BIST tickers (4-5 uppercase letters)
// surrounded by word boundaries.
// Pass `universe` array to restrict matches to known tickers.
// ──────────────────────────────────────────────────────────────
export function extractSymbols(text, universe = null) {
  if (!text) return [];
  const found = new Set();
  // BIST tickers: 4 or 5 uppercase ASCII letters (no digits — except a few like A1CAP, but those start with letter)
  const re = /\b([A-Z]{4,6})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1];
    if (universe && Array.isArray(universe)) {
      if (universe.includes(candidate)) found.add(candidate);
    } else {
      // Without universe filter, exclude common Turkish ALL-CAPS words and orgs
      const blacklist = new Set([
        'BIST', 'BİST', 'BORSA', 'KAP', 'TCMB', 'SPK', 'TUFE', 'UFE',
        'EURO', 'DOLAR', 'TURK', 'TURKIYE', 'TURKİYE', 'ISTANBUL', 'ANKARA',
        'OECD', 'IMF', 'NATO', 'BDDK', 'EPDK', 'BMD', 'GMK', 'ABCD',
        'ABD', 'ALMAN', 'CIN', 'CNBC', 'OECD', 'PMI', 'SWAP', 'AKSAM',
      ]);
      if (!blacklist.has(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

// ──────────────────────────────────────────────────────────────
// Classify a news item — returns {categories, sentiment, impact}
// ──────────────────────────────────────────────────────────────
export function classifyNewsItem(item) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const lc = text.toLocaleLowerCase('tr-TR');
  const categories = [];
  let sentiment = 0;
  for (const rule of CATEGORY_RULES) {
    if (rule.pat.test(lc)) {
      categories.push({ cat: rule.cat, label: rule.label });
      sentiment += rule.weight;
    }
  }
  // Recency multiplier
  const daysAgo = item.date ? (Date.now() - new Date(item.date).getTime()) / 86400000 : 3;
  const recencyMul = daysAgo <= 1 ? 1.5 : daysAgo <= 3 ? 1.2 : daysAgo <= 7 ? 1.0 : 0.5;
  const finalSent = Math.max(-10, Math.min(10, sentiment * recencyMul));
  const impact = Math.abs(sentiment) >= 6 ? 'high' : Math.abs(sentiment) >= 3 ? 'medium' : 'low';
  return { categories, sentiment: +finalSent.toFixed(2), impact, daysAgo: +daysAgo.toFixed(1) };
}

// ──────────────────────────────────────────────────────────────
// fetchMarketNews — pulls items from configured RSS sources,
// classifies them, returns a unified array.
// ──────────────────────────────────────────────────────────────
export async function fetchMarketNews({ sources = DEFAULT_NEWS_SOURCES, maxPerSource = 20, universe = null } = {}) {
  const cacheKey = 'mkt:' + sources.map(s => s.name).join(',') + (universe ? `:${universe.length}` : '');
  const c = _cacheGet(cacheKey); if (c) return c;

  const arrays = await Promise.all(sources.map(async (s) => {
    try {
      const items = await fetchRss(s.url);
      return (items || []).slice(0, maxPerSource).map(it => ({
        ...it,
        source: s.name,
        sourceWeight: s.weight,
      }));
    } catch { return []; }
  }));
  const flat = arrays.flat();

  const enriched = flat.map(it => {
    const klass = classifyNewsItem(it);
    const symbols = extractSymbols(`${it.title} ${it.summary}`, universe);
    return { ...it, ...klass, symbols };
  }).filter(it => it.title);

  // Sort by recency desc
  enriched.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  _cacheSet(cacheKey, enriched);
  return enriched;
}

// ──────────────────────────────────────────────────────────────
// indexBySymbol — group enriched news per symbol, with aggregate
// sentiment per symbol (used by signal engine + Claude prompt).
// ──────────────────────────────────────────────────────────────
export function indexBySymbol(enrichedNews) {
  const idx = {};
  for (const item of enrichedNews) {
    if (!item.symbols?.length) continue;
    for (const sym of item.symbols) {
      if (!idx[sym]) idx[sym] = { symbol: sym, items: [], score: 0, categories: new Set(), highImpact: 0 };
      idx[sym].items.push(item);
      idx[sym].score += item.sentiment * (item.sourceWeight || 1);
      for (const c of item.categories || []) idx[sym].categories.add(c.cat);
      if (item.impact === 'high') idx[sym].highImpact += 1;
    }
  }
  // Finalize
  for (const sym of Object.keys(idx)) {
    const e = idx[sym];
    e.score = Math.max(-10, Math.min(10, +e.score.toFixed(2)));
    e.categories = [...e.categories];
    e.count = e.items.length;
    e.topItem = e.items.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))[0] || null;
  }
  return idx;
}

// ──────────────────────────────────────────────────────────────
// formatForJarvis — short, prompt-ready string per symbol
// ──────────────────────────────────────────────────────────────
export function formatNewsForPrompt(symbolIndex, symbol) {
  const e = symbolIndex?.[symbol];
  if (!e || !e.count) return '';
  const cats = e.categories.length ? `[${e.categories.join(',')}]` : '';
  const sign = e.score >= 0 ? '+' : '';
  const top = e.topItem ? `"${e.topItem.title.slice(0, 70)}"` : '';
  return `HABER ${cats} skor=${sign}${e.score} (${e.count} haber): ${top}`;
}

// ──────────────────────────────────────────────────────────────
// fetchSymbolMarketNews(symbol, opts) — convenience: returns the
// indexed entry for one symbol, ready to feed into genSignal as
// `kapSentiment`-equivalent context.
// ──────────────────────────────────────────────────────────────
export async function fetchSymbolMarketNews(symbol, opts = {}) {
  const sym = String(symbol || '').toUpperCase();
  const all = await fetchMarketNews({ ...opts, universe: opts.universe || [sym] });
  const idx = indexBySymbol(all);
  return idx[sym] || { symbol: sym, items: [], score: 0, categories: [], count: 0, topItem: null, highImpact: 0 };
}

export default {
  fetchMarketNews,
  fetchSymbolMarketNews,
  indexBySymbol,
  classifyNewsItem,
  extractSymbols,
  formatNewsForPrompt,
  DEFAULT_NEWS_SOURCES,
};
