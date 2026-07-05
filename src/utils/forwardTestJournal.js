// ════════════════════════════════════════════════════════════════════
// forwardTestJournal.js — Immutable Daily Prediction Ledger
// ════════════════════════════════════════════════════════════════════
//
// Purpose: Answer the single most important question about this system —
// "How accurate are the next-day predictions, really?"
//
// Neither useSignalTracker (dedups, mutable, mixed sources) nor
// PaperTradeEngine (only trades TOP-3 ML picks) gives a clean, immutable
// daily prediction record. This module does ONE thing well:
//
//   1. On each `advisor-scan-complete`, snapshot the day's top buy picks
//      into an immutable per-day record (keyed by trading date).
//   2. Periodically evaluate matured snapshots against real prices to get
//      directional hit rate + D1/D3/D5 realized return + expectancy.
//   3. Aggregate honest accuracy stats (overall + by grade + by tier).
//
// This is the "ground truth" measurement: without it, every new feature is
// just overfitting in the dark. Pure logic — no React, fully testable.
// ════════════════════════════════════════════════════════════════════

import { TOTAL_COST_PCT } from './tradingCosts.js';

export const JOURNAL_STORAGE_KEY = 'bist_forward_journal_v1';
export const MAX_JOURNAL_DAYS = 180;          // ~6 months of trading days
export const MAX_PICKS_PER_DAY = 8;           // mirror AI Advisor buyPicks cap
const TRADING_DAY_MS = 1000 * 60 * 60 * 24;

// Round-trip cost in percentage points; subtracted from gross returns to get
// net figures. Gross fields stay untouched so v1 records remain comparable.
export const ROUND_TRIP_COST_PP = TOTAL_COST_PCT * 100;
// A stopped-out pick counts as "recovered" if price later regains entry +2%.
const RECOVERY_PCT = 2;

