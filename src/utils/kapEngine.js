import { isKapAvailable, isKapFeedAvailable, kapUnavailableDisclosures } from './kapAvailability.js';
import { fetchKapForSymbol, describeKapFailure } from './kapFeed.js';

// ============================================================
// KAP SENTIMENT SCORING ENGINE
// Analyzes KAP disclosures and produces a sentiment score.
// v31.38: whether that score may reach genSignal is decided by
// dataLayerPolicy (currently NO — display and measurement only).
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

/**
 * One company's recent KAP disclosures.
 *
 * v31.38: rebuilt on kapFeed (KAP's JSON list endpoint, queried by mkkMemberOid).
 * The old path scraped the HTML result page with a hard-coded OID table — and
 * that table was WRONG (THYAO's real mkkMemberOid is a different id), which is
 * part of why this panel stayed empty. Routine filings (bond issuance, forms)
 * are dropped. On failure the array is flagged `unavailable` with a reason, so
 * the UI never presents "could not reach KAP" as "no disclosures".
 */
export async function fetchKAPDisclosures(symbol, { days = 30, limit = 12 } = {}) {
  if (!isKapFeedAvailable()) return kapUnavailableDisclosures();
  const res = await fetchKapForSymbol(symbol, { days });
  if (!res.ok) return kapUnavailableDisclosures(describeKapFailure(res.reason));
  return res.items
    .filter(it => it.cls?.kind !== 'noise')
    .slice(0, limit)
    .map(it => ({
      id: it.id,
      date: new Date(it.ts).toISOString(),
      title: it.title,
      summary: it.summary || it.title,
      link: it.url,
      kind: it.cls?.kind || 'info',
      label: it.cls?.label || '',
    }));
}

/**
 * fetchKAPSummaryFinancials — structured financial highlights from KAP.
 * The `api/ozetFinansalBilgiler` route returned 404 (measured 2026-09-07) and no
 * replacement has been found, so this reports "no data" instead of guessing.
 */
export async function fetchKAPSummaryFinancials(symbol) {
  if (!isKapAvailable() || !symbol) return null;
  return null;
}
