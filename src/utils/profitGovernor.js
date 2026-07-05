// ════════════════════════════════════════════════════════════════════
// profitGovernor.js — Journal-driven risk governor for the AI Advisor
// ════════════════════════════════════════════════════════════════════
//
// Converts the forward-test journal from a scoreboard into a control loop.
// Pure function: reads measured aggregates, returns throttle decisions that
// runScan applies to its score gate, pick count and position sizing.
//
// Design contract (sample-size policy, see plan):
//   - Every rule fires ONLY above its own sample floor; below it the rule
//     contributes nothing and logs why.
//   - Output is bounded (fixed enum of deltas/multipliers) and every applied
//     rule is explained in `reasons` — never a silent retune.
//   - With a young journal the governor is a pure pass-through (NORMAL).
// ════════════════════════════════════════════════════════════════════

import { journalStats } from './forwardTestJournal.js';

export const GOVERNOR_MODES = ['NORMAL', 'CAUTION', 'DEFENSE'];

// Hysteresis: once the rolling kill-switch trips, stepping back up requires
// this many consecutive positive-net evaluations so the mode doesn't flap.
const RECOVERY_STREAK = 5;

// Sample floors
const REGIME_CAUTION_MIN = 20;
const REGIME_DEFENSE_MIN = 30;
const ROLLING_MIN = 20;
const CALENDAR_MIN = 15;

function modeRank(m) { return m === 'DEFENSE' ? 2 : m === 'CAUTION' ? 1 : 0; }

/**
 * computeGovernor(journalDays, currentRegime, opts)
 *   journalDays   — raw journal array (loadJournal())
 *   currentRegime — regime label string ('BULL' | 'BEAR' | 'RANGE' | 'VOLATILE' | ...)
 *   opts.tomorrowDow — optional 0-6 day-of-week the picks will mature on
 *                      (defaults to the next calendar day)
 *   opts.stats    — precomputed journalStats(journalDays) (test seam / reuse)
 *
 * Returns { mode, scoreCutoffDelta, maxPicksMult, positionMult, reasons }
 */
export function computeGovernor(journalDays = [], currentRegime = null, opts = {}) {
  const reasons = [];
  let mode = 'NORMAL';
  let scoreCutoffDelta = 0;
  let maxPicksMult = 1;
  let positionMult = 1;

  const stats = opts.stats || journalStats(journalDays);
  const escalate = (m) => { if (modeRank(m) > modeRank(mode)) mode = m; };

  // ── Rule 1: regime accuracy — is the system measurably blind in this tape? ──
  const regBucket = currentRegime ? stats.byRegime?.[currentRegime] : null;
  if (regBucket && regBucket.total >= REGIME_DEFENSE_MIN && regBucket.accuracy < 38) {
    escalate('DEFENSE');
    scoreCutoffDelta = Math.max(scoreCutoffDelta, 10);
    maxPicksMult = Math.min(maxPicksMult, 0.5);
    reasons.push(`${currentRegime} rejiminde isabet %${regBucket.accuracy.toFixed(0)} (n=${regBucket.total}) — DEFENSE`);
  } else if (regBucket && regBucket.total >= REGIME_CAUTION_MIN && regBucket.accuracy < 45) {
    escalate('CAUTION');
    scoreCutoffDelta = Math.max(scoreCutoffDelta, 5);
    maxPicksMult = Math.min(maxPicksMult, 0.5);
    reasons.push(`${currentRegime} rejiminde isabet %${regBucket.accuracy.toFixed(0)} (n=${regBucket.total}) — esikler sikilastirildi`);
  } else if (currentRegime) {
    const n = regBucket?.total || 0;
    if (n < REGIME_CAUTION_MIN) reasons.push(`yetersiz orneklem: ${currentRegime} rejimi n=${n} < ${REGIME_CAUTION_MIN}`);
  }

  // ── Rule 2: rolling kill-switch — is the last-20 net expectancy negative? ──
  const roll = stats.rolling20;
  if (roll && roll.samples >= ROLLING_MIN) {
    // Recovery hysteresis: while below streak, hold at least CAUTION even if
    // the rolling number has just turned positive.
    const streak = recoveryStreak(journalDays);
    if (roll.netExpectancy < -1.0) {
      escalate('DEFENSE');
      positionMult = Math.min(positionMult, 0.25);
      maxPicksMult = Math.min(maxPicksMult, 0.5);
      reasons.push(`son 20 pick net beklenti %${roll.netExpectancy.toFixed(2)} — DEFENSE (pozisyon 1/4)`);
    } else if (roll.netExpectancy < 0) {
      escalate('CAUTION');
      positionMult = Math.min(positionMult, 0.5);
      reasons.push(`son 20 pick net beklenti %${roll.netExpectancy.toFixed(2)} — pozisyon yariya`);
    } else if (streak < RECOVERY_STREAK && streak >= 0 && wasRecentlyNegative(journalDays)) {
      escalate('CAUTION');
      positionMult = Math.min(positionMult, 0.5);
      reasons.push(`toparlanma dogrulaniyor: ${streak}/${RECOVERY_STREAK} ardisik pozitif degerlendirme`);
    }
  } else {
    reasons.push(`yetersiz orneklem: rolling n=${roll?.samples || 0} < ${ROLLING_MIN}`);
  }

  // ── Rule 3: calendar — do picks maturing on this weekday measurably fail? ──
  const dow = opts.tomorrowDow ?? nextTradingDow();
  const dowBucket = stats.byDayOfWeek?.[String(dow)] ?? stats.byDayOfWeek?.[dow];
  if (dowBucket && dowBucket.total >= CALENDAR_MIN && dowBucket.accuracy < 42) {
    escalate('CAUTION');
    scoreCutoffDelta = Math.max(scoreCutoffDelta, 5);
    reasons.push(`gun-${dow} isabeti %${dowBucket.accuracy.toFixed(0)} (n=${dowBucket.total}) — esik +5`);
  }

  if (mode === 'NORMAL' && !reasons.length) reasons.push('journal saglikli — tam gaz');

  return { mode, scoreCutoffDelta, maxPicksMult, positionMult, reasons };
}

