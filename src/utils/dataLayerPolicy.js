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
// SAKINLIK SIRASI (2026-11-11, v31.53) — ayni politika: goster + olc, sonra ac.
// candidateRank.js adaylari "daha sakin / daha az uzamis" olana gore siralar. Gecmis veride
// ayni gunun adaylarini AYIRIYOR (sira korelasyonu kesif kumesinde +0,049 t 6,3; ona
// bakilmadan sinanan 168 hissede +0,041 t 5,7), mevcut anahtarlar (skor, yarin-potansiyeli,
// guven) AYIRMIYOR. Yine de secime girmiyor, cunku avantaj cikis kuralina bagli cikti:
// olculmus yalniz-trailing cikisiyla ilk-3 farki 2024 ortasina kadar +1..+2 puan, sonrasinda
// ~0 ve 2026'nin ilk yarisinda -0,66 (t -2,8). Ham 5/10 gunluk getiride her donemde arti,
// planla degil. Yani "calisiyor" demek icin ileri veri gerekiyor: sinyale `calmRank`
// yazilir, Sinyal sekmesinde ucte birlik kovalarla olculur, bayrak o tabloya bakilarak acilir.
//
// BILANCO KAPISI (KULLANICI KARARI 2026-11-22, v31.58) — ayni politika: goster + olc.
// fundamentalQualityGate en iyi ~18 AL adayini Yahoo bilancosuyla eliyor (D/O>5, cari<0,4,
// net marj<-%25) ya da guvenini dusuruyordu (D/O>2, cari<0,8, zarar, dusen kar). Olculdu
// (scripts/fundamentals-study.mjs, 586 hisse, Is Yatirim tablolari noktasal): elenenler
// temizlerden KOTU DEGIL (kesif +1,49 / +0,81, dogrulama +0,97 / +1,02, 2022-2026 her yil
// elenenler onde), kotu uc ayni (p1 -9,5, p5 -7,2 / -7,3). Kullanici "cevir" dedi: veri yine
// cekilir ve kartta gorunur, karar (`_fundGate`) sinyale yazilip Sinyal sekmesinde olculur,
// ama eleme ve guven cezasi KAPALI.
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
  calmRankSelection: false,
  fundamentalGate: false,
  decidedAt: '2026-09-12',
  buybackBoostDecidedAt: '2026-09-13',
  calmRankDecidedAt: '2026-11-11',
  fundamentalGateDecidedAt: '2026-11-22',
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

/** Sakinlik sirasi adaylarin SIRASINI / secimini belirlesin mi? (v31.53: hayir — olculuyor) */
export function isCalmRankSelectionEnabled() {
  return DATA_LAYER_POLICY.calmRankSelection === true;
}

/** Bilanco kapisi adayi elesin / guvenini dusursun mu? (v31.58: hayir — gosterilir ve olculur) */
export function isFundamentalGateEnabled() {
  return DATA_LAYER_POLICY.fundamentalGate === true;
}

/** Olculmus pay geri alimi bildirimi AL adayina sinirli guven artisi versin mi? (v31.41) */
export function isKapBuybackBoostEnabled() {
  return DATA_LAYER_POLICY.kapBuybackBoost === true;
}
