import { calcATR, calcFibonacci, calcPivots, calcOBV, calcOBVTrend, calcAll } from './indicators.js';
import { analyzeDetailedFinancials, getFundamentalGrade } from './fundamentalEngine.js';
import { runWallStreetAnalysis } from './wallStreet.js';
import { detectMarketRegime, getAdaptiveThresholds, getRegimeIndicatorWeights, detectHiddenDivergence, MarketRegime } from './adaptiveThresholds.js';
import { applyCalibrationToScore } from './signalCalibration.js';

// ══════════════════════════════════════════════════════════════════
// RELIABILITY FEEDBACK MODULE
// useSignalTracker pushes live win-rate stats here after each batch
// price-check cycle. genSignal reads them to self-attenuate when
// the system is consistently losing on a signal class.
// ══════════════════════════════════════════════════════════════════
function safeDivide(num, den, fallback = 0) {
  if (!den || !Number.isFinite(den)) return fallback;
  const r = num / den;
  return Number.isFinite(r) ? r : fallback;
}

const _reliabilityHints = {};

/**
 * Called by useSignalTracker after each batch price-check cycle.
 * hints: { buy?: { winRate: number, sampleSize: number },
 *           sell?: { winRate: number, sampleSize: number } }
 */
export function setSignalReliabilityHints(hints) {
  if (hints && typeof hints === 'object') Object.assign(_reliabilityHints, hints);
}

// ══════════════════════════════════════════════════════════════════
// SIGNAL ATTRIBUTION — extractFiredSignals
// Hangi teknik/smart-money sinyalleri bu bar'da ateslendigini
// saf fonksiyon olarak dondurur. usePaperTrading + useSignalTracker
// bu listeyi trade'e ekler; kapaninca bySignalType win-rate guncellenir.
// ══════════════════════════════════════════════════════════════════
export function extractFiredSignals(ind, prices = []) {
  if (!ind) return [];
  const fired = [];
  const p = ind.lastClose || 0;

  // ── Momentum ──────────────────────────────────────────────────
  if (ind.lastRSI != null) {
    if (ind.lastRSI < 32) fired.push('RSI_OVERSOLD');
    else if (ind.lastRSI > 70) fired.push('RSI_OVERBOUGHT');
  }
  if (ind.lastMACDHist != null) {
    const h = ind.macd?.histogram || [];
    const n = h.length;
    if (n >= 2 && h[n - 2] != null && h[n - 1] != null) {
      if (h[n - 2] < 0 && h[n - 1] > 0) fired.push('MACD_BULL_CROSS');
      else if (h[n - 2] > 0 && h[n - 1] < 0) fired.push('MACD_BEAR_CROSS');
    }
    if (ind.lastMACDHist > 0) fired.push('MACD_HIST_POS');
  }
  if (ind.ttmSqueeze?.firing && (ind.ttmSqueeze.squeezeCount || 0) >= 5)
    fired.push('TTM_FIRE');
  if (ind.ttmSqueeze?.squeezeRelease) fired.push('TTM_RELEASE');
  if (ind.ttmSqueeze?.squeezeOn) fired.push('TTM_SQUEEZE_ON');

  // ── Smart money ────────────────────────────────────────────────
  if (ind.obvTrend === 'accumulation') fired.push('OBV_ACC');
  if (ind.obvTrend === 'distribution') fired.push('OBV_DIST');
  if (ind.cmf != null) {
    if (ind.cmf > 0.08) fired.push('CMF_STRONG');
    else if (ind.cmf < -0.08) fired.push('CMF_NEG');
  }
  if (ind.mfi != null) {
    if (ind.mfi < 30) fired.push('MFI_OVERSOLD');
    else if (ind.mfi > 70) fired.push('MFI_OVERBOUGHT');
  }

  // ── Wyckoff ────────────────────────────────────────────────────
  if (ind.wyckoffPhase === 'accumulation') fired.push('WYCKOFF_ACC');
  if (ind.wyckoffPhase === 'distribution') fired.push('WYCKOFF_DIST');
  if (ind.wyckoffPhase === 'markup') fired.push('WYCKOFF_MARKUP');
  if (ind.wyckoffSpring === true) fired.push('WYCKOFF_SPRING');

  // ── Structure / MA ─────────────────────────────────────────────
  if (ind.lastMA20 && p > 0) {
    if (p > ind.lastMA20) fired.push('ABOVE_MA20');
    else fired.push('BELOW_MA20');
  }
  if (ind.lastMA50 && p > 0) {
    if (p > ind.lastMA50) fired.push('ABOVE_MA50');
  }
  if (ind.lastMA200 && p > 0) {
    if (p > ind.lastMA200) fired.push('ABOVE_MA200');
  }
  if (ind.lastMA20 && ind.lastMA50) {
    if (ind.lastMA20 > ind.lastMA50) fired.push('GOLDEN_CROSS');
    else fired.push('DEATH_CROSS');
  }

  // ── Supertrend / Ichimoku ──────────────────────────────────────
  if (ind.supertrend?.trend === 'UP') fired.push('SUPERTREND_UP');
  if (ind.supertrend?.trend === 'DOWN') fired.push('SUPERTREND_DOWN');
  if (ind.supertrend?.flip === true) {
    fired.push(ind.supertrend.trend === 'UP' ? 'SUPERTREND_FLIP_UP' : 'SUPERTREND_FLIP_DOWN');
  }

  // ── Bollinger ──────────────────────────────────────────────────
  if (ind.lastBU && ind.lastBL && ind.lastBM) {
    const bw = (ind.lastBU - ind.lastBL) / ind.lastBM;
    if (bw < 0.04) fired.push('BB_SQUEEZE');
    if (p > ind.lastBU) fired.push('BB_ABOVE_UPPER');
    if (p < ind.lastBL) fired.push('BB_BELOW_LOWER');
  }

  // ── Volume & VPVR ──────────────────────────────────────────────
  if (ind.volRatio != null) {
    if (ind.volRatio > 2.5) fired.push('VOL_EXPLOSIVE');
    else if (ind.volRatio > 1.5) fired.push('VOL_HIGH');
  }
  if (ind.volumeProfile && ind.volumeProfile.poc) {
    const distToPoc = (p - ind.volumeProfile.poc) / ind.volumeProfile.poc * 100;
    if (distToPoc > 0 && distToPoc < 3) fired.push('VPVR_SUPPORT');
    else if (distToPoc < 0 && distToPoc > -3) fired.push('VPVR_RESISTANCE');
  }

  // ── Pattern detectors (safe wrappers) ─────────────────────────
  if (prices.length >= 30) {
    try { const r = detectBreakout(prices, ind); if (r) fired.push(r.type); } catch {}
    try { const r = detectChartPattern(prices, ind); if (r) fired.push(r.type); } catch {}
    try { const r = detectMomentumShift(prices, ind); if (r) fired.push(r.type); } catch {}
    try { const sm = detectSmartMoney(ind); sm.forEach(s => fired.push(s.type)); } catch {}
  }

  return [...new Set(fired)]; // deduplicate
}

// ============================================================
// ADVANCED PATTERN DETECTION ENGINE (UNIFIED)
// ============================================================

export function detectBreakout(prices, ind) {
  const n = prices.length;
  if (n < 30) return null;
  const p = ind.lastClose;

  // 1. RESISTANCE BREAKOUT: price breaks above recent resistance with volume
  const recentHighs = [];
  for (let i = n - 25; i < n - 2; i++) recentHighs.push(prices[i].high);
  const resistanceZone = Math.max(...recentHighs);
  const brokeResistance = p > resistanceZone && prices[n - 2].close <= resistanceZone;
  if (brokeResistance && ind.volRatio > 1.5) {
    return { type: 'RESISTANCE_BREAK', desc: `${resistanceZone.toFixed(2)} TL direnci hacimle kirdi (${ind.volRatio.toFixed(1)}x)`, confidence: 85, direction: 'buy' };
  }

  // 2. SUPPORT BREAKDOWN: price breaks below recent support
  const recentLows = [];
  for (let i = n - 25; i < n - 2; i++) recentLows.push(prices[i].low);
  const supportZone = Math.min(...recentLows);
  const brokeSupport = p < supportZone && prices[n - 2].close >= supportZone;
  if (brokeSupport && ind.volRatio > 1.3) {
    return { type: 'SUPPORT_BREAK', desc: `${supportZone.toFixed(2)} TL destegi hacimle kirdi (${ind.volRatio.toFixed(1)}x)`, confidence: 80, direction: 'sell' };
  }

  // 3. BOLLINGER SQUEEZE BREAKOUT: bands were tight, now expanding with direction
  if (ind.lastBU && ind.lastBL && ind.lastBM) {
    const bwNow = (ind.lastBU - ind.lastBL) / ind.lastBM;
    const wasSqueezing = ind.ttmSqueeze?.squeezeOn || bwNow < 0.05;
    if (wasSqueezing && p > ind.lastBU && ind.volRatio > 1.2) {
      return { type: 'SQUEEZE_BREAKOUT', desc: `Bollinger sikismadan yukari patlama — band genisliyor`, confidence: 80, direction: 'buy' };
    }
    if (wasSqueezing && p < ind.lastBL && ind.volRatio > 1.2) {
      return { type: 'SQUEEZE_BREAKDOWN', desc: `Bollinger sikismadan asagi kirilma`, confidence: 75, direction: 'sell' };
    }
  }

  return null;
}

export function detectChartPattern(prices, ind) {
  const n = prices.length;
  if (n < 40) return null;
  const p = ind.lastClose;

  // 1. CUP AND HANDLE
  if (n >= 50) {
    const highZone = prices.slice(n - 50, n - 30);
    const lowZone = prices.slice(n - 25, n - 10);
    const handleZone = prices.slice(n - 10);
    const cupHigh = Math.max(...highZone.map(b => b.high));
    const cupLow = Math.min(...lowZone.map(b => b.low));
    const handleHigh = Math.max(...handleZone.map(b => b.high));
    const depth = (cupHigh - cupLow) / cupHigh * 100;
    if (depth > 8 && depth < 35 && handleHigh >= cupHigh * 0.95 && p >= cupHigh * 0.97) {
      return { type: 'CUP_HANDLE', desc: `Fincan-kulp formasyonu — derinlik %${depth.toFixed(0)}, kirilma yakin`, confidence: 75, direction: 'buy' };
    }
  }

  // 2. ASCENDING TRIANGLE
  if (n >= 30) {
    const last30 = prices.slice(n - 30);
    const highs = last30.map(b => b.high);
    const lows = last30.map(b => b.low);
    const maxH = Math.max(...highs);
    const touchCount = highs.filter(h => h >= maxH * 0.99).length;
    const lowFirst10 = Math.min(...lows.slice(0, 10));
    const lowLast10 = Math.min(...lows.slice(20));
    if (touchCount >= 3 && lowLast10 > lowFirst10 * 1.02 && p >= maxH * 0.98) {
      return { type: 'ASC_TRIANGLE', desc: `Yukselen ucgen — ${touchCount}x direnç dokunusu, dipleri yukseliyor`, confidence: 78, direction: 'buy' };
    }
  }

  // 3. BULLISH ENGULFING
  if (n >= 2) {
    const prev = prices[n - 2], curr = prices[n - 1];
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    if (prev.close < prev.open && curr.close > curr.open && currBody > prevBody * 1.5 && curr.close > prev.open && curr.open < prev.close && ind.volRatio > 1.3) {
      return { type: 'BULL_ENGULF', desc: `Yükseliş yutucu mum — guclu hacimle alici baskisi`, confidence: 72, direction: 'buy' };
    }
  }

  return null;
}

export function detectMomentumShift(prices, ind) {
  const n = prices.length;
  if (n < 15) return null;

  // 1. MACD BULLISH CROSSOVER
  if (ind.macd && ind.macd.macd.length >= 3) {
    const len = ind.macd.macd.length;
    const m0 = ind.macd.macd[len - 1], m1 = ind.macd.macd[len - 2];
    const s0 = ind.macd.signal[len - 1], s1 = ind.macd.signal[len - 2];
    if (m0 != null && s0 != null && m1 != null && s1 != null) {
      if (m1 <= s1 && m0 > s0 && m0 < 0) {
        return { type: 'MACD_BULL_CROSS', desc: `MACD yukselis kesisimi (negatif bolgede) — donme sinyali`, confidence: 70, direction: 'buy' };
      }
      if (m1 >= s1 && m0 < s0 && m0 > 0) {
        return { type: 'MACD_BEAR_CROSS', desc: `MACD dusus kesisimi (pozitif bolgede) — zirve sinyali`, confidence: 70, direction: 'sell' };
      }
    }
  }

  // 2. TTM SQUEEZE FIRE
  if (ind.ttmSqueeze?.firing && ind.ttmSqueeze.squeezeCount >= 5) {
    const dir = ind.ttmSqueeze.momentum > 0 ? 'buy' : 'sell';
    return { type: 'TTM_FIRE', desc: `TTM Squeeze ${ind.ttmSqueeze.squeezeCount} bar sikismadan ATIS — ${dir === 'buy' ? 'yukselis' : 'dusus'} patlamasi`, confidence: 82, direction: dir };
  }

  return null;
}

