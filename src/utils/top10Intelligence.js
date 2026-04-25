import { initDatabase, getDatabase, saveDatabase } from './database.js';
import { fetchAndStoreTopGainers, getRecentTopGainers } from './topGainersEngine.js';
import { analyzeIndicatorsForTop10, findTop10Patterns, updateNextDayResults } from './featureEngine.js';
import { runTop10Backtest, getBacktestHistory, runIntradayTop10Strategy } from './top10Backtest.js';
import { discoverRules, getTopRules } from './ruleDiscovery.js';
import { getStockList } from './constants.js';
import { fetchSingle } from './fetchEngine.js';
import { calcAll } from './indicators.js';

let initialized = false;

export async function initTop10Intelligence() {
  if (initialized) return;

  try {
    await initDatabase();
    initialized = true;
    console.log('[Top10Intelligence] Initialized');
  } catch (e) {
    console.error('[Top10Intelligence] Init failed:', e);
  }
}

export async function dailyTop10Cycle() {
  if (!initialized) await initTop10Intelligence();

  console.log('[Top10Intelligence] Starting daily cycle...');

  try {
    const top10 = await fetchAndStoreTopGainers();
    if (!top10) {
      console.warn('[Top10Intelligence] No Top10 data fetched');
      return null;
    }

    await analyzeIndicatorsForTop10(top10.date);
    await updateNextDayResults();
    const rules = await discoverRules();

    console.log('[Top10Intelligence] Daily cycle complete');
    return {
      top10,
      rules,
      summary: {
        rulesFound: rules.length,
        bestRule: rules[0] || null
      }
    };
  } catch (e) {
    console.error('[Top10Intelligence] Daily cycle failed:', e);
    return null;
  }
}

export async function runBacktestScan(symbols, options = {}) {
  if (!initialized) await initTop10Intelligence();

  const results = await runTop10Backtest(symbols, {
    minVolume: options.minVolume || 1000000,
    maxPositions: options.maxPositions || 10,
    holdingDays: options.holdingDays || 1,
    stopLoss: options.stopLoss || -5,
    targetProfit: options.targetProfit || 10
  });

  return results;
}

export async function getIntradayOpportunities(threshold = 2) {
  if (!initialized) await initTop10Intelligence();

  const symbols = getStockList('bist50');
  const opportunities = await runIntradayTop10Strategy(symbols, threshold);

  return opportunities.slice(0, 10);
}

export async function getSystemPerformance() {
  if (!initialized) await initTop10Intelligence();

  const db = getDatabase();
  if (!db) return null;

  try {
    const stats = {};

    const top10Count = db.exec('SELECT COUNT(DISTINCT date) FROM daily_top10');
    stats.top10Days = top10Count[0]?.values[0]?.[0] || 0;

    const indicatorsCount = db.exec('SELECT COUNT(*) FROM daily_indicators');
    stats.indicatorsAnalyzed = indicatorsCount[0]?.values[0]?.[0] || 0;

    const rulesCount = db.exec('SELECT COUNT(*) FROM rule_performance WHERE occurrences >= 5');
    stats.validRules = rulesCount[0]?.values[0]?.[0] || 0;

    const bestRule = db.exec(`
      SELECT rule_name, success_rate, avg_roi_pct
      FROM rule_performance
      ORDER BY success_rate DESC
      LIMIT 1
    `);
    if (bestRule.length && bestRule[0].values.length) {
      stats.bestRule = {
        name: bestRule[0].values[0][0],
        successRate: bestRule[0].values[0][1]?.toFixed(1),
        avgRoi: bestRule[0].values[0][2]?.toFixed(2)
      };
    }

    const avgTop10Change = db.exec(`
      SELECT AVG(change_pct) FROM daily_top10
    `);
    stats.avgTop10Change = avgTop10Change[0]?.values[0]?.[0]?.toFixed(2) || 0;

    return stats;
  } catch (e) {
    console.error('[Top10Intelligence] Stats failed:', e);
    return null;
  }
}

