// ── SHARED DISPLAY-PICKS DERIVATION (v29) — pure, testable ────────────────
// Extracted from AIAdvisorPanel.jsx. SINGLE SOURCE OF TRUTH for what the top
// "En İyi" header strip AND the bottom "AI FIRSATLAR" panel show — they used to
// diverge (header sorted topPicks by raw score, panel applied an isUnsafe filter
// + emergency fillers), so the header could show THYAO #1 while the panel showed
// a filler VANGD #1. Both now call this pure function → same picks, same order.
//
// regimeRestrict — product decision: the system ALWAYS shows the best stocks in
// every regime (the user wants opportunities visible, not an empty panel). Regime
// is a WARNING layer, not a suppressor: in DUSUS/YATAY the fillers/fallback still
// run, but every buy shown is tagged `_counterRegime` so the UI can warn (⚠ badge
// + banner). Measured edge is negative outside YUKSELIS — surfaced, not hidden.

import { COUNTER_REGIME_MIN_SCORE } from './regimeGate.js';

// Outside YUKSELIS the panel targets fewer buys (matches applyRegimeGate's
// neutralMaxBuys) so the filler can't re-inflate a counter-regime list back to 8.
export const COUNTER_REGIME_BUY_TARGET = 4;

function isUnsafe(r) {
  const tp = Math.max(r.todayPumpReal || 0, r.recentPump || 0, r.change || 0);
  if (tp >= 12) return true;
  if ((r.rsi || 50) > 88) return true;
  if ((r.mfi || 50) > 88) return true;
  if ((r.cumulativePump || 0) >= 22) return true;
  if (tp >= 7) {
    const prob = r.continuationProbability;
    if (prob == null || prob < 38) return true;
    return false;
  }
  if ((r.cumulativePump || 0) >= 18) {
    const hasCatalyst = r.newsCategories?.some(c =>
      ['insider_buy', 'buyback', 'fund_inflow', 'contract'].includes(c));
    if (!hasCatalyst) return true;
  }
  return false;
}

const sortByConf = (a, b) => (b.confidence || b.score || 0) - (a.confidence || a.score || 0);

// Buy-oriented sort: push already-pumped names to the back, else by confidence.
const pickSort = (a, b) => {
  const aPump = Math.max(a.todayPumpReal || 0, a.recentPump || 0);
  const bPump = Math.max(b.todayPumpReal || 0, b.recentPump || 0);
  if (aPump >= 7 && bPump < 7) return 1;
  if (bPump >= 7 && aPump < 7) return -1;
  if (aPump >= 7 && bPump >= 7) return (b.continuationProbability || 0) - (a.continuationProbability || 0);
  return sortByConf(a, b);
};

/**
 * @param {Array} topPicks - backend-filtered picks
 * @param {Array} scanResults - full scan output (for fillers/fallback)
 * @param {boolean} regimeRestrict - true in DUSUS/YATAY → tag buys _counterRegime
 * @returns {Array} the picks to display, deterministic from the inputs (buys first)
 */
