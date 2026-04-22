/**
 * monteCarlo.js - Monte Carlo simulation for BIST price projection
 *
 * Two entry points:
 *   runMonteCarlo(prices, days, sims)          — sync, blocks main thread (legacy)
 *   runMonteCarloAsync(prices, days, sims)     — off-thread via Web Worker (preferred)
 *
 * The async variant keeps the UI at 60fps even with 10,000+ paths.
 * A single worker instance is reused across calls; pending requests
 * are keyed by a monotonically-increasing id.
 *
 * Returns: {
 *   p5, p25, p50, p75, p95   // arrays of length (days+1), starting with lastPrice
 *   days, simulations,
 *   profitProb,              // 0..100 — % of paths that end above lastPrice
 *   median, worst5, best5,   // summary values at horizon
 *   lastPrice,
 *   mu, sigma                // log-return drift and volatility (daily)
 * }
 */
export function runMonteCarlo(prices, days = 20, simulations = 500) {
  if (!Array.isArray(prices) || prices.length < 10) {
    return null;
  }

  const lastPrice = prices[prices.length - 1];
  // Use last ~90 bars to estimate drift & vol
  const window = prices.slice(Math.max(0, prices.length - 90));
  const logReturns = [];
  for (let i = 1; i < window.length; i++) {
    const r = Math.log(window[i] / window[i - 1]);
    if (Number.isFinite(r)) logReturns.push(r);
  }
  if (logReturns.length < 5) return null;

  const mu = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mu) ** 2, 0) / logReturns.length;
  const sigma = Math.sqrt(variance);

  // Cap absurdly high volatility (e.g. data spikes) and dampen extreme drift
  const mcMu = Math.max(-0.02, Math.min(0.02, mu));
  const mcSigma = Math.max(0.005, Math.min(0.08, sigma));

  // Run N paths: price_t = price_{t-1} * exp(mu - 0.5*sigma^2 + sigma*Z)
  const endPrices = [];
  const pathMatrix = []; // pathMatrix[day] = array of prices across simulations

  for (let d = 0; d <= days; d++) pathMatrix.push([]);

  for (let s = 0; s < simulations; s++) {
    let price = lastPrice;
    pathMatrix[0].push(price);
    for (let d = 1; d <= days; d++) {
      // Box-Muller for standard normal
      const u1 = Math.max(1e-9, Math.random());
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      price = price * Math.exp(mcMu - 0.5 * mcSigma * mcSigma + mcSigma * z);
      pathMatrix[d].push(price);
    }
    endPrices.push(price);
  }

  // Compute percentiles per day
  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  };

  const p5 = [], p25 = [], p50 = [], p75 = [], p95 = [];
  for (let d = 0; d <= days; d++) {
    p5.push(percentile(pathMatrix[d], 5));
    p25.push(percentile(pathMatrix[d], 25));
    p50.push(percentile(pathMatrix[d], 50));
    p75.push(percentile(pathMatrix[d], 75));
    p95.push(percentile(pathMatrix[d], 95));
  }

  // Summary stats at horizon
  const profitCount = endPrices.filter(p => p > lastPrice).length;
  const profitProb = (profitCount / endPrices.length) * 100;
  const median = percentile(endPrices, 50);
  const worst5 = percentile(endPrices, 5);
  const best5 = percentile(endPrices, 95);

  return {
    p5, p25, p50, p75, p95,
    days,
    simulations,
    profitProb,
    median,
    worst5,
    best5,
    lastPrice,
    mu: mcMu,
    sigma: mcSigma,
  };
}

// ─── Async worker wrapper ──────────────────────────────────────────────────
let _worker = null;
let _nextId = 1;
const _pending = new Map();

function _ensureWorker() {
  if (_worker) return _worker;
  if (typeof Worker === 'undefined') return null;
  try {
    _worker = new Worker(new URL('./monteCarloWorker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (ev) => {
      const { id, result, error } = ev.data || {};
      const entry = _pending.get(id);
      if (!entry) return;
      _pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    _worker.onerror = (err) => {
      for (const { reject } of _pending.values()) reject(err);
      _pending.clear();
    };
  } catch {
    _worker = null;
  }
  return _worker;
}

/**
 * Non-blocking Monte Carlo. Falls back to synchronous path if Workers
 * are unavailable (SSR / tests / hardened Electron sandbox).
 */
export function runMonteCarloAsync(prices, days = 20, simulations = 500) {
  const w = _ensureWorker();
  if (!w) return Promise.resolve(runMonteCarlo(prices, days, simulations));
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, prices, days, simulations });
  });
}

export function terminateMonteCarloWorker() {
  if (_worker) { _worker.terminate(); _worker = null; _pending.clear(); }
}
