// ════════════════════════════════════════════════════════════════════
// regimeEngine.js — Market Regime Classifier
// ════════════════════════════════════════════════════════════════════
//
// BIST is strongly regime-dependent: the same setup that prints money in a
// broad uptrend bleeds in a distribution tape. A blended win rate hides this.
// This classifier reads MARKET INTERNALS already computed by each scan —
// breadth (% bullish), momentum (avg RSI), and macro stress (VIX/USDTRY) —
// and labels the regime so strategy and sizing can adapt, and so the forward
// journal can break accuracy down by regime (byRegime).
//
// No new data needed: everything here comes from the existing scan + macro.
// Pure functions, fully testable.
// ════════════════════════════════════════════════════════════════════

// Regime codes (stable keys — used as journal byRegime labels).
export const REGIMES = {
  BULL: 'BULL',         // broad uptrend — momentum works
  BEAR: 'BEAR',         // broad downtrend — only the strongest bases survive
  RANGE: 'RANGE',       // choppy / no edge for trend following
  VOLATILE: 'VOLATILE', // high stress / whipsaw — size down hard
};

const META = {
  BULL:     { label: 'YÜKSELİŞ REJİMİ',   riskMult: 1.0, note: 'Geniş katılım — momentum ve kırılım setupları öne çıkar.' },
  RANGE:    { label: 'YATAY REJİM',        riskMult: 0.8, note: 'Yön belirsiz — sadece yüksek R/R ve net taban setupları.' },
  VOLATILE: { label: 'VOLATİL / STRESLİ',  riskMult: 0.6, note: 'Whipsaw riski yüksek — pozisyon küçült, teyit bekle.' },
  BEAR:     { label: 'DÜŞÜŞ REJİMİ',       riskMult: 0.4, note: 'Geniş zayıflık — agresif alımdan kaçın, sadece en güçlü tabanlar.' },
};

/**
 * classifyRegime — derive the market regime from scan internals + macro.
 * @param {object} m
 *   - pctBull   : fraction of scanned stocks that are buy-rated (0..1)
 *   - avgRSI    : average RSI across the scan (0..100)
 *   - scanned   : number of symbols scanned (sample-size gate)
 *   - sectorStrengthAvg : optional avg sector strength (-5..+5-ish)
 *   - macro     : optional { vix, usdtryChangePct } macro stress signal
 * @returns { regime, label, confidence, riskMult, note, factors }
 */
export function classifyRegime(m = {}) {
  const pctBull = clamp01(num(m.pctBull, 0.5));
  const avgRSI = clampN(num(m.avgRSI, 50), 0, 100);
  const scanned = num(m.scanned, 0);
  const sectorStrengthAvg = num(m.sectorStrengthAvg, 0);
  const vix = m.macro && m.macro.vix != null ? num(m.macro.vix, null) : null;
  const usdMove = m.macro && m.macro.usdtryChangePct != null ? Math.abs(num(m.macro.usdtryChangePct, 0)) : null;

  // Macro stress: elevated VIX or a sharp lira move = whipsaw risk.
  // Callers that already have a macro verdict (macroContextEngine) can pass an
  // explicit `macroStress` boolean instead of raw VIX/USDTRY values.
  const macroStress = m.macroStress != null
    ? !!m.macroStress
    : ((vix != null && vix >= 28) || (usdMove != null && usdMove >= 1.5));

  // Breadth and momentum each vote; combine into a single internal score.
  // breadthScore, momoScore in roughly [-1, +1].
  const breadthScore = (pctBull - 0.40) / 0.40;             // 0.40 bull ≈ neutral on BIST
  const momoScore = (avgRSI - 50) / 18;                      // ~32→-1, 68→+1
  const internal = clampN(0.6 * breadthScore + 0.4 * momoScore, -2, 2);

  let regime;
  if (macroStress && internal < 0.5) {
    regime = REGIMES.VOLATILE;
  } else if (internal >= 0.5 && pctBull >= 0.45 && avgRSI >= 53) {
    regime = REGIMES.BULL;
  } else if (internal <= -0.5 || pctBull <= 0.22 || avgRSI <= 42) {
    regime = REGIMES.BEAR;
  } else {
    regime = REGIMES.RANGE;
  }

  // Confidence: how decisive the internals are + macro corroboration + sample.
  let confidence = Math.round(clampN(Math.abs(internal) / 1.5, 0, 1) * 70);
  if (macroStress && regime === REGIMES.VOLATILE) confidence += 15;
  if (sectorStrengthAvg !== 0 && Math.sign(sectorStrengthAvg) === Math.sign(internal)) confidence += 10;
  if (scanned < 30) confidence = Math.min(confidence, 35); // thin scan → don't overclaim
  confidence = clampN(confidence, 5, 99);

  const meta = META[regime];
  return {
    regime,
    label: meta.label,
    riskMult: meta.riskMult,
    note: meta.note,
    confidence,
    factors: { pctBull: +pctBull.toFixed(3), avgRSI: Math.round(avgRSI), internal: +internal.toFixed(2), macroStress },
  };
}

// ── helpers ──
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export default { REGIMES, classifyRegime };
