/**
 * usePaperTradeML — React hook for the ML-scored Paper Trading Engine
 *
 * Wraps PaperTradeEngine.js into React state management:
 *   - Initializes engine on mount
 *   - Listens to `advisor-scan-complete` for auto-trade
 *   - Polls live prices for stop/target monitoring
 *   - Provides snapshot + actions to PaperTradingPanel
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getPaperTradeEngine } from '../utils/PaperTradeEngine.js';
import { fetchBigParaBatchPrices } from '../utils/fetchEngine.js';

const MONITOR_MS = 30_000; // 30s price check

export function usePaperTradeML() {
  const engineRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [autoTrade, setAutoTrade] = useState(() => {
    try { return localStorage.getItem('bist_paper_ml_auto') === 'true'; } catch { return false; }
  });

  // ── Init engine ──
  useEffect(() => {
    const engine = getPaperTradeEngine();
    engineRef.current = engine;

    const unsub = engine.subscribe((snap) => {
      setSnapshot(snap);
    });

    engine.init().catch(err => {
      console.warn('[PaperML] Init failed:', err?.message);
    });

    return () => unsub();
  }, []);

  // ── Persist auto-trade toggle ──
  useEffect(() => {
    try { localStorage.setItem('bist_paper_ml_auto', String(autoTrade)); } catch {}
  }, [autoTrade]);

  // ── Listen to advisor scan results ──
  useEffect(() => {
    if (!autoTrade) return;

    const handler = (e) => {
      const { topPicks, results } = e.detail || {};
      const picks = topPicks || results || [];
      if (!picks?.length) return;

      const engine = engineRef.current;
      if (!engine) return;

      engine.processScanResults(picks).catch(err => {
        console.warn('[PaperML] processScanResults error:', err?.message);
      });
    };

    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, [autoTrade]);

  // ── Price monitoring loop ──
  useEffect(() => {
    const monitor = async () => {
      const engine = engineRef.current;
      if (!engine) return;

      const state = engine.getState();
      if (!state?.openTrades?.length) return;

      try {
        const prices = await fetchBigParaBatchPrices();
        if (prices && Object.keys(prices).length > 0) {
          await engine.checkPrices(prices);
        }
      } catch {}
    };

    const interval = setInterval(monitor, MONITOR_MS);
    // Run once immediately
    monitor();
    return () => clearInterval(interval);
  }, []);

  // ── Actions ──
  const toggleAutoTrade = useCallback(() => {
    setAutoTrade(prev => !prev);
  }, []);

  const manualClose = useCallback(async (tradeId, exitPrice) => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.closeTrade(tradeId, exitPrice, 'MANUAL');
  }, []);

  const reset = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.reset();
  }, []);

  const refresh = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.refresh();
  }, []);

  return {
    snapshot,
    autoTrade,
    toggleAutoTrade,
    closeTrade: manualClose,
    reset,
    refresh,
    isElectron: engineRef.current?._isElectron || false,
  };
}
