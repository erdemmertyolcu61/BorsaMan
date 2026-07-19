/**
 * monteCarlo.js - Realistic Monte Carlo price projection for BIST (v31 hybrid)
 *
 * Two entry points:
 *   runMonteCarlo(prices, days, sims, opts)       — sync, blocks main thread
 *   runMonteCarloAsync(prices, days, sims, opts)  — off-thread via Web Worker (preferred)
 *
 * The old model was constant-vol + Gaussian (Box-Muller) GBM — thin tails, no skew,
 * no autocorrelation, no BIST price limits, ignored the trade's own stop/target and
 * costs. This hybrid replaces the shock source with a MOVING-BLOCK BOOTSTRAP of the
 * stock's own recent log-returns (empirical fat tails + skew + short-range
 * autocorrelation), tilts drift by the terminal's signal view, clamps each day to the
 * BIST ±10% limit, terminates paths at stop/target for realistic exit stats, and
 * reports a cost-adjusted profit probability.
 *
 * opts (all optional):
 *   driftBias  — per-day log-drift tilt from the signal (clamped ±0.01). >0 = bullish.
 *   stop       — stop-loss price. Enables pStopFirst / expectedExitPct.
 *   target     — take-profit price. Enables pTargetFirst.
 *   blockSize  — bootstrap block length in bars (default 5).
 *   costPct    — round-trip cost fraction for profitProbNet (default TOTAL_COST_PCT).
 *
 * Returns: {
 *   p5,p25,p50,p75,p95   arrays length days+1 (interpolated percentiles), index0=lastPrice
 *   days, simulations, method ('bootstrap'|'gaussian'),
 *   profitProb,          // % end-price above lastPrice (gross)
 *   profitProbNet,       // % end-price above lastPrice*(1+costPct) — cost-aware
 *   median, worst5, best5,
 *   pStopFirst, pTargetFirst, pNoExit,   // % of paths (0 when stop/target absent)
 *   expectedExitPct,     // mean realized return honoring stop/target-first exit
 *   avgHoldDays,
 *   lastPrice, mu, sigma
 * }
 */
import { TOTAL_COST_PCT } from './tradingCosts.js';

const BIST_DAILY_LIMIT = 0.10;   // ±10% price band / circuit
const DEFAULT_BLOCK = 5;
const MIN_BOOTSTRAP_RETURNS = 20; // below this, fall back to Gaussian

