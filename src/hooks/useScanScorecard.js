// ── useScanScorecard (v31.47) — tarama karnesinin React sarmalayicisi ──────────
//
// - advisor-scan-complete → gosterilen AL onerilerini yargilayan seansin gunune yazar
// - acilista gecmisi sinyal takibi + tahmin defterinden bir kez tohumlar
// - seans icinde anlik fiyatla, 18:30'dan sonra resmi gunluk barla yerlestirir
//
// App.jsx'te BIR kez mount edilir. Skora geri beslemez — yalniz olcum ve gosterim.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchQuotesBatch } from '../utils/fetchEngine.js';
import { fetchDailyBarsMap } from '../utils/dailyBarsBatch.js';
import { loadJournal } from '../utils/forwardTestJournal.js';
import {
  loadScorecard, persistScorecard, recordScan, seedFromHistory,
  settleWithBars, settleWithQuotes, symbolsToSettle, daysNeedingBars, daysNeedingQuotes,
  featuredDay, summarizeDay,
} from '../utils/scanScorecard.js';

const PASS_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 4000;
const DRAIN_DELAY_MS = 15000;
const MAX_DRAINS_PER_SESSION = 25;

export function useScanScorecard(signals = []) {
  const [days, setDays] = useState(() => loadScorecard());
  const [lastPassAt, setLastPassAt] = useState(null);
  const daysRef = useRef(days);
  useEffect(() => { daysRef.current = days; }, [days]);

  // ── Gecmisten bir kez tohumla ("tum taranan hisselerin gecmisi") ──
  const seededRef = useRef(false);
  const signalsAtMount = useRef(signals);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    setDays(prev => {
      const next = seedFromHistory(prev, { signals: signalsAtMount.current, journal: loadJournal() });
      return next === prev ? prev : persistScorecard(next);
    });
  }, []);

  // ── Her tarama: gosterilen AL onerilerini kaydet ──
  useEffect(() => {
    const handler = (e) => {
      setDays(prev => {
        const next = recordScan(prev, e.detail);
        return next === prev ? prev : persistScorecard(next);
      });
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);

  // ── Yerlesim: anlik fiyat (bugun) + resmi bar (kapanmis gunler) ──
  const runningRef = useRef(false);
  const drainsRef = useRef(0);
  const drainTimerRef = useRef(null);
  const pass = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const now = Date.now();
      const quoteDays = daysNeedingQuotes(daysRef.current, now);
      if (quoteDays.length) {
        const syms = [...new Set(quoteDays.flatMap(d => d.picks.map(p => p.symbol)))];
        let quotes = {};
        try { quotes = await fetchQuotesBatch(syms, { maxAgeMs: 60_000 }); } catch { quotes = {}; }
        if (Object.keys(quotes).length) {
          setDays(prev => {
            const r = settleWithQuotes(prev, quotes, Date.now());
            return r.changed ? persistScorecard(r.days) : prev;
          });
        }
      }

      const syms = symbolsToSettle(daysRef.current, now);
      const needBench = daysNeedingBars(daysRef.current, now).some(d => !d.bench || d.bench.src !== 'bar');
      if (syms.length || needBench) {
        const barsMap = await fetchDailyBarsMap(needBench ? [...syms, 'XU100'] : syms);
        const bench = Array.isArray(barsMap.XU100) && barsMap.XU100.length ? barsMap.XU100 : null;
        setDays(prev => {
          const r = settleWithBars(prev, barsMap, bench, Date.now());
          return r.changed ? persistScorecard(r.days) : prev;
        });
        // Birikmis gecmis varsa yeniden yukleme beklemeden eritsin.
        const remaining = symbolsToSettle(daysRef.current, Date.now(), 500).filter(s => !(s in barsMap));
        if (remaining.length && drainsRef.current < MAX_DRAINS_PER_SESSION) {
          drainsRef.current += 1;
          clearTimeout(drainTimerRef.current);
          drainTimerRef.current = setTimeout(() => { pass(); }, DRAIN_DELAY_MS);
        }
      }
      setLastPassAt(Date.now());
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => { pass(); }, FIRST_PASS_DELAY_MS);
    const tick = setInterval(() => { pass(); }, PASS_INTERVAL_MS);
    const onWake = () => { if (document.visibilityState === 'visible') pass(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
      clearTimeout(drainTimerRef.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [pass]);

  const featured = useMemo(() => featuredDay(days), [days]);
  const featuredSummary = useMemo(() => (featured ? summarizeDay(featured) : null), [featured]);

  return { days, featured, featuredSummary, refresh: pass, lastPassAt };
}

export default useScanScorecard;
