import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchBigParaQuote, fetchBiquoteLatest } from '../utils/fetchEngine.js';

let globalNotificationHandler = null;

export function setSignalNotificationHandler(handler) {
  globalNotificationHandler = handler;
}

const STORAGE_KEY = 'bist_signal_history';
const MAX_HISTORY = 500;
const TRADING_DAY_MS = 1000 * 60 * 60 * 24;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map(s => ({
      ...s,
      timestamp: s.timestamp ? new Date(s.timestamp) : new Date(),
    }));
  } catch { return []; }
}

function persist(signals) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(signals.slice(0, MAX_HISTORY)));
  } catch {}
}

function determineOutcome(signal, priceNow) {
  const entry = signal.entryPrice || signal.price;
  if (!entry || !priceNow) return null;
  const pct = ((priceNow - entry) / entry) * 100;

  let outcome = 'OPEN';
  if (signal.cls === 'buy') {
    if (signal.target && priceNow >= signal.target) outcome = 'TARGET_HIT';
    else if (signal.stop && priceNow <= signal.stop) outcome = 'STOP_HIT';
    else if (pct >= 5) outcome = 'WIN';
    else if (pct <= -3) outcome = 'LOSS';
  } else if (signal.cls === 'sell') {
    if (signal.target && priceNow <= signal.target) outcome = 'TARGET_HIT';
    else if (signal.stop && priceNow >= signal.stop) outcome = 'STOP_HIT';
    else if (pct <= -5) outcome = 'WIN';
    else if (pct >= 3) outcome = 'LOSS';
  }
  return { outcome, pct };
}

function calcStats(signals) {
  const closed = signals.filter(s => s.status === 'closed' && s.outcome);
  const active = signals.filter(s => s.status === 'active');
  const wins = closed.filter(s => s.outcome === 'TARGET_HIT' || s.outcome === 'WIN').length;
  const losses = closed.filter(s => s.outcome === 'STOP_HIT' || s.outcome === 'LOSS').length;
  const total = closed.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const withD1 = signals.filter(s => s.perf?.d1 != null);
  const withD3 = signals.filter(s => s.perf?.d3 != null);
  const withD5 = signals.filter(s => s.perf?.d5 != null);
  const withD7 = signals.filter(s => s.perf?.d7 != null);
  const avg = (arr, key) => arr.length ? arr.reduce((a, s) => a + (s.perf[key] || 0), 0) / arr.length : 0;
  const avgD1 = avg(withD1, 'd1');
  const avgD3 = avg(withD3, 'd3');
  const avgD5 = avg(withD5, 'd5');
  const avgD7 = avg(withD7, 'd7');

  const sampleWeight = Math.min(1, total / 30);
  const expectancy = Math.max(-10, Math.min(10, avgD5));
  const reliability = Math.max(0, Math.min(100, Math.round(
    (winRate * 0.5) +
    (sampleWeight * 20) +
    ((expectancy + 10) / 20) * 30
  )));

  const allReturns = closed.map(s => s.perf?.d5 ?? s.perf?.d3 ?? s.perf?.d1 ?? 0).filter(v => v != null && v !== 0);
  const avgReturn = allReturns.length ? allReturns.reduce((a, v) => a + v, 0) / allReturns.length : 0;
  const maxReturn = allReturns.length ? Math.max(...allReturns) : 0;
  const minReturn = allReturns.length ? Math.min(...allReturns) : 0;

  const winStreak = (() => {
    let best = 0, cur = 0;
    for (const s of closed) {
      if (s.outcome === 'TARGET_HIT' || s.outcome === 'WIN') { cur++; best = Math.max(best, cur); }
      else { cur = 0; }
    }
    return best;
  })();

  const loseStreak = (() => {
    let best = 0, cur = 0;
    for (const s of closed) {
      if (s.outcome === 'STOP_HIT' || s.outcome === 'LOSS') { cur++; best = Math.max(best, cur); }
      else { cur = 0; }
    }
    return best;
  })();

  const profitFactor = (() => {
    let winsTotal = 0, lossesTotal = 0;
    for (const s of closed) {
      const r = s.perf?.d5 ?? s.perf?.d3 ?? s.perf?.d1 ?? 0;
      if (r > 0) winsTotal += r;
      else lossesTotal += Math.abs(r);
    }
    return lossesTotal > 0 ? winsTotal / lossesTotal : 0;
  })();

  const bySource = {};
  const byClass = {};
  const bySymbol = {};
  for (const s of signals) {
    const src = s.source || 'manual';
    bySource[src] = bySource[src] || { total: 0, wins: 0, totalRoi: 0 };
    bySource[src].total += 1;
    const roi = s.perf?.d5 ?? 0;
    if (s.outcome === 'TARGET_HIT' || s.outcome === 'WIN') { bySource[src].wins += 1; bySource[src].totalRoi += roi; }

    const cl = s.cls || 'other';
    byClass[cl] = byClass[cl] || { total: 0, wins: 0, totalRoi: 0 };
    byClass[cl].total += 1;
    if (s.outcome === 'TARGET_HIT' || s.outcome === 'WIN') { byClass[cl].wins += 1; byClass[cl].totalRoi += roi; }

    const sym = s.symbol;
    bySymbol[sym] = bySymbol[sym] || { total: 0, wins: 0, totalRoi: 0 };
    bySymbol[sym].total += 1;
    if (s.outcome === 'TARGET_HIT' || s.outcome === 'WIN') { bySymbol[sym].wins += 1; bySymbol[sym].totalRoi += roi; }
  }

  return {
    total: signals.length,
    active: active.length,
    closed: total,
    wins,
    losses,
    winRate,
    avgD1,
    avgD3,
    avgD5,
    avgD7,
    avgReturn,
    maxReturn,
    minReturn,
    profitFactor,
    reliability,
    winStreak,
    loseStreak,
    bySource,
    byClass,
    bySymbol,
  };
}

