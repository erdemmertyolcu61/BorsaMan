// ── REGIME GATE (v29.2/v29.3) — pure, testable ───────────────────────────
// Extracted from useAIAdvisor.js (a ~3000-line god-file where bugs hid untested).
// Walk-forward measurement (1y, 81 buy signals, XU100 regime × score tier, 5d
// forward return) proved buy picks only work in an uptrend:
//   YUKSELIS +1.14% (59.5% WR) | YATAY -1.68% (26% WR) | DUSUS -3.36% (18.8% WR)
// Score tier does NOT save you — regime dominates. These pure functions encode
// that: regime classification from the BIST100 index, and the buy-gate filter.

/**
 * Classify the market regime from BIST100 (XU100) index closes.
 * TREND-based (close vs MA20 + 5-day slope) — a single-day change is too noisy.
 * @param {number[]} closes - index close prices, oldest → newest
 * @returns {{ regime: 'BULL'|'NEUTRAL'|'BEAR', changePct: number }}
 *   BULL=YUKSELIS, NEUTRAL=YATAY, BEAR=DUSUS
 */
export function classifyBistRegime(closes) {
  const c = (closes || []).filter(x => typeof x === 'number' && x > 0);
  const n = c.length;
  if (n >= 25) {
    const last = c[n - 1];
    const ma20 = c.slice(n - 20).reduce((s, x) => s + x, 0) / 20;
    const ref5 = c[n - 6] || c[0];
    const slope5 = ref5 > 0 ? ((last - ref5) / ref5) * 100 : 0;
    let regime = 'NEUTRAL';
    if (last > ma20 && slope5 > 1) regime = 'BULL';
    else if (last < ma20 && slope5 < -1) regime = 'BEAR';
    return { regime, changePct: slope5 };
  }
  if (n >= 2) {
    // Not enough history for MA20 → fall back to single-day change.
    const yest = c[n - 2], today = c[n - 1];
    const changePct = yest > 0 ? ((today - yest) / yest) * 100 : 0;
    let regime = 'NEUTRAL';
    if (changePct > 1) regime = 'BULL';
    else if (changePct < -0.5) regime = 'BEAR';
    return { regime, changePct };
  }
  return { regime: 'NEUTRAL', changePct: 0 };
}

/** 'BULL'|'NEUTRAL'|'BEAR' → Turkish label shown to the user. */
export function regimeLabel(regime) {
  return regime === 'BULL' ? 'YUKSELIS' : regime === 'BEAR' ? 'DUSUS' : 'YATAY';
}

// v31.5 QUALITY FLOOR (relaxed from 65 at user request): outside YUKSELIS buys
// must clear score>=58. Measured: YATAY -1.68% / 26% WR, DUSUS -3.36% / 18.8% WR.
// v31.4 pinned this at 65 (flagged+ only) which left the panel almost empty in a
// counter-regime — the user reported "cok siki, ne kaybediyorum ne kazaniyorum".
// 58 lets the upper "early" band through (still warned via _counterRegime), while
// the guaranteed daily pick (ensureBestOfDay) makes sure a name always shows.
export const COUNTER_REGIME_MIN_SCORE = 58;

/**
 * Apply the regime buy-gate to a pick list (buy-oriented; sells pass through).
 * Regime WARNS rather than fully hiding — but a quality floor applies outside BULL.
 *   BULL (YUKSELIS)→ unchanged (all picks).
 *   NEUTRAL (YATAY)→ sells + up to `neutralMaxBuys` buys with score>=minScore.
 *   BEAR (DUSUS)   → sells + up to `bearMaxBuys` buys with score>=minScore
 *                    (tighter cap — worst measured edge).
 * Surviving buys are tagged `_counterRegime` for the ⚠ badge + banner.
 * Pure: returns a NEW array, never mutates the input.
 * @param {Array<{cls?: string, score?: number}>} picks
 * @param {'BULL'|'NEUTRAL'|'BEAR'} regime
 * @param {number} [neutralMaxBuys=6] - max counter-regime buys shown in NEUTRAL
 * @param {number} [bearMaxBuys=4] - max counter-regime buys shown in BEAR
 * @param {number} [minScore=58] - quality floor for counter-regime buys
 * @returns {Array}
 */
export function applyRegimeGate(picks, regime, neutralMaxBuys = 6, bearMaxBuys = 4,
                                minScore = COUNTER_REGIME_MIN_SCORE) {
  if (!Array.isArray(picks)) return [];
  if (regime === 'BULL') return picks.slice(); // copy for purity
  const cap = regime === 'BEAR' ? Math.max(0, bearMaxBuys) : Math.max(0, neutralMaxBuys);
  const sells = picks.filter(p => p.cls === 'sell');
  const buys = picks
    .filter(p => p.cls === 'buy' && (p.score || 0) >= minScore) // kalite tabani
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, cap)
    .map(p => (p._counterRegime ? p : { ...p, _counterRegime: true }));
  return [...sells, ...buys];
}

// v31.5 GUARANTEED DAILY PICK — "her gun bir tane".
// The user wants the panel to never be empty: at least ONE buy candidate every
// day, chosen from the PRE-MARKET pool as the coil about to move — explicitly NOT
// a name that has already pumped (that was the FOMO trap isUnsafeForTomorrow
// blocks). Fires ONLY when the gate leaves zero buys, so it never overrides a
// real gated list. The pick is tagged `_bestOfDay` (⭐ GUNUN EN IYISI) and, outside
// YUKSELIS, `_counterRegime` (⚠) so the honest regime warning stays attached.
export function ensureBestOfDay(gatedPicks, candidates, regime) {
  const picks = Array.isArray(gatedPicks) ? gatedPicks.slice() : [];
  if (picks.some(p => p && p.cls === 'buy')) return picks; // already have a long
  const pool = (Array.isArray(candidates) ? candidates : []).filter(r =>
    r && typeof r === 'object' && r.cls !== 'sell' &&
    // henuz patlamamis (pre-pump) — piyasa acilinca hareket edecek olan
    Math.max(r.todayPumpReal || 0, r.recentPump || 0) < 7 &&
    (r.cumulativePump || 0) < 15 &&
    // asiri alim bolgesinde degil (tavan/exhaustion adayi olmasin)
    (r.rsi || 50) <= 78 && (r.mfi || 50) <= 82);
  if (!pool.length) return picks;
  // Rank: early-accumulation (pre-pump coil) first, then signal strength, then score.
  const rank = (r) => (r._earlyPick ? 1000 : 0) + (r._earlyCount || 0) * 10 +
    (r.score || r.confidence || 0);
  const best = pool.slice().sort((a, b) => rank(b) - rank(a))[0];
  const tagged = {
    ...best, _bestOfDay: true,
    ...(regime !== 'BULL' ? { _counterRegime: true } : {}),
  };
  return [tagged, ...picks];
}
