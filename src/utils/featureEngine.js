import { getDatabase, saveDatabase } from './database.js';
import { fetchData } from './fetchEngine.js';
import { calcAll } from './indicators.js';
import { istanbulDayKey } from './fetchEngine.js';

export async function analyzeIndicatorsForTop10(date) {
  const db = getDatabase();
  if (!db) {
    console.warn('[FeatureEng] Database not initialized');
    return null;
  }

  const top10Stmt = db.prepare(`
    SELECT symbol FROM daily_top10 WHERE date = ? ORDER BY rank
  `);
  top10Stmt.bind([date]);

  const symbols = [];
  while (top10Stmt.step()) {
    symbols.push(top10Stmt.getAsObject().symbol);
  }
  top10Stmt.free();

  if (symbols.length === 0) {
    console.warn('[FeatureEng] No Top10 data for', date);
    return null;
  }

  const results = [];
  for (const symbol of symbols) {
    try {
      const data = await fetchData(symbol, '1mo', '1d');
      if (!data || !data.prices || data.prices.length < 20) continue;

      const ind = calcAll(data.prices);
      if (!ind) continue;

      const yesterday = data.prices[data.prices.length - 2];
      const today = data.prices[data.prices.length - 1];
      const nextDayChange = today ? ((today.close - yesterday.close) / yesterday.close) * 100 : 0;

      const features = extractFeatures(ind, yesterday, today, data.prices);

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO daily_indicators
        (date, symbol, rsi, macd, macd_signal, macd_hist, bb_upper, bb_middle, bb_lower, bb_width,
         rsi_divergence, obv, obv_change_pct, mfi, adx, atr, sma_20, sma_50, sma_200,
         volume_ratio, price_vs_sma200, wyckoff_phase, in_top10_next_day, next_day_change_pct,
         momentum5d, momentum20d, roc, volume_accum_ratio, price_vs_vwap, atr_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        date, symbol,
        features.rsi, features.macd, features.macdSignal, features.macdHist,
        features.bbUpper, features.bbMiddle, features.bbLower, features.bbWidth,
        features.rsiDivergence, features.obv, features.obvChange, features.mfi,
        features.adx, features.atr, features.sma20, features.sma50, features.sma200,
        features.volumeRatio, features.priceVsSma200, features.wyckoffPhase,
        0, nextDayChange,
        features.momentum5d, features.momentum20d, features.roc,
        features.volumeAccumRatio, features.priceVsVwap, features.atrPercent
      ]);
      stmt.free();

      results.push({ symbol, features, nextDayChange });
    } catch (e) {
      console.warn(`[FeatureEng] Failed for ${symbol}:`, e.message);
    }
  }

  saveDatabase();
  console.log(`[FeatureEng] Analyzed ${results.length} stocks for ${date}`);
  return results;
}

