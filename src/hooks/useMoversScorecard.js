// ── useMoversScorecard (v31.54) — gun ici hareket listesinin ileri olcumu ────
// advisor-scan-complete → listeyi dayanak gunuyle kaydeder; sonraki seansin resmi
// gunluk bari gelince kuralin sonucunu yazar. App.jsx'te BIR kez mount edilir.
// Skora ya da paper motoruna geri beslemez — yalniz olcum ve gosterim.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchDailyBarsMap } from '../utils/dailyBarsBatch.js';
import { istanbulDayKey } from '../utils/fetchEngine.js';
import { isSessionOver } from '../utils/scanScorecard.js';
import { loadMovers, persistMovers, recordMovers, moversToSettle, settleMovers, summarizeMovers } from '../utils/moversScorecard.js';

const PASS_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 9000;

export function useMoversScorecard() {
  const [days, setDays] = useState(() => loadMovers());
  const daysRef = useRef(days);
  useEffect(() => { daysRef.current = days; }, [days]);

  useEffect(() => {
    const handler = (e) => {
      const movers = e?.detail?.movers;
      if (!Array.isArray(movers) || !movers.length) return;
      setDays((prev) => {
        const next = recordMovers(prev, movers);
        return next === prev ? prev : persistMovers(next);
      });
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);

  const runningRef = useRef(false);
  const pass = useCallback(async () => {
    if (runningRef.current) return;
    const syms = moversToSettle(daysRef.current);
    if (!syms.length) return;
    runningRef.current = true;
    try {
      const barsMap = await fetchDailyBarsMap(syms);
      const today = istanbulDayKey(Date.now());
      setDays((prev) => {
        const r = settleMovers(prev, barsMap, istanbulDayKey, { today, sessionOver: isSessionOver(today) });
        return r.changed ? persistMovers(r.days) : prev;
      });
    } catch { /* ag hatasi: bir sonraki geciste yeniden denenir */ } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => { pass(); }, FIRST_PASS_DELAY_MS);
    const tick = setInterval(() => { pass(); }, PASS_INTERVAL_MS);
    const onWake = () => { if (document.visibilityState === 'visible') pass(); };
    document.addEventListener('visibilitychange', onWake);
    return () => { clearTimeout(first); clearInterval(tick); document.removeEventListener('visibilitychange', onWake); };
  }, [pass]);

  const summary = useMemo(() => summarizeMovers(days), [days]);
  return { days, summary };
}

export default useMoversScorecard;