export function detectSmartMoney(ind) {
  let signals = [];
  const mfiBuy = ind.mfi != null && ind.mfi < 25;
  const obvAcc = ind.obvTrend === 'accumulation';
  const cmfPos = ind.cmf != null && ind.cmf > 0.1;
  const wyckoffAcc = ind.wyckoffPhase === 'accumulation';

  let accScore = 0;
  if (mfiBuy) accScore++; if (obvAcc) accScore++; if (cmfPos) accScore++; if (wyckoffAcc) accScore++;

  if (accScore >= 3) {
    signals.push({ type: 'SMART_ACCUMULATION', desc: `Kurumsal birikim: (${accScore}/4 teyit)`, confidence: 78 + accScore * 3, direction: 'buy' });
  }

  const mfiSell = ind.mfi != null && ind.mfi > 75;
  const obvDist = ind.obvTrend === 'distribution';
  const cmfNeg = ind.cmf != null && ind.cmf < -0.1;
  const wyckoffDist = ind.wyckoffPhase === 'distribution';

  let distScore = 0;
  if (mfiSell) distScore++; if (obvDist) distScore++; if (cmfNeg) distScore++; if (wyckoffDist) distScore++;

  if (distScore >= 3) {
    signals.push({ type: 'SMART_DISTRIBUTION', desc: `Kurumsal dagilim: (${distScore}/4 teyit)`, confidence: 78 + distScore * 3, direction: 'sell' });
  }

  return signals;
}

// Unified analysis entry point for Radar and AnalyzeTab
// extraContext: { kapSentiment, htfContext, sectorStrength } — optional deep confluence inputs
export function getUnifiedAnalysis(sym, data, extraContext) {
  const prices = data.prices;
  const ind = calcAll(prices);
  const sig = genSignal(ind, prices, extraContext || {});
  const events = [];

  // ── Regime-adaptive confidence threshold ──
  // CHOPPY piyasada zayif sinyaller toplanarak yaniltici guven olusturabilir.
  // CHOPPY: 88, diger: 80 — sadece gercek confluence'i gecirme.
  const _regime = detectMarketRegime(prices, ind);
  const _regimeStr = _regime?.regime ?? _regime;
  const requiredConf = _regimeStr === MarketRegime.CHOPPY ? 88 : 80;

  const signalEvent = sig.score >= 5 ? { type: 'SIGNAL_BUY', desc: `Sinyal skoru: ${sig.score.toFixed(1)} (GUCLU AL)`, confidence: 75, direction: 'buy' }
    : sig.score <= -5 ? { type: 'SIGNAL_SELL', desc: `Sinyal skoru: ${sig.score.toFixed(1)} (GUCLU SAT)`, confidence: 75, direction: 'sell' }
    : null;
  if (signalEvent) events.push(signalEvent);

  const breakout = detectBreakout(prices, ind);
  if (breakout) events.push(breakout);

  const pattern = detectChartPattern(prices, ind);
  if (pattern) events.push(pattern);

  const momentum = detectMomentumShift(prices, ind);
  if (momentum) events.push(momentum);

  const smartMoney = detectSmartMoney(ind);
  events.push(...smartMoney);

  if (events.length === 0) return { ind, sig, bestBuy: null, bestSell: null };

  const buyEvents = events.filter(e => e.direction === 'buy');
  const sellEvents = events.filter(e => e.direction === 'sell');

  let bestBuy = null, bestSell = null;
  if (buyEvents.length > 0) {
    const avgConf = buyEvents.reduce((s, e) => s + e.confidence, 0) / buyEvents.length;
    const confluenceBonus = Math.min(15, (buyEvents.length - 1) * 6);
    const composite = Math.min(95, avgConf + confluenceBonus);
    const hasVolume = ind.volRatio > 1.2;
    const minConfluence = buyEvents.length >= 2;
    if (composite >= requiredConf && hasVolume && minConfluence) {
      bestBuy = { direction: 'buy', confidence: Math.round(composite), events: buyEvents, confluenceCount: buyEvents.length, price: ind.lastClose, entry: sig.entry, stop: sig.stop, target: sig.t1, rr: sig.rr, rsi: ind.lastRSI, adx: ind.adx, volRatio: ind.volRatio, score: sig.score };
    }
  }

  if (sellEvents.length > 0) {
    const avgConf = sellEvents.reduce((s, e) => s + e.confidence, 0) / sellEvents.length;
    const confluenceBonus = Math.min(15, (sellEvents.length - 1) * 6);
    const composite = Math.min(95, avgConf + confluenceBonus);
    const minSellConfluence = sellEvents.length >= 2;
    // Sat sinyali icin hacim yerine akilli para cikisini kontrol et:
    // kurumsal dagitim cunku sessiz hacimde baslar, yuksek volum gerektirmez.
    const hasSmartMoneyExit = ind.obvTrend === 'distribution'
      || (ind.cmf != null && ind.cmf < -0.05)
      || (ind.mfi != null && ind.mfi > 75);
    if (composite >= requiredConf && minSellConfluence && (hasSmartMoneyExit || sellEvents.length >= 3)) {
      bestSell = { direction: 'sell', confidence: Math.round(composite), events: sellEvents, confluenceCount: sellEvents.length, price: ind.lastClose, rsi: ind.lastRSI, adx: ind.adx, volRatio: ind.volRatio, score: sig.score };
    }
  }

  return { ind, sig, bestBuy, bestSell };
}

export function detectHolyGrail(ind) {
  const p = ind.lastClose;
  const isUpMA = ind.lastMA20 && p > ind.lastMA20;
  const isRSIPos = ind.lastRSI && ind.lastRSI > 45 && ind.lastRSI < 65;
  const isMACDPos = ind.lastMACDHist && ind.lastMACDHist > 0;
  const isOBVAcc = ind.obvTrend === 'accumulation';
  
  if (isUpMA && isRSIPos && isMACDPos && isOBVAcc) return true;
  return false;
}

/**
 * MASTER CONFLUENCE — Institutional Level Filtering
 * Requires extreme alignment: Technical + Smart Money + Fundamentals + Macro + Holy Grail
 */
export function getEliteConfluence(sym, data, rawFundamentals, marketContext = null) {
  // 1. Core Technical Analysis
  const analysis = getUnifiedAnalysis(sym, data);
  if (!analysis || (!analysis.bestBuy && !analysis.bestSell)) return null;

  const { ind, sig, bestBuy, bestSell } = analysis;
  const target = bestBuy || bestSell;
  
  // 2. Fundamental Filter (Master Rule: No junk stocks for high conviction)
  const fund = analyzeDetailedFinancials(rawFundamentals);
  const fundScore = fund ? fund.score : 0;
  if (fundScore < 6.0 && target.direction === 'buy') return null; 

  // 3. Smart Money Multiplier
  const hasSmartMoney = ind.obvTrend === 'accumulation' || (ind.cmf && ind.cmf > 0.08) || (ind.mfi && ind.mfi < 35);
  
  // 4. Holy Grail check
  const isHolyGrail = detectHolyGrail(ind);
  
  // 5. Candlestick weight
  const hasBullishCandle = ind.candlePatterns.some(p => p.type === 'bullish');
  
  // 6. Data Consistency Guardrail
  if (data.dataConfidence === 'low') {
    target.confidence -= 12; 
  }

  // 7. GLOBAL MARKET GUARDRAIL (BIST100 Trend)
  let macroRisk = false;
  if (marketContext && target.direction === 'buy') {
    const marketInd = calcAll(marketContext.prices);
    const marketMa = marketInd.lastMA20;
    const marketP = marketInd.lastClose;
    if (marketP < marketMa) {
      target.confidence -= 20; // Harsher penalty for Elite Mode
      macroRisk = true;
    }
  }

  // Conviction Calculation
  let masterConfidence = target.confidence;
  if (hasSmartMoney) masterConfidence += 5;
  if (isHolyGrail) masterConfidence += 5;
  if (hasBullishCandle && target.direction === 'buy') masterConfidence += 5;
  if (fundScore >= 8) masterConfidence += 5;
  
  masterConfidence = Math.min(98, masterConfidence);
  
  // High Conviction Threshold (Emin++ Upgrade: %90+)
  if (masterConfidence >= 90) {
    return {
      symbol: sym,
      type: target.direction,
      confidence: masterConfidence,
      price: ind.lastClose,
      fundScore,
      fundGrade: getFundamentalGrade(fundScore).label,
      reasons: target.events.map(e => e.desc),
      target: target.target || (ind.lastClose * 1.05),
      stop: target.stop || (ind.lastClose * 0.95),
      isEmin: true,
      isHolyGrail,
      macroRisk,
      dataRisk: data.dataConfidence === 'low',
      candleNotes: ind.candlePatterns.map(p => p.name).join(', '),
      isSpeculative: ind.volRatio < 0.5
    };
  }

  return null;
}

export function detectSetups(prices, ind) {
  const setups = [];
  const p = ind.lastClose, n = prices.length;

  // 1. Bollinger Squeeze
  if (ind.lastBU && ind.lastBL && ind.lastBM) {
    const bw = (ind.lastBU - ind.lastBL) / ind.lastBM;
    if (bw < 0.04) setups.push({ name: 'Bollinger Sikisma', desc: 'Bantlar dar (' + (bw * 100).toFixed(1) + '%). Sert hareket kapida.', score: 1.5, type: 'momentum' });
  }
  // 2. Oversold Bounce
  if (ind.lastRSI && ind.lastRSI < 32 && ind.sr && ind.sr.length > 0) {
    const nearSup = ind.sr.some(s => s.type === 'support' && Math.abs(s.price - p) / p < 0.02);
    if (nearSup) setups.push({ name: 'Asiri Satim Sicramasi', desc: 'RSI ' + ind.lastRSI.toFixed(1) + ' + destek seviyesinde.', score: 2, type: 'reversal' });
  }
  // 3. MACD Divergence
  if (n >= 10) {
    const pLow1 = Math.min(prices[n-5].low, prices[n-4].low, prices[n-3].low);
    const pLow2 = Math.min(prices[n-10].low, prices[n-9].low, prices[n-8].low);
    const mNow = ind.macd.macd[n-1], mPrev = ind.macd.macd[n-6];
    if (mNow != null && mPrev != null && pLow1 < pLow2 && mNow > mPrev)
      setups.push({ name: 'MACD Yükseliş Diverjans', desc: 'Fiyat dusuk dip yaparken MACD yukseliyor.', score: 2, type: 'reversal' });
  }
  // 4. Volume Breakout
  if (ind.changePct > 1 && ind.volRatio > 2) setups.push({ name: 'Hacim Kirilimi', desc: 'Fiyat +' + ind.changePct.toFixed(1) + '% hacim ' + ind.volRatio.toFixed(1) + 'x.', score: 3.0, type: 'breakout' });
  // 5. Golden Cross
  if (n >= 4 && ind.ma20[n-1] && ind.ma50[n-1] && ind.ma20[n-1] > ind.ma50[n-1] && ind.ma20[n-4] && ind.ma50[n-4] && ind.ma20[n-4] < ind.ma50[n-4])
    setups.push({ name: 'Taze Golden Cross', desc: 'MA-20 son 3 gunde MA-50 yi yukari kirdi.', score: 2, type: 'trend' });
  // 6. MA-200 Reclaim
  if (ind.lastMA200 && p > ind.lastMA200) {
    const prev5 = ind.closes[n-5];
    if (prev5 && prev5 < ind.ma200[n-5]) setups.push({ name: 'MA-200 Geri Kazanimi', desc: 'Fiyat uzun vadeli trendi yukari kirdi.', score: 2, type: 'trend' });
  }
  // 7. Double Bottom
  if (n >= 20) {
    const lows = [];
    for (let i = n - 20; i < n; i++) lows.push(prices[i].low);
    const minLow = Math.min(...lows);
    let dips = 0;
    for (const l of lows) { if (Math.abs(l - minLow) / minLow < 0.01) dips++; }
    if (dips >= 2 && p > minLow * 1.01) setups.push({ name: 'Cift Dip Formasyonu', desc: 'Son 20 barda 2 dip. Guclu destek.', score: 1.5, type: 'reversal' });
  }
  // 8. OBV Distribution/Accumulation
  const obv = calcOBV(prices);
  const obvT = calcOBVTrend(obv, ind.closes, 20);
  if (obvT === 'distribution') setups.push({ name: 'Dağılım Uyarisi', desc: 'Fiyat yukselirken OBV dusuyor. Akilli para cikiyor.', score: -2, type: 'warning' });
  if (obvT === 'accumulation') setups.push({ name: 'Akilli Para Birikimi', desc: 'Fiyat dusukken OBV yukseliyor. Kurumsal birikim.', score: 2, type: 'accumulation' });
  return setups;
}

