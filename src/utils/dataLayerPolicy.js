// ── VERI KATMANI POLITIKASI (v31.38) — tek kaynak, saf ─────────────────────
//
// KULLANICI KARARI (2026-09-12): KAP bildirimleri ve hisse bazli yabanci orani
// icin "goster + olc, sonra ac". Yani bu veriler:
//   - rozet / Piyasa ekrani olarak GORUNUR,
//   - her sinyale KAYDEDILIR (dataLayerEdge ile olculur),
//   - skoru, confidence'i ve secimi ETKILEMEZ.
//
// Tek istisna koruyucu filtre: hissenin KENDISINE uygulanan islem tedbiri
// (VBTS, yatirimci bazinda tedbir, islem sirasi kapatma, odeme temerrudu,
// konkordato/iflas) o hisseyi AL listesinden cikarir. Bu bir getiri iddiasi
// degil — alinmamasi gereken hisseyi onermemek. Siniflandirma: kapFeed.js.
//
// KULLANICI KARARI (2026-09-13, v31.41): olculmus TEK olumlu KAP olayi — pay geri
// alimi (24 ay, n=1063: 10 seansta piyasanin %1,16 ustunde, iki donemde de pozitif)
// — AL adayina sinirli bir guven artisi (+3) verir (kapFeed.kapBuybackBoost). Diger
// KAP olaylari hala skora GIRMEZ: yeni is anlasmasi olculdu, alinabildigi anda
// fiyatlanmis (sonrasi piyasaya gore -%0,4). Artis olcumu DURDURMAZ: sinyaller
// kapCategories ile kaydedilmeye devam eder (dataLayerEdge.kapEvents).
//
// NEDEN BAYRAK: kodda yabanci akis icin HIC OLCULMEMIS kurallar hazir
// bekliyordu (confidence ±8, tomorrowPotential ±18, iki sert eleme). Kaynak
// olu oldugu icin uyuyorlardi; veri geri gelince SESSIZCE devreye girerlerdi.
// Olcum birikince acmak tek satir — ve o satiri degistiren, testi de gorur.

export const DATA_LAYER_POLICY = Object.freeze({
  foreignFlowScoring: false,
  kapCatalystScoring: false,
  kapRiskGuard: true,
  kapBuybackBoost: true,
  decidedAt: '2026-09-12',
  buybackBoostDecidedAt: '2026-09-13',
});

/** Yabanci akis skoru confidence / potansiyel / elemeye girsin mi? */
export function isForeignFlowScoringEnabled() {
  return DATA_LAYER_POLICY.foreignFlowScoring === true;
}

/** KAP olaylari (yeni is, kar payi, bedelsiz...) genel olarak skora girsin mi? */
export function isKapCatalystScoringEnabled() {
  return DATA_LAYER_POLICY.kapCatalystScoring === true;
}

/** Hisseye uygulanan islem tedbiri AL listesinden cikarsin mi? */
export function isKapRiskGuardEnabled() {
  return DATA_LAYER_POLICY.kapRiskGuard === true;
}

/** Olculmus pay geri alimi bildirimi AL adayina sinirli guven artisi versin mi? (v31.41) */
export function isKapBuybackBoostEnabled() {
  return DATA_LAYER_POLICY.kapBuybackBoost === true;
}
