import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList, SECTORS } from '../utils/constants.js';
import { calcSectorMetrics, rankSectors } from '../utils/sectorEngine.js';
import { fetchMarketNews, indexBySymbol } from '../utils/marketNewsEngine.js';

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

/**
 * isMarketClosedForDay — returns true after 17:30 on a weekday,
 * meaning the session has ended and end-of-day data is final.
 */
export function isMarketClosedForDay() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return true; // weekend
  const timeMinutes = now.getHours() * 60 + now.getMinutes();
  return timeMinutes >= 1050; // past 17:30
}

const AUTO_SCAN_INTERVAL_MS = 1000 * 60 * 15; // 15-minute auto scan when market open
const SCAN_CONCURRENCY = 10;                    // parallel workers per chunk
const CHUNK_DELAY_MS = 200;                     // delay between chunks
const SCAN_UNIVERSE = 'bistall';                // full universe ~648 symbols

// ── Tomorrow Potential Score: rank stocks by next-day opportunity ──
// Pure function — no React state dependency, safe to define at module level
// ══════════════════════════════════════════════════════════════════════
// calcTomorrowPotential — kapanis sonrasi "yarin +5%" olasiligini olcer.
// 3 ana setup tipi:
//   A) DIP BOUNCE: oversold (RSI<35, BB alt, Williams<-80) + hacim artisi
//   B) COIL BREAK: TTM Squeeze + daralan ATR + kirilim oncesi birikim
//   C) CATALYST: fund_inflow/buyback/insider_buy haberi + teknik destek
// Anti-pump: son 2 gunde >+7% yapmis hisseler agir ceza alir.
// Gunluk aralik kucukse (<2.5%) skor kucuktulur — %5 cikamaz zaten.
// ══════════════════════════════════════════════════════════════════════
function calcTomorrowPotential(result) {
  if (!result) return 0;
  let tpScore = 0;

  // ── PUMP DEĞERLENDİRMESİ: Artış devam eder mi, yoksa tükenme mi? ──
  // Hard sıfır YOK — tavan bile yapsa devam sinyalleri varsa göster.
  // Ama momentum tükenme işaretleri varsa ağır ceza.
  const recentPump = result.recentPump || 0;

  if (recentPump > 7) {
    // Yüksek pump: devam sinyalleri yoksa skor düşür
    const continuationSignals = [
      result.obvTrend === 'accumulation',        // kurumsal alım devam ediyor
      (result.cmf || 0) > 0.1,                   // para akışı pozitif
      (result.mfi || 50) < 65,                   // MFI henüz aşırı alım değil
      result.wyckoffSpring === true,              // Wyckoff markup fazında
      result.ttmSqueeze?.squeezeRelease === true, // squeeze breakout devam
      result.newsCategories?.some(c =>
        ['fund_inflow','buyback','insider_buy'].includes(c)), // kataliz var
    ].filter(Boolean).length;

    if (continuationSignals >= 3) {
      // Güçlü devam sinyalleri → hafif negatif bias yeterli
      tpScore -= 5;
    } else if (continuationSignals >= 1) {
      // Zayıf devam sinyali → orta ceza
      tpScore -= 18;
    } else {
      // Hiç devam sinyali yok → artış yorgun, büyük ceza ama sıfır değil
      tpScore -= 30;
    }
  } else if (recentPump > 5) {
    tpScore -= 8;   // Orta pump — hafif ceza
  } else if (recentPump > 3) {
    tpScore -= 2;   // Hafif yukarı — neredeyse nötr
  }

  // ── GUNLUK ARALIK GATI: ATR/price < %2 ise hisse yeterince hareket etmez ──
  const atrPct = result.atrPct || 0;           // ATR / price * 100
  if (atrPct < 1.5) tpScore -= 20;            // cok dar bant
  else if (atrPct < 2.5) tpScore -= 5;
  else if (atrPct >= 3) tpScore += 8;         // genis aralik — 5% mumkun
  else if (atrPct >= 5) tpScore += 15;

  // ── SETUP A — DIP BOUNCE (ortalamayi geri donusu) ──
  if (result.bollPct != null) {
    if (result.bollPct < 15) tpScore += 20;   // alt bant altinda — en guclu dip
    else if (result.bollPct < 25) tpScore += 14;
    else if (result.bollPct < 35) tpScore += 7;
    else if (result.bollPct > 85) tpScore -= 12; // ust bantta — yukari yer az
  }
  if (result.rsi != null) {
    if (result.rsi < 25) tpScore += 18;       // asiri satim extremum
    else if (result.rsi < 32) tpScore += 12;
    else if (result.rsi < 40) tpScore += 5;
    else if (result.rsi > 70) tpScore -= 10;
    else if (result.rsi > 80) tpScore -= 18;
  }
  if (result.williamsR != null && result.williamsR < -80) tpScore += 8;
  if (result.mfi != null) {
    if (result.mfi < 25) tpScore += 10;       // oversold + MFI = para girisi bekle
    else if (result.mfi < 35) tpScore += 5;
    else if (result.mfi > 75) tpScore -= 8;
  }

  // ── SETUP B — COIL/SQUEEZE BREAK (kirilim oncesi birikim) ──
  if (result.ttmSqueeze?.squeezeOn) tpScore += 15; // aktif sikisma
  if (result.ttmSqueeze?.squeezeRelease) tpScore += 20; // sikismadan yeni cikis
  if (result.obvTrend === 'accumulation') tpScore += 12;
  if (result.cmf != null) {
    if (result.cmf > 0.15) tpScore += 10;
    else if (result.cmf > 0.05) tpScore += 5;
    else if (result.cmf < -0.1) tpScore -= 8;
  }
  if (result.volRatio != null) {
    if (result.volRatio > 2.5) tpScore += 10;  // hacim patlamasi
    else if (result.volRatio > 1.8) tpScore += 6;
    else if (result.volRatio > 1.3) tpScore += 3;
    else if (result.volRatio < 0.6) tpScore -= 5; // hacim kuruyor
  }

  // ── SETUP C — CATALYST BOOST (haber destekli) ──
  // Haber enricment'tan gelen veri (useAIAdvisor'da ekleniyor)
  if (result.newsScore != null) {
    const HIGH_VALUE_CATS = ['fund_inflow', 'buyback', 'insider_buy', 'contract'];
    const hasCatalyst = result.newsCategories?.some(c => HIGH_VALUE_CATS.includes(c));
    if (hasCatalyst && result.newsScore > 3) tpScore += 20; // guclu kataliz
    else if (hasCatalyst) tpScore += 10;
    else if (result.newsScore > 2) tpScore += 5;            // genel pozitif haber
    else if (result.newsScore < -3) tpScore -= 15;          // negatif haber
    if (result.newsCategories?.includes('risk')) tpScore -= 20;
    if (result.newsHighImpact > 0) tpScore += 8;
  }
  // KAP sentiment da hesaba kat
  if (result.kapSentiment != null) {
    if (result.kapSentiment > 5) tpScore += 10;
    else if (result.kapSentiment > 2) tpScore += 5;
    else if (result.kapSentiment < -3) tpScore -= 10;
  }

  // ── TEKNIK TEYITLER ──
  if (result.ichimoku?.tkCross === 'bullish') tpScore += 10;
  if (result.ichimoku?.kumoBreakout === 'bullish') tpScore += 12;
  if (result.ichimoku?.cloudPosition === 'above') tpScore += 4;
  if (result.supertrend?.flip === 'bullish') tpScore += 12;
  if (result.supertrend?.trend === 'UP') tpScore += 4;
  if (result.wyckoffSpring) tpScore += 15;  // Wyckoff spring = en guclu dip sinyali

  // ── R/R KALITESI ──
  if (result.rr >= 3) tpScore += 12;
  else if (result.rr >= 2.5) tpScore += 8;
  else if (result.rr >= 2) tpScore += 5;
  else if (result.rr < 1.2) tpScore -= 10;

  // ── GENEL SKOR KATKISI (daha kucuk agirlik — kataliz ve dip daha onemli) ──
  tpScore += Math.min(10, ((result.score || 50) - 50) * 0.2);

  return Math.max(0, Math.min(100, Math.round(tpScore)));
}

