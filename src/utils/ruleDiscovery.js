import { getDatabase, saveDatabase } from './database.js';

const RULE_TEMPLATES = [
  { name: 'rsi_oversold', params: { maxRsi: 30 }, score: 0 },
  { name: 'rsi_weak_oversold', params: { maxRsi: 40 }, score: 0 },
  { name: 'rsi_overbought', params: { minRsi: 70 }, score: 0 },
  { name: 'macd_bullish', params: { requireMacdAboveSignal: true }, score: 0 },
  { name: 'macd_histogram_positive', params: { minHist: 0 }, score: 0 },
  { name: 'bb_squeeze', params: { maxBbWidth: 5 }, score: 0 },
  { name: 'bb_lower_touch', params: { maxBbWidth: 8, maxRsi: 40 }, score: 0 },
  { name: 'volume_spike', params: { minVolumeRatio: 2 }, score: 0 },
  { name: 'volume_explosion', params: { minVolumeRatio: 3 }, score: 0 },
  { name: 'obv_accumulation', params: { minObvChange: 3 }, score: 0 },
  { name: 'strong_trend', params: { minAdx: 25 }, score: 0 },
  { name: 'above_sma200', params: { minPriceVsSma200: 0 }, score: 0 },
  { name: 'below_sma200_oversold', params: { maxPriceVsSma200: -5, maxRsi: 40 }, score: 0 },
  { name: 'mfi_oversold', params: { maxMfi: 30 }, score: 0 },
  { name: 'mfi_institutional', params: { maxMfi: 20 }, score: 0 },
  { name: 'atr_volatility', params: { minAtrPercent: 3 }, score: 0 },
  { name: 'golden_cross_approach', params: { sma20AboveSma50: true, maxDistance: 2 }, score: 0 },
  // ── NEW MOMENTUM RULES v2 ──
  { name: 'momentum_strong', params: { minMomentum5d: 3 }, score: 0 },
  { name: 'momentum_accelerating', params: { minRoc: 2 }, score: 0 },
  { name: 'momentum_continuation', params: { minMomentum5d: 0, minMomentum20d: 5 }, score: 0 },
  { name: 'price_above_vwap', params: { minPriceVsVwap: 0 }, score: 0 },
  { name: 'volume_accumulation', params: { minVolumeAccum: 1.2 }, score: 0 },
  { name: 'high_volatility', params: { minAtrPercent: 4 }, score: 0 },
  { name: 'low_volatility', params: { maxAtrPercent: 2 }, score: 0 },
  { name: 'combo_momentum_volume', params: { minMomentum5d: 2, minVolumeRatio: 1.5 }, score: 0 },
 ];

export async function discoverRules() {
  const db = getDatabase();
  if (!db) return [];

  const results = db.exec(`
    SELECT rsi, macd, macd_signal, macd_hist, bb_width, obv_change_pct,
           volume_ratio, adx, price_vs_sma200, mfi, in_top10_next_day,
           next_day_change_pct, momentum5d, momentum20d, roc, volume_accum_ratio, price_vs_vwap, atr_percent
    FROM daily_indicators
    WHERE rsi IS NOT NULL
  `);

  if (!results.length || !results[0].values.length) {
    console.warn('[RuleDiscovery] No data to analyze');
    return [];
  }

  const headers = results[0].columns;
  const rows = results[0].values;

  const rules = {};

  for (const template of RULE_TEMPLATES) {
    const key = JSON.stringify(template.params);
    rules[template.name] = {
      name: template.name,
      params: template.params,
      occurrences: 0,
      successes: 0,
      totalRoi: 0,
      avgRoi: 0,
      successRate: 0
    };
  }

  for (const row of rows) {
    const data = {};
    headers.forEach((h, i) => data[h] = row[i]);

    for (const template of RULE_TEMPLATES) {
      if (evaluateRule(template, data)) {
        const rule = rules[template.name];
        rule.occurrences++;

        if (data.next_day_change_pct != null) {
          rule.totalRoi += data.next_day_change_pct;
          if (data.in_top10_next_day === 1 || data.next_day_change_pct > 0) {
            rule.successes++;
          }
        }
      }
    }
  }

  const finalRules = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.occurrences >= 2) {
      rule.avgRoi = rule.totalRoi / rule.occurrences;
      rule.successRate = (rule.successes / rule.occurrences) * 100;

      finalRules.push({
        name: rule.name,
        params: rule.params,
        occurrences: rule.occurrences,
        successes: rule.successes,
        avgRoi: rule.avgRoi.toFixed(2),
        successRate: rule.successRate.toFixed(1),
        grade: calculateGrade(rule.successRate, rule.avgRoi)
      });
    }
  }

  finalRules.sort((a, b) => b.successRate - a.successRate);

  if (db && finalRules.length > 0) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO rule_performance
      (rule_name, rule_params, occurrences, successes, avg_roi_pct, success_rate, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    for (const rule of finalRules) {
      stmt.run([
        rule.name, JSON.stringify(rule.params), rule.occurrences,
        rule.successes, rule.avgRoi, rule.successRate, now
      ]);
    }
    stmt.free();
    saveDatabase();
  }

  console.log(`[RuleDiscovery] Found ${finalRules.length} valid rules`);
  return finalRules;
}

