// Moving Average
export function calcMA(closes, period) {
  const ma = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    ma[i] = sum / period;
  }
  return ma;
}

// EMA
export function calcEMA(data, period) {
  const ema = new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  let start = -1;
  for (let i = 0; i < data.length; i++) { if (data[i] != null) { start = i; break; } }
  if (start < 0 || data.length - start < period) return ema;
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += data[i];
  ema[start + period - 1] = sum / period;
  for (let i = start + period; i < data.length; i++) ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

// RSI
export function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Stochastic RSI — more sensitive than RSI for timing entries/exits
export function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsi = calcRSI(closes, rsiPeriod);
  const stochK = new Array(closes.length).fill(null);
  const stochD = new Array(closes.length).fill(null);
  // %K = (RSI - RSI_Low) / (RSI_High - RSI_Low) * 100
  for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
    let rsiHigh = -Infinity, rsiLow = Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsi[j] != null) { rsiHigh = Math.max(rsiHigh, rsi[j]); rsiLow = Math.min(rsiLow, rsi[j]); }
    }
    stochK[i] = rsiHigh !== rsiLow ? (rsi[i] - rsiLow) / (rsiHigh - rsiLow) * 100 : 50;
  }
  // Smooth %K with SMA
  const smoothK = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (stochK[i] == null) continue;
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - kSmooth + 1); j <= i; j++) { if (stochK[j] != null) { sum += stochK[j]; cnt++; } }
    if (cnt >= kSmooth) smoothK[i] = sum / cnt;
  }
  // %D = SMA of smoothed %K
  for (let i = 0; i < closes.length; i++) {
    if (smoothK[i] == null) continue;
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - dSmooth + 1); j <= i; j++) { if (smoothK[j] != null) { sum += smoothK[j]; cnt++; } }
    if (cnt >= dSmooth) stochD[i] = sum / cnt;
  }
  return { k: smoothK, d: stochD };
}

// MACD
export function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macd = closes.map((_, i) => emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
  const macdVals = macd.filter(v => v != null);
  const signalRaw = calcEMA(macdVals, sig);
  const signal = new Array(closes.length).fill(null);
  let idx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macd[i] != null) { signal[i] = signalRaw[idx] != null ? signalRaw[idx] : null; idx++; }
  }
  const histogram = closes.map((_, i) => macd[i] != null && signal[i] != null ? macd[i] - signal[i] : null);
  return { macd, signal, histogram };
}

// Bollinger Bands
export function calcBollinger(closes, period = 20, mult = 2) {
  const middle = calcMA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += Math.pow(closes[j] - middle[i], 2);
    const std = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + mult * std;
    lower[i] = middle[i] - mult * std;
  }
  return { upper, middle, lower };
}

// Support & Resistance
export function calcSR(prices) {
  const levels = [];
  const n = prices.length;
  if (n < 10) return levels;
  for (let i = 2; i < n - 2; i++) {
    if (prices[i].high > prices[i-1].high && prices[i].high > prices[i-2].high && prices[i].high > prices[i+1].high && prices[i].high > prices[i+2].high)
      levels.push({ type: 'resistance', price: prices[i].high, idx: i });
    if (prices[i].low < prices[i-1].low && prices[i].low < prices[i-2].low && prices[i].low < prices[i+1].low && prices[i].low < prices[i+2].low)
      levels.push({ type: 'support', price: prices[i].low, idx: i });
  }
  levels.sort((a, b) => a.price - b.price);
  const clustered = [];
  for (const level of levels) {
    const found = clustered.find(c => Math.abs(c.price - level.price) / level.price < 0.015);
    if (found) { found.count++; found.price = (found.price + level.price) / 2; }
    else clustered.push({ ...level, count: 1 });
  }
  clustered.sort((a, b) => b.count - a.count);
  return clustered.slice(0, 8);
}

// MFI
export function calcMFI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let mfPos = 0, mfNeg = 0;
  for (let i = Math.max(1, prices.length - period); i < prices.length; i++) {
    const tp = (prices[i].high + prices[i].low + prices[i].close) / 3;
    const prevTp = (prices[i-1].high + prices[i-1].low + prices[i-1].close) / 3;
    const mf = tp * prices[i].volume;
    if (tp > prevTp) mfPos += mf; else mfNeg += mf;
  }
  if (mfNeg === 0) return 100;
  return 100 - 100 / (1 + mfPos / mfNeg);
}

// OBV
export function calcOBV(prices) {
  const obv = [0];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i].close > prices[i-1].close) obv.push(obv[i-1] + prices[i].volume);
    else if (prices[i].close < prices[i-1].close) obv.push(obv[i-1] - prices[i].volume);
    else obv.push(obv[i-1]);
  }
  return obv;
}

export function calcOBVTrend(obv, closes, lookback = 20) {
  if (obv.length < lookback) return 'neutral';
  const obvStart = obv[obv.length - lookback], obvEnd = obv[obv.length - 1];
  const priceStart = closes[closes.length - lookback], priceEnd = closes[closes.length - 1];
  const obvChg = (obvEnd - obvStart) / (Math.abs(obvStart) || 1);
  const priceChg = priceStart !== 0 ? (priceEnd - priceStart) / priceStart : 0;
  if (obvChg > 0.05 && priceChg < 0) return 'accumulation';
  if (obvChg < -0.05 && priceChg > 0) return 'distribution';
  if (obvChg > 0.05 && priceChg > 0) return 'confirmation';
  return 'neutral';
}

// A/D Line
export function calcADL(prices) {
  const adl = [0];
  for (let i = 0; i < prices.length; i++) {
    const { high: h, low: l, close: c, volume: v } = prices[i];
    const mfm = h === l ? 0 : ((c - l) - (h - c)) / (h - l);
    adl.push((adl[adl.length - 1] || 0) + mfm * v);
  }
  return adl;
}