// ── Sell Potential Score: rank stocks by next-day downside opportunity ──
// Mirrors calcTomorrowPotential but for bearish/short setups.
// High score = strong sell candidate (overbought + distribution + bearish tech).
function calcSellPotential(result) {
  if (!result) return 0;
  let spScore = 0;

  // ── PUMP EXHAUSTION: recent surge without fundamentals = sell setup ──
  const recentPump = result.recentPump || 0;
  if (recentPump > 7) spScore += 22;
  else if (recentPump > 5) spScore += 14;
  else if (recentPump > 3) spScore += 6;

  // ── ATR gate: need enough daily range to profit on short side ──
  const atrPct = result.atrPct || 0;
  if (atrPct < 1.5) spScore -= 20;
  else if (atrPct < 2.5) spScore -= 5;
  else if (atrPct >= 3) spScore += 8;
  else if (atrPct >= 5) spScore += 14;

  // ── OVERBOUGHT indicators ──
  if (result.rsi != null) {
    if (result.rsi > 82) spScore += 24;
    else if (result.rsi > 77) spScore += 18;
    else if (result.rsi > 72) spScore += 12;
    else if (result.rsi > 65) spScore += 6;
    else if (result.rsi < 50) spScore -= 18;
  }
  if (result.bollPct != null) {
    if (result.bollPct > 90) spScore += 20;
    else if (result.bollPct > 80) spScore += 12;
    else if (result.bollPct > 70) spScore += 5;
    else if (result.bollPct < 40) spScore -= 14;
  }
  if (result.mfi != null) {
    if (result.mfi > 80) spScore += 14;
    else if (result.mfi > 72) spScore += 8;
    else if (result.mfi < 40) spScore -= 10;
  }
  if (result.williamsR != null && result.williamsR > -15) spScore += 8; // overbought

  // ── DISTRIBUTION signals ──
  if (result.obvTrend === 'distribution') spScore += 16;
  else if (result.obvTrend === 'accumulation') spScore -= 16;
  if (result.cmf != null) {
    if (result.cmf < -0.12) spScore += 12;
    else if (result.cmf < -0.05) spScore += 6;
    else if (result.cmf > 0.1) spScore -= 10;
  }
  if (result.volRatio != null) {
    if (result.volRatio > 2.5) spScore += 6;  // high volume on down day
    else if (result.volRatio < 0.5) spScore -= 6;
  }

  // ── BEARISH technicals ──
  if (result.supertrend?.flip === 'bearish') spScore += 16;
  if (result.supertrend?.trend === 'DOWN') spScore += 10;
  if (result.ichimoku?.cloudPosition === 'below') spScore += 10;
  if (result.ichimoku?.tkCross === 'bearish') spScore += 10;
  if (result.ichimoku?.kumoBreakout === 'bearish') spScore += 12;

  // ── NEGATIVE NEWS / CATALYST ──
  if (result.newsScore != null) {
    if (result.newsCategories?.includes('risk')) spScore += 20;
    if (result.newsCategories?.includes('downgrade')) spScore += 12;
    if (result.newsScore < -3) spScore += 14;
    else if (result.newsScore < -1) spScore += 6;
    else if (result.newsScore > 3) spScore -= 14;
  }

  // ── R/R quality ──
  if (result.rr >= 3) spScore += 12;
  else if (result.rr >= 2.5) spScore += 8;
  else if (result.rr >= 2) spScore += 4;
  else if (result.rr < 1.2) spScore -= 12;

  // ── General bearish score contribution ──
  spScore += Math.min(10, ((50 - (result.score || 50)) * 0.2));

  return Math.max(0, Math.min(100, Math.round(spScore)));
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

              // Anti-pump: max daily change over the last 3 bars
              const recentBars = data.prices.slice(-4);
              let recentPump = 0;
              for (let bi = 1; bi < recentBars.length; bi++) {
                const pc = recentBars[bi - 1].close;
                if (pc > 0) recentPump = Math.max(recentPump, ((recentBars[bi].close - pc) / pc) * 100);
              }

              // ATR as % of price — for daily-range gate
              const atr = ind.atr ? ind.atr : null;
              const atrPct = atr && ind.lastClose > 0 ? (atr / ind.lastClose) * 100 : 0;

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
                recentPump,
                atrPct,
                ttmSqueeze: ind.ttmSqueeze || null,
                wyckoffSpring: ind.wyckoffSpring || false,
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

      // Clamp stop/target to realistic daily-range levels (1.8× ATR max)
      // This prevents showing stops 10% away for a next-day trade recommendation.
      const normalizeStopTarget = (r) => {
        const entry = r.entry || r.price || 0;
        if (!entry) return r;
        const atr = entry * (r.atrPct || 2) / 100;
        const MAX_STOP_MULT = 1.8; // max 1.8× ATR stop distance

        let { stop, target } = r;

        if (r.cls !== 'sell') {
          // Buy: stop below entry
          if (stop && stop < entry) {
            const origDist = entry - stop;
            const maxDist = atr * MAX_STOP_MULT;
            if (origDist > maxDist) {
              stop = entry - maxDist;
              const rrUse = Math.max(1.5, r.rr || 1.5);
              target = entry + maxDist * rrUse;
            }
          }
        } else {
          // Sell: stop above entry
          if (stop && stop > entry) {
            const origDist = stop - entry;
            const maxDist = atr * MAX_STOP_MULT;
            if (origDist > maxDist) {
              stop = entry + maxDist;
              const rrUse = Math.max(1.5, r.rr || 1.5);
              target = entry - maxDist * rrUse;
            }
          }
        }

        const stopPct = stop && entry ? ((stop - entry) / entry) * 100 : r.stopPct;
        const targetPct = target && entry ? ((target - entry) / entry) * 100 : r.targetPct;
        const stopDist = Math.abs(entry - (stop || entry));
        const targetDist = Math.abs((target || entry) - entry);
        const computedRR = stopDist > 0 ? +(targetDist / stopDist).toFixed(2) : r.rr;

        return { ...r, stop, target, stopPct, targetPct, rr: computedRR };
      };

      // ── BUY PICKS ──
      const buyPicks = results
        .filter(r => {
          if ((r.atrPct || 0) < 1.5) return false;
          if (r.cls !== 'buy') return false;

          if (isAfterHours) {
            const hasSetup = r.score >= 58 && r.rr >= 1.5;
            const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
            const hasCatalyst = r.newsCategories?.some(c =>
              ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c));
            if (hasCatalyst && r.score >= 52 && r.rr >= 1.2) return true;
            return hasSetup || (hasTrend && r.score >= 55 && r.rr >= 1.2);
          } else {
            const hasTraditionalSignal = r.score >= 60 && r.rr >= 1.5;
            const hasMomentumBoost = r.momentumScore >= 50 && (r.change || 0) > 0 && r.score >= 55
              && (r.recentPump || 0) < 5;
            return hasTraditionalSignal || hasMomentumBoost;
          }
        })
        .map(r => normalizeStopTarget({
          ...r,
          tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
        }))
        .sort((a, b) => {
          if (isAfterHours) {
            return (b.tomorrowPotential || 0) - (a.tomorrowPotential || 0);
          }
          const pumpPenaltyA = Math.min(20, (a.recentPump || 0) * 2);
          const pumpPenaltyB = Math.min(20, (b.recentPump || 0) * 2);
          const scoreA = (a.score || 0) + ((a.momentumScore || 0) * 0.2) - pumpPenaltyA;
          const scoreB = (b.score || 0) + ((b.momentumScore || 0) * 0.2) - pumpPenaltyB;
          return scoreB - scoreA;
        })
        .slice(0, 8);

      // ── SELL PICKS — short / bearish candidates ──
      // Stocks that are overbought, distributing, or have bearish technicals.
      const sellPicks = results
        .filter(r => {
          if ((r.atrPct || 0) < 1.5) return false;
          if (r.cls !== 'sell') return false;
          // Must have bearish score + at least one confirming bearish signal
          if (r.score > 44) return false;
          if ((r.rr || 0) < 1.2) return false;
          const isOverbought = (r.rsi || 50) > 62;
          const hasDistribution = r.obvTrend === 'distribution' || (r.cmf || 0) < -0.05;
          const hasBearishTech = r.supertrend?.trend === 'DOWN' || r.ichimoku?.cloudPosition === 'below';
          const hasNegativeNews = r.newsCategories?.some(c => ['risk', 'downgrade'].includes(c));
          return isOverbought || hasDistribution || hasBearishTech || hasNegativeNews;
        })
        .map(r => normalizeStopTarget({
          ...r,
          sellPotential: calcSellPotential(r),
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
        }))
        .sort((a, b) => (b.sellPotential || 0) - (a.sellPotential || 0))
        .slice(0, 3); // max 3 sell candidates alongside buy picks

      const picks = [...buyPicks, ...sellPicks];

      // ── Market news enrichment: fetch borsa haberleri, eslestir + sentiment ──
      // Sadece top 10 pick + universe filtrelenir; tum tarama icin haber cekmiyoruz.
      let newsIndex = {};
      try {
        const universe = picks.map(p => p.symbol);
        if (universe.length) {
          const news = await fetchMarketNews({ universe, maxPerSource: 25 });
          newsIndex = indexBySymbol(news);
          // Inject per-pick news entry (score, count, top headline)
          for (const r of picks) {
            const e = newsIndex[r.symbol];
            if (e?.count) {
              r.newsScore = e.score;
              r.newsCount = e.count;
              r.newsCategories = e.categories;
              r.newsHeadline = e.topItem?.title || '';
              r.newsHighImpact = e.highImpact;
            }
          }
        }
      } catch { /* news enrichment is best-effort */ }

      setScanResults(results);
      setTopPicks(picks);
      setMarketSentiment(sentimentObj);
      setSectorHeatmap(sectorMetrics);
      setLastUpdate(new Date());
      
      const modeLabel = isAfterHours ? 'Kapanis Sonrasi (Yarin Icin)' : 'Canli';
      pushLog({ type: 'ok', msg: `${modeLabel} tarama: ${results.length} hisse, ${buyPicks.length} AL / ${sellPicks.length} SAT firsat` });

      // Dispatch event for other systems (AlertLog, ChatPanel, notifications)
      window.dispatchEvent(new CustomEvent('advisor-scan-complete', {
        detail: {
          results,
          topPicks: picks,
          marketContext: sentimentObj,
          sectorRotation,
          riskAlerts,
          newsIndex,
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