// Interpolated percentile (fixes the biased nearest-rank of the old model).
function percentileInterp(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const w = rank - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

// Moving-block bootstrap: build a length-`days` return sequence by concatenating
// random contiguous blocks (circular) → preserves within-block autocorrelation.
function sampleBlockSequence(logReturns, days, blockSize) {
  const nR = logReturns.length;
  const seq = new Array(days);
  let i = 0;
  while (i < days) {
    const start = Math.floor(Math.random() * nR);
    for (let k = 0; k < blockSize && i < days; k++, i++) {
      seq[i] = logReturns[(start + k) % nR];
    }
  }
  return seq;
}

function gaussianShock(driftLessHalfVar, sigma) {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return driftLessHalfVar + sigma * z;
}

/**
 * Shared simulation core — used by both the sync path and the worker so the model
 * never drifts between them.
 */
export function _mcCore(prices, days = 20, simulations = 500, opts = {}) {
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
  // Relaxed vol cap (fat tails need room) but still guard data spikes.
  const mcSigma = Math.max(0.005, Math.min(0.12, sigma));
  const gaussDrift = mu - 0.5 * mcSigma * mcSigma;

  const driftBias = Number.isFinite(opts.driftBias)
    ? Math.max(-0.01, Math.min(0.01, opts.driftBias)) : 0;
  const costPct = Number.isFinite(opts.costPct) ? opts.costPct : TOTAL_COST_PCT;
  const stop = Number.isFinite(opts.stop) && opts.stop > 0 ? opts.stop : null;
  const target = Number.isFinite(opts.target) && opts.target > 0 ? opts.target : null;
  const blockSize = Math.max(1, Math.min(20, Math.floor(opts.blockSize || DEFAULT_BLOCK)));

  const useBootstrap = logReturns.length >= MIN_BOOTSTRAP_RETURNS;
  const method = useBootstrap ? 'bootstrap' : 'gaussian';

  const loFactor = 1 - BIST_DAILY_LIMIT;
  const hiFactor = 1 + BIST_DAILY_LIMIT;

  const pathMatrix = [];
  for (let d = 0; d <= days; d++) pathMatrix.push(new Array(simulations));
  const endPrices = new Array(simulations);

  let stopFirst = 0, targetFirst = 0, noExit = 0;
  let exitRetSum = 0, holdDaySum = 0;

  for (let s = 0; s < simulations; s++) {
    const seq = useBootstrap ? sampleBlockSequence(logReturns, days, blockSize) : null;
    let price = lastPrice;
    pathMatrix[0][s] = price;
    let exited = false, exitRet = 0, exitDay = days;

    for (let d = 1; d <= days; d++) {
      let shock = useBootstrap ? seq[d - 1] : gaussianShock(gaussDrift, mcSigma);
      shock += driftBias;
      // BIST daily price limit — clamp the multiplicative move to ±10%.
      let factor = Math.exp(shock);
      if (factor < loFactor) factor = loFactor;
      else if (factor > hiFactor) factor = hiFactor;
      price *= factor;
      pathMatrix[d][s] = price;

      if (!exited) {
        if (stop && price <= stop) {
          exited = true; exitRet = (stop - lastPrice) / lastPrice; exitDay = d; stopFirst++;
        } else if (target && price >= target) {
          exited = true; exitRet = (target - lastPrice) / lastPrice; exitDay = d; targetFirst++;
        }
      }
    }
    if (!exited) { noExit++; exitRet = (price - lastPrice) / lastPrice; }
    exitRetSum += exitRet;
    holdDaySum += exitDay;
    endPrices[s] = price;
  }

  // Percentile bands per day (interpolated).
  const p5 = [], p25 = [], p50 = [], p75 = [], p95 = [];
  for (let d = 0; d <= days; d++) {
    const sorted = pathMatrix[d].slice().sort((a, b) => a - b);
    p5.push(percentileInterp(sorted, 5));
    p25.push(percentileInterp(sorted, 25));
    p50.push(percentileInterp(sorted, 50));
    p75.push(percentileInterp(sorted, 75));
    p95.push(percentileInterp(sorted, 95));
  }

  const sortedEnd = endPrices.slice().sort((a, b) => a - b);
  const n = endPrices.length;
  const profitProb = (endPrices.filter(p => p > lastPrice).length / n) * 100;
  const netThreshold = lastPrice * (1 + costPct);
  const profitProbNet = (endPrices.filter(p => p > netThreshold).length / n) * 100;

  const hasLevels = !!(stop || target);
  return {
    p5, p25, p50, p75, p95,
    days,
    simulations,
    method,
    profitProb,
    profitProbNet,
    median: percentileInterp(sortedEnd, 50),
    worst5: percentileInterp(sortedEnd, 5),
    best5: percentileInterp(sortedEnd, 95),
    // Stop/target exit stats (0 / null when no levels supplied)
    pStopFirst: hasLevels ? (stopFirst / n) * 100 : 0,
    pTargetFirst: hasLevels ? (targetFirst / n) * 100 : 0,
    pNoExit: hasLevels ? (noExit / n) * 100 : 100,
    expectedExitPct: (exitRetSum / n) * 100,
    avgHoldDays: holdDaySum / n,
    lastPrice,
    mu: mu,
    sigma: mcSigma,
  };
}

export function runMonteCarlo(prices, days = 20, simulations = 500, opts = {}) {
  return _mcCore(prices, days, simulations, opts);
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
export function runMonteCarloAsync(prices, days = 20, simulations = 500, opts = {}) {
  const w = _ensureWorker();
  if (!w) return Promise.resolve(_mcCore(prices, days, simulations, opts));
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, prices, days, simulations, opts });
  });
}

export function terminateMonteCarloWorker() {
  if (_worker) { _worker.terminate(); _worker = null; _pending.clear(); }
}
