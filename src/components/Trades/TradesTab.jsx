import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { BIST30, getStockList, SECTORS } from '../../utils/constants.js';
import { fetchSingle } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal, calcPosition } from '../../utils/signals.js';
import { fetchIsYatirimFinancials, scoreIsYatirimFundamentals } from '../../utils/isyatirimEngine.js';
import { getFundamentalGrade } from '../../utils/fundamentalEngine.js';
import { isMarketOpen } from '../../hooks/useAIAdvisor.js';

// Session context for BIST trading hours
function getSessionContext() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const totalMin = hour * 60 + minute;

  if (totalMin < 600) return { session: 'pre', label: 'Piyasa Oncesi', icon: '\u{1F319}', tip: 'Piyasa henuz acilmadi. Onceki gun verilerine gore strateji planlayin.' };
  if (totalMin < 660) return { session: 'open', label: 'Acilis Seansi', icon: '\u{1F514}', tip: 'Ilk 1 saat yuksek volatilite. Ani hareketlere dikkat, fake-out riski yuksek. Ilk 15dk bekleyin.' };
  if (totalMin < 720) return { session: 'morning', label: 'Sabah Seansi', icon: '\u2600\uFE0F', tip: 'Kurumsal islemler yogun. Hacim teyitli kirilmalari takip edin.' };
  if (totalMin < 780) return { session: 'midday', label: 'Oglen Molasi', icon: '\u{1F550}', tip: 'Hacim dusuyor. Yeni pozisyon acmak riskli — mevcut pozisyonlari yonetin.' };
  if (totalMin < 960) return { session: 'afternoon', label: 'Ogle Seansi', icon: '\u{1F324}\uFE0F', tip: 'Ogle rallisi veya satisi baslayabilir. Trend yonu netlesir, momentum takibi yapin.' };
  if (totalMin < 1020) return { session: 'closing', label: 'Kapanis Yaklasma', icon: '\u{1F6A8}', tip: 'Son 1 saat — pozisyon kapatma zamani. Gece riski tasimak istemiyorsaniz cikin.' };
  if (totalMin < 1080) return { session: 'close', label: 'Kapanis', icon: '\u{1F512}', tip: 'Piyasa kapandi. Yarin icin strateji planlayin.' };
  return { session: 'after', label: 'Piyasa Kapali', icon: '\u{1F319}', tip: 'Yarin icin analiz yapin. Watchlist ve alarmlari gunceleyin.' };
}

// Generate intraday-specific strategy note
function generateStrategyNote(r) {
  const notes = [];

  // Momentum-based strategy
  if (r.change > 1.5 && r.volRatio > 1.5 && r.macdAccel) {
    notes.push('MOMENTUM TAKIP: Guclu yukselis + hacim teyiti + MACD ivme. Kirilma devamini takip edin.');
  }
  // Mean-reversion
  if (r.rsi < 30 && r.obvTrend === 'accumulation' && r.change < 0) {
    notes.push('DIP ALIS: RSI asiri satim + kurumsal birikim. Destek seviyesinden donus beklentisi.');
  }
  // Squeeze breakout
  if (r.ttmSqueeze?.firing && r.ttmSqueeze?.momentum > 0) {
    notes.push('SQUEEZE PATLAMA: Bollinger sikismadan cikis. Sert yukselis hareketi baslamis olabilir.');
  }
  // Divergence play
  if (r.rsiDivergence === 'bullish' || r.obvDivergence === 'bullish_div') {
    notes.push('DIVERJANS FIRSATI: Fiyat dip yaparken momentum toplaniyor. Dipten donus potansiyeli yuksek.');
  }
  // Spring trap
  if (r.wyckoffSpring === 'spring') {
    notes.push('WYCKOFF SPRING: Kurumsal tuzak tamamlandi. Zayif eller silkelendi, yukari atis bekleniyor.');
  }
  // Volume climax reversal
  if (r.volumeClimax === 'selling_climax') {
    notes.push('SATIS KLIMAKSI: Tum saticilar bosaldi. Taban olusumu ve toparlanma beklenebilir.');
  }
  // Smart money + trend
  if (r.obvTrend === 'accumulation' && r.cmf > 0.1 && r.adx > 20) {
    notes.push('KURUMSAL BIRIKIM: Akilli para toplama yapiyor, trend gucu yeterli. Guclu sinyal.');
  }

  if (notes.length === 0) {
    if (r.cls === 'buy') notes.push('STANDART ALIS: Teknik sinyaller pozitif. Hacim ve momentum teyiti ile giris yapin.');
    else notes.push('IZLEME: Belirgin bir setup olusana kadar bekleyin.');
  }

  return notes;
}

// Calculate enhanced intraday levels using multi-source approach
function calcIntradayLevels(ind, sig, prices) {
  if (!prices || prices.length < 5) return { target: null, stop: null, rr: 0 };

  const p = ind.lastClose;
  const atr = ind.chandelier?.atr || 0;
  const n = prices.length;

  // Calculate average true range for last 5 bars (more responsive)
  const recentRanges = [];
  for (let i = Math.max(0, n - 5); i < n; i++) {
    recentRanges.push(prices[i].high - prices[i].low);
  }
  const avgRange = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;

  // Intraday target: based on ATR and nearby resistance
  const srLevels = ind.sr && Array.isArray(ind.sr) ? ind.sr : [];
  const nearestRes = srLevels.filter(s => s.type === 'resistance' && s.price > p * 1.002).sort((a, b) => a.price - b.price)[0];
  const nearestSup = srLevels.filter(s => s.type === 'support' && s.price < p * 0.998).sort((a, b) => b.price - a.price)[0];

  // Target: weighted average of ATR projection and nearest resistance
  let target;
  if (nearestRes && nearestRes.price < p + avgRange * 2) {
    target = nearestRes.price * 0.995; // Just below resistance
  } else {
    target = p + avgRange * 0.7; // 70% of avg daily range as intraday target
  }
  if (target < p * 1.003) target = p * 1.005; // Minimum 0.5% target

  // Stop: based on support and ATR
  let stop;
  if (nearestSup && nearestSup.price > p - avgRange * 1.5) {
    stop = nearestSup.price * 0.997; // Just below support
  } else {
    stop = p - avgRange * 0.45; // 45% of avg daily range as stop
  }
  if (stop > p * 0.997) stop = p * 0.995; // Minimum 0.5% stop distance

  const rr = (p - stop) > 0 ? (target - p) / (p - stop) : 0;

  return { target, stop, rr, avgRange };
}

