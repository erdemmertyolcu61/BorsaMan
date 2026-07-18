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

    engine.init()
      .then(() => {
        const state = engine.getState();
        console.log('[PaperML] Engine initialized. State:', {
          cash: state?.cash,
          openTrades: state?.openTrades?.length,
          closedTrades: state?.closedTrades?.length,
          isElectron: engine._isElectron,
        });
        // Singleton re-mount fix: if engine was already initialized before this subscriber
        // was registered, _emit() was never called for us. Force snapshot now.
        const snap = engine.getSnapshot();
        if (snap) setSnapshot(snap);
      })
      .catch(err => {
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
    console.log('[PaperTrade] Scan listener attached. autoTrade =', autoTrade);
    if (!autoTrade) {
      console.warn('[PaperTrade] AutoTrade is OFF — scan events will be ignored');
      return;
    }

    const handler = (e) => {
      const scanData = e.detail || {};

      // ML Forward Test pool stratejisi:
      // 1. Oncelik: topPicks (advisor'in onayli ilk 10'u) icerisinde mlMatchedCount > 0 olanlar
      // 2. Eger topPicks'te 3'ten az ML eslesmesi varsa: results (tum 600+ sembol) icerisinden
      //    ek ML eslesmesi olanlar eklenir — ML Forward Test BUTUN evrende en iyi ML kurali
      //    esleseni arar, sadece top-10'la sinirli kalmaz.
      const topPicks  = scanData.topPicks  || [];
      const allResults = scanData.results  || [];

      const mlInTop = topPicks.filter(p => (p.mlMatchedCount || 0) > 0);
      let picks = [...topPicks];

      if (mlInTop.length < 3 && allResults.length > 0) {
        const topSyms = new Set(topPicks.map(p => p.symbol));
        const extraML = allResults.filter(r =>
          r?.symbol && !topSyms.has(r.symbol) && (r.mlMatchedCount || 0) > 0
        );
        if (extraML.length) {
          picks = [...topPicks, ...extraML];
          console.log('[PaperTrade] ML pool genisledildi: topPicks =', topPicks.length,
            '| results ML eslesmesi =', extraML.length,
            '| ekstra:', extraML.map(r => r.symbol));
        }
      }

      console.log('[PaperTrade] Scan event — pool:', picks.length,
        'mlMatched in pool:', picks.filter(p => (p.mlMatchedCount||0) > 0).length);

      if (!picks?.length) {
        console.warn('[PaperTrade] ABORT — no picks in scan event');
        return;
      }

      const engine = engineRef.current;
      if (!engine) {
        console.warn('[PaperTrade] ABORT — engine not initialized');
        return;
      }

      console.log('[PaperTrade] Forwarding', picks.length, 'picks to engine.processScanResults()',
        picks.filter(p=>(p.mlMatchedCount||0)>0).map(p => `${p.symbol}(ML+${(p.mlConfidenceBoost||0).toFixed(1)})`));
      engine.processScanResults(picks).catch(err => {
        console.warn('[PaperML] processScanResults error:', err?.message, err);
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
    // Mobile: WebView freezes timers when backgrounded — the instant the app
    // returns to the foreground, check prices right away so a stop/target hit
    // during suspension is acted on without waiting for the next 30s tick.
    const onVisible = () => { if (document.visibilityState === 'visible') monitor(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
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
