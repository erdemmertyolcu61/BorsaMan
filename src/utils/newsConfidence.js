// ── HABER → GUVEN DELTASI (v31.8, v31.41) — saf, test edilebilir ────────────
//
// v31.8: haber, secimden ONCE aday havuzuna confidence deltasi olarak girer
// (useAIAdvisor). Bu modul o deltanin tek kaynagi — daha once kancanin icinde
// satir ici yaziliydi ve testi yoktu.
//
// v31.41 KULLANICI KARARI (2026-09-13): sozlesme / ihale / yeni siparis
// (`contract`) ve olay (`catalyst_event`: transfer, ortaklik, satin alma, yeni
// yatirim...) haberleri guvene ARTI VERMEZ. Dayanak: 24 aylik KAP olay calismasi
// (scripts/kap-event-study.mjs) — yeni is anlasmasi, gunluk tarayan bir sistemin
// alabildigi anda cogunlukla fiyatlanmis (+%1,6) ve sonrasinda piyasanin %0,4
// gerisinde; birlesme/edinim de sonrasinda hafif negatif. Arti IKI yoldan
// geliyordu, ikisi de kapandi:
//   1) acik +5 kataliz bonusu,
//   2) haber skorunun kendisi: `contract` agirligi +4 x yenilik 1,5 x kaynak
//      agirligi 1,1 → skor ~+6,6 → delta x1,5 ≈ +10. Yalniz +5'i silmek artinin
//      yarisindan fazlasini birakirdi.
// Haber alanlari (kategori, baslik, TAM skor) pick'te durur: Claude istemi ve kart
// ipucu haberi gormeye devam eder. Ayni hissedeki diger haber (tavsiye, geri alim)
// ve olumsuz haber (risk) aynen islenir.

import { symbolNewsScore } from './marketNewsEngine.js';

/** Guven deltasina arti vermeyen haber kategorileri (v31.41). */
export const NEWS_UNSCORED_CATEGORIES = Object.freeze(['contract', 'catalyst_event']);
/** Hala +5 kataliz bonusu alan haber kategorileri. */
export const NEWS_CATALYST_CATEGORIES = Object.freeze(['insider_buy', 'buyback', 'fund_inflow']);
export const NEWS_CATALYST_BONUS = 5;
export const NEWS_DELTA_CAP = 15;

/**
 * @param {object} entry indexBySymbol girdisi ({ score, categories, items, count })
 * @param {{ cls?: string }} [opts] sell icin yon tersine doner
 * @returns {{ delta: number, catalystCategories: string[], unscoredCategories: string[] }}
 */
export function newsConfidenceDelta(entry, { cls } = {}) {
  if (!entry?.count) return { delta: 0, catalystCategories: [], unscoredCategories: [] };
  const cats = Array.isArray(entry.categories) ? entry.categories : [];
  const catalystCategories = cats.filter(c => NEWS_CATALYST_CATEGORIES.includes(c));
  const unscoredCategories = cats.filter(c => NEWS_UNSCORED_CATEGORIES.includes(c));
  let d = symbolNewsScore(entry, { exclude: NEWS_UNSCORED_CATEGORIES }) * 1.5;
  if (catalystCategories.length) d += NEWS_CATALYST_BONUS;
  if (cats.includes('upgrade')) d += 3;
  if (cats.includes('risk')) d -= 8;                  // dava/sorusturma/ceza
  d = Math.max(-NEWS_DELTA_CAP, Math.min(NEWS_DELTA_CAP, d));
  if (cls === 'sell' && d !== 0) d = -d;              // sell icin ters yon (-0 uretme)
  return { delta: d, catalystCategories, unscoredCategories };
}
