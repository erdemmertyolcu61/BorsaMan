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

// v31.28 — YATAY TABANI 54 → 70. Kullanicinin kendi olculen rakamlariyla yapilan
// aritmetik: islem basina net beklenti YUKSELIS +%0,84 / YATAY -%1,98 (%0,3
// gidis-donus maliyeti dahil). YUKSELIS gunleri %70 bile olsa karisimin neti ~0 —
// yani YATAY islemleri YUKSELIS'in tum kazancini siliyor. v31.15'te bu taban
// kullanici istegiyle 54'e cekilmisti ("YATAY'i biraz ac"); kullanici simdi
// onceligi kar olarak koydu ve bu aritmetigi gorup onayladi.
//
// DURUSTLUK NOTU: bu dosyanin basligindaki olcum "score tier does NOT save you"
// diyor — yani YUKSELIS disinda yuksek skor tek basina kurtarici DEGIL. O yuzden
// tabani yukseltmek TEK BASINA bir duzeltme degil; asil mekanizma toplam maruziyeti
// dusurmek: daha AZ aday (cap 8→4) + daha KUCUK pozisyon (positionSizing.js
// NEUTRAL_EXTRA_MULT=0.5) + bu taban birlikte YATAY maruziyetini ~1/4'e indirir.
// Panelin bos kalmasi engellenir (ensureBestOfDay hala garantili bir isim koyar).
export const NEUTRAL_MIN_SCORE = 70;

/**
 * Rejim-ozel kalite tabani — TEK KAYNAK.
 * Hem `applyRegimeGate` hem `displayPicks` fallback dali bunu kullanir; ikisi
 * ayrisirsa panel filler'i gate'in eledigi adaylari geri sizdirir (v31.4'te
 * yasanan hata).
 */
export function counterRegimeFloor(regime) {
  return regime === 'BEAR' ? COUNTER_REGIME_MIN_SCORE : NEUTRAL_MIN_SCORE;
}

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
 * @param {number} [neutralMaxBuys=4] - max counter-regime buys shown in NEUTRAL
 * @param {number} [bearMaxBuys=4] - max counter-regime buys shown in BEAR
 * @param {number} [minScore=null] - quality floor override (default: regime-specific)
 * @returns {Array}
 */
export function applyRegimeGate(picks, regime, neutralMaxBuys = 4, bearMaxBuys = 4,
                                minScore = null) {
  if (!Array.isArray(picks)) return [];
  if (regime === 'BULL') return picks.slice(); // copy for purity
  const cap = regime === 'BEAR' ? Math.max(0, bearMaxBuys) : Math.max(0, neutralMaxBuys);
  // Rejim-ozel taban (tek kaynak): YATAY 70, DUSUS 58.
  const floor = minScore != null ? minScore : counterRegimeFloor(regime);
  const sells = picks.filter(p => p.cls === 'sell');
  const buys = picks
    .filter(p => p.cls === 'buy' && (p.score || 0) >= floor) // kalite tabani (rejim-özel)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, cap)
    // v31.13: BEAR'da AL'lar GORUNUR ama "ALIM DEGIL" — olcum DUSUS'te AL beklentisi
    // -3.36% / %18.8 WR. Kullanici gorunurluk istedi (her gun goster), ama duşen
    // piyasada bunu tradeable buy gibi sunmak sermaye kaybettiriyor → _watchOnly.
    .map(p => {
      const tagged = p._counterRegime ? p : { ...p, _counterRegime: true };
      return regime === 'BEAR' ? { ...tagged, _watchOnly: true } : tagged;
    });
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
    // v31.13: DUSUS'te garantili pick de ALIM DEGIL — izleme (olcum negatif).
    ...(regime === 'BEAR' ? { _watchOnly: true } : {}),
  };
  return [tagged, ...picks];
}
