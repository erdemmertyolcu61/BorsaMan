import { smartFetch } from './fetchEngine.js';

// ============================================================
// KAP SENTIMENT SCORING ENGINE
// Analyzes KAP disclosures and produces a sentiment score
// that feeds directly into the signal engine
// ============================================================

// Keyword-based sentiment analysis for KAP disclosures
const POSITIVE_KEYWORDS = [
  'sozlesme', 'ihale kazanildi', 'kar payi', 'temettu', 'sermaye artirimi',
  'bedelsiz', 'kredi notu yukseltildi', 'gelir artisi', 'kapasite artirimi',
  'yeni yatirim', 'ortaklik', 'is birligi', 'geri alim', 'pay geri alim',
  'pozitif', 'yukselis', 'rekor', 'buyume', 'kar artisi', 'ciro artisi',
  'net kar', 'brut kar', 'faaliyet kari', 'siparis', 'ihracat',
];
const NEGATIVE_KEYWORDS = [
  'uretim durusu', 'zarar', 'karsiliksiz', 'tahsil edilemeyen',
  'ihale kaybedildi', 'ceza', 'dava', 'haciz', 'iflas', 'konkordato',
  'istifa', 'azaltma', 'not indirimi', 'negatif', 'dusus', 'risk',
  'supheli alacak', 'sermaye azaltimi', 'kayip', 'sorusturma',
  'temerrut', 'gecikme', 'feragat', 'iptal',
];
const HIGH_IMPACT_KEYWORDS = [
  'sermaye artirimi', 'bedelsiz', 'birlesme', 'devir', 'halka arz',
  'kar payi', 'temettu', 'kredi notu', 'uretim durusu', 'iflas',
  'konkordato', 'sozlesme', 'ihale',
];

// Score a single KAP disclosure: returns {score: -10..+10, impact: 'high'|'medium'|'low'}
function scoreDisclosure(disclosure) {
  const text = ((disclosure.title || '') + ' ' + (disclosure.summary || '')).toLowerCase();
  let sentiment = 0;
  let isHighImpact = false;

  for (const kw of POSITIVE_KEYWORDS) {
    if (text.includes(kw)) sentiment += 2;
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (text.includes(kw)) sentiment -= 2;
  }
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (text.includes(kw)) isHighImpact = true;
  }

  // Recency weight: newer disclosures matter more
  const daysAgo = disclosure.date ? (Date.now() - new Date(disclosure.date).getTime()) / 86400000 : 7;
  const recencyMul = daysAgo <= 1 ? 1.5 : daysAgo <= 3 ? 1.2 : daysAgo <= 7 ? 1.0 : 0.6;

  // Impact multiplier
  const impactMul = isHighImpact ? 1.5 : 1.0;

  const raw = sentiment * recencyMul * impactMul;
  return {
    score: Math.max(-10, Math.min(10, raw)),
    impact: isHighImpact ? 'high' : Math.abs(sentiment) >= 4 ? 'medium' : 'low',
  };
}

// Aggregate KAP sentiment for signal integration
// Returns: {score: -10..+10, headline: string, count: number, details: []}
export function calcKAPSentiment(disclosures) {
  if (!disclosures || disclosures.length === 0) {
    return { score: 0, headline: '', count: 0, details: [] };
  }

  const details = disclosures.map(d => {
    const s = scoreDisclosure(d);
    return { ...d, sentimentScore: s.score, impact: s.impact };
  });

  // Weighted sum (cap at +/- 10)
  const totalScore = details.reduce((sum, d) => sum + d.sentimentScore, 0);
  const clampedScore = Math.max(-10, Math.min(10, totalScore));

  // Find the most impactful headline
  const sorted = [...details].sort((a, b) => Math.abs(b.sentimentScore) - Math.abs(a.sentimentScore));
  const topHeadline = sorted[0]?.title || '';

  return {
    score: clampedScore,
    headline: topHeadline,
    count: disclosures.length,
    details,
  };
}

const OID_CACHE_KEY = 'kap_oid_map_v1';

function getOidCache() {
  try {
    const saved = localStorage.getItem(OID_CACHE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveOidCache(map) {
  try { localStorage.setItem(OID_CACHE_KEY, JSON.stringify(map)); } catch {}
}

const PRE_MAPPING = {
  'ASELS': '4028e4a140f2ed090140f3408f650041',
  'THYAO': '4028e4a140f2ed090140f33967060002',
  'TUPRS': '4028e4a140f2ed090140f340ba70004c',
  'EREGL': '4028e4a140f2ed090140f33bb694001c',
  'AKBNK': '4028e4a140f2ed090140f33887010001',
  'GARAN': '4028e4a140f2ed090140f33bce300021'
};

async function resolveMemberOid(symbol) {
  if (PRE_MAPPING[symbol]) return PRE_MAPPING[symbol];
  const cache = getOidCache();
  if (cache[symbol]) return cache[symbol];

  const listUrl = 'https://www.kap.org.tr/tr/bist-sirketler';
  
  // Try local proxy first
  let html = null;
  if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      const res = await fetch('/api/kap/tr/bist-sirketler');
      if (res.ok) html = await res.text();
    } catch {}
  }
  
  if (!html) {
    html = await smartFetch(listUrl, 15000);
  }
  if (!html) return null;

  const re = /"mkkMemberOid":"([^"]+)","[^"]*stockCode":"([^"]+)"/g;
  let match;
  let foundOid = null;
  const newMap = { ...cache };
  
  while ((match = re.exec(html)) !== null) {
    newMap[match[2]] = match[1];
    if (match[2] === symbol) foundOid = match[1];
  }
  
  saveOidCache(newMap);
  return foundOid;
}