function evaluateRule(template, data) {
  const { name, params } = template;

  switch (name) {
    case 'rsi_oversold':
      return data.rsi != null && data.rsi <= params.maxRsi;

    case 'rsi_weak_oversold':
      return data.rsi != null && data.rsi <= params.maxRsi;

    case 'rsi_overbought':
      return data.rsi != null && data.rsi >= params.minRsi;

    case 'macd_bullish':
      return data.macd != null && data.macd_signal != null &&
             (params.requireMacdAboveSignal ? data.macd > data.macd_signal : data.macd < data.macd_signal);

    case 'macd_histogram_positive':
      return data.macd_hist != null && data.macd_hist >= params.minHist;

    case 'bb_squeeze':
      return data.bb_width != null && data.bb_width <= params.maxBbWidth;

    case 'bb_lower_touch':
      return data.bb_width != null && data.bb_width <= params.maxBbWidth &&
             data.rsi != null && data.rsi <= params.maxRsi;

    case 'volume_spike':
      return data.volume_ratio != null && data.volume_ratio >= params.minVolumeRatio;

    case 'volume_explosion':
      return data.volume_ratio != null && data.volume_ratio >= params.minVolumeRatio;

    case 'obv_accumulation':
      return data.obv_change_pct != null && data.obv_change_pct >= params.minObvChange;

    case 'strong_trend':
      return data.adx != null && data.adx >= params.minAdx;

    case 'above_sma200':
      return data.price_vs_sma200 != null && data.price_vs_sma200 >= params.minPriceVsSma200;

    case 'below_sma200_oversold':
      return data.price_vs_sma200 != null && data.price_vs_sma200 <= params.maxPriceVsSma200 &&
             data.rsi != null && data.rsi <= params.maxRsi;

    case 'mfi_oversold':
      return data.mfi != null && data.mfi <= params.maxMfi;

    case 'mfi_institutional':
      return data.mfi != null && data.mfi <= params.maxMfi;

    case 'atr_volatility':
      return data.atr_percent != null && data.atr_percent >= params.minAtrPercent;

    case 'golden_cross_approach':
      return data.sma20_vs_sma50 != null &&
             (params.sma20AboveSma50 ? data.sma20_vs_sma50 > 0 : data.sma20_vs_sma50 < 0) &&
             Math.abs(data.sma20_vs_sma50) <= params.maxDistance;

    case 'momentum_strong':
      return data.momentum5d != null && data.momentum5d >= params.minMomentum5d;

    case 'momentum_accelerating':
      return data.roc != null && data.roc >= params.minRoc;

    case 'momentum_continuation':
      return data.momentum5d != null && data.momentum20d != null &&
             data.momentum5d >= params.minMomentum5d && data.momentum20d >= params.minMomentum20d;

    case 'price_above_vwap':
      return data.price_vs_vwap != null && data.price_vs_vwap >= params.minPriceVsVwap;

    case 'volume_accumulation':
      return data.volume_accum_ratio != null && data.volume_accum_ratio >= params.minVolumeAccum;

    case 'high_volatility':
      return data.atr_percent != null && data.atr_percent >= params.minAtrPercent;

    case 'low_volatility':
      return data.atr_percent != null && data.atr_percent <= params.maxAtrPercent;

    case 'combo_momentum_volume':
      return data.momentum5d != null && data.volume_ratio != null &&
             data.momentum5d >= params.minMomentum5d && data.volume_ratio >= params.minVolumeRatio;

    default:
      return false;
  }
}

function calculateGrade(successRate, avgRoi) {
  const score = (successRate * 0.6) + (Math.min(Math.max(avgRoi, 0), 10) * 10 * 0.4);

  if (score >= 70) return 'A+';
  if (score >= 60) return 'A';
  if (score >= 50) return 'B+';
  if (score >= 40) return 'B';
  if (score >= 30) return 'C';
  return 'D';
}

export async function getTopRules(limit = 10) {
  const db = getDatabase();
  if (!db) return [];

  try {
    const results = db.exec(`
      SELECT rule_name, rule_params, occurrences, successes, avg_roi_pct, success_rate
      FROM rule_performance
      ORDER BY success_rate DESC, avg_roi_pct DESC
      LIMIT ${limit}
    `);

    if (!results.length) return [];

    return results[0].values.map(v => ({
      name: v[0],
      params: JSON.parse(v[1] || '{}'),
      occurrences: v[2],
      successes: v[3],
      avgRoi: v[4]?.toFixed(2),
      successRate: v[5]?.toFixed(1),
      grade: calculateGrade(v[5], v[4])
    }));
  } catch (e) {
    console.error('[RuleDiscovery] Get top rules failed:', e);
    return [];
  }
}

export async function predictTop10(symbols) {
  const rules = await getTopRules(10);
  if (rules.length === 0) {
    console.warn('[Predict] No rules found. Run discoverRules first.');
    return [];
  }

  const predictions = [];

  for (const symbol of symbols) {
    let score = 0;
    const matchedRules = [];

    for (const rule of rules) {
      if (symbol.ruleMatches?.includes(rule.name)) {
        score += rule.successRate * (rule.avgRoi > 0 ? 1 : 0.5);
        matchedRules.push(rule.name);
      }
    }

    if (matchedRules.length >= 2) {
      predictions.push({
        symbol,
        score,
        matchedRules,
        confidence: Math.min((score / 100) * 100, 95).toFixed(0)
      });
    }
  }

  return predictions.sort((a, b) => b.score - a.score).slice(0, 10);
}
