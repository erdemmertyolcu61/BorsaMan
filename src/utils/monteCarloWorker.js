/**
 * monteCarloWorker.js — Off-main-thread GBM simulation.
 *
 * Loaded via Vite worker import:  new Worker(new URL('./monteCarloWorker.js', import.meta.url), { type: 'module' })
 *
 * Protocol:
 *   main → worker: { id, prices: number[], days, simulations }
 *   worker → main: { id, result } | { id, error }
 *
 * Why a worker: 10,000 paths x 90 days is a ~2M iteration hot loop.
 * On the main thread this blocks React commits and drops the UI below
 * 30fps during chart interactions. Here the math runs on a dedicated
 * thread and only the final percentile arrays are transferred back.
 */

function simulate(prices, days = 20, simulations = 500) {
  if (!Array.isArray(prices) || prices.length < 10) return null;

  const lastPrice = prices[prices.length - 1];
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

  const mcMu = Math.max(-0.02, Math.min(0.02, mu));
  const mcSigma = Math.max(0.005, Math.min(0.08, sigma));
  const drift = mcMu - 0.5 * mcSigma * mcSigma;

  // Flat Float64 matrix: pathMatrix[d * simulations + s]
  const total = (days + 1) * simulations;
  const pathMatrix = new Float64Array(total);
  const endPrices = new Float64Array(simulations);

  for (let s = 0; s < simulations; s++) {
    let price = lastPrice;
    pathMatrix[0 * simulations + s] = price;
    for (let d = 1; d <= days; d++) {
      const u1 = Math.max(1e-9, Math.random());
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      price = price * Math.exp(drift + mcSigma * z);
      pathMatrix[d * simulations + s] = price;
    }
    endPrices[s] = price;
  }

  const percentile = (arr, p) => {
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  };

  const p5 = new Array(days + 1);
  const p25 = new Array(days + 1);
  const p50 = new Array(days + 1);
  const p75 = new Array(days + 1);
  const p95 = new Array(days + 1);
  const dayBuf = new Float64Array(simulations);
  for (let d = 0; d <= days; d++) {
    for (let s = 0; s < simulations; s++) dayBuf[s] = pathMatrix[d * simulations + s];
    p5[d]  = percentile(dayBuf, 5);
    p25[d] = percentile(dayBuf, 25);
    p50[d] = percentile(dayBuf, 50);
    p75[d] = percentile(dayBuf, 75);
    p95[d] = percentile(dayBuf, 95);
  }

  let profitCount = 0;
  for (let s = 0; s < simulations; s++) if (endPrices[s] > lastPrice) profitCount++;

  return {
    p5, p25, p50, p75, p95,
    days, simulations,
    profitProb: (profitCount / simulations) * 100,
    median: percentile(endPrices, 50),
    worst5: percentile(endPrices, 5),
    best5: percentile(endPrices, 95),
    lastPrice,
    mu: mcMu,
    sigma: mcSigma,
  };
}

self.onmessage = (ev) => {
  const { id, prices, days, simulations } = ev.data || {};
  try {
    const result = simulate(prices, days, simulations);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