// Count consecutive positive-net evaluations from the most recent backwards.
// Used for the recovery hysteresis after a kill-switch trip.
function recoveryStreak(days) {
  const evaluated = days
    .flatMap(d => d.predictions || [])
    .filter(p => p.evaluatedAt)
    .sort((a, b) => (b.evaluatedAt || 0) - (a.evaluatedAt || 0));
  let streak = 0;
  for (const p of evaluated) {
    const gross = p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1;
    if (gross == null) continue;
    if (gross - 0.3 > 0) streak += 1; // net of 0.30% round-trip
    else break;
  }
  return streak;
}

// Was the rolling-20 net expectancy negative just before the current streak?
// (i.e. are we in a recovery phase that still needs confirmation)
function wasRecentlyNegative(days) {
  const evaluated = days
    .flatMap(d => d.predictions || [])
    .filter(p => p.evaluatedAt)
    .sort((a, b) => (b.evaluatedAt || 0) - (a.evaluatedAt || 0));
  const streak = recoveryStreak(days);
  const window = evaluated.slice(streak, streak + 20);
  if (window.length < ROLLING_MIN) return false;
  const rets = window
    .map(p => p.perf?.d5 ?? p.perf?.d3 ?? p.perf?.d1)
    .filter(v => v != null)
    .map(v => v - 0.3);
  if (!rets.length) return false;
  return rets.reduce((a, v) => a + v, 0) / rets.length < 0;
}

// Next trading day-of-week in Istanbul time (Fri/Sat → Mon).
function nextTradingDow(now = Date.now()) {
  const d = new Date(now + 3 * 60 * 60 * 1000);
  let dow = (d.getUTCDay() + 1) % 7;
  if (dow === 6) dow = 1; // Sat → Mon
  if (dow === 0) dow = 1; // Sun → Mon
  return dow;
}

// ════════════════════════════════════════════════════════════════════
// adaptiveStopMult — measured stop-width adaptation (WS6)
// ════════════════════════════════════════════════════════════════════
//
// Replaces the blind 1.8×ATR stop clamp with a per-regime table that the
// journal's stopQuality stats nudge ±0.2 once enough stop-outs accumulate:
//   - stops shaking us out of recoverers (>40% stopped-then-recovered) → widen
//   - winners never coming close to the stop (avgWinnerMAE < half width) → tighten
// Hard bounds 1.4–2.6; below the sample floor the hand-tuned defaults rule.

const STOP_MULT_DEFAULTS = { BULL: 1.8, RANGE: 1.8, VOLATILE: 2.2, BEAR: 1.6 };
const STOP_MULT_MIN = 1.4;
const STOP_MULT_MAX = 2.6;
const STOP_ADAPT_MIN_SAMPLES = 30;

export function adaptiveStopMult(stopQuality, regime) {
  const base = STOP_MULT_DEFAULTS[regime] ?? 1.8;
  const slice = stopQuality?.byRegime?.[regime] || stopQuality;
  if (!slice || (slice.stopHits || 0) < STOP_ADAPT_MIN_SAMPLES) {
    return { mult: base, adapted: false, reason: `orneklem ${slice?.stopHits || 0} < ${STOP_ADAPT_MIN_SAMPLES}` };
  }

  let mult = base;
  let reason = 'olculen stop kalitesi dengeli';
  if ((slice.stoppedThenRecoveredRate || 0) > 40) {
    mult = base + 0.2;
    reason = `stop-sonrasi toparlanma %${slice.stoppedThenRecoveredRate.toFixed(0)} — stoplar cok siki, genisletildi`;
  } else if (slice.avgWinnerMAE != null && slice.avgWinnerMAE > 0) {
    // Winners' worst drawdown vs the width the stop table allows (in ATR mult
    // terms we can't convert directly — use the ratio heuristic on MAE):
    // if winners never use even half the room, the stop is wasting risk budget.
    const impliedHalfWidthPct = base; // ~ATR mult ≈ % at atrPct≈1; heuristic scale
    if (slice.avgWinnerMAE < impliedHalfWidthPct * 0.5) {
      mult = base - 0.2;
      reason = `kazananlarin ort. MAE %${slice.avgWinnerMAE.toFixed(1)} — stop bosa genis, daraltildi`;
    }
  }
  mult = Math.max(STOP_MULT_MIN, Math.min(STOP_MULT_MAX, mult));
  return { mult, adapted: mult !== base, reason };
}

export default { computeGovernor, GOVERNOR_MODES, adaptiveStopMult };
