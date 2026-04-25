import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle, isBistClosedDay } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList, SECTORS } from '../utils/constants.js';
import { calcSectorMetrics, rankSectors, getSectorStocks } from '../utils/sectorEngine.js';
import { fetchKapNews } from '../utils/NewsEngine.js';
import { calcKAPSentiment } from '../utils/kapEngine.js';

// ── Istanbul TZ helper (module-scoped, created once) ──
const _advisorTzFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function _istanbulMinutes() {
  const parts = _advisorTzFmt.formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h * 60 + m;
}

/**
 * isMarketOpen — TZ-stable BIST session check (Istanbul time + holiday calendar).
 * Replaces the old runtime-TZ getHours/getMinutes approach.
 */
export function isMarketOpen() {
  if (isBistClosedDay(new Date())) return false;
  const t = _istanbulMinutes();
  // BIST: 09:30-12:30 (morning) + 14:00-17:30 (afternoon) Istanbul time
  const morning   = t >= 570 && t < 750;   // 09:30-12:30
  const afternoon = t >= 840 && t < 1050;  // 14:00-17:30
  return morning || afternoon;
}

export function isMarketClosedForDay() {
  if (isBistClosedDay(new Date())) return true;
  const t = _istanbulMinutes();
  return t >= 1110 || t < 570; // after 18:30 or before 09:30 Istanbul
}

const AUTO_SCAN_INTERVAL_MS = 1000 * 60 * 15; // 15-minute auto scan when market open
const SCAN_CONCURRENCY = 10;                    // parallel workers per chunk
const CHUNK_DELAY_MS = 200;                     // delay between chunks
const SCAN_UNIVERSE = 'bistall';                // full universe ~648 symbols

// ── Tomorrow Potential Score: rank stocks by next-day opportunity ──
// Pure function — no React state dependency, safe to define at module level
function calcTomorrowPotential(result) {
  if (!result) return 0;
  let tpScore = 0;
  
  // 1. Weak Close Penalty (CRITICAL: Protect against Falling Knives & Bull Traps)
  // If a stock closed in the bottom 30% of its daily range, it was heavily rejected.
  if (result.dayHighLowRange !== undefined && result.dayHighLowRange < 0.3) {
    return 0; // Immediate disqualification for tomorrow (extreme falling knife risk)
  }
  
  // 2. Closing position within Bollinger Bands (lower = more upside)
  // Fix: Only reward touching lower band IF there is a bullish divergence or RSI oversold bounce
  if (result.bollPct != null) {
    if (result.bollPct < 20 && (result.rsi < 40 || result.rsiDivergence === 'bullish')) {
      tpScore += 15; // Mean-reversion setup
    }
    else if (result.bollPct > 80) {
      tpScore -= 10; // Overextended
    }
  }
  
  // 3. Volume trend (rising volume = institutional interest)
  if (result.volRatio) {
    if (result.volRatio > 2) tpScore += 12;
    else if (result.volRatio > 1.5) tpScore += 8;
    else if (result.volRatio > 1.2) tpScore += 4;
  }
  
  // 4. Support proximity (close to support = limited downside)
  if (result.stopPct != null) {
    const riskPct = Math.abs(result.stopPct);
    if (riskPct < 3) tpScore += 10;
    else if (riskPct < 5) tpScore += 5;
  }
  
  // 5. Momentum direction (positive momentum = continuation likely)
  if (result.momentumScore) {
    tpScore += Math.min(15, result.momentumScore * 0.2);
  }
  
  // 6. Ichimoku/Supertrend alignment
  if (result.ichimoku?.cloudPosition === 'above') tpScore += 5;
  if (result.supertrend?.trend === 'UP') tpScore += 5;
  if (result.ichimoku?.tkCross === 'bullish') tpScore += 8;
  if (result.supertrend?.flip === 'bullish') tpScore += 8;
  
  // 7. R/R quality
  if (result.rr >= 2.5) tpScore += 10;
  else if (result.rr >= 2) tpScore += 6;
  else if (result.rr >= 1.5) tpScore += 3;
  
  // 8. Smart money accumulation
  if (result.obvTrend === 'accumulation') tpScore += 8;
  if (result.cmf > 0.1) tpScore += 5;
  
  // 9. Score itself
  tpScore += Math.min(15, (result.score || 0) * 0.2);
  
  return Math.max(0, Math.min(100, tpScore));
}

/**
 * useAIAdvisor - manages AI scanning, top picks, sector rotation, risk alerts.
 * Dispatches window 'advisor-scan-complete' on each full scan.
 */
