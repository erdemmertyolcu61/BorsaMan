// ── CIKIS FIYATI COZUMLEME (v31.34) — saf, test edilebilir ───────────────
//
// OLCULEN PROBLEM: `PaperTradeEngine.checkPrices` pozisyonu stop/hedef
// SEVIYESINDEN degil, kontrol anindaki CANLI FIYATTAN kapatiyordu:
//
//     if (live.price <= trade.stop_price) closeTrade(id, live.price, 'STOP')
//
// Uygulama surekli aciksa bu makul — fiyat stop'a yeni degmistir, aradaki fark
// ihmal edilebilir. Ama MOBILDE degil: WebView arka planda JS'i dondurur
// (OS siniri). Kullanici auto-trade acikken uygulamayi kapatir, fiyat gun icinde
// stop'un cok altina duser, aksam uygulamayi acinca monitor calisir ve pozisyon
// stop'tan DEGIL, dustugu yerden kapanir.
//
//   ornek: giris 214, stop 202,5 (-%5,4). Arka planda 190'a duser.
//          Kayit: -%11,2.  Strateji ise -%5,4 diyordu.
//
// Bu, mobil paper sonuclarini SISTEMATIK olarak kotu gosterir — ve `computeLiveEdge`
// (v31.16) bu kapanislari okuyup canli skorlamayi ±%15 olceklediginden hata
// gercek pick'lere sizar. Hedefte de simetrik: hedefin cok ustunde acilan
// uygulama, gercekte alinamayacak bir kazanci kaydeder.
//
// COZUM — ne oldugunu BILDIGIMIZ kadarini iddia et:
//   - Son kontrolden bu yana KISA sure gectiyse (uygulama izliyordu) canli fiyat
//     adil bir dolum sayilir.
//   - UZUN sure gectiyse (arka plan/kapali) fiyatin YOLUNU bilmiyoruz. Emir
//     seviyeye degdiginde dolardi; ucta bir fiyati iddia etmek uydurma olur.
//     Bu durumda SEVIYE kullanilir ve kayit `stale` olarak isaretlenir.
//
// Kural simetriktir ve tarafli degildir: stop'ta seviye canliDAN IYIDIR (kaybi
// duzeltir), hedefte seviye canliDAN KOTUDUR (kazanci duzeltir). Ikisi de ayni
// ilkeden cikar — gormedigimiz hareketi kendi lehimize yorumlamiyoruz.
//
// NOT: bu, gun ici barlardan yeniden kurmanin (signalOutcome.evaluateOutcomeFromBars,
// v31.26) YERINE gecmez; onun ucuz ve bagimsiz bir yaklasimidir. Barlar elde
// oldugunda o yontem daha kesindir.

/** Bu suredin kisa olmasi "uygulama izliyordu" demektir. */
export const WATCHING_WINDOW_MS = 2 * 60 * 1000;   // 2 dakika

/**
 * Bir cikis icin gercekci dolum fiyatini cozer.
 *
 * @param {object} p
 * @param {number} p.level        stop veya hedef seviyesi (mutlak fiyat)
 * @param {number} p.livePrice    kontrol anindaki fiyat
 * @param {number} p.msSinceCheck son basarili fiyat kontrolunden bu yana gecen ms
 * @param {'stop'|'target'} p.kind
 * @param {boolean} [p.isBuy=true]
 * @param {number} [p.watchingWindowMs]
 * @returns {{price:number|null, basis:'live'|'level'|'none', stale:boolean}}
 *   price === null ise cikis fiyati BILINMIYOR — cagiran pozisyonu KAPATMAMALI.
 */
export function resolveExitPrice({ level, livePrice, msSinceCheck, kind, isBuy = true,
                                   watchingWindowMs = WATCHING_WINDOW_MS }) {
  const live = Number(livePrice);
  const lvl = Number(level);
  const liveOk = Number.isFinite(live) && live > 0;
  const lvlOk = Number.isFinite(lvl) && lvl > 0;
  // IKISI DE gecersizse fiyat UYDURMA — `null` don, cagiran islemi kapatmasin.
  // (Ilk yazimda burada NaN donuyordu; NaN bir fiyat P&L'i sessizce zehirler.)
  if (!liveOk && !lvlOk) return { price: null, basis: 'none', stale: true };
  if (!liveOk) return { price: lvl, basis: 'level', stale: true };
  if (!lvlOk) return { price: live, basis: 'live', stale: false };

  const gap = Number.isFinite(msSinceCheck) ? msSinceCheck : Infinity;
  const watching = gap <= watchingWindowMs;
  if (watching) return { price: live, basis: 'live', stale: false };

  // Izlemiyorduk. Fiyat seviyeyi HENUZ gecmemisse (nadiren: baska bir sebeple
  // kapaniyoruz) canli fiyat zaten dogru taraftadir — seviyeye zorlamak yanlis
  // olur. Yalniz seviye ASILMISSA seviyeye geri cekiyoruz.
  const crossed = kind === 'stop'
    ? (isBuy ? live <= lvl : live >= lvl)
    : (isBuy ? live >= lvl : live <= lvl);
  if (!crossed) return { price: live, basis: 'live', stale: false };

  return { price: lvl, basis: 'level', stale: true };
}