// VWAP
export function calcVWAP(prices, lookback = 20) {
  const start = Math.max(0, prices.length - lookback);
  let cumVol = 0, cumTP = 0;
  for (let i = start; i < prices.length; i++) {
    const tp = (prices[i].high + prices[i].low + prices[i].close) / 3;
    cumVol += prices[i].volume; cumTP += tp * prices[i].volume;
  }
  return cumVol > 0 ? cumTP / cumVol : null;
}

// ATR
export function calcATR(prices, period = 14) {
  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    const { high: hi, low: lo } = prices[i];
    const pc = prices[i-1].close;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  const atr = [];
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period - 1) {
      if (i === period - 1) atr.push(sum / period);
      else { atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period); sum -= trs[i - period + 1]; }
    }
  }
  return atr.length > 0 ? atr[atr.length - 1] : null;
}

// Fibonacci
export function calcFibonacci(prices) {
  const n = prices.length;
  const lookback = Math.min(60, n);
  let hi = -Infinity, lo = Infinity, hiIdx = 0, loIdx = 0;
  for (let i = n - lookback; i < n; i++) {
    if (prices[i].high > hi) { hi = prices[i].high; hiIdx = i; }
    if (prices[i].low < lo) { lo = prices[i].low; loIdx = i; }
  }
  const uptrend = loIdx < hiIdx;
  const diff = hi - lo;
  if (diff <= 0) return null;
  const fibs = { trend: uptrend ? 'up' : 'down', high: hi, low: lo };
  if (uptrend) Object.assign(fibs, { '0.0': hi, '0.236': hi-diff*0.236, '0.382': hi-diff*0.382, '0.5': hi-diff*0.5, '0.618': hi-diff*0.618, '1.0': lo, '1.272': hi+diff*0.272, '1.618': hi+diff*0.618 });
  else Object.assign(fibs, { '0.0': lo, '0.236': lo+diff*0.236, '0.382': lo+diff*0.382, '0.5': lo+diff*0.5, '0.618': lo+diff*0.618, '1.0': hi, '1.272': lo-diff*0.272, '1.618': lo-diff*0.618 });
  return fibs;
}

// Pivots
export function calcPivots(prices) {
  const last = prices[prices.length - 1];
  const { high: h, low: l, close: c } = last;
  const pp = (h + l + c) / 3;
  return { pp, r1: 2*pp-l, r2: pp+(h-l), r3: h+2*(pp-l), s1: 2*pp-h, s2: pp-(h-l), s3: l-2*(h-pp) };
}

// Chaikin Money Flow
export function calcCMF(prices, period = 20) {
  if (prices.length < period) return null;
  let sumMFV = 0, sumVol = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const { high: h, low: l, close: c, volume: v } = prices[i];
    const mfm = h === l ? 0 : ((c - l) - (h - c)) / (h - l);
    sumMFV += mfm * v;
    sumVol += v;
  }
  return sumVol > 0 ? sumMFV / sumVol : 0;
}

// ADX / +DI / -DI (Wilder's method)
export function calcADX(prices, period = 14) {
  const n = prices.length;
  if (n < period + 1) return { adx: null, plusDI: null, minusDI: null, adxArray: [] };
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const h = prices[i].high, l = prices[i].low, pc = prices[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - prices[i - 1].high;
    const downMove = prices[i - 1].low - l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Wilder smoothing
  let sTR = 0, sPDM = 0, sMDM = 0;
  for (let i = 0; i < period; i++) { sTR += tr[i]; sPDM += plusDM[i]; sMDM += minusDM[i]; }
  const diPlus = [], diMinus = [], dx = [];
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i - 1];
      sPDM = sPDM - sPDM / period + plusDM[i - 1];
      sMDM = sMDM - sMDM / period + minusDM[i - 1];
    }
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    diPlus.push(pdi); diMinus.push(mdi);
    const sum = pdi + mdi;
    dx.push(sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0);
  }
  // ADX = smoothed DX
  const adxArr = [];
  if (dx.length >= period) {
    let adxSum = 0;
    for (let i = 0; i < period; i++) adxSum += dx[i];
    adxArr.push(adxSum / period);
    for (let i = period; i < dx.length; i++) {
      adxArr.push((adxArr[adxArr.length - 1] * (period - 1) + dx[i]) / period);
    }
  }
  const lastADX = adxArr.length > 0 ? adxArr[adxArr.length - 1] : null;
  const lastPDI = diPlus.length > 0 ? diPlus[diPlus.length - 1] : null;
  const lastMDI = diMinus.length > 0 ? diMinus[diMinus.length - 1] : null;
  return { adx: lastADX, plusDI: lastPDI, minusDI: lastMDI, adxArray: adxArr };
}

