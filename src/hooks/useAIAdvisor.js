import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList, SECTORS } from '../utils/constants.js';
import { calcSectorMetrics, rankSectors } from '../utils/sectorEngine.js';

/**
 * isMarketOpen - Check if BIST market is currently open
 */
export function isMarketOpen() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const day = now.getDay();
  const timeMinutes = hour * 60 + minute;
  const isWeekday = day >= 1 && day <= 5;
  // BIST: 09:30-12:30 (morning session) + 14:00-17:30 (afternoon session)
  const isMorningSession = timeMinutes >= 570 && timeMinutes < 750;  // 09:30 - 12:30
  const isAfternoonSession = timeMinutes >= 840 && timeMinutes < 1050; // 14:00 - 17:30
  return isWeekday && (isMorningSession || isAfternoonSession);
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
  
  // 1. Closing position within Bollinger Bands (lower = more upside)
  if (result.bollPct != null) {
    if (result.bollPct < 20) tpScore += 15;
    else if (result.bollPct < 40) tpScore += 8;
    else if (result.bollPct > 80) tpScore -= 10;
  }
  
  // 2. Volume trend (rising volume = institutional interest)
  if (result.volRatio) {
    if (result.volRatio > 2) tpScore += 12;
    else if (result.volRatio > 1.5) tpScore += 8;
    else if (result.volRatio > 1.2) tpScore += 4;
  }
  
  // 3. Support proximity (close to support = limited downside)
  if (result.stopPct != null) {
    const riskPct = Math.abs(result.stopPct);
    if (riskPct < 3) tpScore += 10;
    else if (riskPct < 5) tpScore += 5;
  }
  
  // 4. Momentum direction (positive momentum = continuation likely)
  if (result.momentumScore) {
    tpScore += Math.min(15, result.momentumScore * 0.2);
  }
  
  // 5. Ichimoku/Supertrend alignment
  if (result.ichimoku?.cloudPosition === 'above') tpScore += 5;
  if (result.supertrend?.trend === 'UP') tpScore += 5;
  if (result.ichimoku?.tkCross === 'bullish') tpScore += 8;
  if (result.supertrend?.flip === 'bullish') tpScore += 8;
  
  // 6. R/R quality
  if (result.rr >= 2.5) tpScore += 10;
  else if (result.rr >= 2) tpScore += 6;
  else if (result.rr >= 1.5) tpScore += 3;
  
  // 7. Smart money accumulation
  if (result.obvTrend === 'accumulation') tpScore += 8;
  if (result.cmf > 0.1) tpScore += 5;
  
  // 8. Score itself
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
              const sig = genSignal(ind, data.prices);
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

      const sentimentObj = {
        sentiment, color, buys, sells, scanned: results.length, avgRSI, accumulations,
        sectorRotation,
      };

      // ── Top picks — dual mode ──
      const bullishPortfolio = portfolio?.positions?.map(p => p.symbol) || [];
      const isAfterHours = opts.afterHours || !isMarketOpen();
      
      const picks = results
        .filter(r => {
          if (isAfterHours) {
            // After hours: strict filter — only high-conviction setups
            const isBuy = r.cls === 'buy';
            const hasSetup = isBuy && r.score >= 60 && r.rr >= 1.5;
            const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
            return hasSetup || (hasTrend && isBuy && r.score >= 55 && r.rr >= 1.2);
          } else {
            // Market open: strict filter (score100 scale: 0-100)
            const isBuy = r.cls === 'buy';
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
            // Market open: momentum + score
            const scoreA = (a.score || 0) + ((a.momentumScore || 0) * 0.2);
            const scoreB = (b.score || 0) + ((b.momentumScore || 0) * 0.2);
            return scoreB - scoreA;
          }
        })
        .slice(0, 10);

      setScanResults(results);
      setTopPicks(picks);
      setMarketSentiment(sentimentObj);
      setSectorHeatmap(sectorMetrics);
      setLastUpdate(new Date());
      
      const modeLabel = isAfterHours ? 'Kapanis Sonrasi (Yarin Icin)' : 'Canli';
      pushLog({ type: 'ok', msg: `${modeLabel} tarama: ${results.length} hisse, ${picks.length} firsat` });

      // Dispatch event for other systems (AlertLog, ChatPanel, notifications)
      window.dispatchEvent(new CustomEvent('advisor-scan-complete', {
        detail: {
          results,
          topPicks: picks,
          marketContext: sentimentObj,
          sectorRotation,
          riskAlerts,
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
  }, [portfolio, pushLog, riskAlerts]);

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