function extractFeatures(ind, yesterday, today, prices = []) {
  const rsi = ind.rsi?.length ? ind.rsi[ind.rsi.length - 1] : null;
  const macd = ind.macd?.length ? ind.macd[ind.macd.length - 1] : null;
  const macdSignal = ind.macdSignal?.length ? ind.macdSignal[ind.macdSignal.length - 1] : null;
  const macdHist = ind.macdHist?.length ? ind.macdHist[ind.macdHist.length - 1] : null;

  const bb = ind.bollingerBands || {};
  const bbUpper = bb.upper?.[bb.upper.length - 1] || null;
  const bbMiddle = bb.middle?.[bb.middle.length - 1] || null;
  const bbLower = bb.lower?.[bb.lower.length - 1] || null;
  const bbWidth = bbUpper && bbLower && bbMiddle ? ((bbUpper - bbLower) / bbMiddle) * 100 : null;

  const obv = ind.obv?.length ? ind.obv[ind.obv.length - 1] : null;
  const obvPrev = ind.obv?.length > 1 ? ind.obv[ind.obv.length - 2] : null;
  const obvChange = obv && obvPrev ? ((obv - obvPrev) / Math.abs(obvPrev)) * 100 : 0;

  const mfi = ind.mfi?.length ? ind.mfi[ind.mfi.length - 1] : null;
  const adx = ind.adx?.length ? ind.adx[ind.adx.length - 1] : null;
  const atr = ind.atr?.length ? ind.atr[ind.atr.length - 1] : null;

  const sma20 = ind.sma?.find(s => s.period === 20)?.values?.slice(-1)[0] || null;
  const sma50 = ind.sma?.find(s => s.period === 50)?.values?.slice(-1)[0] || null;
  const sma200 = ind.sma?.find(s => s.period === 200)?.values?.slice(-1)[0] || null;

  const volume = yesterday?.volume || 0;
  const avgVolume = ind.sma?.find(s => s.period === 20)?.values?.slice(-1)[0] || volume;
  const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;

  const price = yesterday?.close || 0;
  const priceVsSma200 = sma200 && price > 0 ? ((price - sma200) / sma200) * 100 : 0;

  const wyckoffPhase = ind.wyckoffPhase || 'neutral';

  let rsiDivergence = 'none';
  if (rsi && rsi < 30) rsiDivergence = 'bullish';
  else if (rsi && rsi > 70) rsiDivergence = 'bearish';

  // ── NEW MOMENTUM FEATURES v2 ──
  // 5-day and 20-day price momentum
  const momentum5d = prices.length >= 6 
    ? ((prices[prices.length - 1].close - prices[prices.length - 6].close) / prices[prices.length - 6].close) * 100 
    : 0;
  
  const momentum20d = prices.length >= 21 
    ? ((prices[prices.length - 1].close - prices[prices.length - 21].close) / prices[prices.length - 21].close) * 100 
    : 0;

  // Rate of change (momentum acceleration)
  const roc = momentum5d - momentum20d;
  
  // Volume accumulation (5-day sum vs 20-day average)
  let volumeAccum5 = 0;
  let volumeAvg5 = 0;
  if (prices.length >= 5) {
    for (let i = 0; i < 5; i++) volumeAccum5 += prices[prices.length - 1 - i]?.volume || 0;
    for (let i = 0; i < Math.min(20, prices.length); i++) volumeAvg5 += prices[prices.length - 1 - i]?.volume || 0;
    volumeAvg5 = volumeAvg5 / Math.min(20, prices.length);
  }
  const volumeAccumRatio = volumeAvg5 > 0 ? volumeAccum5 / (volumeAvg5 * 5) : 1;

  // VWAP distance
  const vwap = ind.vwap || null;
  const priceVsVwap = vwap && price > 0 ? ((price - vwap) / vwap) * 100 : 0;

  // ATR as percentage (volatility)
  const atrPercent = price > 0 && atr ? (atr / price) * 100 : 0;

  return {
    rsi, macd, macdSignal, macdHist,
    bbUpper, bbMiddle, bbLower, bbWidth,
    rsiDivergence, obv, obvChange, mfi,
    adx, atr, sma20, sma50, sma200,
    volumeRatio, priceVsSma200, wyckoffPhase,
    // New v2 features
    momentum5d, momentum20d, roc,
    volumeAccumRatio, priceVsVwap, atrPercent
  };
}