// Keltner Channels (for TTM Squeeze)
export function calcKeltner(prices, emaPeriod = 20, atrPeriod = 14, mult = 1.5) {
  const closes = prices.map(p => p.close);
  const ema = calcEMA(closes, emaPeriod);
  const n = prices.length;
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  // rolling ATR
  const trs = [];
  for (let i = 1; i < n; i++) {
    const h = prices[i].high, l = prices[i].low, pc = prices[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  for (let i = 0; i < n; i++) {
    if (ema[i] == null || i < atrPeriod) continue;
    let atrSum = 0;
    for (let j = i - atrPeriod; j < i; j++) { if (trs[j] != null) atrSum += trs[j]; }
    const atr = atrSum / atrPeriod;
    upper[i] = ema[i] + mult * atr;
    lower[i] = ema[i] - mult * atr;
  }
  return { upper, middle: ema, lower };
}

// TTM Squeeze: Bollinger inside Keltner = squeeze on
export function calcTTMSqueeze(prices) {
  const boll = calcBollinger(prices.map(p => p.close), 20, 2);
  const kelt = calcKeltner(prices, 20, 14, 1.5);
  const n = prices.length;
  let squeezeOn = false, squeezeCount = 0;
  for (let i = Math.max(0, n - 10); i < n; i++) {
    if (boll.upper[i] != null && kelt.upper[i] != null) {
      if (boll.upper[i] < kelt.upper[i] && boll.lower[i] > kelt.lower[i]) {
        squeezeOn = true; squeezeCount++;
      }
    }
  }
  // Momentum direction (linear regression of close - midline)
  let momentum = 0;
  if (n >= 3) {
    const last = prices[n - 1].close - (boll.middle[n - 1] || prices[n - 1].close);
    const prev = prices[n - 2].close - (boll.middle[n - 2] || prices[n - 2].close);
    momentum = last - prev; // positive = increasing momentum
  }
  return { squeezeOn, squeezeCount, momentum, firing: squeezeCount >= 3 };
}

// Chandelier Exit (trailing stop)
export function calcChandelierExit(prices, period = 22, mult = 3) {
  const n = prices.length;
  if (n < period + 1) return { longStop: null, shortStop: null };
  // Highest high in lookback
  let hh = -Infinity;
  for (let i = n - period; i < n; i++) { if (prices[i].high > hh) hh = prices[i].high; }
  // Lowest low in lookback
  let ll = Infinity;
  for (let i = n - period; i < n; i++) { if (prices[i].low < ll) ll = prices[i].low; }
  // ATR
  const trs = [];
  for (let i = Math.max(1, n - period - 1); i < n; i++) {
    const h = prices[i].high, l = prices[i].low, pc = prices[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = 0;
  const atrLen = Math.min(period, trs.length);
  for (let i = trs.length - atrLen; i < trs.length; i++) atr += trs[i];
  atr = atrLen > 0 ? atr / atrLen : 0;
  return { longStop: hh - mult * atr, shortStop: ll + mult * atr, atr };
}

// Wyckoff Phase Detection
export function detectWyckoffPhase(prices, ind) {
  if (prices.length < 30) return 'unknown';
  const n = prices.length;
  const recentPriceChg = prices[n-20].close !== 0 ? (prices[n-1].close - prices[n-20].close) / prices[n-20].close * 100 : 0;
  const volTrend = ind.volRatio;

  if (ind.obvTrend === 'accumulation' && recentPriceChg < 2 && recentPriceChg > -5) return 'accumulation';
  if (ind.obvTrend === 'accumulation' && recentPriceChg > 2 && volTrend > 1.3) return 'markup';
  if (ind.obvTrend === 'distribution' && recentPriceChg > -2 && recentPriceChg < 5) return 'distribution';
  if (ind.obvTrend === 'distribution' && recentPriceChg < -2 && volTrend > 1.3) return 'markdown';
  if (recentPriceChg > 5 && volTrend > 1.5) return 'markup';
  if (recentPriceChg < -5 && volTrend > 1.5) return 'markdown';
  return 'ranging';
}

// Candlestick Pattern Recognition (for AI "Visual" Sensing)
export function calcCandlestickPatterns(prices) {
  const n = prices.length;
  if (n < 5) return [];
  const patterns = [];
  const c = prices[n - 1], p = prices[n - 2];
  
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  
  const isGreen = c.close > c.open;
  const isRed = c.close < c.open;

  // 1. Hammer (Bottom reversal)
  if (lowerWick > body * 2 && upperWick < body * 0.5) {
    patterns.push({ name: 'Hammer', type: 'bullish', desc: 'Güçlü alt iğne — alım baskısı' });
  }
  // 2. Shooting Star (Top reversal)
  if (upperWick > body * 2 && lowerWick < body * 0.5) {
    patterns.push({ name: 'Shooting Star', type: 'bearish', desc: 'Güçlü üst iğne — satış baskısı' });
  }
  // 3. Bullish Engulfing
  if (isGreen && p.close < p.open && c.close > p.open && c.open < p.close) {
    patterns.push({ name: 'Bullish Engulfing', type: 'bullish', desc: 'Yutucu Boğa — önceki barı yuttu' });
  }
  // 4. Bearish Engulfing
  if (isRed && p.close > p.open && c.close < p.open && c.open > p.close) {
    patterns.push({ name: 'Bearish Engulfing', type: 'bearish', desc: 'Yutucu Ayı — önceki barı yuttu' });
  }
  // 5. Marubozu (Strong momentum)
  if (body > range * 0.9 && body > 1) {
    patterns.push({ name: isGreen ? 'Bullish Marubozu' : 'Bearish Marubozu', type: isGreen ? 'bullish' : 'bearish', desc: 'Gövdesi dolu güçlü mum' });
  }
  // 6. Doji (Indecision)
  if (body < range * 0.1) {
    patterns.push({ name: 'Doji', type: 'neutral', desc: 'Kararsızlık mumu' });
  }

  return patterns;
}

// OBV Divergence Detection
export function detectOBVDivergence(prices, obv, lookback = 15) {
  // Compare price slope vs OBV slope over last N candles
  // Returns: 'bullish_div' (price down, OBV up), 'bearish_div' (price up, OBV down), 'hidden_bullish' (price higher low, OBV lower low), 'hidden_bearish', or null
  const n = prices.length;
  if (n < lookback + 5 || obv.length < lookback + 5) return null;

  // Find recent swing lows and highs in both price and OBV
  // Price slope
  const priceStart = prices[n - lookback].close;
  const priceEnd = prices[n - 1].close;
  const priceSlope = (priceEnd - priceStart) / priceStart;

  // OBV slope
  const obvStart = obv[obv.length - lookback];
  const obvEnd = obv[obv.length - 1];
  const obvSlope = obvStart !== 0 ? (obvEnd - obvStart) / Math.abs(obvStart) : 0;

  // Find swing lows in last lookback period
  let priceLow1 = Infinity, priceLow2 = Infinity, obvAtLow1 = 0, obvAtLow2 = 0;
  let priceHigh1 = -Infinity, priceHigh2 = -Infinity, obvAtHigh1 = 0, obvAtHigh2 = 0;

  const half = Math.floor(lookback / 2);
  // First half lows/highs
  for (let i = n - lookback; i < n - half; i++) {
    if (prices[i].low < priceLow1) { priceLow1 = prices[i].low; obvAtLow1 = obv[i]; }
    if (prices[i].high > priceHigh1) { priceHigh1 = prices[i].high; obvAtHigh1 = obv[i]; }
  }
  // Second half lows/highs
  for (let i = n - half; i < n; i++) {
    if (prices[i].low < priceLow2) { priceLow2 = prices[i].low; obvAtLow2 = obv[i]; }
    if (prices[i].high > priceHigh2) { priceHigh2 = prices[i].high; obvAtHigh2 = obv[i]; }
  }

  // Regular Bullish Divergence: price makes lower low, OBV makes higher low
  if (priceLow2 < priceLow1 * 0.99 && obvAtLow2 > obvAtLow1 * 1.02) return 'bullish_div';

  // Regular Bearish Divergence: price makes higher high, OBV makes lower high
  if (priceHigh2 > priceHigh1 * 1.01 && obvAtHigh2 < obvAtHigh1 * 0.98) return 'bearish_div';

  // Hidden Bullish: price higher low, OBV lower low (trend continuation)
  if (priceLow2 > priceLow1 * 1.01 && obvAtLow2 < obvAtLow1 * 0.98) return 'hidden_bullish';

  // Hidden Bearish: price lower high, OBV higher high
  if (priceHigh2 < priceHigh1 * 0.99 && obvAtHigh2 > obvAtHigh1 * 1.02) return 'hidden_bearish';

  // Simple slope divergence
  if (priceSlope < -0.02 && obvSlope > 0.05) return 'bullish_div';
  if (priceSlope > 0.02 && obvSlope < -0.05) return 'bearish_div';

  return null;
}

// Wyckoff Spring Detection
export function detectWyckoffSpring(prices, sr) {
  // Spring: price briefly breaks below support, then reverses back above it
  // UTAD: price briefly breaks above resistance, then reverses back below it
  const n = prices.length;
  if (n < 10 || !sr || sr.length === 0) return null;

  const lastPrice = prices[n - 1].close;
  const prevLow = prices[n - 2].low;
  const prevPrevLow = n > 2 ? prices[n - 3].low : prevLow;

  // Find nearest support
  const supports = sr.filter(s => s.type === 'support' && s.price < lastPrice * 1.03);
  const resistances = sr.filter(s => s.type === 'resistance' && s.price > lastPrice * 0.97);

  // Spring: yesterday's low went below support but today closed above
  for (const sup of supports) {
    const breakBelow = prevLow < sup.price * 0.995 || prevPrevLow < sup.price * 0.995;
    const recoveredAbove = lastPrice > sup.price * 1.005;
    if (breakBelow && recoveredAbove) {
      return { type: 'spring', level: sup.price, desc: `Wyckoff Spring: ${sup.price.toFixed(2)} TL destegin altina sarkip geri dondu` };
    }
  }

  // UTAD (Up-Thrust After Distribution): briefly broke resistance, then fell back
  for (const res of resistances) {
    const n2High = prices[n - 2].high;
    const n3High = n > 2 ? prices[n - 3].high : n2High;
    const brokeAbove = n2High > res.price * 1.005 || n3High > res.price * 1.005;
    const fellBack = lastPrice < res.price * 0.995;
    if (brokeAbove && fellBack) {
      return { type: 'utad', level: res.price, desc: `Wyckoff UTAD: ${res.price.toFixed(2)} TL direncin uzerine cikip geri dondu` };
    }
  }

  return null;
}

// Volume Climax Detection
export function detectVolumeClimax(prices, lookback = 20) {
  const n = prices.length;
  if (n < lookback + 2) return null;

  // Calculate average volume
  let avgVol = 0;
  for (let i = n - lookback - 1; i < n - 1; i++) avgVol += prices[i].volume;
  avgVol /= lookback;

  const lastVol = prices[n - 1].volume;
  const lastChange = (prices[n - 1].close - prices[n - 2].close) / prices[n - 2].close * 100;
  const volMultiple = avgVol > 0 ? lastVol / avgVol : 1;

  // Volume climax: 3x+ volume with extreme price move
  if (volMultiple >= 3 && Math.abs(lastChange) > 3) {
    return {
      type: lastChange > 0 ? 'buying_climax' : 'selling_climax',
      volMultiple: volMultiple,
      priceChange: lastChange,
      desc: lastChange > 0
        ? `Alim klimaksi: ${volMultiple.toFixed(1)}x hacim ile +%${lastChange.toFixed(1)} — potansiyel geri cekilme`
        : `Satim klimaksi: ${volMultiple.toFixed(1)}x hacim ile %${lastChange.toFixed(1)} — potansiyel dip firsat`
    };
  }

  // Strong volume divergence from price (exhaustion)
  if (volMultiple >= 2.5 && Math.abs(lastChange) < 0.5) {
    return {
      type: 'volume_exhaustion', volMultiple, priceChange: lastChange,
      desc: `Hacim tukenmesi: ${volMultiple.toFixed(1)}x hacim ama fiyat degismedi — yon degisimi olabilir`
    };
  }

  return null;
}

// RSI Divergence Detection
export function detectRSIDivergence(prices, rsi, lookback = 20) {
  const n = prices.length;
  if (n < lookback + 5 || rsi.length < lookback + 5) return null;

  const half = Math.floor(lookback / 2);

  // Find swing lows/highs in price and RSI
  let pLow1 = Infinity, pLow2 = Infinity, rsiAtPLow1 = 50, rsiAtPLow2 = 50;
  let pHigh1 = -Infinity, pHigh2 = -Infinity, rsiAtPHigh1 = 50, rsiAtPHigh2 = 50;

  for (let i = n - lookback; i < n - half; i++) {
    if (prices[i].low < pLow1) { pLow1 = prices[i].low; rsiAtPLow1 = rsi[i] || 50; }
    if (prices[i].high > pHigh1) { pHigh1 = prices[i].high; rsiAtPHigh1 = rsi[i] || 50; }
  }
  for (let i = n - half; i < n; i++) {
    if (prices[i].low < pLow2) { pLow2 = prices[i].low; rsiAtPLow2 = rsi[i] || 50; }
    if (prices[i].high > pHigh2) { pHigh2 = prices[i].high; rsiAtPHigh2 = rsi[i] || 50; }
  }

  // Bullish RSI Divergence: lower low in price, higher low in RSI
  if (pLow2 < pLow1 * 0.99 && rsiAtPLow2 > rsiAtPLow1 + 3) return 'bullish';

  // Bearish RSI Divergence: higher high in price, lower high in RSI
  if (pHigh2 > pHigh1 * 1.01 && rsiAtPHigh2 < rsiAtPHigh1 - 3) return 'bearish';

  return null;
}

// DI Convergence (trend weakness detector)
export function detectDIConvergence(plusDI, minusDI) {
  if (plusDI == null || minusDI == null) return null;
  const gap = Math.abs(plusDI - minusDI);
  if (gap < 5) return { type: 'converging', desc: '+DI ve -DI yakinlasti — trend zayifliyor', gap };
  return null;
}

// ══════════════════════════════════════════════════════════════
// NEW WORLD-CLASS INDICATORS
// ══════════════════════════════════════════════════════════════

// Ichimoku Cloud (Kumo)
export function calcIchimoku(prices, tenkanPeriod = 9, kijunPeriod = 26, senkouBPeriod = 52) {
  const n = prices.length;
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  const senkouA = new Array(n).fill(null);
  const senkouB = new Array(n).fill(null);
  const chikou = new Array(n).fill(null);

  const periodHL = (start, end) => {
    let hi = -Infinity, lo = Infinity;
    for (let i = start; i <= end; i++) {
      if (prices[i].high > hi) hi = prices[i].high;
      if (prices[i].low < lo) lo = prices[i].low;
    }
    return (hi + lo) / 2;
  };

  for (let i = 0; i < n; i++) {
    if (i >= tenkanPeriod - 1) tenkan[i] = periodHL(i - tenkanPeriod + 1, i);
    if (i >= kijunPeriod - 1) kijun[i] = periodHL(i - kijunPeriod + 1, i);
    if (tenkan[i] != null && kijun[i] != null) {
      // Senkou A shifted 26 ahead (we store at current index for simplicity)
      senkouA[i] = (tenkan[i] + kijun[i]) / 2;
    }
    if (i >= senkouBPeriod - 1) {
      senkouB[i] = periodHL(i - senkouBPeriod + 1, i);
    }
    // Chikou Span: close shifted back 26 periods
    if (i >= kijunPeriod) chikou[i - kijunPeriod] = prices[i].close;
  }

  // Derive signals
  const lastTenkan = tenkan[n - 1];
  const lastKijun = kijun[n - 1];
  const lastSenkouA = senkouA[n - 1];
  const lastSenkouB = senkouB[n - 1];
  const lastClose = prices[n - 1].close;
  const prevTenkan = n >= 2 ? tenkan[n - 2] : null;
  const prevKijun = n >= 2 ? kijun[n - 2] : null;

  // TK Cross
  let tkCross = null;
  if (lastTenkan != null && lastKijun != null && prevTenkan != null && prevKijun != null) {
    if (prevTenkan <= prevKijun && lastTenkan > lastKijun) tkCross = 'bullish';
    else if (prevTenkan >= prevKijun && lastTenkan < lastKijun) tkCross = 'bearish';
  }

  // Kumo Breakout
  let kumoBreakout = null;
  const kumoTop = lastSenkouA != null && lastSenkouB != null ? Math.max(lastSenkouA, lastSenkouB) : null;
  const kumoBottom = lastSenkouA != null && lastSenkouB != null ? Math.min(lastSenkouA, lastSenkouB) : null;
  if (kumoTop != null) {
    const prevClose = n >= 2 ? prices[n - 2].close : lastClose;
    if (lastClose > kumoTop && prevClose <= kumoTop) kumoBreakout = 'bullish';
    else if (lastClose < kumoBottom && prevClose >= kumoBottom) kumoBreakout = 'bearish';
  }

  // Cloud color (Kumo Twist future signal)
  let kumoTwist = null;
  if (n >= 3 && senkouA[n - 2] != null && senkouB[n - 2] != null) {
    const prevAaboveB = senkouA[n - 2] > senkouB[n - 2];
    const currAaboveB = lastSenkouA > lastSenkouB;
    if (!prevAaboveB && currAaboveB) kumoTwist = 'bullish';
    else if (prevAaboveB && !currAaboveB) kumoTwist = 'bearish';
  }

  // Position relative to cloud
  let cloudPosition = 'inside';
  if (kumoTop != null) {
    if (lastClose > kumoTop) cloudPosition = 'above';
    else if (lastClose < kumoBottom) cloudPosition = 'below';
  }

  return {
    tenkan, kijun, senkouA, senkouB, chikou,
    lastTenkan, lastKijun, lastSenkouA, lastSenkouB,
    tkCross, kumoBreakout, kumoTwist, cloudPosition,
    kumoTop, kumoBottom,
  };
}

// Williams %R (independent oscillator, different from RSI)
export function calcWilliamsR(prices, period = 14) {
  const n = prices.length;
  const wr = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (prices[j].high > hh) hh = prices[j].high;
      if (prices[j].low < ll) ll = prices[j].low;
    }
    wr[i] = hh !== ll ? ((hh - prices[i].close) / (hh - ll)) * -100 : -50;
  }
  return wr;
}

// TRIX (Triple Exponential Moving Average — noise filter)
export function calcTRIX(closes, period = 15) {
  const ema1 = calcEMA(closes, period);
  const ema2 = calcEMA(ema1.filter(v => v != null), period);
  const ema3 = calcEMA(ema2.filter(v => v != null), period);
  const n = ema3.length;
  if (n < 2) return { trix: [], signal: [], lastTRIX: null, lastSignal: null };
  const trix = [];
  for (let i = 1; i < n; i++) {
    trix.push(ema3[i - 1] !== 0 ? ((ema3[i] - ema3[i - 1]) / ema3[i - 1]) * 10000 : 0);
  }
  // Signal line = 9-period SMA of TRIX
  const sigPeriod = 9;
  const signal = [];
  for (let i = 0; i < trix.length; i++) {
    if (i < sigPeriod - 1) { signal.push(null); continue; }
    let sum = 0;
    for (let j = i - sigPeriod + 1; j <= i; j++) sum += trix[j];
    signal.push(sum / sigPeriod);
  }
  const lastTRIX = trix.length > 0 ? trix[trix.length - 1] : null;
  const lastSignal = signal.length > 0 ? signal[signal.length - 1] : null;
  const prevTRIX = trix.length > 1 ? trix[trix.length - 2] : null;
  const prevSignal = signal.length > 1 ? signal[signal.length - 2] : null;
  let crossover = null;
  if (lastTRIX != null && lastSignal != null && prevTRIX != null && prevSignal != null) {
    if (prevTRIX <= prevSignal && lastTRIX > lastSignal) crossover = 'bullish';
    else if (prevTRIX >= prevSignal && lastTRIX < lastSignal) crossover = 'bearish';
  }
  return { trix, signal, lastTRIX, lastSignal, crossover };
}

// Supertrend (ATR-based trend following)
export function calcSupertrend(prices, period = 10, multiplier = 3) {
  const n = prices.length;
  if (n < period + 1) return { trend: null, value: null, direction: null };
  const supertrend = new Array(n).fill(null);
  const direction = new Array(n).fill(0); // 1 = up, -1 = down
  // Rolling ATR
  const trs = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(prices[i].high - prices[i].low, Math.abs(prices[i].high - prices[i - 1].close), Math.abs(prices[i].low - prices[i - 1].close)));
  }
  let prevUpper = 0, prevLower = 0, prevST = 0, prevDir = 1;
  for (let i = period; i < n; i++) {
    let atrSum = 0;
    for (let j = i - period; j < i; j++) atrSum += trs[j] || 0;
    const atr = atrSum / period;
    const hl2 = (prices[i].high + prices[i].low) / 2;
    let upperBand = hl2 + multiplier * atr;
    let lowerBand = hl2 - multiplier * atr;
    // Carry forward: upper can only decrease, lower can only increase
    if (prevUpper > 0 && prices[i - 1].close <= prevUpper) upperBand = Math.min(upperBand, prevUpper);
    if (prevLower > 0 && prices[i - 1].close >= prevLower) lowerBand = Math.max(lowerBand, prevLower);
    let dir;
    if (prevST === prevUpper) {
      dir = prices[i].close > upperBand ? 1 : -1;
    } else {
      dir = prices[i].close < lowerBand ? -1 : 1;
    }
    supertrend[i] = dir === 1 ? lowerBand : upperBand;
    direction[i] = dir;
    prevUpper = upperBand;
    prevLower = lowerBand;
    prevST = supertrend[i];
    prevDir = dir;
  }
  const lastDir = direction[n - 1];
  const lastValue = supertrend[n - 1];
  // Detect flip
  let flip = null;
  if (n >= 2 && direction[n - 2] !== 0 && direction[n - 1] !== 0) {
    if (direction[n - 2] === -1 && direction[n - 1] === 1) flip = 'bullish';
    else if (direction[n - 2] === 1 && direction[n - 1] === -1) flip = 'bearish';
  }
  return { supertrend, direction, trend: lastDir === 1 ? 'UP' : 'DOWN', value: lastValue, flip };
}