export async function fetchKAPDisclosures(symbol) {
  try {
    const oid = await resolveMemberOid(symbol);
    if (!oid) return [];

    const drillUrl = `https://www.kap.org.tr/tr/bildirim-sorgu-sonuc?member=${oid}`;
    
    let html = null;
    if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try {
        const res = await fetch(`/api/kap/tr/bildirim-sorgu-sonuc?member=${oid}`);
        if (res.ok) html = await res.text();
      } catch {}
    }
    
    if (!html) {
      html = await smartFetch(drillUrl, 12000);
    }
    if (!html) return [];

    // Improved regex to capture subject/summary if available
    // Fields: publishDate, disclosureIndex, title, subject
    const discRe = /"publishDate":"([^"]+)".*?"disclosureIndex":(\d+).*?"title":"([^"]+)".*?"subject":"([^"]*)"/g;
    const results = [];
    let match;
    let count = 0;

    while ((match = discRe.exec(html)) !== null && count < 6) {
      const pubDate = match[1];
      const index = match[2];
      const title = match[3];
      const subject = match[4] || '';

      let dateObj = new Date();
      try {
        const parts = pubDate.split(' ');
        const dp = parts[0].split('.');
        const tp = parts[1].split(':');
        dateObj = new Date(parseInt(dp[2]), parseInt(dp[1]) - 1, parseInt(dp[0]), parseInt(tp[0]), parseInt(tp[1]), parseInt(tp[2]));
      } catch {}

      results.push({
        id: index,
        date: dateObj.toISOString(),
        title: title.replace(/\\"/g, '"'),
        summary: subject ? subject.replace(/\\"/g, '"') : `Detayli bilgi için linke tıklayın.`,
        link: `https://www.kap.org.tr/tr/bildirim/${index}`
      });
      count++;
    }

    // Fallback if the subject-extended regex didn't match anything (older format)
    if (results.length === 0) {
      const simpleRe = /"publishDate":"([^"]+)".*?"disclosureIndex":(\d+).*?"title":"([^"]+)"/g;
      let sMatch;
      while ((sMatch = simpleRe.exec(html)) !== null && count < 6) {
        results.push({
          id: sMatch[2],
          date: new Date().toISOString(), // fallback date
          title: sMatch[3].replace(/\\"/g, '"'),
          summary: `KAP Bildirimi (ID: ${sMatch[2]})`,
          link: `https://www.kap.org.tr/tr/bildirim/${sMatch[2]}`
        });
        count++;
      }
    }

    return results;
  } catch (err) {
    console.error('KAP integration failed:', err);
    return [];
  }
}

/**
 * fetchKAPSummaryFinancials - Fetches structured financial highlights from KAP JSON API
 * @param {string} symbol - BIST stock code
 */
export async function fetchKAPSummaryFinancials(symbol) {
  try {
    const oid = await resolveMemberOid(symbol);
    if (!oid) return null;

    // KAP Summary Financials API
    const apiUrl = `https://www.kap.org.tr/tr/api/ozetFinansalBilgiler?mkkSirketOid=${oid}`;
    
    let text = null;
    if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try {
        const res = await fetch(`/api/kap/tr/api/ozetFinansalBilgiler?mkkSirketOid=${oid}`);
        if (res.ok) text = await res.text();
      } catch {}
    }
    
    if (!text) {
      text = await smartFetch(apiUrl, 15000);
    }
    if (!text) return null;

    const data = JSON.parse(text);
    if (!data || !data.ozetFinansalBilgiList) return null;

    const list = data.ozetFinansalBilgiList;
    const periods = data.donemler || []; // e.g. ["2022/12", "2023/12", "2024/12", "2025/12"]

    const findItem = (label) => list.find(item => item.kalemAd && item.kalemAd.toLowerCase().includes(label.toLowerCase()));

    // Map Turkish labels to standard keys
    const revenueItem = findItem('Hasılat') || findItem('Satış Gelirleri');
    const netIncItem = findItem('Net Dönem Karı (Zararı)') || findItem('Net Dönem Karı');
    const equityItem = findItem('Ana Ortaklığa Ait Özkaynaklar') || findItem('Toplam Özkaynaklar');
    const assetsItem = findItem('Toplam Varlıklar');
    const liabItem = findItem('Toplam Yükümlülükler');

    // Values in degerler: [P1, P2, P3, P4] (P4 is latest)
    const getVal = (item, idx) => {
      if (!item || !item.degerler || !item.degerler[idx]) return 0;
      // Convert "106.118.918" -> 106118918
      const raw = item.degerler[idx].replace(/\./g, '');
      return parseFloat(raw) || 0;
    };

    const latestIdx = periods.length - 1;
    const prevIdx = latestIdx - 1;

    if (latestIdx < 0) return null;

    // Scale factor: KAP often uses "1000TL" unit
    const scale = data.paraBirimi === '1000TL' ? 1000 : 1;

    return {
      source: 'KAP (Official)',
      periods: periods.slice(-2),
      latest: {
        revenue: getVal(revenueItem, latestIdx) * scale,
        netIncome: getVal(netIncItem, latestIdx) * scale,
        equity: getVal(equityItem, latestIdx) * scale,
        assets: getVal(assetsItem, latestIdx) * scale,
        liabilities: getVal(liabItem, latestIdx) * scale,
      },
      previous: {
        revenue: getVal(revenueItem, prevIdx) * scale,
        netIncome: getVal(netIncItem, prevIdx) * scale,
        equity: getVal(equityItem, prevIdx) * scale,
      }
    };
  } catch (err) {
    console.error('KAP Summary fetch failed:', err);
    return null;
  }
}
