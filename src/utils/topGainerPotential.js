// ── BIST GÜNLÜK TOP-10 YÜKSELEN POTANSİYELİ (v31.24) — saf, test edilebilir ──
//
// The advisor already answers "is this a good setup?". The user asked a different
// and sharper question: "which names could actually make BIST's daily top-10
// gainers list tomorrow?" That is not the same thing — a blue chip can be a
// textbook setup and still never post a +7% day, while a mid-cap with the same
// setup does it routinely.
//
// METHOD — empirical first, judgement second:
//   1. BASE RATE. Count how often THIS stock actually closed >= BIG_MOVE_PCT in
//      its own history. This is the honest anchor: a stock that has never made a
//      big move in a year is not about to be talked into one by an indicator.
//   2. CONDITION MULTIPLIERS. Bounded multipliers for the things that plausibly
//      raise or lower the odds today (coil, accumulation, volume ignition,
//      catalyst, exhaustion, overbought).
//   3. CAP. The result is clamped to PROB_CAP. Claiming a >45% chance of a
//      specific stock topping the daily gainers list would be dishonest, and no
//      amount of indicator agreement earns it.
//
// HONEST LIMITS: this estimates the chance of a LARGE UP DAY, which is the
// dominant requirement for the top-10 list; it does not model the competition
// (how big the other 600 names' moves are that day), because that is unknowable
// in advance. Treat the output as a ranking aid, not a probability contract.

/** BIST daily top-10 gainers almost always clear this, ceiling being ~+10%. */
export const BIG_MOVE_PCT = 6;
/** Below this daily range a big move is mechanically implausible. */
export const MIN_ATR_PCT = 1.5;
/** Never claim more than this. */
export const PROB_CAP = 0.45;

/**
 * Empirical share of sessions where the stock closed >= threshold% up.
 * @param {Array<{close:number}>} prices oldest -> newest
 * @returns {{rate:number, hits:number, days:number}} rate in 0..1
 */
export function bigMoveBaseRate(prices, opts = {}) {
  const { threshold = BIG_MOVE_PCT, lookback = 250 } = opts;
  if (!Array.isArray(prices) || prices.length < 2) return { rate: 0, hits: 0, days: 0 };
  const bars = prices.slice(-Math.max(2, lookback + 1));
  let hits = 0, days = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]?.close;
    const cur = bars[i]?.close;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) continue;
    days++;
    if (((cur - prev) / prev) * 100 >= threshold) hits++;
  }
  return { rate: days ? hits / days : 0, hits, days };
}

/** Multiply and remember why, so the UI can explain the number. */
function applyFactor(state, condition, mult, label) {
  if (!condition) return;
  state.mult *= mult;
  (mult >= 1 ? state.drivers : state.blockers).push(label);
}

/**
 * Estimate the chance this name posts a big up day (top-10 gainer candidate).
 *
 * @param {object} r scan result (atrPct, volRatio, obvTrend, cmf, rsi, mfi,
 *                  ttmSqueeze, wyckoffSpring, recentPump, cumulativePump,
 *                  todayPumpReal, newsCategories, avgVolumeTL, distFromMA20)
 * @param {Array<{close:number}>} prices daily bars for the base rate
 * @returns {{score:number, probPct:number, baseRatePct:number, eligible:boolean,
 *            drivers:string[], blockers:string[], sampleDays:number}}
 */
