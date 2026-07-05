// ============================================================
// SIGNAL CALIBRATION ENGINE
// ------------------------------------------------------------
// Builds a feedback model from historical signals (last N closed
// trades from useSignalTracker) and adjusts new signal scores
// using realized winRate × expectancy.
//
// Pure module — no React, no DOM. Safe to import from signals.js.
// ============================================================

const MIN_SAMPLES = 8;          // need at least 8 closed signals to trust a bucket
const MAX_MULTIPLIER = 1.30;    // hard cap up
const MIN_MULTIPLIER = 0.55;    // hard cap down
const NEUTRAL_WIN_RATE = 0.50;
const NEUTRAL_EXPECTANCY = 0;   // %

// Module-level singleton — set by useSignalTracker, read by genSignal
let _activeModel = null;

export function setSignalCalibration(model) { _activeModel = model || null; }
export function getSignalCalibration() { return _activeModel; }
export function clearSignalCalibration() { _activeModel = null; }

function safeNum(x, fb = 0) {
  return Number.isFinite(x) ? x : fb;
}

// Bucket score 0-100 into 4 quartiles
function scoreBucket(score100) {
  if (score100 == null || !Number.isFinite(score100)) return 'mid';
  if (score100 >= 75) return 'q4';
  if (score100 >= 50) return 'q3';
  if (score100 >= 25) return 'q2';
  return 'q1';
}

function mkBucket() {
  return { closed: 0, wins: 0, losses: 0, sumRoi: 0, sumWinRoi: 0, sumLossRoi: 0 };
}

function pushSignal(bucket, sig) {
  if (!sig || sig.status !== 'closed') return;
  bucket.closed += 1;
  const roi = safeNum(sig.perf?.d5, safeNum(sig.perf?.d3, safeNum(sig.perf?.d1, 0)));
  bucket.sumRoi += roi;
  if (sig.outcome === 'TARGET_HIT' || sig.outcome === 'WIN') {
    bucket.wins += 1;
    bucket.sumWinRoi += Math.max(0, roi);
  } else if (sig.outcome === 'STOP_HIT' || sig.outcome === 'LOSS') {
    bucket.losses += 1;
    bucket.sumLossRoi += Math.min(0, roi);
  }
}

function summarize(bucket) {
  const n = bucket.closed;
  if (n === 0) {
    return { samples: 0, winRate: NEUTRAL_WIN_RATE, expectancy: NEUTRAL_EXPECTANCY, score: 0 };
  }
  const winRate = (bucket.wins) / n;
  const expectancy = bucket.sumRoi / n;
  // Composite reliability score (0-1): equal weight to winRate vs expectancy
  // Normalize expectancy through tanh so a +5% avg ≈ 0.46, +10% ≈ 0.76
  const expN = Math.tanh(expectancy / 7);
  const score = (winRate - 0.5) * 1.0 + expN * 0.7;
  return { samples: n, winRate, expectancy, score };
}

// ------------------------------------------------------------
// buildCalibrationModel — group signals by (cls, source, grade,
// scoreBucket) and produce summary stats per bucket.
// ------------------------------------------------------------
export function buildCalibrationModel(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const closed = list.filter(s => s && s.status === 'closed' && s.outcome);

  const byClass = { buy: mkBucket(), sell: mkBucket(), hold: mkBucket() };
  const bySource = {};
  const byGrade = {};
  const byScoreBucket = { q1: mkBucket(), q2: mkBucket(), q3: mkBucket(), q4: mkBucket() };
  const byClassScore = {
    'buy:q1': mkBucket(), 'buy:q2': mkBucket(), 'buy:q3': mkBucket(), 'buy:q4': mkBucket(),
    'sell:q1': mkBucket(), 'sell:q2': mkBucket(), 'sell:q3': mkBucket(), 'sell:q4': mkBucket(),
  };
  // Regime-sliced buckets (v2): a multiplier earned in BULL must not inflate
  // BEAR signals — the known failure mode of blended calibration.
  const byClsRegime = {};        // 'buy:BULL'
  const byClsRegimeScore = {};   // 'buy:BULL:q3'
  const overall = mkBucket();

  for (const s of closed) {
    pushSignal(overall, s);
    const cls = s.cls || 'hold';
    if (byClass[cls]) pushSignal(byClass[cls], s);

    const src = s.source || 'manual';
    if (!bySource[src]) bySource[src] = mkBucket();
    pushSignal(bySource[src], s);

    const grade = s.setupGrade || s.grade || null;
    if (grade) {
      if (!byGrade[grade]) byGrade[grade] = mkBucket();
      pushSignal(byGrade[grade], s);
    }

    const sb = scoreBucket(s.score100 || s.score);
    if (byScoreBucket[sb]) pushSignal(byScoreBucket[sb], s);

    const clsScoreKey = `${cls}:${sb}`;
    if (byClassScore[clsScoreKey]) pushSignal(byClassScore[clsScoreKey], s);

    const regime = typeof s.regime === 'string' ? s.regime : s.regime?.regime;
    if (regime && (cls === 'buy' || cls === 'sell')) {
      const crKey = `${cls}:${regime}`;
      if (!byClsRegime[crKey]) byClsRegime[crKey] = mkBucket();
      pushSignal(byClsRegime[crKey], s);
      const crsKey = `${cls}:${regime}:${sb}`;
      if (!byClsRegimeScore[crsKey]) byClsRegimeScore[crsKey] = mkBucket();
      pushSignal(byClsRegimeScore[crsKey], s);
    }
  }

  const model = {
    builtAt: Date.now(),
    sampleCount: closed.length,
    overall: summarize(overall),
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, summarize(v)])),
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, summarize(v)])),
    byGrade: Object.fromEntries(Object.entries(byGrade).map(([k, v]) => [k, summarize(v)])),
    byScoreBucket: Object.fromEntries(Object.entries(byScoreBucket).map(([k, v]) => [k, summarize(v)])),
    byClassScore: Object.fromEntries(Object.entries(byClassScore).map(([k, v]) => [k, summarize(v)])),
    byClsRegime: Object.fromEntries(Object.entries(byClsRegime).map(([k, v]) => [k, summarize(v)])),
    byClsRegimeScore: Object.fromEntries(Object.entries(byClsRegimeScore).map(([k, v]) => [k, summarize(v)])),
  };
  return model;
}

