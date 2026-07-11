// ════════════════════════════════════════════════════════════════════
// ML_BacktestEngine.js — Self-Learning Backtest & Rule Discovery
// ════════════════════════════════════════════════════════════════════
//
// Pipeline:
//   1. evaluateHistoricalSignals — calculate actual T+1/T+3/T+5 ROI
//   2. computeFeatureImportance  — rank which indicators predict wins
//   3. extractWinningRules       — combinatorial rule discovery
//   4. scoreNewSignal            — apply discovered rules to live signals
//
// All functions are pure (no React, no DOM). Safe for Node.js or browser.
// ════════════════════════════════════════════════════════════════════

import { initMLDatabase } from './DatabaseManager.js';

// ── CONSTANTS ──────────────────────────────────────────────────────

const MIN_SAMPLES_FOR_RULE   = 10;   // minimum occurrences to trust a rule
const MAX_COMBO_DEPTH        = 3;    // max features per combinatorial rule
const WIN_THRESHOLD_PCT      = 0;    // ROI > 0% = win (T+1 basis)
const RULE_HASH_SEPARATOR    = '||';
const MAX_RULES              = 500;  // cap discovered rules to prevent bloat

// Feature definitions: { name, column, op, thresholds[] }
// Each threshold creates a binary condition for rule mining
const FEATURE_DEFS = [
  { name: 'RSI_OVERSOLD',      col: 'rsi',         op: '<',  vals: [30, 35, 40] },
  { name: 'RSI_OVERBOUGHT',    col: 'rsi',         op: '>',  vals: [65, 70, 75] },
  { name: 'RSI_NEUTRAL',       col: 'rsi',         op: 'range', vals: [[40, 55]] },
  { name: 'MFI_LOW',           col: 'mfi',         op: '<',  vals: [30, 40] },
  { name: 'MFI_HIGH',          col: 'mfi',         op: '>',  vals: [65, 75] },
  { name: 'ADX_STRONG',        col: 'adx',         op: '>',  vals: [22, 28, 35] },
  { name: 'ADX_WEAK',          col: 'adx',         op: '<',  vals: [18, 22] },
  { name: 'CMF_POSITIVE',      col: 'cmf',         op: '>',  vals: [0.05, 0.10, 0.15] },
  { name: 'CMF_NEGATIVE',      col: 'cmf',         op: '<',  vals: [-0.05, -0.10] },
  { name: 'VOL_HIGH',          col: 'vol_ratio',   op: '>',  vals: [1.5, 2.0, 2.5] },
  { name: 'VOL_LOW',           col: 'vol_ratio',   op: '<',  vals: [0.6, 0.8] },
  { name: 'BOLL_LOWER',        col: 'boll_pct',    op: '<',  vals: [15, 25] },
  { name: 'BOLL_UPPER',        col: 'boll_pct',    op: '>',  vals: [75, 85] },
  { name: 'BOLL_MID',          col: 'boll_pct',    op: 'range', vals: [[35, 65]] },
  { name: 'NEAR_MA20',         col: 'dist_ma20_pct', op: 'range', vals: [[-2, 2]] },
  { name: 'ABOVE_MA20',        col: 'dist_ma20_pct', op: '>', vals: [0, 3, 5] },
  { name: 'BELOW_MA20',        col: 'dist_ma20_pct', op: '<', vals: [-3, -5] },
  { name: 'ATR_HIGH',          col: 'atr_pct',     op: '>',  vals: [3, 4, 5] },
  { name: 'ATR_LOW',           col: 'atr_pct',     op: '<',  vals: [2, 1.5] },
  { name: 'SCORE_HIGH',        col: 'score100',    op: '>',  vals: [60, 65, 70] },
  { name: 'SCORE_MID',         col: 'score100',    op: 'range', vals: [[48, 60]] },
];

// Categorical features from fired_signals JSON
const SIGNAL_FEATURES = [
  'OBV_ACC', 'OBV_DIST', 'CMF_STRONG', 'CMF_NEG',
  'MACD_BULL_CROSS', 'MACD_BEAR_CROSS', 'MACD_HIST_POS',
  'TTM_FIRE', 'TTM_RELEASE', 'TTM_SQUEEZE_ON',
  'WYCKOFF_ACC', 'WYCKOFF_DIST', 'WYCKOFF_MARKUP', 'WYCKOFF_SPRING',
  'SUPERTREND_UP', 'SUPERTREND_DOWN', 'SUPERTREND_FLIP_UP',
  'ABOVE_MA20', 'ABOVE_MA50', 'ABOVE_MA200', 'GOLDEN_CROSS',
  'BB_SQUEEZE', 'VOL_EXPLOSIVE', 'VOL_HIGH',
  'RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'MFI_OVERSOLD',
  'RESISTANCE_BREAK', 'CUP_HANDLE', 'DOUBLE_BOTTOM',
];


