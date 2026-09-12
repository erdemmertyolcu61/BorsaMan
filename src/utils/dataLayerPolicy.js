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
// NEDEN BAYRAK: kodda yabanci akis icin HIC OLCULMEMIS kurallar hazir
// bekliyordu (confidence ±8, tomorrowPotential ±18, iki sert eleme). Kaynak
// olu oldugu icin uyuyorlardi; veri geri gelince SESSIZCE devreye girerlerdi.
// Olcum birikince acmak tek satir — ve o satiri degistiren, testi de gorur.

export const DATA_LAYER_POLICY = Object.freeze({
  foreignFlowScoring: false,
  kapCatalystScoring: false,
  kapRiskGuard: true,
  decidedAt: '2026-09-12',
});

/** Yabanci akis skoru confidence / potansiyel / elemeye girsin mi? */
export function isForeignFlowScoringEnabled() {
  return DATA_LAYER_POLICY.foreignFlowScoring === true;
}

/** KAP olaylari (geri alim, yeni is, kar payi...) skora girsin mi? */
export function isKapCatalystScoringEnabled() {
  return DATA_LAYER_POLICY.kapCatalystScoring === true;
}

/** Hisseye uygulanan islem tedbiri AL listesinden cikarsin mi? */
export function isKapRiskGuardEnabled() {
  return DATA_LAYER_POLICY.kapRiskGuard === true;
}