// Multi-timeframe context: pass higher-timeframe indicators to validate signals
// kapSentiment: {score: -10 to +10, reasons: string[]} from KAP news analysis
// htfContext: {trend: 'bull'|'bear'|'neutral', rsi, adx, ma200Above} from daily timeframe
export function genSignal(ind, prices, { kapSentiment, htfContext, sectorStrength } = {}) {
  let score = 0;
  const reasons = [];
  const p = ind.lastClose;
  const atr = prices ? calcATR(prices) : null;
  const fibs = prices ? calcFibonacci(prices) : null;
  const pivots = prices ? calcPivots(prices) : null;

  // ── ADAPTIVE THRESHOLD SYSTEM ──
  const regime = detectMarketRegime(prices, ind);
  const thresholds = getAdaptiveThresholds(ind, regime);
  const indicatorWeights = getRegimeIndicatorWeights(regime);

  // Check for hidden divergence
  const hiddenDiv = detectHiddenDivergence(prices, ind);

  // MA
  if (ind.lastMA20) { if (p > ind.lastMA20) { score += 1; reasons.push({ t: 'Fiyat MA-20 (' + ind.lastMA20.toFixed(2) + ') ustunde', c: 'bullish' }); } else { score -= 1; reasons.push({ t: 'Fiyat MA-20 (' + ind.lastMA20.toFixed(2) + ') altinda', c: 'bearish' }); } }
  if (ind.lastMA50) { if (p > ind.lastMA50) { score += 1; reasons.push({ t: 'Fiyat MA-50 ustunde', c: 'bullish' }); } else { score -= 1; reasons.push({ t: 'Fiyat MA-50 altinda', c: 'bearish' }); } }
  if (ind.lastMA20 && ind.lastMA50) { if (ind.lastMA20 > ind.lastMA50) { score += 1; reasons.push({ t: 'MA-20 > MA-50 Golden cross', c: 'bullish' }); } else { score -= 1; reasons.push({ t: 'MA-20 < MA-50 Death cross', c: 'bearish' }); } }
  if (ind.lastMA200) { if (p > ind.lastMA200) { score += 0.5; reasons.push({ t: 'Fiyat MA-200 ustunde', c: 'bullish' }); } else { score -= 0.5; reasons.push({ t: 'Fiyat MA-200 altinda', c: 'bearish' }); } }

  // RSI — ADAPTIVE THRESHOLDS
  if (ind.lastRSI != null) {
    const rsiWeight = indicatorWeights.rsi;
    if (ind.lastRSI < thresholds.rsiOversold - 10) { score += 2.5 * rsiWeight; reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Asiri satim (Adaptif: ${thresholds.rsiOversold.toFixed(0)})`, c: 'bullish' }); }
    else if (ind.lastRSI < thresholds.rsiOversold) { score += 1.5 * rsiWeight; reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Satis baskisi azaliyor (${regime.regime})`, c: 'bullish' }); }
    else if (ind.lastRSI < thresholds.rsiWeakOversold) { score += 0.5 * rsiWeight; reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Zayif ama iyilesme`, c: 'bullish' }); }
    else if (ind.lastRSI > thresholds.rsiVeryOverbought) {
      // v28: hacim istisnasi KALDIRILDI — yuksek hacim overbought'ta dagilim sinyali,
      // validasyon degil. ISYAT gibi RSI overbought + yuksek hacim = ertesi gun dusus.
      score -= 2.5 * rsiWeight;
      reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Asiri alim (${regime.regime})`, c: 'bearish' });
    }
    else if (ind.lastRSI > thresholds.rsiOverbought) {
      score -= 1.0 * rsiWeight;
      reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Yukari gerilmis`, c: 'bearish' });
    }
    else { reasons.push({ t: `RSI ${ind.lastRSI.toFixed(1)} — Normal bolge`, c: 'neutral' }); }
  }

  // Hidden divergence bonus
  if (hiddenDiv) {
    if (hiddenDiv.type === 'BULLISH_HIDDEN') {
      score += 2;
      reasons.push({ t: 'GIZLI YUKARI DIVERGANS — Trend devami', c: 'bullish' });
    } else if (hiddenDiv.type === 'BEARISH_HIDDEN') {
      score -= 2;
      reasons.push({ t: 'GIZLI ASAGI DIVERGANS — Trend devami', c: 'bearish' });
    }
  }

  // Stochastic RSI — more sensitive timing than RSI
  if (ind.lastStochK != null && ind.lastStochD != null) {
    const sk = ind.lastStochK, sd = ind.lastStochD;
    const n = ind.stochRSI.k.length;
    const prevK = n >= 2 ? ind.stochRSI.k[n - 2] : null;
    const prevD = n >= 2 ? ind.stochRSI.d[n - 2] : null;
    // Oversold crossover (bullish): StochRSI K crosses above D below 20
    if (sk < 20 && sd < 20) { score += 1.5; reasons.push({ t: 'StochRSI ' + sk.toFixed(0) + '/' + sd.toFixed(0) + ' — Asiri satim bolgesi', c: 'bullish' }); }
    else if (sk > 80 && sd > 80) { score -= 1.5; reasons.push({ t: 'StochRSI ' + sk.toFixed(0) + '/' + sd.toFixed(0) + ' — Asiri alim bolgesi', c: 'bearish' }); }
    // Bullish crossover: K crosses above D
    if (prevK != null && prevD != null && prevK <= prevD && sk > sd && sk < 50) { score += 1; reasons.push({ t: 'StochRSI yukari kesiyor — Alim sinyali', c: 'bullish' }); }
    // Bearish crossover: K crosses below D
    else if (prevK != null && prevD != null && prevK >= prevD && sk < sd && sk > 50) { score -= 1; reasons.push({ t: 'StochRSI asagi kesiyor — Satim sinyali', c: 'bearish' }); }
  }

  // MACD
  if (ind.lastMACD != null && ind.lastMACDSig != null) {
    if (ind.lastMACD > ind.lastMACDSig) { score += 1; reasons.push({ t: 'MACD sinyal ustunde', c: 'bullish' }); }
    else { score -= 1; reasons.push({ t: 'MACD sinyal altinda', c: 'bearish' }); }
    const ph2 = ind.macd.histogram[ind.macd.histogram.length - 2];
    if (ind.lastMACDHist > 0 && ph2 != null && ind.lastMACDHist > ph2) { score += 0.5; reasons.push({ t: 'Histogram artiyor', c: 'bullish' }); }
    if (ind.lastMACDHist < 0 && ph2 != null && ind.lastMACDHist > ph2) { score += 0.5; reasons.push({ t: 'Histogram daraliyor', c: 'bullish' }); }
    // MACD Zero-line cross — early trend change signal
    if (ind.macd.macd.length >= 2) {
      const mLen = ind.macd.macd.length;
      const prevMACD = ind.macd.macd[mLen - 2];
      if (prevMACD != null) {
        if (prevMACD <= 0 && ind.lastMACD > 0) { score += 1.5; reasons.push({ t: 'MACD sifir cizgisini yukari kirdi — trend donusu', c: 'bullish' }); }
        else if (prevMACD >= 0 && ind.lastMACD < 0) { score -= 1.5; reasons.push({ t: 'MACD sifir cizgisini asagi kirdi — trend donusu', c: 'bearish' }); }
      }
    }
  }

  // Bollinger
  if (ind.lastBL && ind.lastBU) {
    const bbWidth = (ind.lastBU - ind.lastBL) / ind.lastBM;
    if (bbWidth < 0.05) { score += 0.5; reasons.push({ t: 'Bollinger sikisma', c: 'neutral' }); }
    if (p <= ind.lastBL * 1.01) { score += 1.5; reasons.push({ t: 'Bollinger alt bandinda', c: 'bullish' }); }
    else if (p >= ind.lastBU * 0.99) {
      // v28: hacim istisnasi KALDIRILDI — ust bantta yuksek hacim dagilim sinyali
      score -= 1.5;
      reasons.push({ t: 'Bollinger ust bandinda — geri cekilme olasiligi', c: 'bearish' });
    }
  }

  // Volume — ADAPTIVE THRESHOLDS for institutional flow
  // v28: Hacim puanlari OVERBOUGHT durumda AZALTILIR — yuksek hacim + overbought = dagilim
  const volWeight = indicatorWeights.volume;
  const _isOverbought = (ind.lastRSI || 50) > 68 || (ind.mfi || 50) > 65;
  const _volBullMult = _isOverbought ? 0.3 : 1.0; // overbought'ta hacim bonusu %30'a duser
  if (ind.volRatio > thresholds.volumeExplosion) { score += 3 * volWeight * _volBullMult; reasons.push({ t: `Hacim ${ind.volRatio.toFixed(1)}x — ${_isOverbought ? 'DAGILIM RISKI' : 'KURUMSAL PATLAMA'} (${regime.regime})`, c: _isOverbought ? 'bearish' : 'bullish' }); }
  else if (ind.volRatio > thresholds.volumeSpike) { score += 2 * volWeight * _volBullMult; reasons.push({ t: `Hacim ${ind.volRatio.toFixed(1)}x — ${_isOverbought ? 'Dikkat' : 'Guclu'}`, c: _isOverbought ? 'neutral' : 'bullish' }); }
  else if (ind.volRatio > 1.3) { score += 1 * volWeight * _volBullMult; reasons.push({ t: `Hacim ${ind.volRatio.toFixed(1)}x`, c: 'bullish' }); }
  else if (ind.volRatio < thresholds.volumeLow) { score -= 1; reasons.push({ t: `Hacim dusuk — Ilgisizlik`, c: 'neutral' }); }

  // ── MOMENTUM BREAKOUT BONUS: Price jump + Volume ──
  // v28: OVERBOUGHT hisselerde bu bonus VERILMEZ — pump exhaustion riski
  if (ind.changePct > 2 && ind.volRatio > 1.5 && !_isOverbought) {
    score += 2;
    reasons.push({ t: 'MOMENTUM KIRILIMI: Hacimli yukselis onayi', c: 'bullish' });
  }

  // Smart Money (Enhanced Institutional Flow) — 2x WEIGHT (edge factor)
  if (ind.mfi != null) {
    if (ind.mfi < 20) { score += 3; reasons.push({ t: 'MFI ' + ind.mfi.toFixed(0) + ' — Kurumsal asiri satim (2x agirlik)', c: 'bullish' }); }
    else if (ind.mfi > 80) {
      // v28: hacim istisnasi KALDIRILDI — MFI>80 + yuksek hacim = kar realizasyonu
      score -= 3;
      reasons.push({ t: 'MFI ' + ind.mfi.toFixed(0) + ' — Kar realizasyonu gerilimi', c: 'bearish' });
    }
    else if (ind.mfi < 35) { score += 1; reasons.push({ t: 'MFI ' + ind.mfi.toFixed(0) + ' — Birikim bolgesi', c: 'bullish' }); }
    else if (ind.mfi > 65) { score -= 1.0; reasons.push({ t: 'MFI ' + ind.mfi.toFixed(0) + ' — Asiri alima yakin', c: 'bearish' }); }
  }
  // v28: OBV accumulation bonusu overbought'ta AZALTILIR — lagging indicator tuzagi
  if (ind.obvTrend === 'accumulation') {
    const obvBonus = _isOverbought ? 1.0 : 3.0;
    score += obvBonus;
    reasons.push({ t: `OBV Birikim — ${_isOverbought ? 'Dikkat: overbought + birikim = olasi dagilim' : 'Akilli para aliyor'}`, c: _isOverbought ? 'neutral' : 'bullish' });
  }
  else if (ind.obvTrend === 'distribution') { score -= 3; reasons.push({ t: 'OBV Dagilim — Akilli para satiyor (2x agirlik)', c: 'bearish' }); }
  else if (ind.obvTrend === 'confirmation') { score += 1; reasons.push({ t: 'OBV Teyit — Fiyat-hacim uyumu', c: 'bullish' }); }
  if (ind.vwap && p > ind.vwap) { score += 0.5; reasons.push({ t: 'VWAP ustunde — Alicilar guclu', c: 'bullish' }); }
  else if (ind.vwap && p < ind.vwap) { score -= 0.5; reasons.push({ t: 'VWAP altinda — Saticilar guclu', c: 'bearish' }); }

  // Chaikin Money Flow — 2x WEIGHT
  if (ind.cmf != null) {
    if (ind.cmf > 0.15) { score += 2; reasons.push({ t: 'CMF +' + ind.cmf.toFixed(2) + ' — Guclu para girisi (2x)', c: 'bullish' }); }
    else if (ind.cmf < -0.15) { score -= 2; reasons.push({ t: 'CMF ' + ind.cmf.toFixed(2) + ' — Guclu para cikisi (2x)', c: 'bearish' }); }
    else if (ind.cmf > 0.05) { score += 0.5; reasons.push({ t: 'CMF +' + ind.cmf.toFixed(2) + ' — Hafif para girisi', c: 'bullish' }); }
    else if (ind.cmf < -0.05) { score -= 0.5; reasons.push({ t: 'CMF ' + ind.cmf.toFixed(2) + ' — Hafif para cikisi', c: 'bearish' }); }
  }

  // ── RSI + MFI Divergence Detection (high-value signal) ──
  if (ind.lastRSI != null && ind.mfi != null) {
    // Price rising but RSI/MFI falling = bearish divergence
    if (ind.changePct > 1 && ind.lastRSI < 50 && ind.mfi < 45) {
      score -= 1.5; reasons.push({ t: 'BEARISH DIVERJANS: Fiyat yuksek ama momentum zayifliyor', c: 'bearish' });
    }
    // Price falling but RSI/MFI rising = bullish divergence
    if (ind.changePct < -1 && ind.lastRSI > 35 && ind.mfi > 30) {
      score += 1.5; reasons.push({ t: 'BULLISH DIVERJANS: Fiyat dusuk ama momentum toplaniyor', c: 'bullish' });
    }
  }

  // ── ADVANCED DIVERGENCE & PATTERN SIGNALS ──
  // OBV Divergence (multi-bar lookback, more reliable than single-bar RSI+MFI check)
  if (ind.obvDivergence) {
    if (ind.obvDivergence === 'bullish_div') { score += 2; reasons.push({ t: 'OBV BULLISH DIVERJANS: Fiyat dusuk dip, OBV yuksek dip — gizli alim', c: 'bullish' }); }
    else if (ind.obvDivergence === 'bearish_div') { score -= 2; reasons.push({ t: 'OBV BEARISH DIVERJANS: Fiyat yuksek tepe, OBV dusuk tepe — gizli satim', c: 'bearish' }); }
    else if (ind.obvDivergence === 'hidden_bullish') { score += 1; reasons.push({ t: 'OBV GIZLI YUKSELIS: Trend devam sinyali', c: 'bullish' }); }
    else if (ind.obvDivergence === 'hidden_bearish') { score -= 1; reasons.push({ t: 'OBV GIZLI DUSUS: Trend devam sinyali', c: 'bearish' }); }
  }

  // RSI Divergence (proper multi-bar swing detection)
  if (ind.rsiDivergence) {
    if (ind.rsiDivergence === 'bullish') { score += 2; reasons.push({ t: 'RSI BULLISH DIVERJANS: Fiyat dusuk dip, RSI yuksek dip — donus yakin', c: 'bullish' }); }
    else if (ind.rsiDivergence === 'bearish') { score -= 2; reasons.push({ t: 'RSI BEARISH DIVERJANS: Fiyat yuksek tepe, RSI dusuk tepe — zirve riski', c: 'bearish' }); }
  }

  // Wyckoff Spring/UTAD (institutional traps — high-value reversal signals)
  if (ind.wyckoffSpring) {
    if (ind.wyckoffSpring === 'spring') { score += 2.5; reasons.push({ t: 'WYCKOFF SPRING: Destek alti fake kirilma + toparlanma — kurumsal tuzak', c: 'bullish' }); }
    else if (ind.wyckoffSpring === 'utad') { score -= 2.5; reasons.push({ t: 'WYCKOFF UTAD: Direnç ustu fake kirilma + geri cekilme — dagitim tuzagi', c: 'bearish' }); }
  }

  // Volume Climax (extreme volume events signaling exhaustion)
  if (ind.volumeClimax) {
    if (ind.volumeClimax === 'buying_climax') { score -= 1.5; reasons.push({ t: 'HACIM KLIMAKS: Asiri alim hacmi — tavan olabilir', c: 'bearish' }); }
    else if (ind.volumeClimax === 'selling_climax') { score += 1.5; reasons.push({ t: 'HACIM KLIMAKS: Asiri satim hacmi — taban olabilir', c: 'bullish' }); }
    else if (ind.volumeClimax === 'volume_exhaustion') { score += 0.5; reasons.push({ t: 'HACIM TUKENMESI: Satis baskisi azaliyor', c: 'bullish' }); }
  }

  // DI Convergence (trend weakness warning)
  if (ind.diConvergence) {
    if (ind.diConvergence === 'converging') {
      // DI lines converging = current trend losing steam
      if (score > 2) { score -= 0.5; reasons.push({ t: 'DI YAKINLASMA: +DI/-DI yakinlasiyor — trend zayifliyor', c: 'neutral' }); }
      else if (score < -2) { score += 0.5; reasons.push({ t: 'DI YAKINLASMA: +DI/-DI yakinlasiyor — dusus yavasliyabilir', c: 'neutral' }); }
    }
  }

  // Wyckoff Phase
  if (ind.wyckoffPhase) {
    if (ind.wyckoffPhase === 'accumulation') { score += 1; reasons.push({ t: 'Wyckoff: BIRIKIM FAZI — Kurumsal pozisyon olusumu', c: 'bullish' }); }
    else if (ind.wyckoffPhase === 'markup') { score += 0.5; reasons.push({ t: 'Wyckoff: YUKSELIS FAZI — Trend devam', c: 'bullish' }); }
    else if (ind.wyckoffPhase === 'distribution') { score -= 1; reasons.push({ t: 'Wyckoff: DAGILIM FAZI — Kurumsal cikis basladi', c: 'bearish' }); }
    else if (ind.wyckoffPhase === 'markdown') { score -= 0.5; reasons.push({ t: 'Wyckoff: DUSUS FAZI — Satim baskisi', c: 'bearish' }); }
  }

  // ADX Trend Strength & DI Cross
  const isTrending = ind.adx != null && ind.adx > 25;
  const isRanging = ind.adx != null && ind.adx < 20;
  if (ind.adx != null) {
    if (isTrending && ind.plusDI > ind.minusDI) { score += 1; reasons.push({ t: 'ADX ' + ind.adx.toFixed(0) + ' Trend YUKSELIS (+DI>' + ind.plusDI.toFixed(0) + ')', c: 'bullish' }); }
    else if (isTrending && ind.minusDI > ind.plusDI) { score -= 1; reasons.push({ t: 'ADX ' + ind.adx.toFixed(0) + ' Trend DUSUS (-DI>' + ind.minusDI.toFixed(0) + ')', c: 'bearish' }); }
    else if (isRanging) { reasons.push({ t: 'ADX ' + ind.adx.toFixed(0) + ' — Yatay piyasa (range)', c: 'neutral' }); }
    else { reasons.push({ t: 'ADX ' + ind.adx.toFixed(0) + ' — Zayif trend', c: 'neutral' }); }
  }

  // TTM Squeeze
  if (ind.ttmSqueeze) {
    if (ind.ttmSqueeze.firing) {
      if (ind.ttmSqueeze.momentum > 0) { score += 1.5; reasons.push({ t: 'TTM SQUEEZE ATIYOR — Yükseliş patlamasi', c: 'bullish' }); }
      else { score -= 1.5; reasons.push({ t: 'TTM SQUEEZE ATIYOR — Düşüş patlamasi', c: 'bearish' }); }
    } else if (ind.ttmSqueeze.squeezeOn) {
      score += 0.3; reasons.push({ t: 'Bollinger sikisma (Keltner icinde) — Patlama yaklasiyor', c: 'neutral' });
    }
  }

  // ── VPVR (Volume Profile Point of Control) ──
  if (ind.volumeProfile && ind.volumeProfile.poc) {
    const poc = ind.volumeProfile.poc;
    const distToPoc = (p - poc) / poc * 100;
    if (distToPoc > 0 && distToPoc < 3) {
      score += 2.5; reasons.push({ t: `VPVR DESTEGI: Fiyat Kurumsal POC maliyetine (${poc.toFixed(2)}) cok yakin — Guclu destek`, c: 'bullish' });
    } else if (distToPoc < 0 && distToPoc > -3) {
      score -= 2.5; reasons.push({ t: `VPVR DIRENCI: Fiyat Kurumsal POC maliyetinin (${poc.toFixed(2)}) altinda — Guclu direnc`, c: 'bearish' });
    } else if (distToPoc >= 3) {
      score += 0.5; reasons.push({ t: `VPVR: Fiyat ana maliyetlenmenin (${poc.toFixed(2)}) ustunde`, c: 'bullish' });
    } else if (distToPoc <= -3) {
      score -= 0.5; reasons.push({ t: `VPVR: Fiyat ana maliyetlenmenin (${poc.toFixed(2)}) altinda`, c: 'bearish' });
    }
  }

  // Multi-indicator confluence (bonus for INDEPENDENT indicator type alignment)
  // Count unique indicator categories, not raw reason strings
  const bullishTypes = new Set();
  const bearishTypes = new Set();
  for (const r of reasons) {
    // Classify each reason into an indicator category
    const text = r.t;
    let cat = null;
    if (/MA-\d|Golden|Death|MA-200/i.test(text)) cat = 'MA';
    else if (/RSI\s/i.test(text)) cat = 'RSI';
    else if (/MACD|Histogram/i.test(text)) cat = 'MACD';
    else if (/StochRSI/i.test(text)) cat = 'STOCH';
    else if (/Bollinger|BB/i.test(text)) cat = 'BBAND';
    else if (/Hacim|hacim|VPVR/i.test(text)) cat = 'VOL';
    else if (/MFI|OBV|CMF|VWAP|Wyckoff|Akilli|Birikim|Dagilim/i.test(text)) cat = 'SMART';
    else if (/ADX|DI\s|Trend\s/i.test(text)) cat = 'ADX';
    else if (/TTM|SQUEEZE/i.test(text)) cat = 'TTM';
    else if (/DIVERJANS|KLIMAKS|SPRING|UTAD/i.test(text)) cat = 'DIVERGENCE';
    else if (/Pivot/i.test(text)) cat = 'PIVOT';
    else if (/SETUP/i.test(text)) cat = 'SETUP';
    else if (/KAP/i.test(text)) cat = 'KAP';
    else if (/MTF/i.test(text)) cat = 'MTF';
    else if (/SEKTOR/i.test(text)) cat = 'SECTOR';
    if (cat) {
      if (r.c === 'bullish') bullishTypes.add(cat);
      else if (r.c === 'bearish') bearishTypes.add(cat);
    }
  }
  // Require 5+ independent bullish indicator types for confluence bonus
  if (bullishTypes.size >= 6 && bearishTypes.size <= 2) { score += 2; reasons.push({ t: 'GUCLU COKLU TEYIT: ' + bullishTypes.size + ' bagimsiz gosterge uyumlu (' + [...bullishTypes].join(', ') + ')', c: 'bullish' }); }
  else if (bullishTypes.size >= 5 && bearishTypes.size <= 2) { score += 1; reasons.push({ t: 'COKLU TEYIT: ' + bullishTypes.size + ' bagimsiz gosterge uyumlu', c: 'bullish' }); }
  else if (bearishTypes.size >= 6 && bullishTypes.size <= 2) { score -= 2; reasons.push({ t: 'GUCLU COKLU TEYIT: ' + bearishTypes.size + ' bagimsiz gosterge dusus (' + [...bearishTypes].join(', ') + ')', c: 'bearish' }); }
  else if (bearishTypes.size >= 5 && bullishTypes.size <= 2) { score -= 1; reasons.push({ t: 'COKLU TEYIT: ' + bearishTypes.size + ' bagimsiz gosterge dusus', c: 'bearish' }); }

  // Setups
  const setups = prices ? detectSetups(prices, ind) : [];
  for (const s of setups) { score += s.score; reasons.push({ t: 'SETUP: ' + s.name + ' — ' + s.desc, c: s.score > 0 ? 'bullish' : s.score < 0 ? 'bearish' : 'neutral' }); }

  // Pivots
  if (pivots) {
    if (p > pivots.pp && p < pivots.r1) reasons.push({ t: 'Pivot ustunde, R1 hedefliyor', c: 'bullish' });
    else if (p < pivots.pp && p > pivots.s1) reasons.push({ t: 'Pivot altinda, S1 destek', c: 'bearish' });
  }

  // ── REGIME DETECTION: Trend vs Range — Using adaptive thresholds ──
  const regimeIsTrend = isTrending && ind.adx > 25;
  const regimeIsRange = isRanging && ind.adx < 18;
  if (regimeIsRange) {
    if (ind.lastRSI < thresholds.rsiOversold) { score += 1.5; reasons.push({ t: `RANGE BONUSU: RSI asiri satim ${regime.regime} daha degerli`, c: 'bullish' }); }
    if (ind.lastRSI > thresholds.rsiVeryOverbought) { score -= 1.5; reasons.push({ t: `RANGE CEZASI: RSI asiri alim ${regime.regime} daha tehlikeli`, c: 'bearish' }); }
  }
  if (regimeIsTrend) {
    if (ind.lastRSI > 50 && ind.lastRSI < 70 && ind.plusDI > ind.minusDI) {
      score += 0.5; reasons.push({ t: `TREND BONUSU: Momentum devamliligi ${regime.regime}`, c: 'bullish' });
    }
  }

  // ── GAP ANALYSIS (price gaps as S/R) ──
  if (prices && prices.length >= 3) {
    const prev = prices[prices.length - 2];
    const curr = prices[prices.length - 1];
    const gapUp = curr.low > prev.high;
    const gapDown = curr.high < prev.low;
    if (gapUp && ind.volRatio > 1.5) {
      score += 1.5; reasons.push({ t: 'YUKARI GAP: ' + prev.high.toFixed(2) + ' -> ' + curr.low.toFixed(2) + ' TL hacimle (kirildigi yerde destek)', c: 'bullish' });
    }
    if (gapDown && ind.volRatio > 1.5) {
      score -= 1.5; reasons.push({ t: 'ASAGI GAP: ' + prev.low.toFixed(2) + ' -> ' + curr.high.toFixed(2) + ' TL hacimle (kirilma bolgesi direnc)', c: 'bearish' });
    }
  }

  // ── WEAK CLOSE & PIN BAR PENALTY (After-Hours Fall Protection) ──
  if (ind.dayHighLowRange !== undefined) {
    if (ind.dayHighLowRange < 0.2) {
      score -= 3.5;
      reasons.push({ t: 'COK ZAYIF KAPANIS: Zirveden %80+ geri verildi — agir satis baskisi', c: 'bearish' });
    } else if (ind.dayHighLowRange < 0.3) {
      score -= 2.5;
      reasons.push({ t: 'ZAYIF KAPANIS: Zirveden sert satis yedi (Tuzak riski)', c: 'bearish' });
    } else if (ind.dayHighLowRange < 0.4) {
      score -= 1.0;
      reasons.push({ t: 'ORTA-ZAYIF KAPANIS: Gun icinde saticilar aktif', c: 'bearish' });
    }
    const today = prices && prices.length > 0 ? prices[prices.length - 1] : null;
    if (today && today.high > today.low) {
      const bodyTop = Math.max(today.open, today.close);
      const bodyBottom = Math.min(today.open, today.close);
      const upperShadow = today.high - bodyTop;
      const lowerShadow = bodyBottom - today.low;
      const bodySize = bodyTop - bodyBottom || 0.01;
      // Shooting star: uzun ust golge + kucuk govde = reddedilme
      if (upperShadow > bodySize * 2 && ind.dayHighLowRange < 0.4) {
        score -= 2.0;
        reasons.push({ t: 'SHOOTING STAR / PIN BAR: Yukaridan reddedildi', c: 'bearish' });
      }
      // Gravestone doji: neredeyse tum range ust golgede
      if (upperShadow > bodySize * 4 && bodySize / (today.high - today.low) < 0.1) {
        score -= 2.5;
        reasons.push({ t: 'GRAVESTONE DOJI: Guc tukenmesi — ertesi gun dusus riski cok yuksek', c: 'bearish' });
      }
      // Hammer (bullish): uzun alt golge + kucuk govde = dip red
      if (lowerShadow > bodySize * 2.5 && upperShadow < bodySize * 0.5 && ind.lastRSI < 40) {
        score += 1.5;
        reasons.push({ t: 'HAMMER: Dipten guclu reddedilme — tersine donus sinyali', c: 'bullish' });
      }
    }
  }

  // ── EXHAUSTION / TUKENIS PATTERN (Enhanced — World-Class Detection) ──
  // Ust uste yukselis + bariz momentum kaybı = yarın düşüş olasılığı yüksek
  if (prices && prices.length >= 5) {
    const last5 = prices.slice(-5);
    const last3 = prices.slice(-3);

    // 3 gun ust uste yukselis + son bar'da hacim dusuk = tukenis
    const rising3 = last3.every((b, i) => i === 0 || b.close > last3[i-1].close);
    const totalRise3 = last3.length >= 2 ? ((last3[last3.length-1].close - last3[0].open) / last3[0].open * 100) : 0;

    if (rising3 && totalRise3 > 6 && ind.volRatio < 1.0) {
      score -= 2.5;
      reasons.push({ t: `TUKENIS PATTERNI: 3 gun +%${totalRise3.toFixed(1)} yukselis ama hacim dusuyor — akilli para almıyor`, c: 'bearish' });
    } else if (rising3 && totalRise3 > 4 && ind.volRatio < 0.8) {
      score -= 1.5;
      reasons.push({ t: `ZAYIF RALLI: 3 gunde +%${totalRise3.toFixed(1)} ama hacim kuruyor`, c: 'bearish' });
    }

    // Daralan govde = momentum kaybı (ust uste kuculen mumlar)
    if (last3.length >= 3) {
      const body0 = Math.abs(last3[0].close - last3[0].open);
      const body1 = Math.abs(last3[1].close - last3[1].open);
      const body2 = Math.abs(last3[2].close - last3[2].open);
      if (body0 > body1 && body1 > body2 && body2 > 0 && rising3) {
        score -= 1.5;
        reasons.push({ t: 'DARALAN GOVDE: Her gun daha kucuk yukselis — momentum tukeniyor', c: 'bearish' });
      }
    }

    // 5 bar analizi: extended rally detection
    const greenCount = last5.filter(b => b.close > b.open).length;
    const redCount = last5.filter(b => b.close < b.open).length;
    // 4+ consecutive green bars at overbought = exhaustion risk
    if (greenCount >= 4 && (ind.lastRSI || 50) > 65) {
      const volPenalty = ind.volRatio < 1.0 ? 2.5 : ind.volRatio < 1.2 ? 1.5 : 1.0;
      score -= volPenalty;
      reasons.push({ t: `UZAMIS RALLI: ${greenCount}/5 yesil mum + RSI ${(ind.lastRSI||50).toFixed(0)} — duzeltme olasılığı yuksek`, c: 'bearish' });
    }
    // 4+ consecutive red bars at oversold = bounce potential
    if (redCount >= 4 && (ind.lastRSI || 50) < 35) {
      score += 1.5;
      reasons.push({ t: 'SICRAMA POTANSIYELI: 4+ dusus + RSI dusuk — tepki yukselisi yakin', c: 'bullish' });
    }
  }

  // ── SMART MONEY DIVERGENCE: Rising price + Distribution = TUZAK ──
  // Bu OZSUB/BVSAN'in yakalanmasi gereken en onemli sinyal
  if (ind.obvTrend === 'distribution' && ind.changePct > 0 && (ind.lastRSI || 50) > 55) {
    score -= 2.5;
    reasons.push({ t: 'AKILLI PARA TUZAGI: Fiyat yukselirken OBV dagilim — buyukler satiyor, KACINIZ', c: 'bearish' });
  }
  if ((ind.cmf || 0) < -0.08 && ind.changePct > 0.5) {
    score -= 1.5;
    reasons.push({ t: 'CMF UYARISI: Fiyat artisi + para cikisi — sahte yukselis', c: 'bearish' });
  }
  // MFI overbought + recent pump = sert dusus olasiligi
  if ((ind.mfi || 50) > 75 && ind.changePct > 2) {
    score -= 2.0;
    reasons.push({ t: `MFI ASIRI ALIM (${(ind.mfi||50).toFixed(0)}): Yukselis + asiri MFI = kar realizasyonu yakın`, c: 'bearish' });
  }

  // ── MOMENTUM QUALITY: Volume confirms price direction ──
  if (prices && prices.length >= 5 && ind.volRatio != null) {
    const last3 = prices.slice(-3);
    const priceUp = last3.every((b, i) => i === 0 || b.close >= last3[i-1].close);
    const priceDown = last3.every((b, i) => i === 0 || b.close <= last3[i-1].close);
    if (priceUp && ind.volRatio > 1.5) {
      score += 1.0; reasons.push({ t: 'MOMENTUM KALITESI: Yukselis hacimle teyit ediliyor', c: 'bullish' });
    }
    if (priceUp && ind.volRatio > 3.0) {
      score += 2.0; reasons.push({ t: 'MOMENTUM KALITESI: ASIRI GUCLU kurumsal momentum', c: 'bullish' });
    }
    if (priceDown && ind.volRatio > 1.5) {
      score -= 1.5; reasons.push({ t: 'MOMENTUM KALITESI: Dusus hacimle teyit — satis baskisi agir', c: 'bearish' });
    }
    if (priceDown && ind.volRatio > 2.5) {
      score -= 2.0; reasons.push({ t: 'KURUMSAL SATIS: Agir hacimli dusus — panik modu', c: 'bearish' });
    }
    // Rising price on falling volume = weak rally — ENHANCED PENALTY
    if (priceUp && ind.volRatio < 0.7) {
      score -= 1.5; reasons.push({ t: 'ZAYIF RALLI: Yukselis dusuk hacimle — susdurulabilir (cok tehlikeli)', c: 'bearish' });
    } else if (priceUp && ind.volRatio < 1.0) {
      score -= 0.5; reasons.push({ t: 'DUSUK HACIM RALLISI: Yukselis ortalamanin altinda hacimle', c: 'bearish' });
    }
  }

  // ── VOLUME PROFILE (Deeper Thinking: POC Rejection / Breakout) ──
  if (ind.volumeProfile && ind.volumeProfile.poc) {
    const poc = ind.volumeProfile.poc;
    const distanceToPOC = ((p - poc) / poc) * 100;
    
    // Trapped below POC
    if (distanceToPOC < 0 && distanceToPOC > -3 && ind.dayHighLowRange < 0.4) {
      score -= 1.5; reasons.push({ t: `HACIM PROFILI TUZAGI: Fiyat ${poc.toFixed(2)} POC seviyesinin altinda baskilaniyor`, c: 'bearish' });
    }
    // Breaking above POC with volume
    else if (distanceToPOC > 0 && distanceToPOC < 3 && ind.volRatio > 1.3) {
      score += 1.5; reasons.push({ t: `HACIM PROFILI KIRILIMI: ${poc.toFixed(2)} POC seviyesi hacimle asildi`, c: 'bullish' });
    }
  }

  // ── FALSE BREAKOUT DETECTION ──
  if (prices && prices.length >= 5 && ind.sr && Array.isArray(ind.sr)) {
    const prev2 = prices[prices.length - 3];
    const prev1 = prices[prices.length - 2];
    const curr = prices[prices.length - 1];
    // Check for false resistance breakout (broke above then came back)
    const nearRes = ind.sr.filter(s => s.type === 'resistance').sort((a, b) => a.price - b.price);
    if (nearRes.length > 0) {
      const res0 = nearRes[0].price;
      if (prev1.high > res0 && curr.close < res0 && prev2.close < res0) {
        score -= 1.5; reasons.push({ t: 'SAHTE KIRILMA: ' + res0.toFixed(2) + ' TL direncini kirdi ama geri dusdu — tuzak', c: 'bearish' });
      }
    }
    // Check for false support breakdown
    const nearSup = ind.sr.filter(s => s.type === 'support').sort((a, b) => b.price - a.price);
    if (nearSup.length > 0) {
      const sup0 = nearSup[0].price;
      if (prev1.low < sup0 && curr.close > sup0 && prev2.close > sup0) {
        score += 1.5; reasons.push({ t: 'SAHTE KIRILMA (SPRING): ' + sup0.toFixed(2) + ' TL destegi kirdi ama toparlanma — alis firsati', c: 'bullish' });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ── MULTI-TIMEFRAME CONFLUENCE CHECK (ENHANCED — HARD GATES) ──
  // "Trend ile calis" kuralı: HTF trendine karşı işlem açmak sert cezalandırılır.
  // ══════════════════════════════════════════════════════════════
  if (htfContext) {
    // Calculate HTF trend strength (0-100) — stronger trend = harsher filter
    const htfStrength = (htfContext.adx || 15);
    const isStrongHTFTrend = htfStrength > 25;
    const isWeeklyBear = htfContext.weeklyTrend === 'bear';
    const isWeeklyBull = htfContext.weeklyTrend === 'bull';

    // ── DAILY + WEEKLY BEAR: Penalty for buy signals (Softened to catch bottoms) ──
    if (htfContext.trend === 'bear' && score > 0) {
      if (isWeeklyBear) {
        // Both daily AND weekly bearish → Reduced penalty (25% score cut)
        const penalty = Math.max(1.5, score * 0.25);
        score -= penalty;
        reasons.push({ t: 'MTF UYARI: Haftalik+Gunluk trend DUSUS — alis sinyal skoru %25 kesildi (-' + penalty.toFixed(1) + ')', c: 'bearish' });
      } else if (isStrongHTFTrend) {
        // Daily bearish with strong ADX → moderate penalty
        score -= 1.5;
        reasons.push({ t: 'MTF UYARI: Guclu gunluk dusus trendi (ADX:' + htfStrength.toFixed(0) + ') — dipten donus riski (-1.5)', c: 'bearish' });
      } else {
        // Daily bearish, weak trend → light penalty
        score -= 1;
        reasons.push({ t: 'MTF UYARI: Gunluk trend DUSUS — dipten donus potansiyeli (-1)', c: 'bearish' });
      }
    }
    // ── DAILY + WEEKLY BULL: Strong bonus for buy signals ──
    else if (htfContext.trend === 'bull' && score > 0) {
      if (isWeeklyBull) {
        // Both daily AND weekly bullish → strong confirmation
        score += 2.5;
        reasons.push({ t: 'MTF GUCLU TEYIT: Haftalik+Gunluk trend YUKSELIS ile tam uyumlu (+2.5)', c: 'bullish' });
      } else {
        score += 1.5;
        reasons.push({ t: 'MTF TEYIT: Gunluk trend YUKSELIS ile uyumlu (+1.5)', c: 'bullish' });
      }
    }
    // ── BULL trend but sell signal: buffer ──
    else if (htfContext.trend === 'bull' && score < 0) {
      if (isWeeklyBull && !isStrongHTFTrend) {
        // Weekly uptrend softens sell signals significantly
        score += 2;
        reasons.push({ t: 'MTF TAMPON: Haftalik yukselis trendi satis baskisini onemli olcude hafifletiyor (+2)', c: 'neutral' });
      } else {
        score += 1;
        reasons.push({ t: 'MTF TAMPON: Gunluk yukselis trendi satis baskisini hafifletiyor (+1)', c: 'neutral' });
      }
    }
    // ── BEAR trend and sell signal: confirmation ──
    else if (htfContext.trend === 'bear' && score < 0) {
      if (isWeeklyBear) {
        score -= 2;
        reasons.push({ t: 'MTF TEYIT: Haftalik+Gunluk DUSUS trendi ile uyumlu satis (-2)', c: 'bearish' });
      } else {
        score -= 1;
        reasons.push({ t: 'MTF TEYIT: Gunluk DUSUS trendi ile uyumlu satis (-1)', c: 'bearish' });
      }
    }

    // ── RSI divergence across timeframes ──
    if (htfContext.rsi != null && ind.lastRSI != null) {
      if (htfContext.rsi > 70 && ind.lastRSI > 60) {
        score -= 1.5;
        reasons.push({ t: 'MTF RSI CIFT ASIRI ALIM: Hem gunluk (' + htfContext.rsi.toFixed(0) + ') hem kisa vadede (' + ind.lastRSI.toFixed(0) + ') asiri alim — ciddi duzeltme riski', c: 'bearish' });
      }
      if (htfContext.rsi < 30 && ind.lastRSI < 40) {
        score += 1.5;
        reasons.push({ t: 'MTF RSI CIFT ASIRI SATIM: Coklu zaman diliminde dip — guclu dip firsati', c: 'bullish' });
      }
    }

    // ── MA200 alignment check ──
    if (htfContext.ma200Above === false && score > 0) {
      // Price below MA200 on daily: long-term downtrend → extra penalty for buys
      score -= 1;
      reasons.push({ t: 'MTF MA200: Fiyat gunluk MA200 altinda — uzun vadeli dusus trendinde', c: 'bearish' });
    } else if (htfContext.ma200Above === true && score > 0) {
      score += 0.5;
      reasons.push({ t: 'MTF MA200: Gunluk MA200 uzerinde — uzun vadeli yukselis trendinde', c: 'bullish' });
    }

    // ── Weekly momentum divergence ──
    if (htfContext.weeklyRsi != null && ind.lastRSI != null) {
      // Weekly RSI > 70 AND intraday buying → market at weekly overbought
      if (htfContext.weeklyRsi > 70 && score > 3) {
        score -= 1.5;
        reasons.push({ t: 'HAFTALIK ASIRI ALIM: Haftalik RSI ' + htfContext.weeklyRsi.toFixed(0) + ' — duzeltme riski yuksek', c: 'bearish' });
      }
      // Weekly RSI < 30 AND intraday selling → market at weekly oversold
      if (htfContext.weeklyRsi < 30 && score < -2) {
        score += 1.5;
        reasons.push({ t: 'HAFTALIK ASIRI SATIM: Haftalik RSI ' + htfContext.weeklyRsi.toFixed(0) + ' — tersine donus potansiyeli', c: 'bullish' });
      }
    }
  }

  // ── KAP SENTIMENT INTEGRATION ──
  // Every KAP news affects signal score (user confirmed: all news, not just high-importance)
  if (kapSentiment && kapSentiment.score !== 0) {
    const ks = kapSentiment.score; // range: -10 to +10
    // Scale KAP impact: max +/- 3 points on signal score
    const kapImpact = Math.max(-3, Math.min(3, ks * 0.3));
    score += kapImpact;
    if (kapImpact > 0) {
      reasons.push({ t: 'KAP POZITIF: ' + (kapSentiment.headline || 'Olumlu haber akisi') + ' (+' + kapImpact.toFixed(1) + ')', c: 'bullish' });
    } else if (kapImpact < 0) {
      reasons.push({ t: 'KAP NEGATIF: ' + (kapSentiment.headline || 'Olumsuz haber akisi') + ' (' + kapImpact.toFixed(1) + ')', c: 'bearish' });
    }
  }

  // ── SECTOR RELATIVE STRENGTH (HARD GATE) ──
  // Sector CIKIS (exit) suppresses buy signals regardless of other indicators.
  // Sector GUCLU GIRIS provides a meaningful tailwind bonus.
  if (sectorStrength != null) {
    if (sectorStrength >= 80) {
      score += 2;
      reasons.push({ t: 'SEKTOR GUCLU GIRIS: Sektorde para akisi guclu (' + sectorStrength + '/100) — sektorel tailwind', c: 'bullish' });
    } else if (sectorStrength >= 70) {
      score += 1;
      reasons.push({ t: 'SEKTOR GUCU: Sektor endekse karsi guclu (' + sectorStrength + '/100)', c: 'bullish' });
    } else if (sectorStrength <= 20) {
      // CIKIS territory — hard penalty, automatically caps buy signals
      score -= 2.5;
      reasons.push({ t: 'SEKTOR CIKIS ALARMI: Para sektordan kacıyor (' + sectorStrength + '/100) — AL sinyali bastırıldı', c: 'bearish' });
    } else if (sectorStrength <= 30) {
      score -= 1.5;
      reasons.push({ t: 'SEKTOR ZAYIF: Sektor endekse karsi zayif (' + sectorStrength + '/100)', c: 'bearish' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ── NEW WORLD-CLASS INDICATOR SCORING ──
  // ══════════════════════════════════════════════════════════════

  // ── ICHIMOKU CLOUD ──
  if (ind.ichimoku) {
    const ichi = ind.ichimoku;
    // TK Cross (Tenkan/Kijun)
    if (ichi.tkCross === 'bullish') {
      score += 1.5; bullishTypes.add('ichimoku');
      reasons.push({ t: 'ICHIMOKU TK CROSS: Tenkan Kijun ustune gecti — AL sinyali', c: 'bullish' });
    } else if (ichi.tkCross === 'bearish') {
      score -= 1.5; bearishTypes.add('ichimoku');
      reasons.push({ t: 'ICHIMOKU TK CROSS: Tenkan Kijun altina indi — SAT sinyali', c: 'bearish' });
    }
    // Kumo Breakout
    if (ichi.kumoBreakout === 'bullish') {
      score += 2; bullishTypes.add('ichimoku');
      reasons.push({ t: 'ICHIMOKU KUMO KIRILMA: Fiyat bulutun ustune cikti — guclu AL', c: 'bullish' });
    } else if (ichi.kumoBreakout === 'bearish') {
      score -= 2; bearishTypes.add('ichimoku');
      reasons.push({ t: 'ICHIMOKU KUMO KIRILMA: Fiyat bulutun altina indi — guclu SAT', c: 'bearish' });
    }
    // Cloud Position (trend context)
    if (ichi.cloudPosition === 'above' && !ichi.kumoBreakout) {
      score += 0.5;
      reasons.push({ t: 'ICHIMOKU: Fiyat bulut ustunde — yukselis trendi devam', c: 'bullish' });
    } else if (ichi.cloudPosition === 'below' && !ichi.kumoBreakout) {
      score -= 0.5;
      reasons.push({ t: 'ICHIMOKU: Fiyat bulut altinda — dusus trendi devam', c: 'bearish' });
    }
    // Kumo Twist (future trend change)
    if (ichi.kumoTwist === 'bullish') {
      score += 0.5;
      reasons.push({ t: 'ICHIMOKU KUMO TWIST: Bulut rengi degisti — gelecek yukselis isareti', c: 'bullish' });
    } else if (ichi.kumoTwist === 'bearish') {
      score -= 0.5;
      reasons.push({ t: 'ICHIMOKU KUMO TWIST: Bulut rengi degisti — gelecek dusus isareti', c: 'bearish' });
    }
  }

  // ── SUPERTREND ──
  if (ind.supertrend) {
    const st = ind.supertrend;
    if (st.flip === 'bullish') {
      score += 2; bullishTypes.add('supertrend');
      reasons.push({ t: 'SUPERTREND FLIP: Trend yukselise dondu — guclu AL sinyali', c: 'bullish' });
    } else if (st.flip === 'bearish') {
      score -= 2; bearishTypes.add('supertrend');
      reasons.push({ t: 'SUPERTREND FLIP: Trend dususe dondu — guclu SAT sinyali', c: 'bearish' });
    } else if (st.trend === 'UP' && !st.flip) {
      score += 0.5; bullishTypes.add('supertrend');
      reasons.push({ t: 'SUPERTREND: Yukselis trendinde — destek: ' + (st.value?.toFixed(2) || '-') + ' TL', c: 'bullish' });
    } else if (st.trend === 'DOWN' && !st.flip) {
      score -= 0.5; bearishTypes.add('supertrend');
      reasons.push({ t: 'SUPERTREND: Dusus trendinde — direnc: ' + (st.value?.toFixed(2) || '-') + ' TL', c: 'bearish' });
    }
  }

  // ── WILLIAMS %R ──
  if (ind.lastWilliamsR != null) {
    const wr = ind.lastWilliamsR;
    if (wr < -80) {
      score += 1; bullishTypes.add('williams');
      reasons.push({ t: 'WILLIAMS %R ASIRI SATIM: %R=' + wr.toFixed(0) + ' — dip firsati', c: 'bullish' });
    } else if (wr > -20) {
      score -= 1; bearishTypes.add('williams');
      reasons.push({ t: 'WILLIAMS %R ASIRI ALIM: %R=' + wr.toFixed(0) + ' — geri cekilme riski', c: 'bearish' });
    }
  }

  // ── TRIX (Noise Filter) ──
  if (ind.trix) {
    const trix = ind.trix;
    if (trix.crossover === 'bullish') {
      score += 1.5; bullishTypes.add('trix');
      reasons.push({ t: 'TRIX YUKARIS KESISIM: Uzun vadeli momentum yukselise dondu', c: 'bullish' });
    } else if (trix.crossover === 'bearish') {
      score -= 1.5; bearishTypes.add('trix');
      reasons.push({ t: 'TRIX ASAGI KESISIM: Uzun vadeli momentum dususe dondu', c: 'bearish' });
    } else if (trix.lastTRIX != null && trix.lastTRIX > 0) {
      score += 0.3;
    } else if (trix.lastTRIX != null && trix.lastTRIX < 0) {
      score -= 0.3;
    }
  }

  // ── VOLUME PROFILE (POC Proximity) ──
  if (ind.volumeProfile && ind.volumeProfile.poc != null) {
    const vp = ind.volumeProfile;
    const priceDistFromPOC = Math.abs(p - vp.poc) / vp.poc;
    if (priceDistFromPOC < 0.02) {
      reasons.push({ t: 'VOLUME PROFILE: Fiyat POC yakini (' + vp.poc.toFixed(2) + ' TL) — yogun islem bolgesi', c: 'neutral' });
    }
    if (p < vp.valueAreaLow && vp.valueAreaLow > 0) {
      score += 0.5; bullishTypes.add('volume_profile');
      reasons.push({ t: 'VOLUME PROFILE: Fiyat deger alaninin altinda — deger firsati', c: 'bullish' });
    }
    if (p > vp.valueAreaHigh && vp.valueAreaHigh > 0) {
      score -= 0.5; bearishTypes.add('volume_profile');
      reasons.push({ t: 'VOLUME PROFILE: Fiyat deger alaninin ustunde — asiri uzanma', c: 'bearish' });
    }
  }

  // ── ROC (Rate of Change — Momentum Acceleration) ──
  if (ind.lastROC10 != null && ind.lastROC20 != null) {
    const rocAccel = ind.lastROC10 - ind.lastROC20;
    if (ind.lastROC10 > 5 && rocAccel > 2) {
      score += 1; bullishTypes.add('roc');
      reasons.push({ t: 'ROC IVME: Momentum hizlaniyor (ROC10:+' + ind.lastROC10.toFixed(1) + '%, ivme:+' + rocAccel.toFixed(1) + ')', c: 'bullish' });
    } else if (ind.lastROC10 < -5 && rocAccel < -2) {
      score -= 1; bearishTypes.add('roc');
      reasons.push({ t: 'ROC IVME: Momentum dususe hizlaniyor (ROC10:' + ind.lastROC10.toFixed(1) + '%, ivme:' + rocAccel.toFixed(1) + ')', c: 'bearish' });
    }
  }

  // ═══ NORMALIZE SCORE TO 0-100 ═══
  // Raw score range is approximately -25 to +25 in practice
  // Normalize: 50 = neutral, 100 = max bullish, 0 = max bearish
  const MAX_PRACTICAL = 35;
  const rawScore = score;
  let score100 = Math.max(0, Math.min(100, 50 + (rawScore / MAX_PRACTICAL) * 50));

  // ── ML CALIBRATION: adjust score based on historical winRate × expectancy ──
  // The active model is published from useSignalTracker via setSignalCalibration().
  // When fewer than MIN_SAMPLES closed signals exist the multiplier is 1.0 (no-op).
  let calibrationInfo = null;
  try {
    const provisionalCls = score100 >= 60 ? 'buy' : score100 <= 40 ? 'sell' : 'hold';
    const cal = applyCalibrationToScore(score100, { cls: provisionalCls });
    if (cal.calibration?.applied) {
      const before = score100;
      score100 = cal.score100;
      calibrationInfo = cal.calibration;
      const delta = score100 - before;
      if (Math.abs(delta) >= 1) {
        const arrow = delta > 0 ? 'yukseltildi' : 'dusuruldu';
        reasons.push({
          t: `ML KALIBRASYON: Skor ${arrow} ${before.toFixed(0)} -> ${score100.toFixed(0)} (gecmis ${calibrationInfo.breakdown[0]?.samples || '?'} sinyal, x${calibrationInfo.multiplier})`,
          c: delta > 0 ? 'bullish' : 'bearish',
        });
      }
    }
  } catch (err) { /* calibration is best-effort — never block signal */ }

  // Signal classification using normalized 0-100 score
  // GUCLU AL: >=75 AND volume AND smart money AND 4+ indicator types
  // AL: >=65 AND volume AND 3+ indicator types  
  // SAT: <=35 AND 3+ indicator types
  // GUCLU SAT: <=25 AND volume AND smart money selling AND 4+ types
  let signal, cls;
  let conf = Math.min(score100 > 50 ? (score100 - 50) * 2 : (50 - score100) * 2, 95);

  // ── HTF CONFIDENCE PENALTY: Reduce confidence for counter-trend trades ──
  if (htfContext) {
    if (htfContext.trend === 'bear' && score100 > 50) {
      conf *= 0.70;
    }
    if (htfContext.weeklyTrend === 'bear' && score100 > 50) {
      conf *= 0.80;
    }
    if (htfContext.trend === 'bull' && score100 > 50) {
      conf = Math.min(95, conf * 1.10);
    }
    if (htfContext.weeklyTrend === 'bull' && htfContext.trend === 'bull' && score100 > 50) {
      conf = Math.min(95, conf * 1.10);
    }
  }
  // v24: Volume threshold relaxed — BIST ortalama volRatio ~0.8-1.0, strict >1.1 %85 hisseyi eliyordu
  const hasVolConfirm = ind.volRatio > 1.1;
  const hasVolSoft = ind.volRatio > 0.8;         // Yumusak hacim — dusuk degil yeterli
  const hasSmartMoneyBuy = ind.obvTrend === 'accumulation' || (ind.cmf != null && ind.cmf > 0.05) || (ind.mfi != null && ind.mfi < 35);
  const hasSmartMoneySell = ind.obvTrend === 'distribution' || (ind.cmf != null && ind.cmf < -0.05) || (ind.mfi != null && ind.mfi > 75);

  // v24: bullishTypes esigi: GUCLU AL=5, AL=4, ZAYIF AL=3
  const minBullTypes = bullishTypes.size >= 4;
  const softBullTypes = bullishTypes.size >= 3;   // 3 bagimsiz teyit = makul sinyal
  const minBearTypes = bearishTypes.size >= 4;
  const softBearTypes = bearishTypes.size >= 3;

  // GUCLU AL: score100 >= 75 AND volume AND smart money AND 5+ indicator types
  if (score100 >= 75 && hasVolConfirm && hasSmartMoneyBuy && bullishTypes.size >= 5) { signal = 'GUCLU AL'; cls = 'buy'; }
  // AL: score100 >= 65 AND volume AND 4+ indicator types
  else if (score100 >= 65 && hasVolConfirm && minBullTypes) { signal = 'AL'; cls = 'buy'; }
  // v24 ZAYIF AL: score100 >= 57 AND soft volume AND 3+ types AND smart money teyidi
  // BIST'te volRatio 0.8-1.1 arasi cok yaygin; bunlar guclu setup olabilir
  else if (score100 >= 57 && hasVolSoft && softBullTypes && hasSmartMoneyBuy) { signal = 'AL'; cls = 'buy'; }
  // GUCLU SAT: score100 <= 25 AND volume AND smart money selling AND 5+ types
  else if (score100 <= 25 && hasVolConfirm && hasSmartMoneySell && bearishTypes.size >= 5) { signal = 'GUCLU SAT'; cls = 'sell'; }
  // SAT: score100 <= 35 AND 4+ indicator types
  else if (score100 <= 35 && minBearTypes) { signal = 'SAT'; cls = 'sell'; }
  // v24 ZAYIF SAT: score100 <= 42 AND soft bear types AND smart money selling
  else if (score100 <= 42 && softBearTypes && hasSmartMoneySell) { signal = 'SAT'; cls = 'sell'; }
  else { signal = 'TUT'; cls = 'hold'; }

  // ========== ENTRY / STOP / TARGETS (ADVANCED) ==========
  // Find all support/resistance levels
  let sup = null, sup2 = null, res = null, res2 = null;
  const srLevels = ind.sr && Array.isArray(ind.sr) ? ind.sr : [];
  const supports = srLevels.filter(s => s.type === 'support' && s.price < p).sort((a, b) => b.price - a.price);
  const resistances = srLevels.filter(s => s.type === 'resistance' && s.price > p).sort((a, b) => a.price - b.price);
  if (supports.length > 0) sup = supports[0];
  if (supports.length > 1) sup2 = supports[1];
  if (resistances.length > 0) res = resistances[0];
  if (resistances.length > 1) res2 = resistances[1];

  // ═══ STOP LOSS: kesin teknik seviyelere dayalı hassas hesaplama ═══
  // Öncelik: Chandelier > Destek > ATR-bazlı
  // Pump hisselerde (son bar yüksek) stop son barin low'unun altı
  // Sıkışma setup'larında sıkışma alt bandı
  const recentLow = prices && prices.length >= 3
    ? Math.min(prices[prices.length - 1].low, prices[prices.length - 2].low, prices[prices.length - 3].low)
    : null;
  const swingLow = prices && prices.length >= 10
    ? Math.min(...prices.slice(-10).map(b => b.low))
    : null;

  const atrMul = regimeIsTrend ? 1.6 : 2.0; // Trend: daha sıkı, range: biraz boşluk
  const atrStop = atr ? p - atrMul * atr : null;
  const srStop = sup ? sup.price * 0.993 : null; // %0.7 destek altı buffer
  const chandelierStop = ind.chandelier ? ind.chandelier.longStop : null;
  // Recent structure low — en yakın teknik stop
  const structureStop = recentLow && recentLow < p ? recentLow * 0.997 : null;
  const swingStop = swingLow && swingLow < p * 0.94 ? null : (swingLow ? swingLow * 0.993 : null);

  // Floor: maksimum risk (trend: %6, range: %8, volatil: %10)
  const maxRisk = regimeIsTrend ? 0.94 : (atr && atr / p > 0.03 ? 0.90 : 0.92);
  let stop;
  const stopCandidates = [chandelierStop, srStop, structureStop, swingStop, atrStop]
    .filter(s => s != null && s < p && s > p * maxRisk);

  if (stopCandidates.length > 0) {
    if (regimeIsTrend) {
      // Trend: tightest (highest) — kapitali koru
      stop = Math.max(...stopCandidates);
    } else {
      // Range: destek bazlı stop öncelikli
      stop = srStop && srStop > p * maxRisk ? srStop
           : structureStop && structureStop > p * maxRisk ? structureStop
           : Math.max(...stopCandidates);
    }
  } else {
    // Fallback: hacim kırılımında sıkı, normal'de standart
    const defaultStop = ind.volRatio > 2 ? 0.965 : 0.95;
    stop = sup ? Math.max(sup.price * 0.99, p * defaultStop) : p * defaultStop;
  }
  // Hard floor
  if (stop < p * maxRisk) stop = p * maxRisk;
  // Hard ceiling: stop hiçbir zaman entry'nin %1.5'inden yakın olmamalı (bant slipajı)
  if (stop > p * 0.985) stop = p * 0.985;

  // --- ENTRY ---
  let entry = p;
  if (cls === 'hold' && ind.lastMA20 && ind.lastMA20 < p) entry = ind.lastMA20;
  else if (cls === 'hold' && sup) entry = sup.price * 1.005;

  // ═══ TARGETS: çok katmanlı, ağırlıklı — en güvenilir seviyeyi öne çeker ═══
  const t1Candidates = [];

  // 1. En yakın direnç — en güvenilir (ağırlık 4)
  if (res && res.price > entry * 1.008) t1Candidates.push({ price: res.price, source: 'resistance', weight: 4 });

  // 2. ATR-bazlı (trend'de agresif, range'de muhafazakâr)
  if (atr) {
    const atrMult = regimeIsTrend ? 2.8 : 2.0;
    t1Candidates.push({ price: entry + atrMult * atr, source: 'atr', weight: 2 });
  }

  // 3. Fibonacci extension (sadece net trend'de güvenilir)
  if (fibs && fibs.trend === 'up') {
    if (fibs['0.618'] && fibs['0.618'] > entry * 1.01) t1Candidates.push({ price: fibs['0.618'], source: 'fib618', weight: 2 });
    if (fibs['1.0']   && fibs['1.0']   > entry * 1.01) t1Candidates.push({ price: fibs['1.0'],   source: 'fib100', weight: 3 });
    if (fibs['1.272'] && fibs['1.272'] > entry * 1.02) t1Candidates.push({ price: fibs['1.272'], source: 'fib127', weight: 1 });
  }

  // 4. Pivot dirençleri
  if (pivots) {
    if (pivots.r1 && pivots.r1 > entry * 1.005) t1Candidates.push({ price: pivots.r1, source: 'pivot_r1', weight: 2 });
    if (pivots.r2 && pivots.r2 > entry * 1.02)  t1Candidates.push({ price: pivots.r2, source: 'pivot_r2', weight: 1 });
  }

  // 5. R/R-based floor: en az 1.5:1 R/R sağlayacak minimum hedef
  const minRRTarget = entry + (entry - stop) * 1.5;
  t1Candidates.push({ price: minRRTarget, source: 'minRR', weight: 1 });

  // Ağırlıklı ortalama — aşırı uzak adayları çıkar (entry * 1.25'ten uzak)
  const filtered = t1Candidates.filter(c => c.price <= entry * 1.30 && c.price > entry * 1.005);
  let t1;
  if (filtered.length > 0) {
    const totalWeight = filtered.reduce((s, c) => s + c.weight, 0);
    t1 = filtered.reduce((s, c) => s + c.price * c.weight, 0) / totalWeight;
  } else if (t1Candidates.length > 0) {
    // Fallback: minimum hedefi kullan
    t1 = Math.min(...t1Candidates.map(c => c.price).filter(v => v > entry));
  } else {
    t1 = entry * 1.05;
  }
  // Minimum %2 target (çok sıkı olmasın), Maximum %20 (gerçekçi olmayan hedef koyma)
  if (t1 < entry * 1.02) t1 = entry * 1.02;
  if (t1 > entry * 1.20) t1 = entry * 1.15;

  // T2: ikinci direnç veya Fib 1.618
  let t2;
  if (res2 && res2.price > t1 * 1.01) t2 = res2.price;
  else if (fibs && fibs['1.618'] && fibs['1.618'] > t1 * 1.01) t2 = fibs['1.618'];
  else if (pivots && pivots.r2 && pivots.r2 > t1 * 1.01) t2 = pivots.r2;
  else if (atr) t2 = entry + 3.5 * atr;
  else t2 = t1 * 1.05;

  // T3: uzak hedef
  let t3;
  if (fibs && fibs['2.0'] && fibs['2.0'] > t2 * 1.01) t3 = fibs['2.0'];
  else if (pivots && pivots.r3 && pivots.r3 > t2 * 1.01) t3 = pivots.r3;
  else if (atr) t3 = entry + 5.5 * atr;
  else t3 = t2 * 1.06;

  if (t2 <= t1) t2 = t1 * 1.05;
  if (t3 <= t2) t3 = t2 * 1.05;

  // --- RISK/REWARD ---
  const risk = entry - stop, reward = t1 - entry;
  const rr = risk > 0 ? reward / risk : 0;
  const rr2 = risk > 0 ? (t2 - entry) / risk : 0;
  const rrQuality = rr >= 2.5 ? 'excellent' : rr >= 1.8 ? 'good' : rr >= 1.2 ? 'fair' : 'poor';

  // ── R/R QUALITY GATE (v24 — yumusatildi) ──
  // ONCEKI SORUN: rr<1.0 → cls='hold' → useAIAdvisor'da ikinci kez score gate → cift ceza
  // YENI: rr<0.5 = gercekten kotu → hold; rr 0.5-1.0 = uyari ama sinyal korunur
  // useAIAdvisor zaten composite confidence ile R/R'yi degerlendiriyor
  const minRR = (ind.volRatio > 2.0 && score100 >= 65) ? 0.3 : 0.5;
  if (rr < minRR && cls === 'buy') {
    signal = 'TUT'; cls = 'hold';
    reasons.push({ t: 'R/R FILTRESI: Risk/Odul 1:' + rr.toFixed(1) + ' yetersiz (Eşik: ' + minRR + ') — sinyal iptal', c: 'bearish' });
  } else if (rr < 1.0 && cls === 'buy') {
    // Uyar ama sinyal KORUNSUN — useAIAdvisor composite confidence ile degerlendirsin
    conf = Math.max(15, conf * 0.90);
    reasons.push({ t: 'R/R UYARISI: Risk/Odul 1:' + rr.toFixed(1) + ' dusuk — diger faktorlerle dengelenecek', c: 'neutral' });
  }

  // ── VOLUME-PRICE DIVERGENCE PENALTY: Rising price + falling volume ──
  if (cls === 'buy' && ind.volRatio < 0.7 && ind.changePct > 0.5) {
    conf = Math.max(10, conf * 0.90);
    reasons.push({ t: 'HACIM UYARISI: Yukselis dusuk hacimle — guvenilirlik azaltildi', c: 'neutral' });
  }

  // ── MULTI-TEYIT: az teyitte confidence dusur ama sinyal KORUNSUN ──
  if (cls === 'buy' && bullishTypes.size < 3) {
    conf = Math.max(15, conf * 0.85);
    reasons.push({ t: 'TEYIT NOTU: ' + bullishTypes.size + ' bagimsiz yukselis teyidi — ek teyit aranmali', c: 'neutral' });
  }
  if (cls === 'sell' && bearishTypes.size < 3) {
    conf = Math.max(15, conf * 0.85);
    reasons.push({ t: 'TEYIT NOTU: ' + bearishTypes.size + ' bagimsiz dusus teyidi', c: 'neutral' });
  }

  // ── ADVANCED HOLD DURATION ESTIMATE (GERCEKCI VADE TAHMINI) ──
  let holdBars = null, holdText = '';
  if (atr && atr > 0) {
    // 1. Base duration to reach average target (T1 + T2)/2
    const targetDistance = Math.abs(((t1 + t2) / 2) - p);
    let baseBars = targetDistance / atr;

    // 2. Regime adjustment (Trendler dalgalıdır ve düzeltme ile ilerler, Range ise hızlı çarpar döner)
    if (typeof regimeIsTrend !== 'undefined' && regimeIsTrend) baseBars *= 1.4;
    else if (typeof regimeIsTrend !== 'undefined' && !regimeIsTrend && typeof regimeIsVolatile !== 'undefined' && !regimeIsVolatile) baseBars *= 0.8; // Range
    if (typeof regimeIsVolatile !== 'undefined' && regimeIsVolatile) baseBars *= 0.6; // Hizli hareket

    // 3. Momentum acceleration
    const rocVal = ind.lastROC10 || 0;
    if (rocVal > 10 || rocVal < -10) baseBars *= 0.7; // Aşırı momentum hedefe varışı hızlandırır

    // 4. Setup Type Context Base (Yapısal kurulumlar uzun, tepkiler kısa sürer)
    const isStructural = bullishTypes.has('wyckoff_spring') || bullishTypes.has('wyckoff_markup') || 
                         bearishTypes.has('wyckoff_distribution') || bullishTypes.has('golden_cross') || 
                         ind.wyckoffPhase === 'accumulation';
    
    const isTrendFollow = bullishTypes.has('supertrend') || bearishTypes.has('supertrend') ||
                          bullishTypes.has('ichimoku') || bearishTypes.has('ichimoku') ||
                          bullishTypes.has('macd') || bearishTypes.has('macd') ||
                          bullishTypes.has('trix') || bearishTypes.has('trix');

    const isMeanReversion = bullishTypes.has('rsi') || bearishTypes.has('rsi') || 
                            bullishTypes.has('williams') || bearishTypes.has('williams') ||
                            bullishTypes.has('bollinger') || bearishTypes.has('bollinger');

    // Structural -> taban 15 gun
    // TrendFollow -> taban 7 gun
    // MeanReversion -> taban 2 gun
    let contextualBars = baseBars;
    if (isStructural) contextualBars = Math.max(baseBars, 15);
    else if (isTrendFollow) contextualBars = Math.max(baseBars, 7);
    else if (isMeanReversion) contextualBars = Math.min(baseBars, 5);

    holdBars = Math.max(1, Math.ceil(contextualBars));

    // Yalnızca gerçekten yüksek hacimli ve kısa hedefli işlemleri "Gün İçi" olarak etiketle
    const isRealIntraday = holdBars <= 1 && ind.volRatio > 2.0 && ind.dayHighLowRange > 0.3;

    if (isRealIntraday) holdText = 'Gün İçi (Scalp / T-0)';
    else if (holdBars <= 3) holdText = '1-3 gün (Kısa Vade Tepki)';
    else if (holdBars <= 8) holdText = '3-8 gün (Swing Trade)';
    else if (holdBars <= 21) holdText = '1-3 hafta (Orta Vade Trend)';
    else if (holdBars <= 45) holdText = '3-6 hafta (Yapısal Formasyon)';
    else holdText = '6+ hafta (Orta-Uzun Vade)';
  }

  // Long-term investment perspective
  // Evaluate whether this stock is suitable for 6-12 month or 1-3 year holding
  let longTermView = null;
  // Use MA200 if available, else fallback to MA100 or MA50
  const longMA = ind.lastMA200 || ind.lastMA100 || ind.lastMA50;
  const longMAArr = ind.lastMA200 ? ind.ma200 : ind.lastMA100 ? ind.ma100 : ind.ma50;
  if (prices && prices.length >= 50 && longMA) {
    const aboveLongMA = p > longMA;
    const slopeIdx = Math.min(20, prices.length - 1);
    const maSlope = longMAArr[prices.length - 1] && longMAArr[prices.length - 1 - slopeIdx]
      ? (longMAArr[prices.length - 1] - longMAArr[prices.length - 1 - slopeIdx]) / longMAArr[prices.length - 1 - slopeIdx] * 100
      : 0;
    const strongUptrend = aboveLongMA && maSlope > 1;
    const accumPhase = ind.wyckoffPhase === 'accumulation' || ind.wyckoffPhase === 'markup';
    const smartMoneyBuying = ind.obvTrend === 'accumulation' || (ind.cmf != null && ind.cmf > 0.05);
    const bullishFactors = [
      aboveLongMA,
      maSlope > 0.5,
      accumPhase,
      smartMoneyBuying,
      ind.lastRSI != null && ind.lastRSI > 40 && ind.lastRSI < 70,
      ind.adx != null && ind.adx > 20 && ind.plusDI > ind.minusDI,
    ].filter(Boolean).length;

    if (bullishFactors >= 5) {
      longTermView = { recommendation: 'UZUN VADELI AL', color: 'var(--green)', horizon: '1-3 yil',
        reason: 'Guclu yukselis trendi + akilli para birikimi + teknik uyum. Uzun vadeli portfoye uygun.' };
    } else if (bullishFactors >= 4 && strongUptrend) {
      longTermView = { recommendation: 'UZUN VADELI BIRIKIMDE TUT', color: 'var(--cyan)', horizon: '6-12 ay',
        reason: 'MA-200 yukselis trendinde. Dusmelerde kademe kademe birikim stratejisi uygulanabilir.' };
    } else if (bullishFactors >= 3) {
      longTermView = { recommendation: 'IZLE', color: 'var(--yellow)', horizon: '3-6 ay',
        reason: 'Karisik sinyaller. Birikime baslamadan once trend netlesmeyi bekle.' };
    } else if (bullishFactors <= 1) {
      longTermView = { recommendation: 'UZUN VADELI UZAK DUR', color: 'var(--red)', horizon: '-',
        reason: 'Uzun vadeli hareketli ortalama altinda, dusus trendinde. Uzun vadeli pozisyon icin uygun degil.' };
    } else {
      longTermView = { recommendation: 'NOTR', color: 'var(--t2)', horizon: '-',
        reason: 'Yeterli yukselis sinyali yok. Bekle.' };
    }
  }

  // Intraday metrics
  let dailyRange = 0, avgDailyPct = 0;
  if (prices && prices.length >= 5) {
    const ranges = [];
    for (let di = Math.max(0, prices.length - 10); di < prices.length; di++) {
      const cl = prices[di].close;
      if (cl > 0) ranges.push((prices[di].high - prices[di].low) / cl * 100);
    }
    avgDailyPct = ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
    dailyRange = avgDailyPct;
  }
  const intradayTarget = p * (1 + avgDailyPct * 0.4 / 100);
  const intradayStop = p * (1 - avgDailyPct * 0.25 / 100);
  const intradayRR = safeDivide(intradayTarget - p, p - intradayStop, 0);

  const baseSig = {
    signal, cls, score: score100, rawScore, conf: conf.toFixed(0), reasons,
    stop, t1, t2, t3, rr, rr2, rrQuality, entry, atr, fibs, pivots,
    holdBars, holdText, longTermView, dailyRange, intradayTarget, intradayStop, intradayRR,
    calibration: calibrationInfo,
    ma20pct: ind.lastMA20 ? (p - ind.lastMA20) / ind.lastMA20 * 100 : null,
    ma50pct: ind.lastMA50 ? (p - ind.lastMA50) / ind.lastMA50 * 100 : null,
    bollPct: ind.lastBU && ind.lastBL && ind.lastBU !== ind.lastBL ? (p - ind.lastBL) / (ind.lastBU - ind.lastBL) * 100 : null,
    indicators: ind
  };

  // ── WALL STREET META ANALYSIS ──
  // Rejim + veri kalitesi + likidite + edge skoru + kurulum notu
  try {
    const meta = runWallStreetAnalysis(prices, ind, baseSig);
    baseSig.regime = meta.regime;
    baseSig.dataQuality = meta.quality;
    baseSig.liquidity = meta.liquidity;
    baseSig.edge = meta.edge.edge;
    baseSig.setupGrade = meta.edge.grade;
    baseSig.edgeReasons = meta.edge.reasons;

    // Regime-adjusted confidence
    if (meta.edge.edge < 35 && baseSig.cls !== 'neutral') {
      // Very weak edge — downgrade to TUT
      baseSig.meta = { downgraded: true, originalCls: baseSig.cls };
      baseSig.cls = 'neutral';
      baseSig.signal = 'TUT';
    }

    // Append meta-reasons so downstream sees the Wall Street logic
    for (const r of meta.edge.reasons) {
      baseSig.reasons.push({ t: 'WS: ' + r, c: 'neutral' });
    }
  } catch (err) {
    baseSig.regime = { regime: 'UNKNOWN', label: '-' };
    baseSig.setupGrade = 'C';
    baseSig.edge = 50;
  }

  // ── RELIABILITY FEEDBACK (cls-level) ──
  // useSignalTracker, her 10 dakikalik fiyat kontrol dongusunden sonra
  // kazanma oranini buraya push eder. Sistem surekli kaybediyorsa guveni duser;
  // surekli kazaniyorsa guveni hafifce artar. Min 15 ornek sart.
  {
    const hint = _reliabilityHints[baseSig.cls];
    if (hint && hint.sampleSize >= 15) {
      const currentConf = parseFloat(baseSig.conf) || 50;
      if (hint.winRate < 0.35) {
        baseSig.conf = String(Math.max(10, Math.round(currentConf * 0.80)));
        baseSig.reasons.push({
          t: `GUVENILIRLIK UYARISI: Son ${hint.sampleSize} ${baseSig.cls.toUpperCase()} sinyalinde win rate %${(hint.winRate * 100).toFixed(0)} — guven %20 azaltildi`,
          c: 'neutral',
        });
      } else if (hint.winRate > 0.65 && hint.sampleSize >= 20) {
        baseSig.conf = String(Math.min(95, Math.round(currentConf * 1.10)));
        baseSig.reasons.push({
          t: `GUVENILIRLIK BONUS: ${hint.sampleSize} ornekle %${(hint.winRate * 100).toFixed(0)} win rate — guven %10 arttirildi`,
          c: 'bullish',
        });
      }
    }
  }

  // ── SIGNAL ATTRIBUTION FEEDBACK (per-signal-type) ──
  // Her fired sinyal tipi icin gecmis win-rate'i hesapla.
  // Yeterli ornegi olan (>=8) ve cok basarili/basarisiz tipleri
  // score100'e kucuk bir delta olarak yansit (±2 max).
  {
    const stHints = _reliabilityHints.bySignalType;
    if (stHints) {
      try {
        const firedNow = extractFiredSignals(ind, prices);
        let totalDelta = 0, counted = 0;
        for (const sigType of firedNow) {
          const sh = stHints[sigType];
          if (!sh || sh.sampleSize < 8) continue;
          // winRate 0-1 arasi; 0.5 etrafinda merkezle, [-1,+1] araligina scale et
          const delta = (sh.winRate - 0.5) * 2; // -1..+1
          totalDelta += delta;
          counted++;
        }
        if (counted > 0) {
          const avgDelta = totalDelta / counted;
          const scoreBump = Math.max(-2, Math.min(2, avgDelta * 2));
          if (Math.abs(scoreBump) >= 0.3) {
            baseSig.score = Math.max(0, Math.min(100, baseSig.score + scoreBump));
            baseSig.attributionDelta = Math.round(scoreBump * 10) / 10;
            baseSig.reasons.push({
              t: `SINYAL ATRIBU: ${counted} tip gecmisi (${scoreBump > 0 ? '+' : ''}${scoreBump.toFixed(1)} skor)`,
              c: scoreBump > 0 ? 'bullish' : 'neutral',
            });
          }
        }
        baseSig.firedSignals = firedNow;
      } catch {}
    } else {
      // bySignalType henuz yok — sadece firedSignals'i ekle, skoru degistirme
      try { baseSig.firedSignals = extractFiredSignals(ind, prices); } catch {}
    }
  }

  return baseSig;
}

const SIGNAL_TYPE_STATS = {
  'GUCLU_AL': { winRate: 0.72, avgRR: 2.8 },
  'AL': { winRate: 0.58, avgRR: 2.0 },
  'SAT': { winRate: 0.55, avgRR: 1.8 },
  'GUCLU_SAT': { winRate: 0.65, avgRR: 2.5 },
  'default': { winRate: 0.50, avgRR: 1.5 }
};

function estimateSignalPerformance(signalType) {
  return SIGNAL_TYPE_STATS[signalType] || SIGNAL_TYPE_STATS['default'];
}

function calcKellyFraction(winRate, avgRR, fraction = 0.25) {
  if (winRate <= 0 || avgRR <= 0) return 0;
  const kelly = (winRate * avgRR - (1 - winRate)) / avgRR;
  if (kelly <= 0) return 0;
  return Math.min(kelly * fraction, 0.04);
}

export function calcPosition(accountSize, riskPct = 2, entry, stop, options = {}) {
  const { signalType = 'default', confidence = 50, useKelly = false } = options;
  
  const riskPerShare = Math.abs(entry - stop);
  if (riskPerShare <= 0) return { shares: 0, cost: 0, maxLoss: 0, method: 'fixed' };
  
  const maxRiskTL = accountSize * (riskPct / 100);
  let shares = Math.floor(maxRiskTL / riskPerShare);
  
  // Kelly Criterion adjustment for high confidence signals.
  // Prefer the REAL measured win rate (from useSignalTracker / forward journal)
  // over static per-type estimates — sizing should track demonstrated edge,
  // not assumed edge. Falls back to the static table until enough samples exist.
  let kellySource = null;
  if (useKelly && confidence >= 70) {
    const staticStats = estimateSignalPerformance(signalType);
    const cls = options.cls || 'buy';
    const hint = _reliabilityHints[cls];
    const useMeasured = hint && hint.sampleSize >= 20 && hint.winRate > 0;
    const winRate = useMeasured ? hint.winRate : staticStats.winRate;
    // Use the signal's own R/R as the payoff when provided; else the static avg.
    const avgRR = (options.rr && options.rr > 0) ? options.rr : staticStats.avgRR;
    const kellyFrac = calcKellyFraction(winRate, avgRR, 0.25);
    if (kellyFrac > 0) {
      kellySource = useMeasured ? 'measured' : 'estimated';
      const kellyShares = Math.floor(accountSize * kellyFrac / riskPerShare);
      if (kellyShares > shares) {
        shares = kellyShares;
      }
    }
  }
  
  // Confidence bonus: higher confidence = larger position (up to 25% more)
  if (confidence >= 80) {
    const bonus = Math.floor(shares * 0.25);
    shares += bonus;
  } else if (confidence >= 70) {
    const bonus = Math.floor(shares * 0.15);
    shares += bonus;
  }
  
  // Signal type differentiation
  if (signalType === 'GUCLU_AL') {
    const bonus = Math.floor(shares * 0.20);
    shares += bonus;
  } else if (signalType === 'AL') {
    const bonus = Math.floor(shares * 0.10);
    shares += bonus;
  }

  // ── GRADE-BASED LOT SCALING ──
  // A-grade: full conviction, B+: 85%, B: 75%, C: 50%, D: skip entirely.
  // Never open full size on low-edge setups — grade already embeds edge quality.
  if (options.setupGrade) {
    const GRADE_MULT = { 'A': 1.0, 'B+': 0.85, 'B': 0.75, 'C': 0.5, 'D': 0.0 };
    const mult = GRADE_MULT[options.setupGrade];
    if (mult !== undefined) {
      shares = Math.floor(shares * mult);
      if (shares <= 0) {
        return { shares: 0, cost: 0, maxLoss: 0, riskPct: 0, costPct: 0,
                 method: 'grade_blocked', setupGrade: options.setupGrade };
      }
    }
  }

  // Cap by available cash
  const maxByBudget = Math.floor(accountSize / entry);
  if (shares > maxByBudget) shares = maxByBudget;
  
  const cost = shares * entry;
  const maxLoss = shares * riskPerShare;
  const usedRiskPct = (maxLoss / accountSize) * 100;
  
  return { 
    shares, 
    cost, 
    maxLoss, 
    riskPct: usedRiskPct,
    costPct: cost / accountSize * 100,
    method: kellySource ? `kelly_${kellySource}` : 'fixed',
    kellySource,
  };
}
