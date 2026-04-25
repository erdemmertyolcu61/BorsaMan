/**
 * fundamentalEngine.js - BIST fundamental analysis engine
 *
 * Exports:
 *   - analyzeDetailedFinancials(raw)        -> { score, grossMargin, opMargin, netMargin, roe, roa, profitTrend, reasons }
 *   - getFundamentalGrade(score)            -> { label, color }   (A+/A/B/C/D)
 *   - analyzeComprehensiveFinancials(y, k)  -> { source, marketCap, pe, pb, divYield, roe, grossMargin, opMargin, profitTrend, score, grade }
 */

const num = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * analyzeDetailedFinancials
 * Accepts a raw fundamentals object (flexible shape — supports KAP-style and Yahoo-style fields).
 * Returns a scored breakdown with fundamental health metrics.
 */
export function analyzeDetailedFinancials(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  // Accept multiple field aliases
  const revenue = num(raw.revenue ?? raw.totalRevenue ?? raw.hasilat);
  const grossProfit = num(raw.grossProfit ?? raw.brutKar);
  const operatingIncome = num(raw.operatingIncome ?? raw.faaliyetKari ?? raw.opIncome);
  const netIncome = num(raw.netIncome ?? raw.netKar);
  const equity = num(raw.equity ?? raw.totalEquity ?? raw.ozkaynak);
  const totalAssets = num(raw.totalAssets ?? raw.toplamVarlik);
  const totalDebt = num(raw.totalDebt ?? raw.toplamBorc);
  const currentAssets = num(raw.currentAssets ?? raw.donenVarlik);
  const currentLiab = num(raw.currentLiabilities ?? raw.kisaVadeliYukum);

  // Margins
  const grossMargin = (revenue != null && revenue > 0 && grossProfit != null) ? (grossProfit / revenue) * 100 : null;
  const opMargin    = (revenue != null && revenue > 0 && operatingIncome != null) ? (operatingIncome / revenue) * 100 : null;
  const netMargin   = (revenue != null && revenue > 0 && netIncome != null) ? (netIncome / revenue) * 100 : null;

  // Returns
  const roe = (equity && netIncome != null && equity > 0) ? (netIncome / equity) * 100 : null;
  const roa = (totalAssets && netIncome != null && totalAssets > 0) ? (netIncome / totalAssets) * 100 : null;

  // Leverage / liquidity
  const debtToEquity = (equity && totalDebt != null && equity > 0) ? totalDebt / equity : null;
  const currentRatio = (currentLiab && currentAssets != null && currentLiab > 0) ? currentAssets / currentLiab : null;

  // Profit trend from last 3 quarters if provided (raw.quarterlyNet = [q1,q2,q3])
  let profitTrend = 'NEUTRAL';
  const qn = Array.isArray(raw.quarterlyNet) ? raw.quarterlyNet.map(num).filter(v => v != null) : null;
  if (qn && qn.length >= 3) {
    const [q1, q2, q3] = qn.slice(-3);
    if (q3 > q2 && q2 > q1) profitTrend = 'IMPROVING';
    else if (q3 < q2 && q2 < q1) profitTrend = 'DECLINING';
    else if (q3 > q1) profitTrend = 'RECOVERING';
    else profitTrend = 'MIXED';
  }

  // Scoring 0..10 with 15+ thresholds
  let score = 5;
  const reasons = [];

  if (grossMargin != null) {
    if (grossMargin > 40) { score += 0.7; reasons.push('Brut marj guclu (>%40)'); }
    else if (grossMargin > 25) { score += 0.4; reasons.push('Brut marj iyi'); }
    else if (grossMargin < 5)  { score -= 1.0; reasons.push('Brut marj kritik'); }
    else if (grossMargin < 10) { score -= 0.6; reasons.push('Brut marj zayif (<%10)'); }
  }

  if (opMargin != null) {
    if (opMargin > 15) { score += 0.7; reasons.push('Op. marj cazip (>%15)'); }
    else if (opMargin > 5) { score += 0.3; }
    else if (opMargin < 0) { score -= 0.8; reasons.push('Op. zarar'); }
  }

  if (netMargin != null) {
    if (netMargin > 10) { score += 0.5; reasons.push('Net marj >%10'); }
    else if (netMargin < 0) { score -= 0.8; reasons.push('Net zarar'); }
  }

  if (roe != null) {
    if (roe > 25) { score += 1.2; reasons.push('ROE ustun (>%25)'); }
    else if (roe > 15) { score += 0.8; reasons.push('ROE guclu (>%15)'); }
    else if (roe > 8)  { score += 0.3; }
    else if (roe < 0)  { score -= 1.0; reasons.push('ROE negatif'); }
  }

  if (roa != null) {
    if (roa > 10) { score += 0.5; }
    else if (roa < 0) { score -= 0.5; }
  }

  if (debtToEquity != null) {
    if (debtToEquity > 4)       { score -= 1.2; reasons.push('Kritik borc (D/E>4)'); }
    else if (debtToEquity > 2)  { score -= 0.8; reasons.push('Yuksek borc (D/E>2)'); }
    else if (debtToEquity < 0.3){ score += 0.3; }
  }

  if (currentRatio != null) {
    if (currentRatio > 2) { score += 0.3; }
    else if (currentRatio < 1) { score -= 0.6; reasons.push('Likidite riski'); }
  }

  if (profitTrend === 'IMPROVING') { score += 0.8; reasons.push('Net kar 3 ceyrek artiyor'); }
  else if (profitTrend === 'DECLINING') { score -= 0.8; reasons.push('Net kar 3 ceyrek duser'); }
  else if (profitTrend === 'RECOVERING') { score += 0.3; }

  score = Math.max(0, Math.min(10, score));

  return {
    score: Math.round(score * 10) / 10,
    grossMargin, opMargin, netMargin,
    roe, roa,
    debtToEquity, currentRatio,
    profitTrend,
    revenue, netIncome, equity,
    reasons,
  };
}