export default function TradesTab({ addToPortfolio, portfolio, signalTracker, advisorData, onScanComplete }) {
  const [results, setResults] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: 'Bekleniyor...' });
  const [listType, setListType] = useState('bist30');
  const [marketCondition, setMarketCondition] = useState(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [expandedCard, setExpandedCard] = useState(null);
  const [useAdvisorCache, setUseAdvisorCache] = useState(true);
  const [autoScanPending, setAutoScanPending] = useState(false);
  const generateRef = useRef(null);
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const sessionCtx = getSessionContext();

  // ── Auto-scan when AI Advisor completes a new full scan ──
  useEffect(() => {
    const handler = (e) => {
      // Only auto-trigger if TradesTab has already been scanned once and advisor has fresh data
      if (scanComplete && !loading && useAdvisorCache) {
        setAutoScanPending(true);
      }
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, [scanComplete, loading, useAdvisorCache]);

  // Execute auto-scan when pending
  useEffect(() => {
    if (autoScanPending && !loading && generateRef.current) {
      setAutoScanPending(false);
      generateRef.current();
    }
  }, [autoScanPending, loading]);

  const generate = useCallback(async () => {
    setLoading(true); setResults([]); setRejected([]); setScanComplete(false); setMarketCondition(null); setExpandedCard(null);

    // ── Step 1: Check overall market condition (BIST100 daily + weekly) ──
    let marketOk = true;
    let marketInfo = { trend: 'neutral', rsi: 50, change: 0 };
    let htfContext = null;
    try {
      // Fetch daily AND weekly BIST100 for multi-timeframe context
      const [xu100Daily, xu100Weekly] = await Promise.all([
        fetchSingle('XU100', '1mo', '1d', true),
        fetchSingle('XU100', '2y', '1wk', true).catch(() => null),
      ]);

      if (xu100Daily && xu100Daily.prices.length >= 10) {
        const mInd = calcAll(xu100Daily.prices);
        const mSig = genSignal(mInd, xu100Daily.prices);
        marketInfo.trend = mInd.lastClose > mInd.lastMA20 ? 'bullish' : mInd.lastClose < mInd.lastMA50 ? 'bearish' : 'neutral';
        marketInfo.rsi = mInd.lastRSI || 50;
        marketInfo.change = mInd.changePct || 0;
        marketInfo.score = mSig.score;
        marketInfo.adx = mInd.adx;
        marketInfo.obvTrend = mInd.obvTrend;
        marketInfo.ma200Above = mInd.lastMA200 ? mInd.lastClose > mInd.lastMA200 : null;

        // Weekly trend analysis
        let weeklyTrend = 'neutral';
        let weeklyRsi = null;
        let weeklyAdx = null;
        if (xu100Weekly && xu100Weekly.prices.length >= 20) {
          const wInd = calcAll(xu100Weekly.prices);
          weeklyTrend = wInd.lastClose > wInd.lastMA20 ? 'bull' : wInd.lastClose < wInd.lastMA50 ? 'bear' : 'neutral';
          weeklyRsi = wInd.lastRSI || null;
          weeklyAdx = wInd.adx || null;
          marketInfo.weeklyTrend = weeklyTrend;
          marketInfo.weeklyRsi = weeklyRsi;
        }

        // Build enhanced HTF context with BOTH daily and weekly data
        htfContext = {
          trend: marketInfo.trend === 'bullish' ? 'bull' : marketInfo.trend === 'bearish' ? 'bear' : 'neutral',
          rsi: marketInfo.rsi,
          adx: marketInfo.adx,
          ma200Above: marketInfo.ma200Above,
          // NEW: Weekly context for hard trend filtering
          weeklyTrend,
          weeklyRsi,
          weeklyAdx,
        };

        // Market rejection gate: bearish daily + weekly downtrend = very risky
        if (marketInfo.trend === 'bearish' && marketInfo.rsi < 35 && marketInfo.change < -2) {
          marketOk = false;
        }
        // NEW: If both weekly AND daily are strongly bearish, also reject
        if (weeklyTrend === 'bear' && marketInfo.trend === 'bearish' && weeklyRsi && weeklyRsi < 40) {
          marketOk = false;
        }
      }
    } catch (e) {}
    setMarketCondition(marketInfo);

    const stocks = getStockList(listType);
    const total = stocks.length;
    const all = [];

    // ── Step 2: Check AI Advisor cache for pre-scanned data ──
    const advisorResults = advisorData?.scanResults || [];
    const advisorCacheMap = {};
    if (useAdvisorCache && advisorResults.length > 0) {
      advisorResults.forEach(r => { advisorCacheMap[r.symbol] = r; });
    }
    const cachedCount = stocks.filter(s => advisorCacheMap[s]).length;
    const needsFetch = stocks.filter(s => !advisorCacheMap[s]);

    if (cachedCount > 0) {
      setProgress({ pct: 10, label: `AI Advisor onbellekten ${cachedCount} hisse yukleniyor...` });
    }

    // ── PERFECT DATA ARCHITECTURE: Parallel Single Fetch for Full OHLC Accuracy ──
    const CHUNK_SIZE = 15;
    
    // Combine cached and non-cached for a unified high-quality scan
    const allStocks = [...stocks];
    for (let i = 0; i < allStocks.length; i += CHUNK_SIZE) {
      const chunk = allStocks.slice(i, i + CHUNK_SIZE);
      
      const chunkPromises = chunk.map(async (sym) => {
        try {
          const data = await fetchSingle(sym, '3mo', '1d', true);
          if (data && data.prices && data.prices.length >= 20) {
            const cached = advisorCacheMap[sym];
            const ind2 = calcAll(data.prices);
            const sig2 = genSignal(ind2, data.prices, { htfContext });
            const intraday = calcIntradayLevels(ind2, sig2, data.prices);
            
            const macdHist = ind2.macd?.histogram?.length > 0 ? ind2.macd.histogram[ind2.macd.histogram.length - 1] : 0;
            const prevMacdHist = ind2.macd?.histogram?.length > 1 ? ind2.macd.histogram[ind2.macd.histogram.length - 2] : 0;
            
            return {
              symbol: sym, price: ind2.lastClose, change: ind2.changePct,
              signal: sig2.signal, cls: sig2.cls, score: sig2.score, conf: sig2.conf,
              rsi: ind2.lastRSI, rr: sig2.rr, entry: sig2.entry, stop: sig2.stop,
              target: sig2.t1, t2: sig2.t2, mfi: ind2.mfi, obvTrend: ind2.obvTrend,
              volRatio: ind2.volRatio, sector: SECTORS[sym] || 'Diger',
              dailyRange: sig2.dailyRange,
              intradayTarget: intraday.target, intradayStop: intraday.stop,
              intradayRR: intraday.rr, avgRange: intraday.avgRange,
              adx: ind2.adx, cmf: ind2.cmf, wyckoff: ind2.wyckoffPhase,
              macdHist, prevMacdHist,
              macdAccel: macdHist > 0 && macdHist > prevMacdHist,
              bollPct: sig2.bollPct, stochK: ind2.stochRSI?.k?.length > 0 ? ind2.stochRSI.k[ind2.stochRSI.k.length - 1] : null,
              ttmSqueeze: ind2.ttmSqueeze, candlePatterns: ind2.candlePatterns,
              reasons: sig2.reasons,
              obvDivergence: ind2.obvDivergence, rsiDivergence: ind2.rsiDivergence,
              wyckoffSpring: ind2.wyckoffSpring, volumeClimax: ind2.volumeClimax,
              diConvergence: ind2.diConvergence,
              nearSupport: ind2.sr?.filter(s => s.type === 'support' && s.price < ind2.lastClose).sort((a, b) => b.price - a.price)[0]?.price,
              nearResistance: ind2.sr?.filter(s => s.type === 'resistance' && s.price > ind2.lastClose).sort((a, b) => a.price - b.price)[0]?.price,
              longTermView: sig2.longTermView, rrQuality: sig2.rrQuality,
              advisorScore: cached?.score || 0, advisorPickScore: cached?.pickScore || 0,
              advisorSignal: cached?.signal || 'neutral',
            };
          }
        } catch (err) {
          console.warn(`[TradesTab] Failed to fetch ${sym}:`, err);
        }
        return null;
      });

      const chunkResults = await Promise.all(chunkPromises);
      chunkResults.forEach(r => { if (r) all.push(r); });

      setProgress({ 
        pct: 10 + Math.floor(((i + CHUNK_SIZE) / allStocks.length) * 85), 
        label: `Piyasa taranıyor (${Math.min(i + CHUNK_SIZE, allStocks.length)}/${allStocks.length})...` 
      });

      // Controlled delay to prevent proxy pressure
      await new Promise(r => setTimeout(r, 250));
    }

    // ── Step 3: Advanced Multi-Factor Scoring (Enhanced for Daily Trading) ──
    const scored = all.filter(r => r.dailyRange > 0).map(r => {
      let s = 0;
      const tags = [];

      // ── A. Volatility & Range (max 4 pts) ──
      if (r.dailyRange > 3.5) { s += 4; tags.push('Yuksek Volatilite'); }
      else if (r.dailyRange > 2.5) { s += 3; tags.push('Iyi Volatilite'); }
      else if (r.dailyRange > 1.8) { s += 2; }
      else if (r.dailyRange > 1.2) { s += 1; }

      // ── B. Momentum Direction (max 5 pts) ──
      if (r.change > 2) { s += 3; tags.push('Guclu Momentum'); }
      else if (r.change > 0.8) { s += 2; }
      else if (r.change > 0) { s += 1; }
      else if (r.change < -3) { s -= 2; }

      if (r.macdAccel) { s += 2; tags.push('MACD Ivmeleniyor'); }
      else if (r.macdHist > 0) { s += 1; }
      else if (r.macdHist < 0 && r.macdHist < r.prevMacdHist) { s -= 1; }

      // ── C. Volume Confirmation (max 4 pts) ──
      if (r.volRatio > 3) { s += 4; tags.push('Hacim Patlamasi'); }
      else if (r.volRatio > 2) { s += 3; tags.push('Guclu Hacim'); }
      else if (r.volRatio > 1.5) { s += 2; }
      else if (r.volRatio > 1) { s += 1; }
      else if (r.volRatio < 0.5) { s -= 2; tags.push('Dusuk Hacim'); }

      // ── D. Smart Money / Institutional Flow (max 5 pts) ──
      if (r.obvTrend === 'accumulation') { s += 3; tags.push('Kurumsal Birikim'); }
      else if (r.obvTrend === 'distribution') { s -= 2; }

      if (r.mfi != null && r.mfi < 20) { s += 2; tags.push('MFI Asiri Satim'); }
      else if (r.mfi != null && r.mfi < 35 && r.obvTrend === 'accumulation') { s += 1; }
      else if (r.mfi != null && r.mfi > 80) { s -= 1; }

      if (r.cmf != null && r.cmf > 0.15) { s += 2; tags.push('Pozitif Para Akisi'); }
      else if (r.cmf != null && r.cmf < -0.15) { s -= 1; }

      // ── E. RSI Zone (max 3 pts) ──
      if (r.rsi && r.rsi < 30) { s += 3; tags.push('RSI Asiri Satim'); }
      else if (r.rsi && r.rsi < 40 && r.change > 0) { s += 2; tags.push('Dipten Donus'); }
      else if (r.rsi && r.rsi > 40 && r.rsi < 60) { s += 1; }
      else if (r.rsi && r.rsi > 75) { s -= 2; tags.push('RSI Asiri Alim'); }

      // ── F. Trend Strength (max 3 pts) ──
      if (r.adx != null && r.adx > 25) { s += 2; tags.push('Guclu Trend'); }
      else if (r.adx != null && r.adx < 15) { s -= 1; }

      if (r.wyckoff === 'accumulation' || r.wyckoff === 'markup') { s += 1; }
      else if (r.wyckoff === 'distribution' || r.wyckoff === 'markdown') { s -= 1; }

      // ── G. Risk/Reward Quality (max 3 pts) ──
      if (r.intradayRR > 2) { s += 3; tags.push('Mukemmel R/R'); }
      else if (r.intradayRR > 1.5) { s += 2; tags.push('Iyi R/R'); }
      else if (r.intradayRR > 1) { s += 1; }
      else { s -= 1; }

      // ── H. Technical Signal Alignment (max 3 pts) ──
      if (r.cls === 'buy' && r.score >= 65) { s += 3; tags.push('GUCLU AL Sinyali'); }
      else if (r.cls === 'buy') { s += 1; }
      else if (r.cls === 'sell') { s -= 3; }

      // ── I. Bollinger Squeeze Breakout (max 2 pts) ──
      if (r.ttmSqueeze?.firing && r.ttmSqueeze?.momentum > 0) { s += 2; tags.push('Squeeze Patlama'); }

      // ── J. Candle Pattern Bonus (max 2 pts) ──
      if (r.candlePatterns?.length > 0) {
        const bullish = r.candlePatterns.filter(p => p.type === 'bullish');
        if (bullish.length > 0) { s += 2; tags.push(bullish[0].name); }
      }

      // ── K. StochRSI Timing (max 2 pts) ──
      if (r.stochK != null && r.stochK < 20 && r.change > 0) { s += 2; tags.push('StochRSI Donus'); }
      else if (r.stochK != null && r.stochK > 80) { s -= 1; }

      // ── L. NEW — Advanced Divergence Signals (max 8 pts) ──
      if (r.obvDivergence === 'bullish_div') { s += 3; tags.push('OBV Bullish Diverjans'); }
      else if (r.obvDivergence === 'bearish_div') { s -= 3; tags.push('OBV Bearish Diverjans'); }
      else if (r.obvDivergence === 'hidden_bullish') { s += 1; }

      if (r.rsiDivergence === 'bullish') { s += 2; tags.push('RSI Bullish Diverjans'); }
      else if (r.rsiDivergence === 'bearish') { s -= 2; }

      if (r.wyckoffSpring === 'spring') { s += 3; tags.push('Wyckoff Spring'); }
      else if (r.wyckoffSpring === 'utad') { s -= 3; }

      if (r.volumeClimax === 'selling_climax') { s += 2; tags.push('Satis Klimaksi'); }
      else if (r.volumeClimax === 'buying_climax') { s -= 2; tags.push('Alis Klimaksi'); }

      if (r.diConvergence === 'converging' && r.adx > 20) { s -= 0.5; tags.push('DI Yakinlasma'); }

      // ── M. Market Alignment ──
      if (marketInfo.trend === 'bullish' && r.cls === 'buy') { s += 1; tags.push('Piyasa Uyumlu'); }
      if (marketInfo.trend === 'bearish' && r.cls !== 'sell') { s -= 1; }

      // ── N. Session Context Bonus ──
      if (sessionCtx.session === 'morning' || sessionCtx.session === 'afternoon') {
        if (r.volRatio > 1.5) s += 0.5; // Volume during active hours = more reliable
      }
      if (sessionCtx.session === 'midday') {
        s -= 0.5; // Reduced conviction during lunch
      }

      // Calculate confidence percentage
      const maxPossible = 48; // theoretical max from all categories
      const confidence = Math.min(95, Math.max(5, Math.round((s / maxPossible) * 100 + 20)));

      // Generate strategy notes
      const strategyNotes = generateStrategyNote(r);

      return { ...r, intScore: s, confidence, tags, strategyNotes };
    }).sort((a, b) => b.intScore - a.intScore);

    // ── Step 4: Confidence-Based Filtering ──
    const MIN_SCORE = 8;
    const winners = scored.filter(r => r.intScore >= MIN_SCORE && r.cls !== 'sell');
    const nearMiss = scored.filter(r => r.intScore >= 5 && r.intScore < MIN_SCORE && r.cls !== 'sell').slice(0, 5);

    // ── Step 5: Fetch Bilanco for Top Winners (background enrichment) ──
    const topWinners = marketOk ? winners.slice(0, 8) : [];
    setProgress({ pct: 95, label: 'Bilanco verisi yukleniyor...' });

    const enriched = await Promise.all(topWinners.map(async (r) => {
      try {
        const finData = await fetchIsYatirimFinancials(r.symbol);
        if (finData && finData.ratios) {
          const fundScore = scoreIsYatirimFundamentals(finData);
          const grade = fundScore ? getFundamentalGrade(fundScore.score) : null;
          return {
            ...r,
            fundScore: fundScore?.score || null,
            fundGrade: grade?.label || null,
            fundGradeColor: grade?.color || null,
            fundPoints: fundScore?.points || [],
            fundRatios: finData.ratios,
            fundLatest: finData.latest,
          };
        }
      } catch {}
      return { ...r, fundScore: null, fundGrade: null };
    }));

    if (!marketOk) {
      setResults([]);
      setRejected(nearMiss);
    } else {
      setResults(enriched);
      setRejected(nearMiss);
      // Record winning signals into the Signal Tracker
      if (signalTracker?.recordSignal) {
        for (const r of enriched) {
          signalTracker.recordSignal({
            symbol: r.symbol,
            cls: r.cls || 'buy',
            signal: r.signal,
            score: r.intScore,
            conf: r.confidence,
            price: r.price,
            entry: r.intEntry,
            stop: r.intStop,
            target: r.intTarget,
            rr: r.intRR,
            source: 'trades',
            sector: r.sector,
          });
        }
      }
    }
    setScanComplete(true);
    setLoading(false);

    // Emit event for JARVIS and other systems to consume intraday results
    const scanData = {
      results: marketOk ? enriched : [],
      rejected: nearMiss,
      marketCondition: marketInfo,
      listType,
      timestamp: new Date().toISOString(),
      isEod: !isMarketOpen()
    };
    window.dispatchEvent(new CustomEvent('trades-scan-complete', { detail: scanData }));
    // Notify App.jsx via callback (React state sharing — more reliable than events)
    if (onScanComplete) onScanComplete(scanData);
  }, [listType, sessionCtx.session, advisorData, useAdvisorCache, onScanComplete]);

  // Keep generateRef current for auto-scan
  useEffect(() => { generateRef.current = generate; }, [generate]);

  const today = new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="scanner-wrap">
      {/* Session Context Banner */}
      <div style={{
        padding: '12px 18px', borderRadius: 12, marginBottom: 16,
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 14,
        boxShadow: 'var(--shadow)',
      }}>
        <span style={{ fontSize: 22 }}>{sessionCtx.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>{sessionCtx.label}</div>
          <div style={{ fontSize: 9, color: 'var(--t3)', lineHeight: 1.4 }}>{sessionCtx.tip}</div>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--cyan)', fontFamily: 'Space Grotesk,sans-serif' }}>
          {new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="scan-btn go" onClick={generate} disabled={loading} style={{ background: 'linear-gradient(135deg, var(--blue), var(--purple))', color: '#fff', boxShadow: 'var(--shadow)' }}>
          {loading ? '\u2605 TARANIYOR...' : '\u2605 GUNLUK TRADE FIRSATLARI BUL'}
        </button>
        <select className="inp" value={listType} onChange={e => setListType(e.target.value)} style={{ width: 'auto', padding: '8px 30px 8px 10px' }}>
          <option value="bist30">BIST 30 (Hizli)</option><option value="bist50">BIST 50</option><option value="bist100">BIST 100</option>
        </select>
        {/* AI Advisor sync toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--t3)', cursor: 'pointer' }}>
          <input type="checkbox" checked={useAdvisorCache} onChange={e => setUseAdvisorCache(e.target.checked)} style={{ accentColor: 'var(--cyan)' }} />
          AI Advisor Senkron
          {advisorData?.scanResults?.length > 0 && (
            <span style={{ fontSize: 8, color: 'var(--green)', fontWeight: 600 }}>({advisorData.scanResults.length} onbellek)</span>
          )}
        </label>
      </div>

      {/* AI Advisor Integration Banner */}
      {advisorData?.marketSentiment && !scanComplete && !loading && (
        <div style={{
          padding: '8px 14px', borderRadius: 6, marginBottom: 12,
          background: 'rgba(0,229,255,.04)', border: '1px solid rgba(0,229,255,.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', boxShadow: '0 0 4px var(--cyan)' }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--cyan)' }}>AI ADVISOR AKTIF</span>
            <span style={{ fontSize: 9, color: advisorData.marketSentiment.color, fontWeight: 600 }}>{advisorData.marketSentiment.sentiment}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 9, color: 'var(--t3)' }}>
            <span style={{ color: 'var(--green)' }}>{advisorData.marketSentiment.buys} AL</span>
            <span style={{ color: 'var(--red)' }}>{advisorData.marketSentiment.sells} SAT</span>
            <span>Ort RSI: {advisorData.marketSentiment.avgRSI?.toFixed(0)}</span>
            {advisorData.topPicks?.length > 0 && (
              <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>
                Top: {advisorData.topPicks.slice(0, 3).map(p => p.symbol).join(', ')}
              </span>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className="scan-progress visible">
          <div className="sp-text"><span>{progress.label}</span><span>{progress.pct}%</span></div>
          <div className="sp-bar"><div className="sp-fill" style={{ width: progress.pct + '%' }} /></div>
        </div>
      )}

      {!scanComplete && !loading && (
        <div className="scan-empty">
          <div style={{ fontSize: 14, color: 'var(--yellow)', marginBottom: 6 }}>
            {isMarketOpen() ? 'Gunluk Trade Firsatlari' : 'Yarinin Firsatlari (EOD)'}
          </div>
          <div>Multi-faktor algoritmasi: Teknik + Akilli Para + Diverjans + Hacim Klimaks + Wyckoff + Piyasa Uyumu</div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
            Yeni: OBV/RSI Diverjans, Wyckoff Spring, Hacim Klimaksi, DI Yakinlasma, Seans Bazli Analiz
          </div>
        </div>
      )}

      {scanComplete && !loading && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 22, fontWeight: 700, color: 'var(--yellow)' }}>
              {'\u2605'} {isMarketOpen() ? 'Gunluk Trade (Intraday)' : 'Yarin Icin (EOD Modu)'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
              {today} {!isMarketOpen() && <span style={{ color: 'var(--purple)', fontWeight: 'bold' }}>• KAPALISI PIYASA EOD ANALIZI</span>}
            </div>
          </div>

          {/* Market Condition Banner */}
          {marketCondition && (
            <div style={{
              padding: '12px 16px', borderRadius: 10, marginBottom: 16,
              background: 'var(--bg1)',
              borderLeft: '4px solid ' + (marketCondition.trend === 'bullish' ? 'var(--green)' : marketCondition.trend === 'bearish' ? 'var(--red)' : 'var(--yellow)'),
              boxShadow: 'var(--shadow)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>{marketCondition.trend === 'bullish' ? '\u{1F7E2}' : marketCondition.trend === 'bearish' ? '\u{1F534}' : '\u{1F7E1}'}</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)' }}>
                    Piyasa: {marketCondition.trend === 'bullish' ? 'Yukselis Trendi' : marketCondition.trend === 'bearish' ? 'Dusus Trendi — Dikkatli Ol' : 'Yatay / Kararsiz'}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>
                    BIST100 RSI: {marketCondition.rsi?.toFixed(0)} | Degisim: {marketCondition.change >= 0 ? '+' : ''}{marketCondition.change?.toFixed(2)}%
                    {marketCondition.adx ? ` | ADX: ${marketCondition.adx.toFixed(0)}` : ''}
                    {marketCondition.obvTrend ? ` | OBV: ${marketCondition.obvTrend}` : ''}
                    {marketCondition.weeklyTrend && (
                      <span style={{ marginLeft: 4, color: marketCondition.weeklyTrend === 'bull' ? 'var(--green)' : marketCondition.weeklyTrend === 'bear' ? 'var(--red)' : 'var(--yellow)', fontWeight: 600 }}>
                        | Haftalik: {marketCondition.weeklyTrend === 'bull' ? 'YUKSELIS' : marketCondition.weeklyTrend === 'bear' ? 'DUSUS' : 'YATAY'}
                        {marketCondition.weeklyRsi ? ` (RSI:${marketCondition.weeklyRsi.toFixed(0)})` : ''}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* No Opportunity State */}
          {results.length === 0 && (
            <div style={{
              padding: '30px 20px', textAlign: 'center', borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(139,92,246,.06), rgba(59,130,246,.04))',
              border: '1px solid rgba(139,92,246,.15)', marginBottom: 16,
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>{'\u{1F6E1}\uFE0F'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>
                {marketCondition?.trend === 'bearish' ? 'Piyasa Kosullari Uygun Degil' : 'Bugun Yuksek Guvenceli Firsat Yok'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.6, maxWidth: 450, margin: '0 auto' }}>
                {marketCondition?.trend === 'bearish'
                  ? 'Piyasa guclu bir dusus trendinde. Sermaye koruma modunda beklemenizi oneriyorum. Kaybetmemek, kazanmanin ilk adimidir.'
                  : 'Multi-faktor algoritmam bugun yuksek guven esigini asan bir firsat tespit edemedi. Dusuk guvenle islem yapmak uzun vadede zarara yol acar.'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 12, fontWeight: 600 }}>
                "Para kazanmanin en onemli kurali: para kaybetmemektir." — Warren Buffett
              </div>
            </div>
          )}

          {/* Winner Cards */}
          {results.map((r, i) => (
            <TradeResultCard 
              key={r.symbol}
              r={r}
              index={i}
              isExpanded={expandedCard === r.symbol}
              onToggle={() => setExpandedCard(expandedCard === r.symbol ? null : r.symbol)}
              addToPortfolio={addToPortfolio}
              portfolio={portfolio}
            />
          ))}

          {/* Near-Miss Section */}
          {rejected.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                Esik Altinda — Izleme Listesi
              </div>
              {rejected.map(r => {
                const hasDivTag = r.obvDivergence === 'bullish_div' || r.rsiDivergence === 'bullish' || r.wyckoffSpring === 'spring';
                return (
                  <div key={r.symbol} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px', background: 'var(--bg3)', borderRadius: 6, marginBottom: 6,
                    border: '1px solid ' + (hasDivTag ? 'rgba(171,71,188,.3)' : 'var(--border)'), opacity: hasDivTag ? 1 : 0.7,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{r.symbol}</div>
                      <div style={{ fontSize: 9, color: 'var(--t3)' }}>{r.sector}</div>
                      {hasDivTag && <span style={{ fontSize: 7, background: 'var(--purple)', color: '#fff', padding: '1px 4px', borderRadius: 2 }}>DIV</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 10, color: 'var(--t2)' }}>{r.price.toFixed(2)} TL</span>
                      <span style={{ fontSize: 9, color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>{r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}%</span>
                      <span style={{ fontSize: 9, color: 'var(--orange)', fontWeight: 600 }}>Skor: {r.intScore}</span>
                      <span style={{ fontSize: 9, color: 'var(--t3)' }}>%{r.confidence}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="disc" style={{ marginTop: 12, border: 'none' }}>Bu analiz yatirim tavsiyesi degildir.</div>
    </div>
  );
}

const indBox = { background: 'var(--bg0)', padding: '6px 8px', borderRadius: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const indLabel = { fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' };
const indVal = { fontSize: 11, fontWeight: 700 };

// Optimized Card Component (Memoized to prevent freeze on expand)
const TradeResultCard = memo(({ r, index, isExpanded, onToggle, addToPortfolio, portfolio }) => {
  const intGain = r.intradayTarget ? ((r.intradayTarget - r.price) / r.price * 100) : 0;
  const intLoss = r.intradayStop ? ((r.intradayStop - r.price) / r.price * 100) : 0;
  const pos = calcPosition(10000, 1, r.price, r.intradayStop || r.stop);
  const confColor = r.confidence >= 75 ? 'var(--green)' : r.confidence >= 55 ? 'var(--yellow)' : 'var(--orange)';

  // Determine divergence badge
  const hasDivergence = r.obvDivergence === 'bullish_div' || r.rsiDivergence === 'bullish';
  const hasSpring = r.wyckoffSpring === 'spring';
  const hasClimax = r.volumeClimax === 'selling_climax';

  return (
    <div style={{
      background: 'var(--bg1)',
      border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, marginBottom: 16,
      boxShadow: 'var(--shadow)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            background: r.confidence >= 75 ? 'var(--green)' : r.confidence >= 55 ? 'var(--yellow)' : 'var(--orange)',
            color: '#000', fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700,
            width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{index + 1}</div>
          <div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              {r.symbol}
              {hasDivergence && <span style={{ fontSize: 8, background: 'var(--purple)', color: '#fff', padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>DIV</span>}
              {hasSpring && <span style={{ fontSize: 8, background: '#ff6b00', color: '#fff', padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>SPRING</span>}
              {hasClimax && <span style={{ fontSize: 8, background: 'var(--cyan)', color: '#000', padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>KLIMAKS</span>}
            </div>
            <div style={{ fontSize: 9, color: 'var(--t3)' }}>
              {r.sector} | {r.signal} | Vol: %{r.dailyRange.toFixed(1)}
              {r.fundGrade && <span style={{ marginLeft: 6, color: r.fundScore >= 7 ? 'var(--green)' : r.fundScore >= 5 ? 'var(--yellow)' : 'var(--red)', fontWeight: 600 }}>| Bilanco: {r.fundGrade}</span>}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{r.price.toFixed(2)} TL</div>
          <div style={{ fontSize: 11, color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>{r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}%</div>
        </div>
      </div>

      {/* Confidence Bar */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Sistem Guveni</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: confColor }}>{r.confidence}%</span>
        </div>
        <div style={{ height: 4, background: 'var(--bg0)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: r.confidence + '%', background: confColor, borderRadius: 2, transition: 'width .5s' }} />
        </div>
      </div>

      {/* Reason Tags */}
      {r.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {r.tags.slice(0, 6).map((tag, ti) => {
            const isDivTag = tag.includes('Diverjans') || tag.includes('Spring') || tag.includes('Klimaks');
            return (
              <span key={ti} style={{
                fontSize: 9, padding: '3px 10px', borderRadius: 14,
                background: isDivTag ? 'var(--purple2)' : 'var(--blue2)',
                color: isDivTag ? 'var(--purple)' : 'var(--blue)', fontWeight: 600,
                border: '1px solid ' + (isDivTag ? 'var(--purple)22' : 'var(--blue)22'),
              }}>{tag}</span>
            );
          })}
        </div>
      )}

      {/* Strategy Note */}
      {r.strategyNotes && r.strategyNotes.length > 0 && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6,
          background: 'rgba(255,214,0,.04)', border: '1px solid rgba(255,214,0,.12)',
        }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--yellow)', marginBottom: 4, letterSpacing: 0.5 }}>STRATEJI NOTU</div>
          {r.strategyNotes.map((note, ni) => (
            <div key={ni} style={{ fontSize: 10, color: 'var(--t2)', lineHeight: 1.5 }}>{note}</div>
          ))}
        </div>
      )}

      {/* Price Levels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 8, marginBottom: 12 }}>
        <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 5, borderLeft: '3px solid var(--blue)' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Giris</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--blue)' }}>{r.price.toFixed(2)}</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 5, borderLeft: '3px solid var(--red)' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Stop</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--red)' }}>{r.intradayStop?.toFixed(2) || '-'}</div>
          <div style={{ fontSize: 9, color: 'var(--red)' }}>{intLoss.toFixed(2)}%</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 5, borderLeft: '3px solid var(--green)' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Hedef</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green)' }}>{r.intradayTarget?.toFixed(2) || '-'}</div>
          <div style={{ fontSize: 9, color: 'var(--green)' }}>+{intGain.toFixed(2)}%</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 5, borderLeft: '3px solid var(--yellow)' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>R/O</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--yellow)' }}>1:{r.intradayRR ? r.intradayRR.toFixed(1) : '\u2014'}</div>
        </div>
      </div>

      {/* Support/Resistance Levels */}
      {(r.nearSupport || r.nearResistance) && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 9, color: 'var(--t3)' }}>
          {r.nearSupport && <span>Destek: <b style={{ color: 'var(--green)' }}>{r.nearSupport.toFixed(2)}</b></span>}
          {r.nearResistance && <span>Direnc: <b style={{ color: 'var(--red)' }}>{r.nearResistance.toFixed(2)}</b></span>}
          {r.avgRange && <span>Ort. Range: <b style={{ color: 'var(--cyan)' }}>{r.avgRange.toFixed(2)} TL</b></span>}
        </div>
      )}

      {/* Expand/Collapse for detailed view */}
      <button onClick={onToggle} style={{
        width: '100%', padding: '6px 0', background: 'none', border: '1px solid var(--border)',
        borderRadius: 4, color: 'var(--t3)', fontSize: 9, cursor: 'pointer', fontFamily: 'inherit',
        marginBottom: 8,
      }}>
        {isExpanded ? 'Detaylari Gizle \u25B2' : 'Detaylari Goster \u25BC'}
      </button>

      {/* Expanded Detail Section */}
      {isExpanded && (
        <div style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 6, marginBottom: 10 }}>
            <div style={indBox}><span style={indLabel}>RSI</span><span style={{ ...indVal, color: r.rsi > 70 ? 'var(--red)' : r.rsi < 30 ? 'var(--green)' : 'var(--t1)' }}>{r.rsi?.toFixed(0) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>ADX</span><span style={{ ...indVal, color: r.adx > 25 ? 'var(--cyan)' : 'var(--t3)' }}>{r.adx?.toFixed(0) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>MFI</span><span style={{ ...indVal, color: r.mfi < 20 ? 'var(--green)' : r.mfi > 80 ? 'var(--red)' : 'var(--t1)' }}>{r.mfi?.toFixed(0) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>Hacim</span><span style={{ ...indVal, color: r.volRatio > 1.5 ? 'var(--cyan)' : 'var(--t1)' }}>{r.volRatio?.toFixed(1) || '-'}x</span></div>
            <div style={indBox}><span style={indLabel}>CMF</span><span style={{ ...indVal, color: r.cmf > 0.05 ? 'var(--green)' : r.cmf < -0.05 ? 'var(--red)' : 'var(--t1)' }}>{r.cmf?.toFixed(3) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>OBV</span><span style={{ ...indVal, color: r.obvTrend === 'accumulation' ? 'var(--green)' : r.obvTrend === 'distribution' ? 'var(--red)' : 'var(--t3)' }}>{r.obvTrend === 'accumulation' ? 'BIRIKM' : r.obvTrend === 'distribution' ? 'DAGIL' : 'NOTR'}</span></div>
            <div style={indBox}><span style={indLabel}>Wyckoff</span><span style={{ ...indVal, fontSize: 9, color: r.wyckoff === 'accumulation' ? 'var(--green)' : r.wyckoff === 'distribution' ? 'var(--red)' : 'var(--t3)' }}>{r.wyckoff?.toUpperCase() || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>Squeeze</span><span style={{ ...indVal, color: r.ttmSqueeze?.firing ? 'var(--yellow)' : 'var(--t3)' }}>{r.ttmSqueeze?.squeezeOn ? 'AKTIF' : r.ttmSqueeze?.firing ? 'ATIS!' : 'Pasif'}</span></div>
          </div>

          {(r.obvDivergence || r.rsiDivergence || r.wyckoffSpring || r.volumeClimax || r.diConvergence) && (
            <div style={{ padding: '8px 10px', background: 'rgba(171,71,188,.05)', borderRadius: 6, marginBottom: 10, border: '1px solid rgba(171,71,188,.12)' }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--purple)', marginBottom: 4 }}>ILERI SINYALLER</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 9 }}>
                {r.obvDivergence && <span style={{ color: r.obvDivergence.includes('bullish') ? 'var(--green)' : 'var(--red)' }}>OBV: {r.obvDivergence}</span>}
                {r.rsiDivergence && <span style={{ color: r.rsiDivergence === 'bullish' ? 'var(--green)' : 'var(--red)' }}>RSI: {r.rsiDivergence}</span>}
                {r.wyckoffSpring && <span style={{ color: r.wyckoffSpring === 'spring' ? 'var(--green)' : 'var(--red)' }}>Wyckoff: {r.wyckoffSpring}</span>}
                {r.volumeClimax && <span style={{ color: r.volumeClimax.includes('selling') ? 'var(--green)' : 'var(--red)' }}>Hacim: {r.volumeClimax}</span>}
                {r.diConvergence && <span style={{ color: 'var(--yellow)' }}>DI: {r.diConvergence}</span>}
              </div>
            </div>
          )}

          {r.fundScore != null && (
            <div style={{ padding: '8px 10px', background: 'rgba(0,229,255,.04)', borderRadius: 6, marginBottom: 10, border: '1px solid rgba(0,229,255,.12)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--cyan)' }}>BILANCO ANALIZI (Is Yatirim)</span>
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 3,
                  background: r.fundScore >= 7 ? 'var(--green)' : r.fundScore >= 5 ? 'var(--yellow)' : 'var(--red)',
                  color: '#000',
                }}>{r.fundGrade} ({r.fundScore.toFixed(1)}/10)</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 4 }}>
                {Object.entries({
                  'ROE': { val: r.fundRatios?.roe, unit: '%', condition: v => v > 15 ? 'var(--green)' : v < 5 ? 'var(--red)' : 'var(--t1)' },
                  'Net Marj': { val: r.fundRatios?.netMargin, unit: '%', condition: v => v > 10 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t1)' },
                  'Cari Oran': { val: r.fundRatios?.currentRatio, unit: '', condition: v => v >= 1.5 ? 'var(--green)' : v < 1 ? 'var(--red)' : 'var(--yellow)' },
                  'Borc/Oz': { val: r.fundRatios?.debtToEquity, unit: '', condition: v => v < 1 ? 'var(--green)' : v > 2 ? 'var(--red)' : 'var(--yellow)' },
                  'Ciro B.': { val: r.fundRatios?.revenueGrowth, unit: '%', condition: v => v > 10 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t1)' },
                  'Brut Marj': { val: r.fundRatios?.grossMargin, unit: '%', condition: v => v > 20 ? 'var(--green)' : 'var(--t1)' },
                }).map(([label, cfg]) => cfg.val != null && (
                  <div key={label} style={indBox}><span style={indLabel}>{label}</span><span style={{ ...indVal, fontSize: 10, color: cfg.condition(cfg.val) }}>{cfg.unit}{cfg.val.toFixed(cfg.unit ? 1 : 2)}</span></div>
                ))}
              </div>
              {r.fundPoints?.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 8, color: 'var(--t3)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {r.fundPoints.map((p, pi) => <span key={pi} style={{ padding: '1px 5px', background: 'var(--bg0)', borderRadius: 3 }}>{p}</span>)}
                </div>
              )}
            </div>
          )}

          <div style={{ fontSize: 9, color: 'var(--t3)', lineHeight: 1.6 }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--t2)', marginBottom: 4 }}>SINYAL DETAYLARI (Skor: {r.score.toFixed(0)}/100)</div>
            {r.reasons?.slice(0, 8).map((reason, ri) => (
              <div key={ri} style={{ color: reason.c === 'bullish' ? 'var(--green)' : reason.c === 'bearish' ? 'var(--red)' : 'var(--t3)' }}>
                {reason.c === 'bullish' ? '\u25B2' : reason.c === 'bearish' ? '\u25BC' : '\u2500'} {reason.t}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Position Sizing + Portfolio */}
      {pos.shares > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--t2)', marginBottom: 4, marginTop: 8 }}>
          <span>10K hesapta: <b style={{ color: 'var(--cyan)' }}>{pos.shares} lot</b> | Max kayip: <b style={{ color: 'var(--red)' }}>{pos.maxLoss.toFixed(0)} TL</b></span>
          {addToPortfolio && (() => {
            const alreadyOpen = portfolio?.positions?.some(p => p.symbol === r.symbol && p.status === 'open');
            const pfPos = calcPosition(portfolio?.cash || 10000, 2, r.price, r.intradayStop || r.stop);
            if (alreadyOpen) return <span style={{ color: 'var(--yellow)', fontSize: 9 }}>Portfoyde acik</span>;
            if (pfPos.shares <= 0) return <span style={{ color: 'var(--red)', fontSize: 9 }}>Yetersiz nakit</span>;
            return (
              <button className="scan-btn go" style={{ fontSize: 9, padding: '4px 10px' }} onClick={() => {
                addToPortfolio(r.symbol, r.price, r.intradayStop || r.stop, r.intradayTarget || r.target, pfPos.shares);
              }}>+ PORTFOYE EKLE</button>
            );
          })()}
        </div>
      )}
    </div>
  );
});
