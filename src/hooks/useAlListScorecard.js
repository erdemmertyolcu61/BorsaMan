// ── useAlListScorecard (v31.59) — AL listesinin ileri olcumu ────────────────
// advisor-scan-complete → seans disi taramanin AL listesini dayanak gunuyle kaydeder;
// sonraki seansin resmi gunluk bari gelince kuralin (acilista al, yalniz trailing) sonucunu
// yazar, acik islemleri her geciste gunceller. App.jsx'te BIR kez mount edilir.
// Skora ya da paper motoruna geri beslemez — yalniz olcum ve gosterim.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchDailyBarsMap } from '../utils/dailyBarsBatch.js';
import { istanbulDayKey } from '../utils/fetchEngine.js';
import { isSessionOver } from '../utils/scanScorecard.js';
import { loadAlList, persistAlList, recordAlList, alListToSettle, settleAlList, summarizeAlList } from '../utils/alListScorecard.js';

const PASS_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 11000;

export function useAlListScorecard() {
  const [days, setDays] = useState(() => loadAlList());
  const daysRef = useRef(days);
  useEffect(() => { daysRef.current = days; }, [days]);

  useEffect(() => {
    const handler = (e) => {
      setDays((prev) => {
        const next = recordAlList(prev, e?.detail);
        return next === prev ? prev : persistAlList(next);
      });
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);

  const runningRef = useRef(false);
  const pass = useCallback(async () => {
    if (runningRef.current) return;
    const syms = alListToSettle(daysRef.current);
    if (!syms.length) return;
    runningRef.current = true;
    try {
      const barsMap = await fetchDailyBarsMap(syms);
      const today = istanbulDayKey(Date.now());
      setDays((prev) => {
        const r = settleAlList(prev, barsMap, istanbulDayKey, { today, sessionOver: isSessionOver(today) });
        return r.changed ? persistAlList(r.days) : prev;
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

  const summary = useMemo(() => summarizeAlList(days), [days]);
  return { days, summary };
}

export default useAlListScorecard;
