/**
 * monteCarloWorker.js — Off-main-thread Monte Carlo.
 *
 * Loaded via Vite worker import:
 *   new Worker(new URL('./monteCarloWorker.js', import.meta.url), { type: 'module' })
 *
 * Protocol:
 *   main → worker: { id, prices: number[], days, simulations, opts }
 *   worker → main: { id, result } | { id, error }
 *
 * The math lives in the shared `_mcCore` (monteCarlo.js) so the worker and the
 * synchronous path can never drift apart. This module is just the thread boundary:
 * the hybrid block-bootstrap over 5-10k paths runs here, off the React thread.
 */
import { _mcCore } from './monteCarlo.js';

self.onmessage = (ev) => {
  const { id, prices, days, simulations, opts } = ev.data || {};
  try {
    const result = _mcCore(prices, days, simulations, opts || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