export async function predictTomorrowTop10() {
  if (!initialized) await initTop10Intelligence();

  const rules = await getTopRules(15);
  
  // If no rules yet, use fallback based on simple indicators
  if (rules.length === 0) {
    console.warn('[Predict] No rules found, using fallback predictions');
    return getFallbackPredictions();
  }

  const db = getDatabase();
  if (!db) return getFallbackPredictions();

  const symbols = getStockList('bist50').slice(0, 50);
  const predictions = [];

  for (const symbol of symbols) {
    try {
      const recentIndicators = db.exec(`
        SELECT rsi, macd, macd_signal, macd_hist, bb_width, obv_change_pct,
               volume_ratio, adx, price_vs_sma200, mfi
        FROM daily_indicators
        WHERE symbol = '${symbol}'
        ORDER BY date DESC
        LIMIT 1
      `);

      if (!recentIndicators.length || !recentIndicators[0].values.length) continue;

      const ind = recentIndicators[0].values[0];
      const data = {
        rsi: ind[0], macd: ind[1], macd_signal: ind[2], macd_hist: ind[3],
        bb_width: ind[4], obv_change_pct: ind[5], volume_ratio: ind[6],
        adx: ind[7], price_vs_sma200: ind[8], mfi: ind[9]
      };

      let score = 0;
      const matchedRules = [];

      for (const rule of rules) {
        let matches = false;

        if (rule.name === 'rsi_oversold' && data.rsi && data.rsi <= 30) matches = true;
        if (rule.name === 'rsi_weak_oversold' && data.rsi && data.rsi <= 40) matches = true;
        if (rule.name === 'macd_bullish' && data.macd && data.macd_signal && data.macd > data.macd_signal) matches = true;
        if (rule.name === 'macd_histogram_positive' && data.macd_hist && data.macd_hist > 0) matches = true;
        if (rule.name === 'bb_squeeze' && data.bb_width && data.bb_width <= 5) matches = true;
        if (rule.name === 'volume_spike' && data.volume_ratio && data.volume_ratio >= 2) matches = true;
        if (rule.name === 'obv_accumulation' && data.obv_change_pct && data.obv_change_pct >= 3) matches = true;
        if (rule.name === 'strong_trend' && data.adx && data.adx >= 25) matches = true;
        if (rule.name === 'above_sma200' && data.price_vs_sma200 && data.price_vs_sma200 > 0) matches = true;
        if (rule.name === 'mfi_oversold' && data.mfi && data.mfi <= 30) matches = true;
        if (rule.name === 'mfi_institutional' && data.mfi && data.mfi <= 20) matches = true;

        if (matches) {
          const ruleSuccess = parseFloat(rule.successRate) / 100;
          const ruleRoi = parseFloat(rule.avgRoi);
          score += ruleSuccess * (ruleRoi > 0 ? 2 : 1);
          matchedRules.push(rule.name);
        }
      }

      if (matchedRules.length >= 2) {
        predictions.push({
          symbol,
          score: score.toFixed(2),
          matchedRules,
          source: 'rules_based',
          confidence: Math.min((score / 50) * 100, 95).toFixed(0)
        });
      }
    } catch (e) {
      console.warn(`[Predict] ${symbol} failed:`, e.message);
    }
  }

  return predictions.sort((a, b) => b.score - a.score).slice(0, 10);
}