export function useAIAdvisor(portfolio) {
  const [topPicks, setTopPicks] = useState([]);
  const [scanResults, setScanResults] = useState([]);
  const [riskAlerts, setRiskAlerts] = useState([]);
  const [marketSentiment, setMarketSentiment] = useState(null);
  const [globalMarket, setGlobalMarket] = useState([]);
  const [advisorLog, setAdvisorLog] = useState([]);
  const [sectorHeatmap, setSectorHeatmap] = useState({});
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [lastUpdate, setLastUpdate] = useState(null);
  const runningRef = useRef(false);
  const riskAlertsRef = useRef([]);
  // Onceki taramadan kalan sembol → sektor gucu haritasi.
  // Scan esnasinda mevcut sektorel veri henuz hazir degil; bir onceki taramanin
  // sonuclari kullanilarak her sembol icin sektorel baglam saglanir.
  const prevSectorStrengthRef = useRef({});

  const pushLog = useCallback((entry) => {
    setAdvisorLog(prev => [{ time: new Date(), ...entry }, ...prev].slice(0, 100));
  }, []);

  // ── Portfolio-level risk alerts ──
  useEffect(() => {
    if (!portfolio?.positions) { setRiskAlerts([]); return; }
    const alerts = [];
    const open = portfolio.positions.filter(p => p.status === 'open');
    const totalValue = open.reduce((s, p) => s + (p.entryPrice || 0) * (p.quantity || 0), 0);

    // Single-position concentration
    for (const p of open) {
      const val = (p.entryPrice || 0) * (p.quantity || 0);
      if (totalValue > 0 && val / totalValue > 0.3) {
        alerts.push({ type: 'warn', msg: `${p.symbol} portfoyun %${((val / totalValue) * 100).toFixed(0)}'i — asiri yogunluk` });
      }
    }

    // Sector concentration
    const sectorVal = {};
    for (const p of open) {
      const sec = SECTORS[p.symbol] || 'Diger';
      sectorVal[sec] = (sectorVal[sec] || 0) + (p.entryPrice || 0) * (p.quantity || 0);
    }
    for (const [sec, v] of Object.entries(sectorVal)) {
      if (totalValue > 0 && v / totalValue > 0.4) {
        alerts.push({ type: 'warn', msg: `${sec} sektorunde %${((v / totalValue) * 100).toFixed(0)} yogunluk` });
      }
    }

    // Cash-level advice
    if (portfolio.cash != null && portfolio.cash < 0) {
      alerts.push({ type: 'err', msg: 'Nakit bakiye eksi — marjin riski' });
    }
    setRiskAlerts(alerts);
    riskAlertsRef.current = alerts;
  }, [portfolio]);

  // ── Core scan implementation ──
  const runScan = useCallback(async (opts = {}) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setScanning(true);
    pushLog({ type: 'info', msg: 'AI taramasi baslatildi' });

    try {
      const symbols = getStockList(opts.universe || SCAN_UNIVERSE);
      setScanProgress({ done: 0, total: symbols.length });

      const results = [];
      let done = 0;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Chunk-based scanning (matches original .exe behavior)
      for (let i = 0; i < symbols.length; i += SCAN_CONCURRENCY) {
        const chunk = symbols.slice(i, i + SCAN_CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(async (sym) => {
          try {
            const data = await fetchSingle(sym, '6mo', '1d', true);
            if (data && data.prices && data.prices.length >= 20) {
              const ind = calcAll(data.prices);
              // Onceki taramadan gelen sektorel guc — yoksa null (ilk taramada)
              const sectorStrength = prevSectorStrengthRef.current[sym] ?? null;
              const sig = genSignal(ind, data.prices, { sectorStrength });
              const last = data.prices[data.prices.length - 1];
              const prev = data.prices[data.prices.length - 2] || last;
              const change = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;

              // Use genSignal's normalized score100 directly (no re-mixing)
              const finalScore = Number(sig.score) || 50;

              return {
                symbol: sym,
                sector: SECTORS[sym] || 'Diger',
                price: ind.lastClose,
                change: ind.changePct ?? change,
                volume: last.volume,
                signal: sig.signal,
                cls: sig.cls,
                score: finalScore,
                momentumScore: ind.momentumScore || 0,
                conf: Number(sig.conf) || 0,
                rsi: ind.lastRSI,
                adx: ind.adx,
                mfi: ind.mfi,
                cmf: ind.cmf,
                volRatio: ind.volRatio,
                obvTrend: ind.obvTrend,
                obvDivergence: ind.obvDivergence,
                rsiDivergence: ind.rsiDivergence,
                wyckoff: ind.wyckoffPhase,
                wyckoffSpring: ind.wyckoffSpring,
                volumeClimax: ind.volumeClimax,
                entry: sig.entry,
                stop: sig.stop,
                target: sig.t1,
                targetT2: sig.t2,
                targetT3: sig.t3,
                rr: Number(sig.rr) || 0,
                rrQuality: sig.rrQuality,
                holdText: sig.holdText,
                longTermView: sig.longTermView,
                stopPct: sig.stop && sig.entry ? ((sig.stop - sig.entry) / sig.entry) * 100 : 0,
                targetPct: sig.t1 && sig.entry ? ((sig.t1 - sig.entry) / sig.entry) * 100 : 0,
                // Intraday momentum fields
                dayHighLowRange: ind.dayHighLowRange ?? 0.5,
                gapPct: ind.gapPct,
                gapUp: ind.gapUp,
                momentumIntraday: ind.momentumIntraday,
                volumeSurge: ind.volumeSurge,
                orBreakout: ind.orBreakout,
                // New world-class indicator fields
                ichimoku: ind.ichimoku ? {
                  tkCross: ind.ichimoku.tkCross,
                  kumoBreakout: ind.ichimoku.kumoBreakout,
                  kumoTwist: ind.ichimoku.kumoTwist,
                  cloudPosition: ind.ichimoku.cloudPosition,
                } : null,
                supertrend: ind.supertrend ? {
                  trend: ind.supertrend.trend,
                  flip: ind.supertrend.flip,
                  value: ind.supertrend.value,
                } : null,
                trixCrossover: ind.trix?.crossover || null,
                williamsR: ind.lastWilliamsR,
                roc10: ind.lastROC10,
                bollPct: ind.lastBU && ind.lastBL ? (ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL) * 100 : null,
                volumeProfilePOC: ind.volumeProfile?.poc || null,
              };
            }
          } catch (e) {
            // swallow individual fetch errors
          }
          return null;
        }));
        chunkResults.forEach(r => { if (r) results.push(r); });
        done = Math.min(i + SCAN_CONCURRENCY, symbols.length);
        setScanProgress({ done, total: symbols.length });
        if (i + SCAN_CONCURRENCY < symbols.length) await sleep(CHUNK_DELAY_MS);
      }

      // ── Market sentiment ──
      const buys = results.filter(r => r.cls === 'buy').length;
      const sells = results.filter(r => r.cls === 'sell').length;
      const accumulations = results.filter(r => r.obvTrend === 'accumulation').length;
      const avgRSI = results.length ? results.reduce((s, r) => s + (r.rsi || 50), 0) / results.length : 50;
      const pctBull = results.length ? buys / results.length : 0.5;

      let sentiment = 'NOTR', color = 'var(--yellow)';
      if (pctBull > 0.55) { sentiment = 'YUKSELIS'; color = 'var(--green)'; }
      else if (pctBull < 0.25) { sentiment = 'DUSUS'; color = 'var(--red)'; }
      else if (pctBull < 0.35) { sentiment = 'TEMKINLI'; color = 'var(--orange)'; }

      // Sector rotation
      const sectorMetrics = calcSectorMetrics(results);
      const sectorRotation = rankSectors(sectorMetrics).slice(0, 8).map(s => ({
        sector: s.sector, avgScore: s.avgScore, total: s.scanned, strength: s.strength, rotation: s.rotation,
      }));

      // ── Sonraki tarama icin sembol → sektor gucu haritasini guncelle ──
      // Her sembol kendi sektorunun strength degerini alir.
      {
        const sectorStockMap = getSectorStocks(); // { [sector]: [sym, ...] }
        const nextMap = {};
        for (const [sector, metrics] of Object.entries(sectorMetrics)) {
          const stocks = sectorStockMap[sector] || [];
          for (const s of stocks) nextMap[s] = metrics.strength;
        }
        prevSectorStrengthRef.current = nextMap;
      }

      const sentimentObj = {
        sentiment, color, buys, sells, scanned: results.length, avgRSI, accumulations,
        sectorRotation,
      };

      // ── Top picks — dual mode ──
      const bullishPortfolio = portfolio?.positions?.map(p => p.symbol) || [];
      const isAfterHours = opts.afterHours || isMarketClosedForDay();
      
      const picks = results
        .filter(r => {
          // ── Sektor CIKIS engeli: her iki modda da gecerli ──
          // Onceki taramadan gelen sektor gucu <= 20 ise AL onerisi bloklanir.
          const sectorStr = prevSectorStrengthRef.current[r.symbol];
          if (r.cls === 'buy' && sectorStr != null && sectorStr <= 20) return false;

          if (isAfterHours) {
            // After hours: strict filter — only high-conviction setups
            const isBuy = r.cls === 'buy';
            // Weak close disqualification
            if (r.dayHighLowRange !== undefined && r.dayHighLowRange < 0.3) return false;

            const hasSetup = isBuy && r.score >= 60 && r.rr >= 1.5;
            const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
            return hasSetup || (hasTrend && isBuy && r.score >= 55 && r.rr >= 1.2);
          } else {
            // Market open: strict filter (score100 scale: 0-100)
            const isBuy = r.cls === 'buy';
            // Must hold gains intraday (prevent recommending faded spikes)
            if (r.dayHighLowRange !== undefined && r.dayHighLowRange < 0.4) return false;
            
            const hasTraditionalSignal = isBuy && r.score >= 60 && r.rr >= 1.5;
            const hasMomentumBoost = r.momentumScore >= 50 && (r.change || 0) > 0 && r.score >= 55;
            return hasTraditionalSignal || hasMomentumBoost;
          }
        })
        .map(r => ({
          ...r,
          tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
        }))
        .sort((a, b) => {
          if (isAfterHours) {
            // After hours: sort by tomorrow potential
            return (b.tomorrowPotential || 0) - (a.tomorrowPotential || 0);
          } else {
            // Market open: live momentum is king, traditional score is secondary
            const scoreA = ((a.score || 0) * 0.4) + ((a.momentumScore || 0) * 0.6);
            const scoreB = ((b.score || 0) * 0.4) + ((b.momentumScore || 0) * 0.6);
            return scoreB - scoreA;
          }
        })
        .slice(0, 10);

      // ── KAP haber entegrasyonu: seçilen top picks için paralel çekme (max 10 istek) ──
      // Scan loop'u sırasında 648 sembol için KAP çekmek çok yavaş olur.
      // Sadece filtreden geçen picks için çekiyoruz — max 10 çağrı, kabul edilebilir.
      const picksWithKAP = await Promise.all(picks.map(async (r) => {
        try {
          const disclosures = await fetchKapNews(r.symbol);
          if (disclosures && disclosures.length > 0) {
            const kap = calcKAPSentiment(disclosures);
            return { ...r, kapSentiment: kap.score, kapHeadline: kap.headline, kapCount: kap.count };
          }
        } catch { /* KAP non-fatal — picks still shown without news */ }
        return r;
      }));

      setScanResults(results);
      setTopPicks(picksWithKAP);
      setMarketSentiment(sentimentObj);
      setSectorHeatmap(sectorMetrics);
      setLastUpdate(new Date());
      
      const modeLabel = isAfterHours ? 'Kapanis Sonrasi (Yarin Icin)' : 'Canli';
      pushLog({ type: 'ok', msg: `${modeLabel} tarama: ${results.length} hisse, ${picks.length} firsat` });

      // Dispatch event for other systems (AlertLog, ChatPanel, notifications)
      window.dispatchEvent(new CustomEvent('advisor-scan-complete', {
        detail: {
          results,
          topPicks: picksWithKAP,
          marketContext: sentimentObj,
          sectorRotation,
          riskAlerts: riskAlertsRef.current,
          timestamp: Date.now(),
          scanMode: isAfterHours ? 'afterHours' : 'intraday',
        },
      }));
    } catch (err) {
      pushLog({ type: 'err', msg: 'Tarama hatasi: ' + (err.message || err) });
    } finally {
      setScanning(false);
      runningRef.current = false;
    }
  }, [portfolio, pushLog]);

  const manualScan = useCallback(() => {
    runScan({ universe: SCAN_UNIVERSE });
  }, [runScan]);


  // Auto-scan loop — dual mode: market open vs after hours
  useEffect(() => {
    let timer = null;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const marketOpen = isMarketOpen();
      
      if (!runningRef.current) {
        if (marketOpen) {
          // Market open: standard 15-min scan with intraday momentum boost
          runScan({ universe: SCAN_UNIVERSE }).catch(() => {});
        } else {
          // After hours: run "Tomorrow Picks" scan with end-of-day analysis
          runScan({ universe: SCAN_UNIVERSE, afterHours: true }).catch(() => {});
        }
      }
      
      // Scan interval: 15 min during market, 30 min after hours
      const interval = marketOpen ? AUTO_SCAN_INTERVAL_MS : AUTO_SCAN_INTERVAL_MS * 2;
      timer = setTimeout(tick, interval);
    };
    // Kick off delayed first scan (5s) so app has time to mount
    timer = setTimeout(tick, 5000);
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [runScan]);

  return {
    topPicks,
    scanResults,
    results: scanResults, // alias for backward-compat
    riskAlerts,
    marketSentiment,
    globalMarket,
    advisorLog,
    sectorHeatmap,
    scanning,
    scanProgress,
    lastUpdate,
    manualScan,
    runScan,
    setGlobalMarket,
  };
}
