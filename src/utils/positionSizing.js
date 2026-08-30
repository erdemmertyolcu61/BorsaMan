// ── KONVIKSIYON-BAZLI POZISYON BOYUTU (v31.28) — saf, test edilebilir ─────
//
// PROBLEM: `_positionSizeMult` yalniz REJIM (regimeEngine.riskMult) ve profit
// governor'dan besleniyordu. Yani ayni rejimde score 82'lik bir "sniper" ile
// score 56'lik bir "early" AYNI buyuklukte aciliyordu — oysa olculen edge
// bu ikisi arasinda ciddi farkli.
//
// ARITMETIK (kullanicinin kendi olculen rakamlari, %0,3 gidis-donus maliyeti dahil):
//   YUKSELIS  +%1,14 brut → +%0,84 net
//   YATAY     -%1,68 brut → -%1,98 net
//   DUSUS     -%3,36 brut → -%3,66 net
// YATAY'da tam boyutla islem yapmak, YUKSELIS'in kazancini karisim icinde
// tamamen siliyor (YUKSELIS gunleri %70 bile olsa net ~0). Cozum tek basina
// "daha az goster" degil, "daha kucuk ac" — gorunurluk korunur, sermaye korunur.
//
// DURUST SINIR: bu carpanlar edge YARATMAZ. Sermayeyi olculen edge'in yogun
// oldugu yere kaydirir. Rejim olcumleri de v31.20/v31.22/v31.26 duzeltmelerinden
// ONCE alindi (sektor sisirmesi, olu haber hatti, bozuk d5, hic kapanmayan
// sinyaller) — yon guvenilir, kesin degerler degil. Temiz veri birikince
// yeniden ayarlanmali.

/** Konviksiyon kademesi carpanlari — sniper tam, early yarim. */
export const TIER_MULT = { sniper: 1.0, flagged: 0.75, early: 0.5, sell: 1.0 };

/**
 * YATAY icin EK kisitlama.
 *
 * BILINCLI BILESIK ETKI — cifte sayim degil, dozaj:
 * zincirdeki mevcut `regimeEngine.riskMult` YATAY'i (RANGE) 0.8 ile carpiyor.
 * 0.8, beklentisi -%1,98 NET olan bir rejim icin cok hafif. Bu katman uzerine
 * 0.5 daha koyar → toplam ~0.4. Iki farkli siniflandiricinin (regimeEngine ve
 * classifyBistRegime) ayni yone bakmasi tesaduf degil; hedeflenen toplam doz budur.
 * DUSUS zaten `_watchOnly` (hic pozisyon acilmaz) → burada ayrica cezalandirilmaz.
 */
export const NEUTRAL_EXTRA_MULT = 0.5;

/** Toplam carpan bu araligin disina cikamaz. */
export const MIN_MULT = 0;
export const MAX_MULT = 1.5;

/** Kademeyi damgadan al, yoksa score'dan turet (stampSegKeys ile birebir: 75/65). */
export function convictionTierOf(pick = {}) {
  if (pick.convictionTier) return pick.convictionTier;
  if (pick.cls === 'sell') return 'sell';
  const s = pick.score || 0;
  return s >= 75 ? 'sniper' : s >= 65 ? 'flagged' : 'early';
}

/**
 * Mevcut `_positionSizeMult` zincirine konviksiyon + YATAY dozajini ekler.
 * TEK giris noktasi — cagri yerinde ayrica rejim carpani UYGULANMAZ.
 *
 * @param {number} current mevcut _positionSizeMult (regimeEngine.riskMult × governor)
 * @param {object} pick { convictionTier, score, cls, _regime, _watchOnly }
 * @param {string} [regimeFallback] pick uzerinde _regime yoksa kullanilir
 * @returns {number} 0..1.5 arasi carpan
 */
export function applyConvictionSizing(current, pick = {}, regimeFallback = null) {
  // Izle-only (DUSUS) → sifir: panelde gorunur ama pozisyon acilmaz.
  if (pick._watchOnly) return 0;

  const base = Number.isFinite(current) && current > 0 ? current : 1;
  const tierMult = TIER_MULT[convictionTierOf(pick)] ?? TIER_MULT.early;

  // SAT sinyalleri YATAY cezasindan muaf — ceza AL beklentisi olcumunden geliyor.
  const regime = pick._regime || regimeFallback;
  const neutralMult = (pick.cls !== 'sell' && regime === 'NEUTRAL') ? NEUTRAL_EXTRA_MULT : 1;

  const out = base * tierMult * neutralMult;
  return Math.max(MIN_MULT, Math.min(MAX_MULT, Math.round(out * 1000) / 1000));
}