export async function findTop10Patterns(minOccurrences = 5) {
  const db = getDatabase();
  if (!db) return [];

  const patterns = [
    { name: 'RSI_Oversold', condition: d => d.rsi && d.rsi < 35 },
    { name: 'RSI_Overbought', condition: d => d.rsi && d.rsi > 65 },
    { name: 'MACD_Bullish_Cross', condition: d => d.macd && d.macdSignal && d.macd > d.macdSignal },
    { name: 'MACD_Bearish_Cross', condition: d => d.macd && d.macdSignal && d.macd < d.macdSignal },
    { name: 'BB_Squeeze', condition: d => d.bbWidth && d.bbWidth < 5 },
    { name: 'BB_Lower_Touch', condition: d => d.rsi && d.rsi < 40 && d.bbWidth && d.bbWidth < 10 },
    { name: 'OBV_Accumulation', condition: d => d.obvChange && d.obvChange > 5 },
    { name: 'Volume_Spike', condition: d => d.volumeRatio && d.volumeRatio > 2 },
    { name: 'Strong_Trend', condition: d => d.adx && d.adx > 25 },
    { name: 'Above_SMA200', condition: d => d.priceVsSma200 && d.priceVsSma200 > 0 },
    { name: 'Below_SMA200', condition: d => d.priceVsSma200 && d.priceVsSma200 < -5 },
    { name: 'MFI_Oversold', condition: d => d.mfi && d.mfi < 30 },
    { name: 'MFI_Overbought', condition: d => d.mfi && d.mfi > 70 },
    { name: 'Near_SMA50', condition: d => d.sma50 && d.priceVsSma200 && Math.abs(d.priceVsSma200) < 3 },
  ];

  const results = db.exec(`
    SELECT symbol, date, rsi, macd, macd_signal, macd_hist, bb_width,
           obv_change_pct, volume_ratio, adx, price_vs_sma200, mfi, in_top10_next_day,
           next_day_change_pct, momentum5d, momentum20d, roc, volume_accum_ratio, price_vs_vwap, atr_percent
    FROM daily_indicators
    WHERE date IS NOT NULL
  `);

  if (!results.length) return [];

  const headers = results[0].columns;
  const rows = results[0].values;

  const stats = {};

  for (const pattern of patterns) {
    stats[pattern.name] = {
      occurrences: 0,
      successes: 0,
      totalRoi: 0,
      avgRoi: 0,
      successRate: 0
    };
  }

  for (const row of rows) {
    const data = {};
    headers.forEach((h, i) => {
      data[h] = row[i];
    });

    for (const pattern of patterns) {
      if (pattern.condition(data)) {
        stats[pattern.name].occurrences++;
        if (data.next_day_change_pct != null) {
          stats[pattern.name].totalRoi += data.next_day_change_pct;
          if (data.next_day_change_pct > 0) {
            stats[pattern.name].successes++;
          }
        }
      }
    }
  }

  const final = [];
  for (const [name, s] of Object.entries(stats)) {
    if (s.occurrences >= minOccurrences) {
      s.avgRoi = s.totalRoi / s.occurrences;
      s.successRate = (s.successes / s.occurrences) * 100;
      final.push({
        name,
        ...s,
        successRate: s.successRate.toFixed(1),
        avgRoi: s.avgRoi.toFixed(2)
      });
    }
  }

  return final.sort((a, b) => b.successRate - a.successRate);
}

export async function updateNextDayResults() {
  const db = getDatabase();
  if (!db) return;

  const top10Dates = db.exec(`
    SELECT DISTINCT date FROM daily_top10 ORDER BY date DESC LIMIT 30
  `);

  if (!top10Dates.length) return;

  const dates = top10Dates[0].values.map(v => v[0]);

  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i];
    const tomorrow = dates[i + 1];

    const tomorrowTop10 = db.exec(`
      SELECT symbol FROM daily_top10 WHERE date = '${tomorrow}'
    `);

    if (!tomorrowTop10.length) continue;

    const tomorrowSymbols = new Set(tomorrowTop10[0].values.map(v => v[0]));

    const updateStmt = db.prepare(`
      UPDATE daily_indicators
      SET in_top10_next_day = ?, next_day_change_pct = ?
      WHERE date = ? AND symbol = ?
    `);

    const todayStocks = db.exec(`
      SELECT symbol, next_day_change_pct FROM daily_indicators WHERE date = '${today}'
    `);

    if (todayStocks.length && todayStocks[0].values) {
      for (const row of todayStocks[0].values) {
        const symbol = row[0];
        const change = row[1];
        const inTop10 = tomorrowSymbols.has(symbol) ? 1 : 0;
        updateStmt.run([inTop10, change, today, symbol]);
      }
    }

    updateStmt.free();
  }

  saveDatabase();
  console.log('[FeatureEng] Updated next-day results');
}