// Volume Profile (simplified — POC detection)
export function calcVolumeProfile(prices, lookback = 50) {
  const n = prices.length;
  const start = Math.max(0, n - lookback);
  const slice = prices.slice(start, n);
  if (slice.length < 10) return { poc: null, valueAreaHigh: null, valueAreaLow: null, bins: [] };
  let hi = -Infinity, lo = Infinity;
  for (const b of slice) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  const range = hi - lo;
  if (range <= 0) return { poc: null, valueAreaHigh: null, valueAreaLow: null, bins: [] };
  const numBins = 24;
  const binSize = range / numBins;
  const bins = new Array(numBins).fill(0);
  for (const b of slice) {
    const idx = Math.min(numBins - 1, Math.floor((b.close - lo) / binSize));
    bins[idx] += b.volume;
  }
  // POC = bin with highest volume
  let maxVol = 0, pocIdx = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] > maxVol) { maxVol = bins[i]; pocIdx = i; }
  }
  const poc = lo + (pocIdx + 0.5) * binSize;
  // Value Area = 70% of total volume around POC
  const totalVol = bins.reduce((a, b) => a + b, 0);
  const targetVol = totalVol * 0.7;
  let vaVol = bins[pocIdx], vaLo = pocIdx, vaHi = pocIdx;
  while (vaVol < targetVol && (vaLo > 0 || vaHi < numBins - 1)) {
    const loAdd = vaLo > 0 ? bins[vaLo - 1] : 0;
    const hiAdd = vaHi < numBins - 1 ? bins[vaHi + 1] : 0;
    if (loAdd >= hiAdd && vaLo > 0) { vaLo--; vaVol += bins[vaLo]; }
    else if (vaHi < numBins - 1) { vaHi++; vaVol += bins[vaHi]; }
    else break;
  }
  return {
    poc,
    valueAreaHigh: lo + (vaHi + 1) * binSize,
    valueAreaLow: lo + vaLo * binSize,
    bins: bins.map((v, i) => ({ price: lo + (i + 0.5) * binSize, volume: v })),
  };
}