export function computeTopGainerPotential(r, prices, opts = {}) {
  const empty = {
    score: 0, probPct: 0, baseRatePct: 0, eligible: false,
    drivers: [], blockers: [], sampleDays: 0,
  };
  if (!r) return empty;

  const base = bigMoveBaseRate(prices, opts);
  const atrPct = Number.isFinite(r.atrPct) ? r.atrPct : 0;

  // ── HARD GATE: a stock that cannot move that far in a day, will not. ──
  // Base rate alone would already handle this, but a thin sample (a newly
  // listed name) must not sneak through on 1-2 lucky sessions.
  if (atrPct > 0 && atrPct < MIN_ATR_PCT) {
    return { ...empty, baseRatePct: +(base.rate * 100).toFixed(2), sampleDays: base.days,
      blockers: ['Gunluk aralik cok dar (ATR<%1.5)'] };
  }

  // With no usable history fall back to a neutral prior implied by the range:
  // roughly, a stock whose ATR is x% posts a >=6% day at a low single-digit rate.
  const priorRate = atrPct >= 5 ? 0.06 : atrPct >= 3.5 ? 0.035 : atrPct >= 2.5 ? 0.02 : 0.01;
  const rate = base.days >= 40 ? base.rate : priorRate;

  const st = { mult: 1, drivers: [], blockers: [] };

  const cmf = Number.isFinite(r.cmf) ? r.cmf : 0;
  const volRatio = Number.isFinite(r.volRatio) ? r.volRatio : 1;
  const rsi = Number.isFinite(r.rsi) ? r.rsi : 50;
  const mfi = Number.isFinite(r.mfi) ? r.mfi : 50;
  const recentPump = r.recentPump || 0;
  const cumulativePump = r.cumulativePump || recentPump;
  const todayPump = r.todayPumpReal || 0;
  const cats = Array.isArray(r.newsCategories) ? r.newsCategories : [];
  const hotCats = ['insider_buy', 'buyback', 'fund_inflow', 'contract', 'catalyst_event', 'upgrade'];

  // ── ENERGY: a coiled spring is the classic precursor of an outsized day ──
  applyFactor(st, r.ttmSqueeze?.squeezeRelease === true, 1.60, 'TTM sikisma birakti');
  applyFactor(st, r.ttmSqueeze?.squeezeRelease !== true && r.ttmSqueeze?.squeezeOn === true,
    1.30, 'TTM sikisma aktif');
  applyFactor(st, r.wyckoffSpring === true, 1.25, 'Wyckoff Spring');

  // ── SMART MONEY: someone has to be buying before the tape does ──
  applyFactor(st, r.obvTrend === 'accumulation' && cmf > 0.05, 1.30, 'OBV birikim + CMF+');
  applyFactor(st, r.obvTrend === 'distribution', 0.60, 'OBV dagitim');
  applyFactor(st, cmf < -0.08, 0.75, 'CMF negatif');

  // ── IGNITION: volume is the fuel; too much of it means we are already late ──
  applyFactor(st, volRatio >= 1.5 && volRatio <= 3, 1.30, 'Hacim ateslemesi');
  applyFactor(st, volRatio > 3, 1.10, 'Hacim cok yuksek (gec olabilir)');
  applyFactor(st, volRatio < 0.7, 0.70, 'Hacim kurudu');

  // ── CATALYST: the single most common cause of a genuine top-10 day ──
  applyFactor(st, cats.some(c => hotCats.includes(c)), 1.50, 'Kataliz haber');
  applyFactor(st, cats.includes('risk'), 0.55, 'Olumsuz haber');

  // ── ROOM TO RUN: already-spent moves rarely repeat next session ──
  applyFactor(st, todayPump >= 9 || recentPump >= 9, 0.45, 'Zaten tavan bolgesinde');
  applyFactor(st, todayPump < 9 && todayPump >= 6, 0.70, 'Bugun zaten sert yukseldi');
  applyFactor(st, cumulativePump >= 18, 0.55, 'Kumulatif yorgunluk');
  applyFactor(st, rsi > 78 || mfi > 82, 0.65, 'Asiri alim');
  applyFactor(st, recentPump <= 2 && cumulativePump <= 5, 1.20, 'Henuz hareket etmemis');

  // ── TRADABILITY: an untradeable move is not an opportunity ──
  const volTL = r.avgVolumeTL || 0;
  applyFactor(st, volTL > 0 && volTL < 2_000_000, 0.75, 'Dusuk likidite');

  const probPct = Math.min(PROB_CAP, Math.max(0, rate * st.mult)) * 100;

  // Ranking score: PROB_CAP maps to 100 so the scale is stable and honest about
  // what the ceiling means.
  const score = Math.round(Math.min(100, (probPct / (PROB_CAP * 100)) * 100));

  return {
    score,
    probPct: +probPct.toFixed(1),
    baseRatePct: +(base.rate * 100).toFixed(2),
    sampleDays: base.days,
    eligible: score >= 35,
    drivers: st.drivers,
    blockers: st.blockers,
  };
}

/**
 * Bounded confidence contribution, so this dimension informs ranking without
 * overwhelming the existing 7-component composite. Sell picks are unaffected —
 * "could top the gainers list" is a long-side idea only.
 */
export const TOP_GAINER_CONF_CAP = 8;
export function topGainerConfidenceAdjust(tg, isSell = false) {
  if (isSell || !tg || !Number.isFinite(tg.score)) return 0;
  // score 35 (eligibility floor) is neutral; below it a small penalty, above it
  // a bounded premium.
  const delta = ((tg.score - 35) / 65) * TOP_GAINER_CONF_CAP;
  return Math.max(-TOP_GAINER_CONF_CAP / 2, Math.min(TOP_GAINER_CONF_CAP, +delta.toFixed(1)));
}
