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
const SAMPLES = 6000;       // Dirichlet samples for frontier search
const RF_RATE = 0.25;       // TR risksiz faiz benchmark (%25 yillik — TCMB)

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

function portfolioStats(weights, expectedReturns, covMatrix) {
  const n = weights.length;
  let pReturn = 0;
  for (let i = 0; i < n; i++) pReturn += weights[i] * expectedReturns[i];
  let pVar = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pVar += weights[i] * weights[j] * covMatrix[i][j];
    }
  }
  const pStd = Math.sqrt(Math.max(0, pVar));
  const sharpe = pStd > 0 ? (pReturn - RF_RATE) / pStd : 0;
  return { return: pReturn, variance: pVar, stdev: pStd, sharpe };
}

// Dirichlet(α=1) sample = normalized iid exponentials.
function sampleDirichlet(n) {
  const w = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    // Exp(1) via -log(U)
    const u = Math.random() || 1e-9;
    w[i] = -Math.log(u);
    sum += w[i];
  }
  for (let i = 0; i < n; i++) w[i] /= sum;
  return w;
}

function diversificationScore(weights) {
  // Effective N (inverse Herfindahl) → ideal == n, worst == 1
  let h = 0;
  for (const w of weights) h += w * w;
  const effectiveN = h > 0 ? 1 / h : 0;
  const maxW = Math.max(...weights);
  const evenness = 1 - maxW; // 1 = perfectly even, 0 = single asset
  return { effectiveN, maxWeight: maxW, evenness };
}

/**
 * optimizePortfolio(seriesByAsset, opts)
 * Random-search Dirichlet frontier — finds:
 *   - maxSharpe portfolio
 *   - minVariance portfolio
 *   - (optional) targetReturn portfolio: closest to opts.targetReturn
 *
 * @param opts.samples   number of random portfolios (default 6000)
 * @param opts.maxWeight cap per asset (e.g., 0.3 = max 30% in one asset)
 * @param opts.targetReturn optional annualized return target
 */
export function optimizePortfolio(seriesByAsset, opts = {}) {
  const samples = opts.samples || SAMPLES;
  const maxWeight = opts.maxWeight ?? 0.40;
  const matrix = buildReturnMatrix(seriesByAsset);
  const { symbols, expectedReturns, covMatrix } = matrix;
  const n = symbols.length;
  if (n === 0) return { error: 'no_symbols' };
  if (n === 1) {
    const w = [1];
    const stats = portfolioStats(w, expectedReturns, covMatrix);
    return {
      symbols, expectedReturns, covMatrix,
      maxSharpe: { weights: w, ...stats, ...diversificationScore(w) },
      minVariance: { weights: w, ...stats, ...diversificationScore(w) },
      targetReturn: null,
      frontier: [{ weights: w, ...stats }],
    };
  }

  let best = null;        // max sharpe
  let minVar = null;      // min variance
  let nearestTarget = null;
  const frontier = [];

  for (let s = 0; s < samples; s++) {
    let w = sampleDirichlet(n);
    // Apply maxWeight cap with iterative water-filling:
    // clip caps, redistribute deficit only across uncapped slots, repeat until stable.
    if (maxWeight < 1 && maxWeight * n >= 1) {
      for (let iter = 0; iter < 8; iter++) {
        let overflow = 0;
        const capped = new Array(n).fill(false);
        for (let i = 0; i < n; i++) {
          if (w[i] > maxWeight) { overflow += w[i] - maxWeight; w[i] = maxWeight; capped[i] = true; }
        }
        if (overflow < 1e-9) break;
        let freeSum = 0;
        for (let i = 0; i < n; i++) if (!capped[i]) freeSum += w[i];
        if (freeSum <= 0) break;
        for (let i = 0; i < n; i++) if (!capped[i]) w[i] += overflow * (w[i] / freeSum);
      }
    }
    const stats = portfolioStats(w, expectedReturns, covMatrix);
    if (s % Math.floor(samples / 60) === 0) frontier.push({ weights: [...w], ...stats });

    if (!best || stats.sharpe > best.sharpe) best = { weights: [...w], ...stats };
    if (!minVar || stats.variance < minVar.variance) minVar = { weights: [...w], ...stats };
    if (opts.targetReturn != null) {
      const dist = Math.abs(stats.return - opts.targetReturn);
      if (!nearestTarget || dist < nearestTarget._dist) nearestTarget = { weights: [...w], ...stats, _dist: dist };
    }
  }

  const decorate = (p) => p ? { ...p, ...diversificationScore(p.weights) } : null;

  return {
    symbols,
    expectedReturns,
    covMatrix,
    maxSharpe: decorate(best),
    minVariance: decorate(minVar),
    targetReturn: decorate(nearestTarget),
    frontier,
  };
}

/**
 * weightsToAllocations — converts decimal weights into TL allocations
 * @param weights array of decimals summing to ~1
 * @param symbols array of tickers
 * @param totalCapital TL amount
 */
export function weightsToAllocations(weights, symbols, totalCapital) {
  const out = [];
  for (let i = 0; i < symbols.length; i++) {
    out.push({
      symbol: symbols[i],
      weight: +weights[i].toFixed(4),
      pctLabel: (weights[i] * 100).toFixed(1) + '%',
      tlAllocation: Math.round(weights[i] * totalCapital),
    });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

/**
 * correlationMatrix — quick utility for UI display
 */
export function correlationMatrix(seriesByAsset) {
  const { symbols, alignedReturns } = buildReturnMatrix(seriesByAsset);
  const n = symbols.length;
  const mat = [];
  const stds = symbols.map(s => {
    const arr = alignedReturns[s];
    if (!arr || arr.length < 2) return 0;
    const m = mean(arr);
    const v = arr.reduce((a, x) => a + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
  });
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const c = covariance(alignedReturns[symbols[i]], alignedReturns[symbols[j]]);
      const denom = stds[i] * stds[j];
      row.push(denom > 0 ? +(c / denom).toFixed(3) : 0);
    }
    mat.push(row);
  }
  return { symbols, matrix: mat };
}
