// ════════════════════════════════════════════════════════════════════
// useForwardTestJournal.js — React wrapper for the daily prediction ledger
// ════════════════════════════════════════════════════════════════════
//
// - Listens to `advisor-scan-complete` → snapshots the day's top buy picks.
// - Every 30 min, evaluates matured predictions against real prices.
// - Exposes honest accuracy stats (next-day directional hit rate, etc.).
//
// Designed to run ONCE (mount in App.jsx). It is read-only ground truth;
// it does not feed back into scoring — that keeps the measurement unbiased.
// ════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchQuotesBatch } from '../utils/fetchEngine.js';
import { fetchDailyBarsMap } from '../utils/dailyBarsBatch.js';
import {
  loadJournal,
  persistJournal,
  recordSnapshot,
  evaluateJournal,
  settleJournalFromBars,
  journalSymbolsToSettle,
  journalStats,
  exportJournalJSON,
} from '../utils/forwardTestJournal.js';

const EVAL_INTERVAL_MS = 30 * 60 * 1000; // evaluate every 30 minutes

export function useForwardTestJournal() {
  const [days, setDays] = useState(() => loadJournal());
  const daysRef = useRef(days);
  daysRef.current = days;
  const evalTimerRef = useRef(null);

  // ── Snapshot on scan complete ──
  useEffect(() => {
    const handler = (e) => {
      setDays(prev => recordSnapshot(prev, e.detail));
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);

  // ── Periodic evaluation of matured predictions ──
  const runEvaluation = useCallback(async () => {
    const current = daysRef.current;
    if (!current.length) return;

    // Collect symbols from all days still inside the measurement window.
    // Day-0 is included so running extremes (MFE/MAE) capture the entry
    // day's excursion — outcomes still only mature from day 1.
    const now = Date.now();
    const symbols = new Set();
    for (const day of current) {
      const ageDays = (now - day.timestamp) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) continue;
      for (const p of day.predictions) {
        if (p.perf?.d5 == null) symbols.add(p.symbol);
      }
    }
    if (!symbols.size) return;

    const symList = [...symbols];
    // v31.45: tek toplu istek + eksikler icin sembol basina yedek (fetchQuotesBatch).
    const quoteMap = {};
    try {
      const map = await fetchQuotesBatch(symList, { maxAgeMs: 60_000 });
      for (const [sym, q] of Object.entries(map)) if (q?.price > 0) quoteMap[sym] = q.price;
    } catch {}
    if (!Object.keys(quoteMap).length) return;

    // Functional update: the close-settlement pass may have written in between.
    setDays(prev => {
      const { days: nextDays, changed } = evaluateJournal(prev, quoteMap, now);
      return changed ? persistJournal(nextDays) : prev;
    });
  }, []);

  // ── v31.47: close-based settlement ("gecmis verileri guncelle") ──
  // The live latch above only fires while the app is open; this pass rebuilds
  // d1/d3/d5, outcome and MFE/MAE from official daily closes, oldest backlog
  // included, so the governor and the accuracy panel read real numbers.
  const settleRunningRef = useRef(false);
  const drainRef = useRef({ n: 0, timer: null });
  const runCloseSettlement = useCallback(async () => {
    if (settleRunningRef.current) return;
    const syms = journalSymbolsToSettle(daysRef.current, Date.now());
    if (!syms.length) return;
    settleRunningRef.current = true;
    try {
      const barsMap = await fetchDailyBarsMap(syms);
      if (!Object.keys(barsMap).length) return;
      setDays(prev => {
        const { days: next, changed } = settleJournalFromBars(prev, barsMap, Date.now());
        return changed ? persistJournal(next) : prev;
      });
      const more = journalSymbolsToSettle(daysRef.current, Date.now(), 500).filter(s => !(s in barsMap));
      if (more.length && drainRef.current.n < 25) {
        drainRef.current.n += 1;
        clearTimeout(drainRef.current.timer);
        drainRef.current.timer = setTimeout(() => { runCloseSettlement(); }, 20_000);
      }
    } finally {
      settleRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    runEvaluation();
    const first = setTimeout(() => { runCloseSettlement(); }, 6000);
    evalTimerRef.current = setInterval(() => { runEvaluation(); runCloseSettlement(); }, EVAL_INTERVAL_MS);
    const onWake = () => { if (document.visibilityState === 'visible') runCloseSettlement(); };
    document.addEventListener('visibilitychange', onWake);
    const drain = drainRef.current;
    return () => {
      if (evalTimerRef.current) clearInterval(evalTimerRef.current);
      clearTimeout(first);
      clearTimeout(drain.timer);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [runEvaluation, runCloseSettlement]);

  const stats = journalStats(days);

  const clearJournal = useCallback(() => {
    setDays([]);
    persistJournal([]);
  }, []);

  const exportCSV = useCallback(() => {
    const headers = ['Tarih', 'Sembol', 'Sektör', 'Giriş', 'Hedef', 'Stop', 'Skor', 'Grade', 'Tier', 'D1%', 'D3%', 'D5%', 'YönİsabetI', 'Sonuç'];
    const rows = [];
    for (const day of days) {
      for (const p of day.predictions) {
        rows.push([
          day.date, p.symbol, p.sector, p.entryPrice ?? '', p.target ?? '', p.stop ?? '',
          p.score ?? '', p.grade, p.tier,
          p.perf?.d1?.toFixed(2) ?? '', p.perf?.d3?.toFixed(2) ?? '', p.perf?.d5?.toFixed(2) ?? '',
          p.directionalHit == null ? '' : (p.directionalHit ? 'EVET' : 'HAYIR'),
          p.outcome ?? '',
        ]);
      }
    }
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bist_forward_journal_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [days]);

  const exportJSON = useCallback(() => {
    const json = exportJournalJSON(days);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bist_forward_journal_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [days]);

  return {
    days,
    stats,
    runEvaluation,
    clearJournal,
    exportCSV,
    exportJSON,
  };
}
