// ════════════════════════════════════════════════════════════════════
// unifiedDecision.js — Single Source of Truth for AL/SAT/TUT Decision
// ════════════════════════════════════════════════════════════════════
//
// Both the AI Advisor (bulk scan) and the Single Stock Analysis must
// produce IDENTICAL signal labels for the same stock. This function is
// the unified decision engine.
//
// Logic:
//   1. If ML rules matched (mlConfidenceBoost > 0), force AL — ML is the
//      strongest available signal because it's grounded in past outcomes
//   2. Otherwise, fall back to standard SMC/genSignal score thresholds
//
// Returns: { cls, signal, label, source } where source explains the
// reasoning origin (so UI can show why the decision was made).
// ════════════════════════════════════════════════════════════════════

const BUY_THRESHOLD = 55;
const SELL_THRESHOLD = 40;

/**
 * Unified buy/sell/hold decision.
 *
 * @param {number} smcScore - genSignal score100 (0-100)
 * @param {number} [mlConfidenceBoost=0] - ML rule match boost from scoreNewSignal()
 * @param {object} [opts={}] - optional context
 * @param {number} [opts.mlMatchedCount=0] - count of matched ML rules
 * @param {string} [opts.baseSignal] - existing genSignal label (GUCLU AL / AL / TUT / SAT / GUCLU SAT)
 * @param {string} [opts.baseCls] - existing genSignal cls (buy / sell / hold)
 * @returns {{cls: string, signal: string, label: string, source: string, override: boolean}}
 */
export function getUnifiedDecision(smcScore, mlConfidenceBoost = 0, opts = {}) {
  const score = Number(smcScore) || 0;
  const boost = Number(mlConfidenceBoost) || 0;
  const matched = Number(opts.mlMatchedCount) || 0;
  const baseSignal = opts.baseSignal || null;
  const baseCls = opts.baseCls || null;

  // ── Priority 1: ML override ──
  // If ML rules matched with positive boost, this stock has historical
  // evidence of profitability — force AL regardless of raw SMC score.
  if (boost > 0 && matched > 0) {
    // Preserve "GUCLU AL" if base was already strong-buy + ML confirms
    if (baseSignal === 'GUCLU AL' || (score >= 75 && boost >= 5)) {
      return {
        cls: 'buy',
        signal: 'GUCLU AL',
        label: 'GÜÇLÜ AL',
        source: `ML+SMC (boost +${boost.toFixed(1)}, ${matched} kural, score ${score.toFixed(0)})`,
        override: true,
      };
    }
    return {
      cls: 'buy',
      signal: 'AL',
      label: 'AL',
      source: `ML override (boost +${boost.toFixed(1)}, ${matched} kural eşleşti)`,
      override: score < BUY_THRESHOLD, // flag if SMC alone wouldn't have said AL
    };
  }

  // ── Priority 2: Use existing genSignal label if provided ──
  // genSignal already has nuanced 5-tier labels (GUCLU AL/AL/TUT/SAT/GUCLU SAT)
  // — preserve them when ML doesn't override.
  if (baseSignal && baseCls) {
    return {
      cls: baseCls,
      signal: baseSignal,
      label: baseSignal === 'GUCLU AL' ? 'GÜÇLÜ AL'
           : baseSignal === 'GUCLU SAT' ? 'GÜÇLÜ SAT'
           : baseSignal,
      source: `SMC score ${score.toFixed(0)}`,
      override: false,
    };
  }

  // ── Priority 3: Pure SMC threshold fallback ──
  if (score >= BUY_THRESHOLD) {
    return {
      cls: 'buy',
      signal: score >= 75 ? 'GUCLU AL' : 'AL',
      label: score >= 75 ? 'GÜÇLÜ AL' : 'AL',
      source: `SMC score ${score.toFixed(0)} ≥ ${BUY_THRESHOLD}`,
      override: false,
    };
  }
  if (score < SELL_THRESHOLD) {
    return {
      cls: 'sell',
      signal: score <= 25 ? 'GUCLU SAT' : 'SAT',
      label: score <= 25 ? 'GÜÇLÜ SAT' : 'SAT',
      source: `SMC score ${score.toFixed(0)} < ${SELL_THRESHOLD}`,
      override: false,
    };
  }
  return {
    cls: 'hold',
    signal: 'TUT',
    label: 'TUT',
    source: `SMC score ${score.toFixed(0)} (${SELL_THRESHOLD}-${BUY_THRESHOLD} aralığında)`,
    override: false,
  };
}

export default { getUnifiedDecision };