export function deriveDisplayPicks(topPicks = [], scanResults = [], regimeRestrict = false) {
  const scan = Array.isArray(scanResults) ? scanResults : [];
  if (topPicks.length > 0) {
    const safe = [...topPicks].filter(p => p._emergencyPick || !isUnsafe(p));
    // Split buys / sells. Buys MUST always be represented: in a sell-heavy YATAY/
    // DUSUS market the sells could otherwise fill all 8 slots and hide every AL —
    // that was the "YATAY rejimde AL gozukmedi" bug. Buys go first, sells fill the rest.
    let buys = safe.filter(p => p.cls !== 'sell').sort(pickSort);
    const sells = safe.filter(p => p.cls === 'sell').sort(sortByConf);

    // v31.4: outside YUKSELIS the panel targets FEWER buys and the fillers must
    // clear the same quality floor as the gate — otherwise the sub-65 "early" tier
    // sneaks back in through the filler and undoes the tightening.
    const buyTarget = regimeRestrict ? COUNTER_REGIME_BUY_TARGET : 8;
    const qualityOk = (r) => !regimeRestrict || (r.score || 0) >= COUNTER_REGIME_MIN_SCORE;

    if (buys.length < buyTarget && scan.length > 0) {
      const have = new Set(safe.map(p => p.symbol));
      const need = buyTarget - buys.length;
      const tag = (r) => ({ ...r, _fallback: true, _emergencyPick: true, ...(regimeRestrict ? { _counterRegime: true } : {}) });
      const buildFiller = (rows) => rows
        .filter(r => !have.has(r.symbol) && qualityOk(r))
        .sort(sortByConf)
        .slice(0, need)
        .map(tag);

      let filler = buildFiller(scan.filter(r =>
        (r.avgVolumeTL || 0) >= 200_000 && (r.atrPct || 0) >= 0.4 &&
        r.cls !== 'sell' && (r.rsi || 50) <= 92 && (r.mfi || 50) <= 92));

      if (filler.length < need) {
        const t2have = new Set([...have, ...filler.map(p => p.symbol)]);
        const t2 = buildFiller(scan
          .filter(r => !t2have.has(r.symbol))
          .filter(r => (r.avgVolumeTL || 0) >= 100_000)
          .filter(r => (r.atrPct || 0) >= 0.2)
          .filter(r => r.cls !== 'sell')).slice(0, need - filler.length);
        filler = [...filler, ...t2];
      }
      if (filler.length < need) {
        const t3have = new Set([...have, ...filler.map(p => p.symbol)]);
        const t3 = scan
          .filter(r => !t3have.has(r.symbol) && r.cls !== 'sell' && qualityOk(r))
          .sort(sortByConf)
          .slice(0, need - filler.length)
          .map(tag);
        filler = [...filler, ...t3];
      }
      buys = [...buys, ...filler];
    }
    // Buys first (always visible), sells fill the remaining slots. Cap at 10.
    return [...buys, ...sells].slice(0, 10);
  }

  if (scanResults.length > 0) {
    const sortFn = (a, b) => {
      if (a._earlyPick && !b._earlyPick) return -1;
      if (b._earlyPick && !a._earlyPick) return 1;
      return (b.confidence || b.score || 0) - (a.confidence || a.score || 0);
    };
    // v31.4: in a counter-regime the score floor and the smaller target apply here
    // too — this branch must not become a back door for the sub-65 tier.
    const minScore = regimeRestrict ? COUNTER_REGIME_MIN_SCORE : 45;
    const target = regimeRestrict ? COUNTER_REGIME_BUY_TARGET : 8;
    let pool = scanResults.filter(r => !isUnsafe(r) && (r.score || 0) >= minScore && (r.avgVolumeTL || 0) >= 1_000_000);
    if (pool.length < target) {
      const have = new Set(pool.map(p => p.symbol));
      pool = [...pool, ...scanResults.filter(r => !have.has(r.symbol) && (r.avgVolumeTL || 0) >= 200_000
        && r.cls !== 'sell' && (r.score || 0) >= minScore)];
    }
    if (pool.length < target && !regimeRestrict) {
      const have2 = new Set(pool.map(p => p.symbol));
      pool = [...pool, ...scanResults.filter(r => !have2.has(r.symbol))];
    }
    return pool.sort(sortFn).slice(0, target).map(r => ({
      symbol: r.symbol, sector: r.sector, price: r.price, change: r.change,
      signal: r.signal, cls: r.cls, score: r.score, rr: r.rr,
      stop: r.stop, target: r.target, stopPct: r.stopPct, targetPct: r.targetPct,
      holdText: r.holdText, atrPct: r.atrPct,
      recentPump: r.recentPump, cumulativePump: r.cumulativePump,
      todayPumpReal: r.todayPumpReal, continuationProbability: r.continuationProbability,
      confidence: r.confidence, grade: r.grade, tier: r.tier,
      convictionTier: r.convictionTier, convictionLabel: r.convictionLabel,
      _earlyPick: r._earlyPick, _earlyCount: r._earlyCount,
      _fallback: true, _warningPick: true,
      _counterRegime: regimeRestrict && r.cls !== 'sell' ? true : undefined,
      mlConfidenceBoost: r.mlConfidenceBoost, mlBestRule: r.mlBestRule,
      mlMatchedCount: r.mlMatchedCount, mlRegimeGated: r.mlRegimeGated,
    }));
  }
  return [];
}