// ════════════════════════════════════════════════════════════════════
// 1. EVALUATE HISTORICAL SIGNALS — ROI Backfill
// ════════════════════════════════════════════════════════════════════

/**
 * Calculate actual T+1, T+3, T+5 ROI for signals that have null outcomes.
 *
 * @param {Array<object>} openSignals - signals from db.getOpenSignals()
 * @param {Map<string, Array<{date:Date, close:number}>>} historicalData
 *   Pre-fetched price data keyed by symbol. Each value is an array of
 *   {date, close} sorted ascending by date.
 * @returns {Array<{id, t1Roi, t3Roi, t5Roi, outcome}>} outcome records to write back
 */
export function evaluateHistoricalSignals(openSignals, historicalData) {
  if (!openSignals?.length || !historicalData) return [];

  const outcomes = [];

  for (const sig of openSignals) {
    const sym = sig.symbol;
    const prices = historicalData.get?.(sym) || historicalData[sym];
    if (!prices?.length) continue;

    const entryPrice = sig.entry_price || sig.entryPrice;
    const signalTs   = sig.ts;
    if (!entryPrice || entryPrice <= 0 || !signalTs) continue;

    // Find the bar index at or immediately after signal timestamp
    const entryIdx = _findBarIndex(prices, signalTs);
    if (entryIdx < 0) continue;

    // T+1, T+3, T+5 ROI calculation
    const t1Roi = _calcRoi(entryPrice, prices, entryIdx, 1);
    const t3Roi = _calcRoi(entryPrice, prices, entryIdx, 3);
    const t5Roi = _calcRoi(entryPrice, prices, entryIdx, 5);

    // Determine outcome based on stop/target hit analysis
    const outcome = _determineOutcome(sig, prices, entryIdx, t1Roi, t3Roi);

    // Only emit if we have at least T+1 data
    if (t1Roi != null) {
      outcomes.push({
        id:       sig.id,
        t1Roi:    Math.round(t1Roi * 100) / 100,
        t3Roi:    t3Roi != null ? Math.round(t3Roi * 100) / 100 : null,
        t5Roi:    t5Roi != null ? Math.round(t5Roi * 100) / 100 : null,
        outcome,
      });
    }
  }

  return outcomes;
}

/**
 * End-to-end: fetch open signals from DB, evaluate, write back.
 * @param {object} db - DatabaseManager API instance
 * @param {Map<string, Array>} historicalData - pre-fetched prices
 * @returns {{evaluated: number, wins: number, losses: number}}
 */
export function runOutcomeBackfill(db, historicalData) {
  const openSignals = db.getOpenSignals(2000);
  if (!openSignals.length) return { evaluated: 0, wins: 0, losses: 0 };

  const outcomes = evaluateHistoricalSignals(openSignals, historicalData);
  if (!outcomes.length) return { evaluated: 0, wins: 0, losses: 0 };

  const updated = db.updateOutcomes(outcomes);
  const wins   = outcomes.filter(o => o.outcome === 'WIN' || o.outcome === 'TARGET_HIT').length;
  const losses = outcomes.filter(o => o.outcome === 'LOSS' || o.outcome === 'STOP_HIT').length;

  console.log(`[MLBacktest] Backfilled ${updated} signals: ${wins}W / ${losses}L`);
  return { evaluated: updated, wins, losses };
}


// ── Internal helpers ───────────────────────────────────────────────