/**
 * getFundamentalGrade - convert numeric score to letter grade with color
 */
export function getFundamentalGrade(score) {
  if (score == null || !Number.isFinite(score)) return { label: '-', color: 'var(--t3)' };
  if (score >= 8.5) return { label: 'A+', color: 'var(--green)' };
  if (score >= 7.5) return { label: 'A',  color: 'var(--green)' };
  if (score >= 6.5) return { label: 'B+', color: 'var(--cyan)' };
  if (score >= 5.5) return { label: 'B',  color: 'var(--yellow)' };
  if (score >= 4)   return { label: 'C',  color: 'var(--orange)' };
  return { label: 'D', color: 'var(--red)' };
}

/**
 * analyzeComprehensiveFinancials - merge Yahoo + KAP fundamentals
 */
export function analyzeComprehensiveFinancials(yahoo = {}, kap = {}) {
  const hasY = yahoo && typeof yahoo === 'object' && Object.keys(yahoo).length;
  const hasK = kap && typeof kap === 'object' && Object.keys(kap).length;
  if (!hasY && !hasK) return null;

  const source = hasY ? (hasK ? 'Yahoo+KAP' : 'Yahoo') : 'KAP';

  const merged = {
    marketCap: num(yahoo?.marketCap),
    pe: num(yahoo?.pe ?? yahoo?.trailingPE),
    pb: num(yahoo?.pb ?? yahoo?.priceToBook),
    divYield: num(yahoo?.divYield ?? yahoo?.dividendYield),
    roe: num(kap?.roe ?? yahoo?.roe ?? yahoo?.returnOnEquity),
    beta: num(yahoo?.beta),
    ...(hasK ? kap : {}),
  };

  const detail = analyzeDetailedFinancials(merged) || {};
  const score = detail.score ?? scoreQuickFromYahoo(yahoo);
  const grade = getFundamentalGrade(score);

  return {
    source,
    marketCap: merged.marketCap,
    pe: merged.pe,
    pb: merged.pb,
    divYield: merged.divYield,
    roe: detail.roe ?? merged.roe,
    grossMargin: detail.grossMargin,
    opMargin: detail.opMargin,
    netMargin: detail.netMargin,
    debtToEquity: detail.debtToEquity,
    currentRatio: detail.currentRatio,
    profitTrend: detail.profitTrend,
    score,
    grade,
    reasons: detail.reasons || [],
  };
}

function scoreQuickFromYahoo(y) {
  if (!y) return 5;
  let s = 5;
  const pe = num(y.pe ?? y.trailingPE);
  const roe = num(y.roe ?? y.returnOnEquity);
  const pm = num(y.profitMargin);
  if (pe != null) {
    if (pe < 8)       s += 1;
    else if (pe < 15) s += 0.5;
    else if (pe > 30) s -= 0.8;
  }
  if (roe != null) {
    if (roe > 20)     s += 1;
    else if (roe > 10) s += 0.5;
    else if (roe < 0)  s -= 1;
  }
  if (pm != null) {
    if (pm > 15) s += 0.5;
    else if (pm < 0) s -= 0.8;
  }
  return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
}