function getFallbackPredictions() {
  const db = getDatabase();
  const stocks = getStockList('bist50').slice(0, 30);
  const predictions = [];

  for (const symbol of stocks) {
    try {
      const recentIndicators = db?.exec(`
        SELECT rsi, macd, macd_hist, bb_width, volume_ratio, adx, mfi, momentum5d, volume_accum_ratio
        FROM daily_indicators
        WHERE symbol = '${symbol}'
        ORDER BY date DESC
        LIMIT 1
      `);

      if (!recentIndicators?.length || !recentIndicators[0].values.length) {
        continue;
      }

      const ind = recentIndicators[0].values[0];
      let score = 0;
      const matchedRules = [];

      if (ind[0] && ind[0] <= 35) { score += 20; matchedRules.push('rsi_oversold'); }
      if (ind[1] && ind[2] && ind[1] > ind[2]) { score += 20; matchedRules.push('macd_bullish'); }
      if (ind[2] && ind[2] > 0) { score += 15; matchedRules.push('macd_histogram_positive'); }
      if (ind[3] && ind[3] <= 5) { score += 35; matchedRules.push('bb_squeeze_patlama_riski'); } // Riskier: BB Squeeze breakout potential
      if (ind[4] && ind[4] >= 2) { score += 30; matchedRules.push('volume_spike_ani_hacim'); } // Riskier: High volume explosion
      if (ind[5] && ind[5] >= 25) { score += 15; matchedRules.push('strong_trend'); }
      if (ind[6] && ind[6] <= 30) { score += 15; matchedRules.push('mfi_oversold'); }
      if (ind[7] && ind[7] >= 3) { score += 25; matchedRules.push('momentum_strong_ralli'); } // Riskier: Strong momentum
      if (ind[8] && ind[8] >= 1.2) { score += 15; matchedRules.push('volume_accumulation'); }

      if (matchedRules.length >= 2) {
        predictions.push({
          symbol,
          score: score.toFixed(2),
          matchedRules,
          confidence: Math.min((score / 120) * 100, 85).toFixed(0)
        });
      }
    } catch {}
  }

  if (predictions.length > 0) {
    return predictions.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  return stocks.slice(0, 10).map((symbol, i) => ({
    symbol,
    score: (85 - i * 5).toFixed(2),
    matchedRules: ['no_data'],
    confidence: (80 - i * 3).toFixed(0)
  }));
}

export { getTopRules, discoverRules, runTop10Backtest };

// ── LIVE MOMENTUM SCANNER (AI Advisor'dan BAĞIMSIZ) ──
// Bu fonksiyon AI Advisor taramasindan tamamen bagimsiz calisir.
// Sadece momentum-based scoring kullanir — database gerektirmez.
// AI Advisor ile paralel calisabilir.
export async function scanLiveMomentumTop10(count = 10) {
  const allSymbols = getStockList('bistall');
  const results = [];
  
  for (const symbol of allSymbols) {
    try {
      const data = await fetchSingle(symbol, '5d', '1d', true);
      if (!data?.prices || data.prices.length < 5) continue;
      
      const prices = data.prices;
      const last = prices[prices.length - 1];
      const prev = prices[prices.length - 2];
      if (!last?.close || !prev?.close) continue;
      
      const ind = calcAll(prices);
      const momScore = ind.momentumScore || 0;
      const gapPct = ind.gapPct || 0;
      const changePct = ((last.close / prev.close) - 1) * 100;
      const volSurge = ind.volumeSurge || '';
      
      // Live momentum criteria (bagimsiz - AI Advisor'dan farkli)
      const isMomentum = momScore >= 40 || (gapPct > 1 && momScore >= 30) || (volSurge === 'strong' || volSurge === 'explosive');
      
      if (!isMomentum) continue;
      
      // Bagimsiz momentum score hesapla
      const liveScore = Math.round(
        (momScore * 0.5) +
        (Math.min(30, gapPct * 6)) +
        (changePct > 0 ? Math.min(20, changePct * 4) : 0) +
        (volSurge === 'explosive' ? 15 : volSurge === 'strong' ? 8 : 0)
      );
      
      results.push({
        symbol,
        score: liveScore,
        momentumScore: momScore,
        gapPct,
        changePct,
        volumeSurge: volSurge,
        source: 'momentum_scanner',
        reasons: [
          momScore >= 50 ? 'Guclu momentum' : 'Orta momentum',
          gapPct > 1 ? `Gap ${gapPct.toFixed(1)}%` : null,
          volSurge ? `Hacim ${volSurge}` : null,
        ].filter(Boolean)
      });
    } catch {
      // silent fail
    }
    await new Promise(r => setTimeout(r, 100));
  }
  
  return results.sort((a, b) => b.score - a.score).slice(0, count);
}
