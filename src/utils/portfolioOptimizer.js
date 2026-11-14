// ============================================================
// MARKOWITZ PORTFOLIO OPTIMIZER (Mean-Variance)
// ------------------------------------------------------------
// Verilen sembollerin tarihsel kapanis serileri uzerinden:
//   1. Log getiri matrisi
//   2. Annualized expected return vector
//   3. Annualized covariance matrix
//   4. Random-search frontier (10K Dirichlet samples) ile:
//        - max Sharpe portfoy
//        - min variance portfoy
//        - target-return portfoy (opsiyonel)
//   5. Diversification score (1 - max(weight) ve effective N)
//
// Net BIST kullanimi: portfoy ag1rliklarini onerir, tek hisseye
// asiri yogunlasmayi engeller, korelasyon farkindaligi katar.
//
// Pure module — JS Math only, no external deps.
// ============================================================

const TRADING_DAYS = 252;
       // Dirichlet samples for frontier search

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      out.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  return out;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0;
}

function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (n - 1);
}

/**
 * buildReturnMatrix(seriesByAsset)
 * @param seriesByAsset {Record<string, number[]>}  // symbol -> closing prices
 * @returns { symbols, alignedReturns, expectedReturns, covMatrix }
 *   alignedReturns: {symbol -> daily log-returns trimmed to common length}
 *   expectedReturns: annualized mean log-return per symbol
 *   covMatrix: annualized covariance matrix (symbol order)
 */
export function buildReturnMatrix(seriesByAsset) {
  const symbols = Object.keys(seriesByAsset);
  if (!symbols.length) return { symbols: [], alignedReturns: {}, expectedReturns: [], covMatrix: [] };

  // Compute log returns for each
  const rawReturns = {};
  for (const s of symbols) rawReturns[s] = logReturns(seriesByAsset[s] || []);

  // Trim to shortest common length (align at the end — most recent overlap)
  const minLen = Math.min(...symbols.map(s => rawReturns[s].length));
  if (minLen < 2) {
    return { symbols, alignedReturns: rawReturns, expectedReturns: symbols.map(() => 0), covMatrix: symbols.map(() => symbols.map(() => 0)) };
  }
  const aligned = {};
  for (const s of symbols) aligned[s] = rawReturns[s].slice(rawReturns[s].length - minLen);

  // Annualized expected returns
  const expectedReturns = symbols.map(s => mean(aligned[s]) * TRADING_DAYS);

  // Annualized covariance matrix
  const n = symbols.length;
  const cov = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(covariance(aligned[symbols[i]], aligned[symbols[j]]) * TRADING_DAYS);
    }
    cov.push(row);
  }
  return { symbols, alignedReturns: aligned, expectedReturns, covMatrix: cov };
}

/**
 * highCorrelationPairs — derive correlation from a covariance matrix and return
 * the pairs whose absolute correlation exceeds `threshold`. Two highly-correlated
 * holdings are effectively one bet; flag them so the user can de-duplicate.
 * @returns array of { a, b, corr } sorted by descending |corr|
 */
export function highCorrelationPairs(symbols, covMatrix, threshold = 0.80) {
  const out = [];
  if (!Array.isArray(symbols) || !Array.isArray(covMatrix)) return out;
  const n = symbols.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const denom = Math.sqrt((covMatrix[i]?.[i] || 0) * (covMatrix[j]?.[j] || 0));
      if (denom <= 0) continue;
      const corr = covMatrix[i][j] / denom;
      if (Math.abs(corr) >= threshold) {
        out.push({ a: symbols[i], b: symbols[j], corr: +corr.toFixed(3) });
      }
    }
  }
  return out.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));
}

/**
 * correlationCapFilter — greedy de-duplication for a candidate pick list.
 * Walks candidates in priority order (best first) and drops any whose return
 * series correlates above `threshold` with an already-accepted pick. Keeps the
 * portfolio of recommendations from being many copies of the same bet.
 * @param candidates array of { symbol, series: number[] } in priority order
 * @returns { kept: [...], dropped: [{ symbol, conflictsWith, corr }] }
 */
export function correlationCapFilter(candidates, threshold = 0.85) {
  const kept = [];
  const dropped = [];
  for (const c of candidates || []) {
    if (!c?.series || c.series.length < 5) { kept.push(c); continue; }
    let conflict = null;
    for (const k of kept) {
      if (!k?.series || k.series.length < 5) continue;
      const corr = pearson(c.series, k.series);
      if (corr != null && Math.abs(corr) >= threshold) { conflict = { with: k.symbol, corr: +corr.toFixed(3) }; break; }
    }
    if (conflict) dropped.push({ symbol: c.symbol, conflictsWith: conflict.with, corr: conflict.corr });
    else kept.push(c);
  }
  return { kept, dropped };
}

// Pearson correlation on two equal-length-aligned numeric series (tail-aligned).
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const xa = a.slice(a.length - n);
  const xb = b.slice(b.length - n);
  const ma = mean(xa), mb = mean(xb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const u = xa[i] - ma, v = xb[i] - mb;
    num += u * v; da += u * u; db += v * v;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : null;
}