export function useSignalTracker() {
  const [signals, setSignals] = useState(() => loadFromStorage());
  const checkTimerRef = useRef(null);
  const checkCountRef = useRef(0);

  useEffect(() => {
    persist(signals);
  }, [signals]);

  const recordSignal = useCallback((signalData) => {
    const key = `${signalData.symbol}-${signalData.cls}-${signalData.source || 'manual'}`;
    setSignals(prev => {
      const fourHrAgo = Date.now() - 4 * 60 * 60 * 1000;
      const dup = prev.find(s => {
        const k = `${s.symbol}-${s.cls}-${s.source || 'manual'}`;
        return k === key && new Date(s.timestamp).getTime() > fourHrAgo;
      });
      if (dup) return prev;

      if (signalData.confidence && signalData.confidence < 4) return prev;

      // Calculate slippage based on liquidity tier
      let baseEntry = signalData.price || signalData.entry || null;
      let slippagePct = 0.002; // Default 0.2% slippage for normal market conditions
      if (signalData.liquidity) {
        const tier = signalData.liquidity.tier || signalData.liquidity;
        if (tier === 'VERY_LOW') slippagePct = 0.008; // 0.8% spread
        else if (tier === 'LOW') slippagePct = 0.005; // 0.5% spread
        else if (tier === 'MEDIUM') slippagePct = 0.003; // 0.3% spread
        else if (tier === 'HIGH' || tier === 'INSTITUTIONAL') slippagePct = 0.0015; // 0.15% spread
      }
      
      let finalEntry = baseEntry;
      if (baseEntry) {
        if (signalData.cls === 'buy') finalEntry = baseEntry * (1 + slippagePct);
        else if (signalData.cls === 'sell') finalEntry = baseEntry * (1 - slippagePct);
      }

      const newSignal = {
        id: `${signalData.symbol}-${Date.now()}`,
        timestamp: new Date(),
        status: 'active',
        outcome: null,
        perf: { d1: null, d3: null, d5: null, d7: null },
        lastPrice: null,
        notes: signalData.notes || signalData.reason || signalData.signal || '',
        sector: signalData.sector || '',
        entryPrice: finalEntry,
        target: signalData.target || null,
        stop: signalData.stop || null,
        rr: signalData.rr || null,
        score100: signalData.score100 || signalData.score || null,
        ...signalData,
      };
      return [newSignal, ...prev].slice(0, MAX_HISTORY);
    });

    if (globalNotificationHandler?.notifySignal) {
      try { globalNotificationHandler.notifySignal(signalData); } catch {}
    }
  }, []);

  const updateSignal = useCallback((signalId, updates) => {
    setSignals(prev => prev.map(sig => (sig.id === signalId ? { ...sig, ...updates } : sig)));
  }, []);

  const removeSignal = useCallback((signalId) => {
    setSignals(prev => prev.filter(sig => sig.id !== signalId));
  }, []);

  const clearHistory = useCallback(() => {
    setSignals([]);
  }, []);

  const filterSignals = useCallback((options = {}) => {
    return signals.filter(s => {
      if (options.status && s.status !== options.status) return false;
      if (options.cls && s.cls !== options.cls) return false;
      if (options.source && s.source !== options.source) return false;
      if (options.outcome && s.outcome !== options.outcome) return false;
      if (options.symbol && !s.symbol.toLowerCase().includes(options.symbol.toLowerCase())) return false;
      if (options.minScore && (!s.score100 || s.score100 < options.minScore)) return false;
      if (options.dateFrom) {
        const d = new Date(s.timestamp).getTime();
        if (d < new Date(options.dateFrom).getTime()) return false;
      }
      if (options.dateTo) {
        const d = new Date(s.timestamp).getTime();
        if (d > new Date(options.dateTo).getTime()) return false;
      }
      return true;
    });
  }, [signals]);

  const exportCSV = useCallback(() => {
    const headers = ['Tarih', 'Sembol', 'Sınıf', 'Kaynak', 'Giriş', 'Son Fiyat', 'Hedef', 'Stop', 'R/R', 'Skor', '1G%', '3G%', '5G%', '7G%', 'Sonuç', 'Durum'];
    const rows = signals.map(s => [
      new Date(s.timestamp).toLocaleDateString('tr-TR'),
      s.symbol,
      s.cls || '',
      s.source || 'manual',
      s.price || s.entryPrice || '',
      s.lastPrice || '',
      s.target || '',
      s.stop || '',
      s.rr || '',
      s.score100 || '',
      s.perf?.d1?.toFixed(2) ?? '',
      s.perf?.d3?.toFixed(2) ?? '',
      s.perf?.d5?.toFixed(2) ?? '',
      s.perf?.d7?.toFixed(2) ?? '',
      s.outcome || '',
      s.status || '',
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bist_signals_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [signals]);

  const importCSV = useCallback((csvText) => {
    try {
      const lines = csvText.trim().split('\n');
      if (lines.length < 2) return 0;
      const imported = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 2) continue;
        imported.push({
          id: `import-${Date.now()}-${i}`,
          timestamp: new Date(parts[0]),
          symbol: parts[1],
          cls: parts[2] || 'buy',
          source: parts[3] || 'import',
          price: parseFloat(parts[4]) || null,
          lastPrice: parseFloat(parts[5]) || null,
          target: parseFloat(parts[6]) || null,
          stop: parseFloat(parts[7]) || null,
          rr: parseFloat(parts[8]) || null,
          score100: parseFloat(parts[9]) || null,
          perf: {
            d1: parts[10] ? parseFloat(parts[10]) : null,
            d3: parts[11] ? parseFloat(parts[11]) : null,
            d5: parts[12] ? parseFloat(parts[12]) : null,
            d7: parts[13] ? parseFloat(parts[13]) : null,
          },
          outcome: parts[14] || null,
          status: parts[15] || 'closed',
        });
      }
      setSignals(prev => [...imported, ...prev].slice(0, MAX_HISTORY));
      return imported.length;
    } catch {
      return 0;
    }
  }, []);

  // Batch price check every 10 minutes
  useEffect(() => {
    const checkSignals = async () => {
      const now = Date.now();
      const activeSignals = signals.filter(s => s.status === 'active');
      if (!activeSignals.length) return;

      const symbols = [...new Set(activeSignals.map(s => s.symbol))];

      let quotes = {};
      try {
        const batch = await fetchBiquoteLatest(symbols);
        if (batch?.length) {
          for (const q of batch) quotes[q.symbol] = q.price;
        } else {
          for (const sym of symbols) {
            try {
              const q = await fetchBigParaQuote(sym);
              if (q?.price) quotes[sym] = q.price;
            } catch {}
          }
        }
      } catch {
        for (const sym of symbols) {
          try {
            const q = await fetchBigParaQuote(sym);
            if (q?.price) quotes[sym] = q.price;
          } catch {}
        }
      }

      const updates = {};
      for (const sig of activeSignals) {
        const t = new Date(sig.timestamp).getTime();
        const ageDays = (now - t) / TRADING_DAY_MS;
        if (ageDays < 0.5) continue;

        const priceNow = quotes[sig.symbol];
        if (!priceNow) continue;

        // --- TRAILING STOP LOGIC ---
        let currentStop = sig.stop;
        let trailingStopActivated = sig.trailingStopActivated || false;
        const entryPrice = sig.entryPrice || sig.price;
        
        if (entryPrice && sig.cls === 'buy') {
          const profitPct = ((priceNow - entryPrice) / entryPrice) * 100;
          // Activate trailing stop when profit exceeds 3%
          if (profitPct >= 3) {
            // Trail stop at 2% below the highest reached price
            const newStop = priceNow * 0.98;
            if (!currentStop || newStop > currentStop) {
              currentStop = newStop;
              trailingStopActivated = true;
            }
          }
        }

        const tempSig = { ...sig, stop: currentStop, entryPrice };
        const out = determineOutcome(tempSig, priceNow);
        if (!out) continue;

        const perf = { ...(sig.perf || {}) };
        if (ageDays >= 1 && perf.d1 == null) perf.d1 = out.pct;
        if (ageDays >= 3 && perf.d3 == null) perf.d3 = out.pct;
        if (ageDays >= 5 && perf.d5 == null) perf.d5 = out.pct;
        if (ageDays >= 7 && perf.d7 == null) perf.d7 = out.pct;

        const finalOutcome = (ageDays >= 7 || out.outcome === 'TARGET_HIT' || out.outcome === 'STOP_HIT')
          ? out.outcome
          : sig.outcome;

        updates[sig.id] = {
          perf,
          outcome: finalOutcome,
          lastPrice: priceNow,
          stop: currentStop,
          trailingStopActivated,
          status: (finalOutcome && finalOutcome !== 'OPEN') || ageDays >= 10 ? 'closed' : 'active',
        };
      }

      if (Object.keys(updates).length) {
        setSignals(prev => prev.map(s => updates[s.id] ? { ...s, ...updates[s.id] } : s));
      }

      checkCountRef.current++;
    };

    checkSignals();
    checkTimerRef.current = setInterval(checkSignals, 10 * 60 * 1000);
    return () => { if (checkTimerRef.current) clearInterval(checkTimerRef.current); };
  }, [signals.length]);

  const stats = (() => calcStats(signals))();

  return {
    signals,
    stats,
    recordSignal,
    updateSignal,
    removeSignal,
    clearHistory,
    filterSignals,
    exportCSV,
    importCSV,
  };
}