// Rate of Change (multi-period momentum)
export function calcROC(closes, period = 10) {
  const roc = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    if (closes[i - period] !== 0) {
      roc[i] = ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
    }
  }
  return roc;
}

// Main calcAll — computes all indicators
export function calcAll(prices) {
  const closes = prices.map(p => p.close);
  const n = closes.length;
  const ma20 = calcMA(closes, 20), ma50 = calcMA(closes, 50), ma100 = calcMA(closes, 100), ma200 = calcMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const stochRSI = calcStochRSI(closes, 14, 14, 3, 3);
  const macd = calcMACD(closes, 12, 26, 9);
  const bollinger = calcBollinger(closes, 20, 2);
  const sr = calcSR(prices);
  const mfi = calcMFI(prices, 14);
  const obv = calcOBV(prices);
  const obvTrend = calcOBVTrend(obv, closes, 20);
  const adl = calcADL(prices);
  const vwap = calcVWAP(prices, 20);
  const cmf = calcCMF(prices, 20);
  const adxData = calcADX(prices, 14);
  const ttmSqueeze = calcTTMSqueeze(prices);
  const chandelier = calcChandelierExit(prices, 22, 3);
  const candlePatterns = calcCandlestickPatterns(prices);

  let adlTrend = 'neutral';
  if (adl.length >= 20) {
    const adlChg = (adl[adl.length-1] - adl[adl.length-20]) / (Math.abs(adl[adl.length-20]) || 1);
    if (adlChg > 0.05) adlTrend = 'accumulation'; else if (adlChg < -0.05) adlTrend = 'distribution';
  }
  const volumes = prices.map(p => p.volume);
  const lastVol = volumes[n - 1];
  let avgVol = 0;
  const volLookback = Math.min(20, n);
  for (let i = n - volLookback; i < n; i++) avgVol += volumes[i];
  avgVol /= volLookback;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const lastClose = closes[n - 1], prevClose = n > 1 ? closes[n - 2] : lastClose;
  const change = lastClose - prevClose, changePct = (change / prevClose) * 100;

  const result = {
    closes, ma20, ma50, ma100, ma200,
    lastMA20: ma20[n-1], lastMA50: ma50[n-1], lastMA100: ma100[n-1], lastMA200: ma200[n-1],
    rsi, lastRSI: rsi[n-1],
    stochRSI, lastStochK: stochRSI.k[n-1], lastStochD: stochRSI.d[n-1],
    macd, lastMACD: macd.macd[n-1], lastMACDSig: macd.signal[n-1], lastMACDHist: macd.histogram[n-1],
    bollinger, lastBU: bollinger.upper[n-1], lastBM: bollinger.middle[n-1], lastBL: bollinger.lower[n-1],
    sr, mfi, obv, obvTrend, adl, adlTrend, vwap, lastVol, volRatio, lastClose, change, changePct,
    cmf,
    adx: adxData.adx, plusDI: adxData.plusDI, minusDI: adxData.minusDI,
    ttmSqueeze, chandelier, candlePatterns,
  };

  result.wyckoffPhase = detectWyckoffPhase(prices, result);

  // New advanced indicators
  result.obvDivergence = detectOBVDivergence(prices, obv, 15);
  result.rsiDivergence = detectRSIDivergence(prices, rsi, 20);
  result.wyckoffSpring = detectWyckoffSpring(prices, sr);
  result.volumeClimax = detectVolumeClimax(prices, 20);
  result.diConvergence = detectDIConvergence(adxData.plusDI, adxData.minusDI);

  // ── NEW WORLD-CLASS INDICATORS ──
  const ichimoku = calcIchimoku(prices);
  result.ichimoku = ichimoku;

  const williamsR = calcWilliamsR(prices, 14);
  result.williamsR = williamsR;
  result.lastWilliamsR = williamsR[n - 1];

  const trixData = calcTRIX(closes, 15);
  result.trix = trixData;

  const supertrendData = calcSupertrend(prices, 10, 3);
  result.supertrend = supertrendData;

  const volumeProfile = calcVolumeProfile(prices, 50);
  result.volumeProfile = volumeProfile;

  const roc10 = calcROC(closes, 10);
  const roc20 = calcROC(closes, 20);
  result.roc10 = roc10;
  result.roc20 = roc20;
  result.lastROC10 = roc10[n - 1];
  result.lastROC20 = roc20[n - 1];

  // ── INTRADAY MOMENTUM INDICATORS ──
  // Gap detection (today's open vs yesterday's close)
  const yesterday = n >= 2 ? closes[n - 2] : lastClose;
  const todayOpen = prices[n - 1]?.open || lastClose;
  const gapPct = yesterday ? ((todayOpen - yesterday) / yesterday) * 100 : 0;
  const gapUp = gapPct > 1;
  const gapDown = gapPct < -1;

  // ── INTRADAY METRICS (Fix: using true daily high/low/open instead of n-5 days) ──
  const today = prices[n - 1] || {};
  const tOpen = today.open || lastClose;
  const tHigh = today.high || lastClose;
  const tLow = today.low || lastClose;
  
  // How close is it to the high of the day? (1 = at high, 0 = at low)
  const dayHighLowRange = (tHigh - tLow) > 0 ? (lastClose - tLow) / (tHigh - tLow) : 0.5;
  // Net move since open (stripping out the gap)
  const openToCurrentPct = tOpen > 0 ? ((lastClose - tOpen) / tOpen) * 100 : 0;
  
  // Replace old 5-day momentum with true intraday net move
  const momentumIntraday = openToCurrentPct;

  // Volume surge detection
  const volSurge = volRatio > 2.5 ? 'explosive' : volRatio > 1.8 ? 'strong' : volRatio > 1.3 ? 'moderate' : 'normal';

  // Relative strength vs XU100 (sector proxy)
  const relStrength = changePct; // Simplified: can be enhanced with benchmark comparison

  // ── SHORT-PERIOD MOMENTUM (approximate 1h / 4h from daily bars) ──
  // On daily bars we cannot get true intraday 1h/4h, so approximate from recent bars
  const momentum1h = n >= 2 ? ((closes[n-1] - closes[n-2]) / closes[n-2]) * 100 : 0;
  const momentum4h = n >= 4 ? ((closes[n-1] - closes[n-4]) / closes[n-4]) * 100 : momentum1h;

  // ── FORWARD MOMENTUM — Trend analysis over last 3-5 days ──
  // Instead of rewarding TODAY'S spike, reward GRADUAL momentum buildup
  // This prevents the "tavan yapmış hisse bias"
  const momentumSlope = (() => {
    if (n < 5) return 0;
    // Linear regression slope over last 5 days
    const recent = closes.slice(-5);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    let num = 0, den = 0;
    for (let i = 0; i < recent.length; i++) {
      num += (i - 2) * (recent[i] - avg);  // i-2 centers the slope
      den += Math.pow(i - 2, 2);
    }
    const slope = den > 0 ? (num / den) / avg * 100 : 0;  // % change per day
    
    // Categorize: steep spike vs gradual trend
    // slope > 1.5%/day = steep, 0.5-1.5 = moderate, < 0.5 = gradual
    return {
      value: slope,
      trend: slope > 1.5 ? 'steep' : slope > 0.5 ? 'moderate' : slope > -0.5 ? 'gradual' : slope > -1.5 ? 'weak' : 'declining',
      isSteep: slope > 1.5,  // sudden spike — could be fade risk
      isGradual: slope > 0 && slope <= 1.5,  // sustainable — preferred
      hasMomentum: slope > 0.3  // has positive trend
    };
  })();

  // ── OPENING RANGE BREAKOUT / BREAKDOWN ──
  // Check if today's close broke above yesterday's high (breakout) or below yesterday's low (breakdown)
  const prevBar = n >= 2 ? prices[n-2] : null;
  const orBreakout = prevBar ? lastClose > prevBar.high : false;
  const orBreakdown = prevBar ? lastClose < prevBar.low : false;

  // Momentum score (0-100) — Refined for "Falling Knife" & "Fade Gap" protection
  let momScore = 0;
  // Only reward Gap Up if it's holding its gains (not selling off)
  if (gapUp && dayHighLowRange > 0.5) momScore += 15;
  else if (gapDown) momScore -= 15;
  
  // Volume points
  momScore += (volRatio > 2 ? 25 : volRatio > 1.5 ? 15 : 0);
  
  // True Intraday Trend points (up to 25 points)
  if (openToCurrentPct > 0) {
    momScore += Math.min(25, openToCurrentPct * 5);
  } else {
    momScore -= Math.min(20, Math.abs(openToCurrentPct * 5));
  }
  
// Closing Strength Points
  if (dayHighLowRange > 0.8) momScore += 15; // Holding near high
  else if (dayHighLowRange < 0.3) momScore -= 25; // Selling off heavily from high (Weak Close)
  
  // ── FORWARD MOMENTUM SCORING (replaces simple today change) ──
  // Instead of rewarding TODAY'S spike with changePct, reward gradual momentum buildup
  // This eliminates "tavan yapmış hisse" bias
  if (momentumSlope.isGradual && momentumSlope.value > 0.5) {
    // Gradual sustainable momentum — PREFERRED
    momScore += 20;
  } else if (momentumSlope.isSteep && changePct > 3) {
    // Steep spike today (>3%) — likely a fade candidate, apply 50% penalty
    momScore *= 0.5;
  } else if (changePct > 8) {
    // "Bugün tavan" — entry noktası kaçırıldı, 70% ceza
    momScore *= 0.3;
  } else {
    // Normal case: use moderate change scoring
    momScore += (changePct > 0 ? changePct * 2 : changePct * 0.5);
  }
  
  const momentumScore = Math.min(100, Math.max(0, Math.round(momScore)));

  // Add momentum fields to result
  result.gapPct = gapPct;
  result.gapUp = gapUp;
  result.gapDown = gapDown;
  result.momentum1h = momentum1h;
  result.momentum4h = momentum4h;
  result.momentumIntraday = momentumIntraday;
  result.volumeSurge = volSurge;
  result.relStrength = relStrength;
  result.orBreakout = orBreakout;
  result.orBreakdown = orBreakdown;
  result.dayHighLowRange = dayHighLowRange;
  result.openToCurrentPct = openToCurrentPct;
  result.momentumScore = momentumScore;
  // NEW: Forward momentum fields
  result.momentumSlope = momentumSlope.value;
  result.momentumTrend = momentumSlope.trend;
  result.forwardMomentum = momentumSlope.hasMomentum && momentumSlope.isGradual;

  return result;
}