function _findBarIndex(prices, ts) {
  // Binary search for the bar closest to (at or after) the signal timestamp
  const targetMs = typeof ts === 'number' ? ts : new Date(ts).getTime();
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const barMs = _barTime(prices[mid]);
    if (barMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  // Validate: bar must be within 2 trading days of signal
  const found = _barTime(prices[lo]);
  if (Math.abs(found - targetMs) > 5 * 86400000) return -1; // too far
  return lo;
}

function _barTime(bar) {
  if (!bar) return 0;
  if (bar.date instanceof Date) return bar.date.getTime();
  if (typeof bar.date === 'number') return bar.date;
  if (typeof bar.date === 'string') return new Date(bar.date).getTime();
  if (bar.timestamp) return typeof bar.timestamp === 'number' ? bar.timestamp : new Date(bar.timestamp).getTime();
  return 0;
}

function _calcRoi(entryPrice, prices, entryIdx, offset) {
  const targetIdx = entryIdx + offset;
  if (targetIdx >= prices.length) return null;
  const futureClose = prices[targetIdx].close;
  if (!futureClose || futureClose <= 0) return null;
  return ((futureClose - entryPrice) / entryPrice) * 100;
}

function _determineOutcome(sig, prices, entryIdx, t1Roi, t3Roi) {
  const entry = sig.entry_price || sig.entryPrice;
  const stop  = sig.stop_price || sig.stopPrice;
  const target = sig.target_price || sig.targetPrice;
  const direction = sig.direction || 'BUY';

  // Check for stop/target hit within T+5 window
  const lookAhead = Math.min(entryIdx + 5, prices.length);
  for (let i = entryIdx + 1; i < lookAhead; i++) {
    const bar = prices[i];
    if (!bar) continue;

    if (direction === 'BUY' || direction === 'HOLD') {
      if (stop && bar.low <= stop) return 'STOP_HIT';
      if (target && bar.high >= target) return 'TARGET_HIT';
    } else if (direction === 'SELL') {
      if (stop && bar.high >= stop) return 'STOP_HIT';
      if (target && bar.low <= target) return 'TARGET_HIT';
    }
  }

  // Fallback: use T+3 ROI (or T+1 if T+3 unavailable)
  const bestRoi = t3Roi ?? t1Roi;
  if (bestRoi == null) return 'OPEN';
  if (direction === 'BUY' || direction === 'HOLD') {
    return bestRoi > WIN_THRESHOLD_PCT ? 'WIN' : 'LOSS';
  }
  // SELL signals: negative ROI = win
  return bestRoi < -WIN_THRESHOLD_PCT ? 'WIN' : 'LOSS';
}


// ════════════════════════════════════════════════════════════════════
// 2. FEATURE IMPORTANCE — Information Gain & Correlation
// ════════════════════════════════════════════════════════════════════

/**
 * Compute per-feature predictive power from closed signals.
 *
 * Uses two metrics:
 *   - Pearson correlation with T+1 ROI (continuous)
 *   - Information gain: H(win) - H(win|feature_present) (binary)
 *
 * @param {object} db - DatabaseManager API
 * @param {string} [direction='BUY']
 * @returns {Array<{name, infoGain, correlation, sampleCount}>}
 */
export function computeFeatureImportance(db, direction = 'BUY') {
  const signals = db.getClosedSignals({ direction, limit: 10000 });
  if (signals.length < 30) return [];

  // Preprocess: parse fired_signals JSON and extract numeric features
  const rows = signals.map(s => ({
    ...s,
    _fired: _parseFired(s.fired_signals || s.firedSignals),
    _roi:   s.actual_t1_roi ?? 0,
    _win:   (s.actual_t1_roi ?? 0) > WIN_THRESHOLD_PCT ? 1 : 0,
  }));

  const baseWinRate = rows.reduce((s, r) => s + r._win, 0) / rows.length;
  const baseEntropy = _entropy(baseWinRate);
  const results = [];

  // ── Numeric features ──
  for (const fd of FEATURE_DEFS) {
    for (const threshold of fd.vals) {
      const label = _makeLabel(fd.name, fd.op, threshold);
      const present = [];
      const absent  = [];

      for (const r of rows) {
        const val = _getNumericVal(r, fd.col);
        if (val == null) continue;
        const match = _evalCondition(val, fd.op, threshold);
        (match ? present : absent).push(r);
      }

      if (present.length < 5 || absent.length < 5) continue;

      const ig = _infoGain(present, absent, baseEntropy, rows.length);
      const corr = _pointBiserialCorr(present, absent);

      results.push({
        name: label,
        infoGain: Math.round(ig * 10000) / 10000,
        correlation: Math.round(corr * 10000) / 10000,
        sampleCount: present.length,
        winRate: present.reduce((s, r) => s + r._win, 0) / present.length,
        avgRoi: present.reduce((s, r) => s + r._roi, 0) / present.length,
      });
    }
  }

  // ── Categorical features (from fired_signals) ──
  for (const sf of SIGNAL_FEATURES) {
    const present = rows.filter(r => r._fired.has(sf));
    const absent  = rows.filter(r => !r._fired.has(sf));
    if (present.length < 5 || absent.length < 5) continue;

    const ig = _infoGain(present, absent, baseEntropy, rows.length);
    const corr = _pointBiserialCorr(present, absent);

    results.push({
      name: 'SIG_' + sf,
      infoGain: Math.round(ig * 10000) / 10000,
      correlation: Math.round(corr * 10000) / 10000,
      sampleCount: present.length,
      winRate: present.reduce((s, r) => s + r._win, 0) / present.length,
      avgRoi: present.reduce((s, r) => s + r._roi, 0) / present.length,
    });
  }

  // Sort by information gain descending
  results.sort((a, b) => b.infoGain - a.infoGain);

  // Persist to DB
  db.updateFeatureImportance(results);

  console.log(`[MLBacktest] Feature importance: ${results.length} features ranked (${signals.length} samples)`);
  return results;
}


// ── Statistical helpers ────────────────────────────────────────────

function _entropy(p) {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

function _infoGain(present, absent, baseEntropy, totalN) {
  const pWin = present.reduce((s, r) => s + r._win, 0) / present.length;
  const aWin = absent.reduce((s, r) => s + r._win, 0) / absent.length;
  const pWeight = present.length / totalN;
  const aWeight = absent.length / totalN;
  const condEntropy = pWeight * _entropy(pWin) + aWeight * _entropy(aWin);
  return Math.max(0, baseEntropy - condEntropy);
}

function _pointBiserialCorr(present, absent) {
  // Point-biserial correlation between binary group membership and ROI
  const m1 = present.reduce((s, r) => s + r._roi, 0) / present.length;
  const m0 = absent.reduce((s, r) => s + r._roi, 0) / absent.length;
  const n1 = present.length;
  const n0 = absent.length;
  const N  = n1 + n0;

  // Pool variance
  let sumSq = 0;
  const mean = (present.reduce((s, r) => s + r._roi, 0) + absent.reduce((s, r) => s + r._roi, 0)) / N;
  for (const r of present) sumSq += (r._roi - mean) ** 2;
  for (const r of absent)  sumSq += (r._roi - mean) ** 2;
  const sd = Math.sqrt(sumSq / N);
  if (sd === 0) return 0;

  return ((m1 - m0) / sd) * Math.sqrt((n1 * n0) / (N * N));
}

function _parseFired(val) {
  if (val instanceof Set) return val;
  if (Array.isArray(val)) return new Set(val);
  if (typeof val === 'string') {
    try { return new Set(JSON.parse(val)); } catch { return new Set(); }
  }
  return new Set();
}

// Alias map: DB/feature column → scan result field name
// Handles naming mismatches between FEATURE_DEFS columns and live scan data
const _COL_ALIASES = {
  score100:       'score',          // genSignal outputs 'score' (0-100)
  dist_ma20_pct:  'distFromMA20',   // scan stores as distFromMA20
  boll_pct:       'bollPct',        // scan stores as bollPct
  vol_ratio:      'volRatio',       // scan stores as volRatio
  atr_pct:        'atrPct',         // scan stores as atrPct
};

function _getNumericVal(row, col) {
  // 1. Direct column match
  const v = row[col];
  if (v != null && Number.isFinite(v)) return v;
  // 2. Explicit alias match
  const alias = _COL_ALIASES[col];
  if (alias) {
    const va = row[alias];
    if (va != null && Number.isFinite(va)) return va;
  }
  // 3. camelCase fallback
  const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const v2 = row[camel];
  return (v2 != null && Number.isFinite(v2)) ? v2 : null;
}

function _evalCondition(val, op, threshold) {
  if (op === '<')  return val < threshold;
  if (op === '>')  return val > threshold;
  if (op === '<=') return val <= threshold;
  if (op === '>=') return val >= threshold;
  if (op === 'range') {
    const [lo, hi] = Array.isArray(threshold) ? threshold : [0, 0];
    return val >= lo && val <= hi;
  }
  return false;
}

function _makeLabel(name, op, threshold) {
  if (op === 'range') {
    const [lo, hi] = Array.isArray(threshold) ? threshold : [0, 0];
    return `${name}[${lo}-${hi}]`;
  }
  return `${name}${op}${threshold}`;
}


// ════════════════════════════════════════════════════════════════════
// 3. COMBINATORIAL RULE DISCOVERY — Exhaustive 1-2-3 Feature Combos
// ════════════════════════════════════════════════════════════════════

/**
 * Autonomous rule discovery: find combinations of technical conditions
 * that historically produced winning trades.
 *
 * Algorithm:
 *   1. Get closed signals from DB
 *   2. Rank features by information gain (top K)
 *   3. Generate all 1-combo, 2-combo, 3-combo rules from top K features
 *   4. For each combo, compute win_rate, avg_roi, expectancy, profit_factor
 *   5. Filter: min_occurrences >= 10, win_rate >= 50%
 *   6. Persist top rules to DB
 *
 * @param {object} db - DatabaseManager API instance
 * @param {object} [opts]
 * @param {number} [opts.topK=15]        - top K features to combine
 * @param {number} [opts.minOccurrences] - override MIN_SAMPLES_FOR_RULE
 * @param {number} [opts.maxDepth]       - override MAX_COMBO_DEPTH
 * @param {string} [opts.direction='BUY']
 * @returns {Array<object>} discovered rules
 */
export function extractWinningRules(db, opts = {}) {
  const {
    topK         = 15,
    minOccurrences = MIN_SAMPLES_FOR_RULE,
    maxDepth     = MAX_COMBO_DEPTH,
    direction    = 'BUY',
  } = opts;

  // Step 1: Get closed signal data
  const signals = db.getClosedSignals({ direction, limit: 10000 });
  if (signals.length < minOccurrences * 2) {
    console.warn(`[MLBacktest] Not enough data for rule discovery (${signals.length} signals)`);
    return [];
  }

  // Preprocess rows
  const rows = signals.map(s => ({
    ...s,
    _fired: _parseFired(s.fired_signals || s.firedSignals),
    _roi:   s.actual_t1_roi ?? 0,
    _win:   (s.actual_t1_roi ?? 0) > WIN_THRESHOLD_PCT ? 1 : 0,
  }));

  // Step 2: Compute feature importance to select top K
  const featureRanking = _rankFeaturesInternal(rows);
  const topFeatures = featureRanking.slice(0, topK);

  if (topFeatures.length === 0) return [];

  // Step 3: Generate and evaluate rule combinations
  const allRules = [];

  // Depth 1: single conditions
  for (const f of topFeatures) {
    const stats = _evalRule(rows, [f]);
    if (stats && stats.total >= minOccurrences) {
      allRules.push(_buildRuleObj([f], stats, direction));
    }
  }

  // Depth 2: pairs
  if (maxDepth >= 2) {
    for (let i = 0; i < topFeatures.length; i++) {
      for (let j = i + 1; j < topFeatures.length; j++) {
        // Skip contradictory pairs (e.g., RSI_OVERSOLD + RSI_OVERBOUGHT)
        if (_isContradictory(topFeatures[i], topFeatures[j])) continue;
        const stats = _evalRule(rows, [topFeatures[i], topFeatures[j]]);
        if (stats && stats.total >= minOccurrences) {
          allRules.push(_buildRuleObj([topFeatures[i], topFeatures[j]], stats, direction));
        }
      }
    }
  }

  // Depth 3: triples (only from best pairs)
  if (maxDepth >= 3) {
    // Only combine top-performing pairs with additional features to limit explosion
    const bestPairs = allRules
      .filter(r => r.conditions.length === 2 && r.winRatePct >= 55)
      .sort((a, b) => b.expectancy - a.expectancy)
      .slice(0, 20);

    for (const pair of bestPairs) {
      const pairConds = JSON.parse(pair.conditions);
      const pairNames = new Set(pairConds.map(c => c.name));

      for (const f of topFeatures) {
        if (pairNames.has(f.name)) continue;
        if (pairConds.some(c => _isContradictory(c, f))) continue;

        const allConds = [...pairConds, f];
        const stats = _evalRule(rows, allConds);
        if (stats && stats.total >= minOccurrences) {
          allRules.push(_buildRuleObj(allConds, stats, direction));
        }
      }
    }
  }

  // Step 4: Sort by expectancy (most profitable first), cap at MAX_RULES
  allRules.sort((a, b) => b.expectancy - a.expectancy);
  const topRules = allRules.slice(0, MAX_RULES);

  // Step 5: Persist to DB
  db.upsertRules(topRules);

  console.log(`[MLBacktest] Discovered ${topRules.length} rules from ${signals.length} signals`);
  return topRules;
}

// ── Internal rule evaluation ───────────────────────────────────────

function _rankFeaturesInternal(rows) {
  const baseWinRate = rows.reduce((s, r) => s + r._win, 0) / rows.length;
  const baseEntropy = _entropy(baseWinRate);
  const features = [];

  // Numeric features
  for (const fd of FEATURE_DEFS) {
    for (const threshold of fd.vals) {
      const present = [];
      const absent  = [];
      for (const r of rows) {
        const val = _getNumericVal(r, fd.col);
        if (val == null) continue;
        (_evalCondition(val, fd.op, threshold) ? present : absent).push(r);
      }
      if (present.length < 5 || absent.length < 5) continue;
      const ig = _infoGain(present, absent, baseEntropy, rows.length);
      features.push({
        name: _makeLabel(fd.name, fd.op, threshold),
        type: 'numeric',
        col: fd.col,
        op: fd.op,
        threshold,
        infoGain: ig,
        sampleCount: present.length,
      });
    }
  }

  // Categorical (fired signals)
  for (const sf of SIGNAL_FEATURES) {
    const present = rows.filter(r => r._fired.has(sf));
    const absent  = rows.filter(r => !r._fired.has(sf));
    if (present.length < 5 || absent.length < 5) continue;
    const ig = _infoGain(present, absent, baseEntropy, rows.length);
    features.push({
      name: 'SIG_' + sf,
      type: 'signal',
      signalKey: sf,
      infoGain: ig,
      sampleCount: present.length,
    });
  }

  features.sort((a, b) => b.infoGain - a.infoGain);
  return features;
}

function _evalRule(rows, conditions) {
  // Filter rows that match ALL conditions
  const matching = rows.filter(r => {
    for (const cond of conditions) {
      if (cond.type === 'signal') {
        if (!r._fired.has(cond.signalKey)) return false;
      } else {
        const val = _getNumericVal(r, cond.col);
        if (val == null || !_evalCondition(val, cond.op, cond.threshold)) return false;
      }
    }
    return true;
  });

  if (matching.length === 0) return null;

  const wins   = matching.filter(r => r._win === 1);
  const losses = matching.filter(r => r._win === 0);
  const rois   = matching.map(r => r._roi);
  const avgRoi = rois.reduce((s, v) => s + v, 0) / rois.length;

  const winRois  = wins.map(r => r._roi);
  const lossRois = losses.map(r => r._roi);
  const avgWin   = winRois.length ? winRois.reduce((s, v) => s + v, 0) / winRois.length : 0;
  const avgLoss  = lossRois.length ? lossRois.reduce((s, v) => s + v, 0) / lossRois.length : 0;

  const winRate = wins.length / matching.length;
  const grossWin  = winRois.reduce((s, v) => s + Math.max(0, v), 0);
  const grossLoss = Math.abs(lossRois.reduce((s, v) => s + Math.min(0, v), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Expectancy = (winRate × avgWin) + (lossRate × avgLoss)
  const expectancy = (winRate * avgWin) + ((1 - winRate) * avgLoss);

  // Sharpe-like ratio: mean(roi) / std(roi)
  const mean = avgRoi;
  const variance = rois.reduce((s, v) => s + (v - mean) ** 2, 0) / rois.length;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

  // Max drawdown (sequential)
  let peak = 0, dd = 0, maxDD = 0;
  for (const r of rois) {
    peak = Math.max(peak, peak + r);
    dd = peak - (peak + r - Math.max(peak, peak + r)); // simplified running dd
    // Actually track cumulative equity
  }
  // Simple max drawdown from equity curve
  let equity = 0, peakEq = 0;
  for (const r of rois) {
    equity += r;
    peakEq = Math.max(peakEq, equity);
    maxDD = Math.min(maxDD, equity - peakEq);
  }

  return {
    total:        matching.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate,
    avgRoi,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    sharpe,
    maxDrawdown:  maxDD,
  };
}

function _buildRuleObj(conditions, stats, direction) {
  const condArray = conditions.map(c => ({
    name: c.name,
    type: c.type,
    col: c.col || null,
    op: c.op || null,
    threshold: c.threshold || null,
    signalKey: c.signalKey || null,
  }));

  const setupName = conditions.map(c => c.name).join(' + ');
  const ruleHash  = conditions.map(c => c.name).sort().join(RULE_HASH_SEPARATOR);

  return {
    rule_hash:      ruleHash,
    setup_name:     setupName,
    conditions:     JSON.stringify(condArray),
    direction,
    total_count:    stats.total,
    win_count:      stats.wins,
    loss_count:     stats.losses,
    win_rate_pct:   Math.round(stats.winRate * 10000) / 100,  // e.g. 67.85
    avg_roi_pct:    Math.round(stats.avgRoi * 100) / 100,
    avg_win_roi:    Math.round(stats.avgWin * 100) / 100,
    avg_loss_roi:   Math.round(stats.avgLoss * 100) / 100,
    expectancy:     Math.round(stats.expectancy * 100) / 100,
    sharpe:         Math.round(stats.sharpe * 1000) / 1000,
    max_drawdown:   Math.round(stats.maxDrawdown * 100) / 100,
    profit_factor:  Math.round(stats.profitFactor * 100) / 100,
  };
}

function _isContradictory(a, b) {
  // Simple heuristic: same base feature with opposite directions
  const baseName = n => n.name?.replace(/[<>]=?\d+\.?\d*|\[.*?\]/g, '').replace(/SIG_/, '') || '';
  const aBase = baseName(a);
  const bBase = baseName(b);
  if (aBase !== bBase) return false;
  // Same feature, different direction: e.g. RSI_OVERSOLD vs RSI_OVERBOUGHT
  if (a.op === '<' && b.op === '>') return true;
  if (a.op === '>' && b.op === '<') return true;
  return false;
}


// ════════════════════════════════════════════════════════════════════
// 4. LIVE SIGNAL SCORING — Apply Discovered Rules
// ════════════════════════════════════════════════════════════════════

/**
 * v29 REGIME GATE — is this an overbought-momentum rule?
 * These rules (RSI_OVERBOUGHT / MFI_HIGH patterns) show 71-90% win rate in the
 * 3-year training data (bull-inclusive), but the recent-6mo backtest found the
 * same pattern loses in choppy regimes (~20% WR). We only trust them in a
 * confirmed uptrend.
 * @param {object} rule - discovered rule with setup_name / conditions
 * @returns {boolean}
 */
export function isOverboughtMomentumRule(rule) {
  const name = (rule.setup_name || rule.setupName || rule.conditions || '').toString().toUpperCase();
  return /RSI_OVERBOUGHT|MFI_HIGH/.test(name);
}

/**
 * v29 REGIME GATE — filter the rule set for a signal's regime.
 * In a confirmed uptrend (ADX>25 + supertrend UP + weekly bull) ALL rules apply.
 * Otherwise overbought-momentum rules are removed so v29's overbought guards are
 * not undone by the ML boost. Missing regime data → conservative (not uptrend).
 * @param {Array<object>} rules
 * @param {{adx?: number, supertrendTrend?: string, weeklyTrend?: string}} ctx
 * @returns {{rules: Array, gated: boolean, suppressed: number}}
 */
export function filterRulesForRegime(rules, ctx) {
  if (!rules?.length) return { rules: rules || [], gated: false, suppressed: 0 };
  const confirmedUptrend =
    (ctx?.adx || 0) > 25 &&
    ctx?.supertrendTrend === 'UP' &&
    ctx?.weeklyTrend === 'bull';
  if (confirmedUptrend) return { rules, gated: false, suppressed: 0 };
  const filtered = rules.filter(r => !isOverboughtMomentumRule(r));
  return { rules: filtered, gated: filtered.length < rules.length, suppressed: rules.length - filtered.length };
}

/**
 * Score a new signal against discovered rules.
 * Returns the matching rules and a composite confidence boost.
 *
 * @param {object} signal - live signal with indicator data (same shape as scan result)
 * @param {Array<object>} rules - from db.getTopRules()
 * @returns {{matchedRules: Array, confidenceBoost: number, ruleCount: number}}
 */
export function scoreNewSignal(signal, rules) {
  if (!rules?.length || !signal) return { matchedRules: [], confidenceBoost: 0, ruleCount: 0 };

  const fired = _parseFired(signal.firedSignals || signal.fired_signals);
  const matched = [];

  for (const rule of rules) {
    const conditions = typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions;
    if (!conditions?.length) continue;

    let allMatch = true;
    for (const cond of conditions) {
      if (cond.type === 'signal') {
        if (!fired.has(cond.signalKey)) { allMatch = false; break; }
      } else {
        const val = _getNumericVal(signal, cond.col);
        if (val == null || !_evalCondition(val, cond.op, cond.threshold)) { allMatch = false; break; }
      }
    }

    if (allMatch) {
      matched.push({
        setupName:  rule.setup_name || rule.setupName,
        winRate:    rule.win_rate_pct || rule.winRatePct,
        avgRoi:     rule.avg_roi_pct || rule.avgRoiPct,
        expectancy: rule.expectancy,
        conditions: conditions.length,
      });
    }
  }

  // Confidence boost: weighted average of matched rules' expectancy
  // More rules matching = higher confidence, but diminishing returns
  let boost = 0;
  if (matched.length > 0) {
    const totalExp = matched.reduce((s, r) => s + (r.expectancy || 0), 0);
    const avgExp = totalExp / matched.length;
    // Scale: avg expectancy of +2% → +5 confidence points, +5% → +10 points
    boost = Math.min(15, Math.max(-10, avgExp * 2.5));
    // Multi-rule confluence bonus (diminishing)
    boost += Math.min(5, (matched.length - 1) * 1.5);
    // Minimum base boost: any matched rule = at least +1 confidence
    // This ensures ML badges always show when rules fire, even with zero expectancy
    if (boost < 1) boost = 1;
  }

  return {
    matchedRules: matched.sort((a, b) => (b.expectancy || 0) - (a.expectancy || 0)),
    confidenceBoost: Math.round(boost * 10) / 10,
    ruleCount: matched.length,
  };
}


// ════════════════════════════════════════════════════════════════════
// 5. ORCHESTRATOR — Full Self-Learning Pipeline
// ════════════════════════════════════════════════════════════════════

/**
 * Run the complete self-learning pipeline:
 *   1. Backfill outcomes for open signals
 *   2. Compute feature importance
 *   3. Discover winning rules
 *
 * Call this periodically (e.g., after market close or nightly).
 *
 * @param {object} db - DatabaseManager API
 * @param {Map<string, Array>} historicalData - price data for all relevant symbols
 * @param {object} [opts] - options for rule discovery
 * @returns {object} pipeline results summary
 */
export function runLearningPipeline(db, historicalData, opts = {}) {
  const t0 = Date.now();

  // Step 1: Backfill outcomes
  const backfill = runOutcomeBackfill(db, historicalData);

  // Step 2: Feature importance (only if enough closed signals)
  const stats = db.getStats();
  let featureImportance = [];
  if ((stats.closed || 0) >= 50) {
    featureImportance = computeFeatureImportance(db, opts.direction || 'BUY');
  }

  // Step 3: Rule discovery (only if enough closed signals)
  let rules = [];
  if ((stats.closed || 0) >= MIN_SAMPLES_FOR_RULE * 3) {
    rules = extractWinningRules(db, opts);
  }

  const elapsed = Date.now() - t0;
  const summary = {
    elapsed_ms: elapsed,
    signals_evaluated: backfill.evaluated,
    wins: backfill.wins,
    losses: backfill.losses,
    features_ranked: featureImportance.length,
    rules_discovered: rules.length,
    top3_rules: rules.slice(0, 3).map(r => ({
      name: r.setup_name,
      winRate: r.win_rate_pct,
      expectancy: r.expectancy,
      count: r.total_count,
    })),
    db_stats: stats,
  };

  console.log(`[MLBacktest] Pipeline complete in ${elapsed}ms:`, summary);
  return summary;
}


// ════════════════════════════════════════════════════════════════════
// 6. SIGNAL INGESTION — Hook into existing useAIAdvisor scan results
// ════════════════════════════════════════════════════════════════════

/**
 * Convert advisor scan results into trade_signals rows and insert.
 * Call after every advisor scan completes.
 *
 * @param {object} db - DatabaseManager API
 * @param {Array<object>} scanResults - from useAIAdvisor.scanResults
 * @param {string} [filterDirection] - only ingest 'BUY' signals, or null for all
 * @returns {number} inserted count
 */
export function ingestScanResults(db, scanResults, filterDirection = null) {
  if (!scanResults?.length) return 0;

  const signals = scanResults
    .filter(r => {
      if (filterDirection && r.cls?.toUpperCase() !== filterDirection) return false;
      return r.entry || r.price; // must have a price
    })
    .map(r => ({
      symbol:       r.symbol,
      ts:           r._scanTs || Date.now(),
      direction:    r.cls?.toUpperCase() || 'HOLD',
      score100:     r.score ?? null,
      rawScore:     r.rawScore ?? null,
      entry:        r.entry || r.price,
      stop:         r.stop,
      t1:           r.target,
      rr:           r.rr,
      atrPct:       r.atrPct,
      rsi:          r.rsi,
      mfi:          r.mfi,
      adx:          r.adx,
      cmf:          r.cmf,
      volRatio:     r.volRatio,
      bollPct:      r.bollPct,
      distFromMA20: r.distFromMA20,
      ma50pct:      r.ma50pct,
      obvTrend:     r.obvTrend,
      wyckoff:      r.wyckoff,
      supertrend:   r.supertrend,
      ichimoku:     r.ichimoku,
      ttmSqueeze:   r.ttmSqueeze,
      firedSignals: r.firedSignals,
      regime:       r.regime,
      setupGrade:   r.setupGrade,
      sector:       r.sector,
    }));

  return db.insertSignals(signals);
}


export default {
  evaluateHistoricalSignals,
  runOutcomeBackfill,
  computeFeatureImportance,
  extractWinningRules,
  scoreNewSignal,
  runLearningPipeline,
  ingestScanResults,
};