// ── Date key (Istanbul trading day, YYYY-MM-DD) ──
export function tradingDayKey(ts = Date.now()) {
  // BIST trades in Europe/Istanbul (UTC+3, no DST). Normalize to that offset
  // so a scan at 17:25 local always maps to the correct calendar trading day.
  const d = new Date(ts + 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ── Storage ──
export function loadJournal() {
  try {
    const raw = localStorage.getItem(JOURNAL_STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function persistJournal(days) {
  try {
    const trimmed = days
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, MAX_JOURNAL_DAYS);
    localStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch { return days; }
}

// ── Snapshot a scan into the journal (immutable per day) ──
//
// Policy: keep ONE record per trading day. We overwrite with the LATEST scan
// of the day so the prediction reflects the freshest pre-close information,
// BUT we never mutate a day once its predictions have started maturing
// (any pick has a recorded outcome) — that protects the ground truth.
export function recordSnapshot(days, eventDetail, now = Date.now()) {
  const detail = eventDetail || {};
  const picks = Array.isArray(detail.topPicks) ? detail.topPicks : [];
  const buyPicks = picks
    .filter(p => p && p.cls === 'buy' && p.symbol)
    .slice(0, MAX_PICKS_PER_DAY);

  if (!buyPicks.length) return days; // nothing worth recording

  const date = tradingDayKey(now);
  const existing = days.find(d => d.date === date);

  // Freeze a day once any prediction has matured — never overwrite ground truth.
  if (existing && existing.predictions.some(p => p.evaluatedAt)) {
    return days;
  }

  const predictions = buyPicks.map(p => ({
    symbol: p.symbol,
    sector: p.sector || '',
    cls: 'buy',
    entryPrice: p.price ?? p.entry ?? p.currentPrice ?? null,
    target: p.target ?? p.t1 ?? null,
    stop: p.stop ?? null,
    rr: p.rr ?? null,
    rrNet: p.rrNet ?? null,
    score: p.score ?? null,
    grade: p.grade || '',
    tier: p.tier || '',
    confidence: p.confidence ?? null,
    firedSignals: Array.isArray(p.firedSignals) ? p.firedSignals : [],
    claudeGrade: p.claudeGrade ?? null,
    source: p.source || 'advisor',
    atrPct: p.atrPct ?? null,
    positionSizeMult: p._positionSizeMult ?? null,
    // outcome fields, filled during evaluation:
    perf: { d1: null, d3: null, d5: null },
    outcome: null,        // 'TARGET_HIT' | 'STOP_HIT' | 'WIN' | 'LOSS' | 'OPEN'
    directionalHit: null, // true/false — did a BUY actually go up by D1?
    evaluatedAt: null,
    lastPrice: null,
    // running extremes across evaluations → MFE/MAE + stop-quality stats
    runningHigh: null,
    runningLow: null,
    postStopHigh: null,   // highest price seen AFTER a stop-out
  }));

  // regime may arrive as a string or a regimeEngine object ({regime, riskMult, ...})
  const rawRegime = detail.marketContext?.regime;
  const regimeLabel = typeof rawRegime === 'string' ? rawRegime : (rawRegime?.regime ?? null);
  const scanDate = new Date(now + 3 * 60 * 60 * 1000); // Istanbul wall clock

  const record = {
    date,
    timestamp: now,
    scanMode: detail.scanMode || 'intraday',
    marketBias: detail.marketContext?.bias || detail.marketContext?.sentiment || null,
    regime: regimeLabel,
    avgRSI: detail.marketContext?.avgRSI ?? null,
    dayOfWeek: scanDate.getUTCDay(),           // 0=Sun … 6=Sat (Istanbul day)
    scanHour: scanDate.getUTCHours(),          // Istanbul hour of the scan
    predictions,
  };

  const next = existing
    ? days.map(d => (d.date === date ? record : d))
    : [record, ...days];

  return persistJournal(next);
}

// ── Determine per-prediction outcome from a live price ──
//
// Running extremes (when present) catch target/stop touches that happened
// BETWEEN 30-min evaluations. When both were touched we cannot know the order
// at this sampling rate, so the stop wins — the pessimistic assumption keeps
// the ledger honest.
export function outcomeFromPrice(pred, priceNow) {
  const entry = pred.entryPrice;
  if (!entry || !priceNow) return null;
  const pct = ((priceNow - entry) / entry) * 100; // BUY-only journal

  const hi = Math.max(pred.runningHigh ?? -Infinity, priceNow);
  const lo = Math.min(pred.runningLow ?? Infinity, priceNow);

  let outcome = 'OPEN';
  if (pred.stop && lo <= pred.stop) outcome = 'STOP_HIT';
  else if (pred.target && hi >= pred.target) outcome = 'TARGET_HIT';
  else if (pct >= 5) outcome = 'WIN';
  else if (pct <= -3) outcome = 'LOSS';

  return { outcome, pct };
}

// ── Evaluate matured predictions against a symbol→price map ──
//
// quoteMap: { SYMBOL: number }  (current/last price)
// Mirrors useSignalTracker maturation: assign d1/d3/d5 by snapshot age in days.
// directionalHit is locked in at the first D1 evaluation (the headline metric).
export function evaluateJournal(days, quoteMap, now = Date.now()) {
  let changed = false;

  const next = days.map(day => {
    const ageDays = (now - day.timestamp) / TRADING_DAY_MS;

    // Running extremes update from day 0 — MFE/MAE must include the entry
    // day's excursion even before outcomes mature.
    let dayTouched = false;
    let predictions = day.predictions.map(pred => {
      const priceNow = quoteMap[pred.symbol];
      if (priceNow == null || !pred.entryPrice) return pred;

      const runningHigh = Math.max(pred.runningHigh ?? priceNow, priceNow);
      const runningLow = Math.min(pred.runningLow ?? priceNow, priceNow);
      // Track recovery after a stop-out (approximate but unbiased over samples)
      const postStopHigh = pred.outcome === 'STOP_HIT'
        ? Math.max(pred.postStopHigh ?? priceNow, priceNow)
        : pred.postStopHigh;

      if (runningHigh !== pred.runningHigh || runningLow !== pred.runningLow
          || postStopHigh !== pred.postStopHigh) {
        dayTouched = true;
        return { ...pred, runningHigh, runningLow, postStopHigh };
      }
      return pred;
    });

    if (ageDays < 1) {
      if (dayTouched) changed = true;
      return dayTouched ? { ...day, predictions } : day;
    }

    predictions = predictions.map(pred => {
      const priceNow = quoteMap[pred.symbol];
      if (priceNow == null) return pred;

      const out = outcomeFromPrice(pred, priceNow);
      if (!out) return pred;

      const perf = { ...pred.perf };
      if (ageDays >= 1 && perf.d1 == null) perf.d1 = out.pct;
      if (ageDays >= 3 && perf.d3 == null) perf.d3 = out.pct;
      if (ageDays >= 5 && perf.d5 == null) perf.d5 = out.pct;

      // directionalHit: lock at first maturation — did the BUY go up next day?
      const directionalHit = pred.directionalHit == null
        ? out.pct > 0
        : pred.directionalHit;

      // Hard hits finalize immediately; soft WIN/LOSS hold; everything closes by D5.
      // A finalized STOP_HIT stays a STOP_HIT — post-stop recovery is measured
      // separately (stoppedThenRecovered), never rewrites the outcome.
      const isHard = out.outcome === 'TARGET_HIT' || out.outcome === 'STOP_HIT';
      const alreadyStopped = pred.outcome === 'STOP_HIT';
      const finalOutcome = alreadyStopped
        ? 'STOP_HIT'
        : (isHard || ageDays >= 5) ? out.outcome : (pred.outcome || out.outcome);

      changed = true;
      return {
        ...pred,
        perf,
        outcome: finalOutcome,
        directionalHit,
        lastPrice: priceNow,
        evaluatedAt: now,
      };
    });

    return { ...day, predictions };
  });

  return { days: next, changed };
}

// ── Derived per-prediction measurements (v2, tolerant of v1 records) ──
export function predMetrics(pred) {
  const entry = pred.entryPrice;
  if (!entry) return { mfePct: null, maePct: null, stoppedThenRecovered: null };
  const mfePct = pred.runningHigh != null ? ((pred.runningHigh - entry) / entry) * 100 : null;
  const maePct = pred.runningLow != null ? ((pred.runningLow - entry) / entry) * 100 : null;
  const stoppedThenRecovered = pred.outcome === 'STOP_HIT'
    ? (pred.postStopHigh != null && pred.postStopHigh >= entry * (1 + RECOVERY_PCT / 100))
    : null;
  return { mfePct, maePct, stoppedThenRecovered };
}

// Net-of-cost realized return (percentage points); null when nothing realized.
export function netRealized(pred) {
  const gross = pred.perf?.d5 ?? pred.perf?.d3 ?? pred.perf?.d1;
  return gross == null ? null : gross - ROUND_TRIP_COST_PP;
}

// ── Aggregate honest accuracy stats ──
export function journalStats(days) {
  // Carry each day's market regime onto its predictions so accuracy can be
  // sliced by regime — the system almost certainly works in some regimes and
  // not others, and knowing WHEN it is reliable matters more than a blended %.
  const allPreds = days.flatMap(d =>
    d.predictions.map(p => ({
      ...p,
      _regime: (typeof d.regime === 'string' ? d.regime : d.regime?.regime)
        || d.marketBias || '—',
      _dayOfWeek: d.dayOfWeek ?? new Date(d.date + 'T12:00:00Z').getUTCDay(),
      _scanHourBucket: d.scanHour == null ? '—'
        : d.scanHour < 12 ? 'morning' : d.scanHour < 16 ? 'midday' : 'preclose',
    }))
  );
  const evaluated = allPreds.filter(p => p.evaluatedAt && p.directionalHit != null);

  const n = evaluated.length;
  const hits = evaluated.filter(p => p.directionalHit).length;
  const directionalAccuracy = n > 0 ? (hits / n) * 100 : 0;

  const withD1 = evaluated.filter(p => p.perf?.d1 != null);
  const withD3 = evaluated.filter(p => p.perf?.d3 != null);
  const withD5 = evaluated.filter(p => p.perf?.d5 != null);
  const mean = (arr, k) => (arr.length ? arr.reduce((a, p) => a + p.perf[k], 0) / arr.length : 0);
  const avgD1 = mean(withD1, 'd1');
  const avgD3 = mean(withD3, 'd3');
  const avgD5 = mean(withD5, 'd5');

  // Expectancy on the realized horizon (prefer D5, fall back to shorter).
  const realized = evaluated
    .map(p => p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1)
    .filter(v => v != null);
  const expectancy = realized.length
    ? realized.reduce((a, v) => a + v, 0) / realized.length
    : 0;

  const targetHits = evaluated.filter(p => p.outcome === 'TARGET_HIT').length;
  const stopHits = evaluated.filter(p => p.outcome === 'STOP_HIT').length;

  // Breakdown helper (by grade / by tier)
  const breakdown = (key) => {
    const map = {};
    for (const p of evaluated) {
      const k = p[key] || '—';
      map[k] = map[k] || { total: 0, hits: 0, sumRet: 0 };
      map[k].total += 1;
      if (p.directionalHit) map[k].hits += 1;
      map[k].sumRet += (p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1 ?? 0);
    }
    for (const k of Object.keys(map)) {
      const m = map[k];
      m.accuracy = m.total > 0 ? (m.hits / m.total) * 100 : 0;
      m.avgReturn = m.total > 0 ? m.sumRet / m.total : 0;
    }
    return map;
  };

  // Net expectancy: same realized returns minus the round-trip cost.
  const netExpectancy = realized.length ? expectancy - ROUND_TRIP_COST_PP : 0;

  // Per-signal-type attribution: fold every fired signal on evaluated picks.
  const bySignalType = {};
  for (const p of evaluated) {
    const ret = p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1 ?? 0;
    for (const sig of (p.firedSignals || [])) {
      const k = typeof sig === 'string' ? sig : sig?.type;
      if (!k) continue;
      bySignalType[k] = bySignalType[k] || { total: 0, hits: 0, sumRet: 0 };
      bySignalType[k].total += 1;
      if (p.directionalHit) bySignalType[k].hits += 1;
      bySignalType[k].sumRet += ret;
    }
  }
  for (const k of Object.keys(bySignalType)) {
    const m = bySignalType[k];
    m.accuracy = m.total > 0 ? (m.hits / m.total) * 100 : 0;
    m.avgReturn = m.total > 0 ? m.sumRet / m.total : 0;
    m.samples = m.total;
  }

  // Rolling window over the most recent evaluated predictions — the governor's
  // kill-switch input. Ordered by evaluation recency.
  const rollingWindow = (size) => {
    const recent = evaluated
      .slice()
      .sort((a, b) => (b.evaluatedAt || 0) - (a.evaluatedAt || 0))
      .slice(0, size);
    const rets = recent.map(netRealized).filter(v => v != null);
    const hits2 = recent.filter(p => p.directionalHit).length;
    return {
      samples: recent.length,
      netExpectancy: rets.length ? rets.reduce((a, v) => a + v, 0) / rets.length : 0,
      accuracy: recent.length ? (hits2 / recent.length) * 100 : 0,
    };
  };

  // Stop quality: are stops doing their job, or shaking us out of winners?
  const stopQualityFor = (preds) => {
    const evald = preds.filter(p => p.evaluatedAt);
    const stopped = evald.filter(p => p.outcome === 'STOP_HIT');
    const recovered = stopped.filter(p => predMetrics(p).stoppedThenRecovered === true);
    const winners = evald.filter(p => p.directionalHit);
    const winnerMAEs = winners
      .map(p => predMetrics(p).maePct)
      .filter(v => v != null)
      .map(v => Math.abs(v));
    return {
      samples: evald.length,
      stopHits: stopped.length,
      stopHitRate: evald.length ? (stopped.length / evald.length) * 100 : 0,
      stoppedThenRecovered: recovered.length,
      stoppedThenRecoveredRate: stopped.length ? (recovered.length / stopped.length) * 100 : 0,
      avgWinnerMAE: winnerMAEs.length
        ? winnerMAEs.reduce((a, v) => a + v, 0) / winnerMAEs.length
        : null,
    };
  };
  const stopQuality = stopQualityFor(evaluated);
  stopQuality.byRegime = {};
  for (const p of evaluated) {
    const r = p._regime;
    (stopQuality.byRegime[r] = stopQuality.byRegime[r] || []).push(p);
  }
  for (const r of Object.keys(stopQuality.byRegime)) {
    stopQuality.byRegime[r] = stopQualityFor(stopQuality.byRegime[r]);
  }

  // Confidence band: is the sample big enough to trust the number?
  let confidence = 'insufficient';
  if (n >= 100) confidence = 'high';
  else if (n >= 30) confidence = 'medium';
  else if (n >= 10) confidence = 'low';

  return {
    days: days.length,
    totalPredictions: allPreds.length,
    evaluated: n,
    pending: allPreds.length - n,
    directionalAccuracy,   // headline: next-day directional hit rate (%)
    avgD1, avgD3, avgD5,
    expectancy,            // avg realized return per prediction (%)
    netExpectancy,         // expectancy minus round-trip cost (pp)
    targetHits,
    stopHits,
    sampleConfidence: confidence,
    byGrade: breakdown('grade'),
    byTier: breakdown('tier'),
    byRegime: breakdown('_regime'),
    byClaudeGrade: breakdown('claudeGrade'),
    byDayOfWeek: breakdown('_dayOfWeek'),
    byScanHour: breakdown('_scanHourBucket'),
    bySignalType,
    rolling20: rollingWindow(20),
    stopQuality,
  };
}

// ── Export the full ledger for offline tooling (threshold tuner etc.) ──
export function exportJournalJSON(days = loadJournal()) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 2,
    roundTripCostPp: ROUND_TRIP_COST_PP,
    stats: journalStats(days),
    days,
  }, null, 2);
}

export default {
  JOURNAL_STORAGE_KEY,
  ROUND_TRIP_COST_PP,
  tradingDayKey,
  loadJournal,
  persistJournal,
  recordSnapshot,
  outcomeFromPrice,
  evaluateJournal,
  predMetrics,
  netRealized,
  journalStats,
  exportJournalJSON,
};