// ------------------------------------------------------------
// calibrateScore — given a candidate signal's raw 0-100 score and
// hints (cls, source, grade), look up matching buckets and return
// a multiplier with debug breakdown. Multiplier ∈ [MIN, MAX].
// ------------------------------------------------------------
export function calibrateScore(score100, { cls, source, grade, regime } = {}, model = _activeModel) {
  if (!model || !model.sampleCount || model.sampleCount < MIN_SAMPLES) {
    return { multiplier: 1, applied: false, reason: 'insufficient_history', breakdown: [] };
  }

  const breakdown = [];
  let weightedDelta = 0;   // sum of (bucket.score × weight)
  let totalWeight = 0;

  function consider(label, bucket, weight) {
    if (!bucket || bucket.samples < MIN_SAMPLES) return;
    const delta = bucket.score; // typically -0.7 .. +0.7
    weightedDelta += delta * weight;
    totalWeight += weight;
    breakdown.push({ label, samples: bucket.samples, winRate: +bucket.winRate.toFixed(3), expectancy: +bucket.expectancy.toFixed(2), weight });
  }

  // Hierarchy: most-specific bucket gets highest weight. Regime-sliced buckets
  // (when populated) outrank blended ones so BULL-earned edge stays in BULL.
  const sb = scoreBucket(score100);
  const regLabel = typeof regime === 'string' ? regime : regime?.regime;
  if (cls && (cls === 'buy' || cls === 'sell')) {
    if (regLabel) {
      consider(`cls+regime+score:${cls}:${regLabel}:${sb}`, model.byClsRegimeScore?.[`${cls}:${regLabel}:${sb}`], 5);
      consider(`cls+regime:${cls}:${regLabel}`, model.byClsRegime?.[`${cls}:${regLabel}`], 3);
    }
    consider(`cls+score:${cls}:${sb}`, model.byClassScore?.[`${cls}:${sb}`], 4);
    consider(`cls:${cls}`, model.byClass?.[cls], 2);
  }
  if (grade) consider(`grade:${grade}`, model.byGrade?.[grade], 2);
  if (source) consider(`source:${source}`, model.bySource?.[source], 1);
  consider('overall', model.overall.samples ? model.overall : null, 0.5);

  if (totalWeight === 0) {
    return { multiplier: 1, applied: false, reason: 'no_matching_bucket', breakdown };
  }

  const avgDelta = weightedDelta / totalWeight;
  // avgDelta ∈ ~[-1, +1] → map to multiplier ∈ [MIN, MAX] around 1.0
  let multiplier = 1 + avgDelta * 0.30;
  if (multiplier > MAX_MULTIPLIER) multiplier = MAX_MULTIPLIER;
  if (multiplier < MIN_MULTIPLIER) multiplier = MIN_MULTIPLIER;

  return {
    multiplier: +multiplier.toFixed(3),
    applied: true,
    reason: 'calibrated',
    avgDelta: +avgDelta.toFixed(3),
    breakdown,
  };
}

// ------------------------------------------------------------
// applyCalibrationToScore — convenience wrapper used by genSignal.
// Pulls score100 toward 50 (neutral) when multiplier < 1 and
// pushes it away from 50 when multiplier > 1. Keeps result in [0,100].
// ------------------------------------------------------------
export function applyCalibrationToScore(score100, hints) {
  const cal = calibrateScore(score100, hints);
  if (!cal.applied) return { score100, calibration: cal };

  // Translate score around neutral 50, scale by multiplier, translate back.
  const centered = score100 - 50;
  const adjusted = centered * cal.multiplier;
  const out = Math.max(0, Math.min(100, 50 + adjusted));
  return { score100: out, calibration: cal };
}
