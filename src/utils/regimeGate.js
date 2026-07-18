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

/**
 * Apply the regime buy-gate to a pick list (buy-oriented; sells pass through).
 * Product decision: the system ALWAYS shows the best stocks — regime WARNS, it
 * never hides. An empty panel is a worse product than a clearly-flagged list.
 *   BULL (YUKSELIS)→ unchanged (all picks).
 *   NEUTRAL (YATAY)→ sells + top `neutralMaxBuys` strongest buys, tagged _counterRegime.
 *   BEAR (DUSUS)   → sells + top `bearMaxBuys` strongest buys (tighter cap — worst
 *                    measured edge), tagged _counterRegime.
 * The measured negative edge outside YUKSELIS is surfaced in the UI (banner +
 * ⚠ per-card badge), not by suppression.
 * Pure: returns a NEW array, never mutates the input.
 * @param {Array<{cls?: string, score?: number}>} picks
 * @param {'BULL'|'NEUTRAL'|'BEAR'} regime
 * @param {number} [neutralMaxBuys=8] - max counter-regime buys shown in NEUTRAL
 * @param {number} [bearMaxBuys=3] - max counter-regime buys shown in BEAR
 * @returns {Array}
 */
export function applyRegimeGate(picks, regime, neutralMaxBuys = 8, bearMaxBuys = 3) {
  if (!Array.isArray(picks)) return [];
  if (regime === 'BULL') return picks.slice(); // copy for purity
  const cap = regime === 'BEAR' ? Math.max(0, bearMaxBuys) : Math.max(0, neutralMaxBuys);
  const sells = picks.filter(p => p.cls === 'sell');
  const buys = picks
    .filter(p => p.cls === 'buy')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, cap)
    .map(p => (p._counterRegime ? p : { ...p, _counterRegime: true }));
  return [...sells, ...buys];
}
