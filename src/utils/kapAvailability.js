// ── KAP KULLANILABILIRLIGI (v31.33) — saf, test edilebilir ────────────────
//
// OLCULEN DURUM (2026-09-07, canli istek): KAP sitesini Next.js / React Server
// Components'e tasidi ve uygulamanin kullandigi ROTALARIN HEPSI kalkti:
//
//   https://www.kap.org.tr/tr/api/iceridiogrenenler/<oid>     -> HTTP 404
//   https://www.kap.org.tr/tr/api/ozetFinansalBilgiler?...    -> HTTP 404
//   https://www.kap.org.tr/tr/bildirim-sorgu-sonuc?member=... -> HTTP 200 AMA
//       govdesi Next.js'in "404: This page could not be found" kabugu; RSC
//       yukunde tek bir bildirim kaydi yok, <td> sayisi 1, dd.mm.yyyy tarih 0.
//       insiderEngine'in ayristiricisi /"publishDate"/ ariyor → 0 eslesme.
//
// NEDEN KAZIMA DENEMIYORUZ: /tr/bildirim-sorgu sayfasi (1,1 MB) canli ama
// bildirim verisini ISTEMCI TARAFINDA yukluyor; sayfada ve ilk JS chunk'larinda
// hicbir API yolu gorunmuyor. Kararli bir uc olmadan yazilacak kazima, bir
// sonraki dagitimda YINE SESSIZCE olur — ki bu katmanin aylarca fark edilmeden
// sifir katki vermesinin sebebi tam olarak buydu (ayni sinif hata: v31.22'de
// olu RSS hatti). `foreignFlowEngine` icin de ayni karar verilmisti.
//
// TASARIM: sessizce bos donmek YASAK. Cagrilar `unavailable: true` + sebep
// dondurur; UI ve tarama logu "KAP verisi yok" der. Boylece skorda hayalet
// bilesen olmaz ve gelecekte kimse ayni olu ucu yeniden aramaz.
//
// GERI ACMA: KAP calisan bir uc yayinlarsa TEK degisiklik `KAP_STATUS.available`
// degerini true yapmak (ve gerekiyorsa engine'lerdeki URL'leri guncellemek).

/** Olculen durum. Tek kaynak — engine'ler ve UI bunu okur. */
export const KAP_STATUS = Object.freeze({
  available: false,
  measuredAt: '2026-09-07',
  reason: 'KAP Next.js/RSC gecisi sonrasi kullanilan tum rotalar kalkti (JSON uclari 404, '
        + 'HTML sonuc sayfasi bos 404 kabugu). Kararli bir veri ucu yok.',
  routes: Object.freeze([
    { url: '/tr/api/iceridiogrenenler/<oid>', status: 404 },
    { url: '/tr/api/ozetFinansalBilgiler', status: 404 },
    { url: '/tr/bildirim-sorgu-sonuc', status: 200, note: 'bos 404 kabugu — kayit yok' },
  ]),
});

/** KAP'tan veri cekmeyi denemeli miyiz? */
export function isKapAvailable() {
  return KAP_STATUS.available === true;
}

/** Kullanicidan/logdan gorunecek tek satirlik sebep. */
export function kapUnavailableNote() {
  return `KAP verisi kullanilamiyor (${KAP_STATUS.measuredAt}): ${KAP_STATUS.reason}`;
}

/**
 * Bildirim listesi yerine dondurulen bos-ama-DURUST sonuc.
 * Dizi olmasi cagiranlarin `.length`/`.map` beklentisini korur; `unavailable`
 * bayragi "veri yok" ile "olumsuz veri" ayrimini mumkun kilar.
 */
export function kapUnavailableDisclosures() {
  const arr = [];
  arr.unavailable = true;
  arr.reason = KAP_STATUS.reason;
  return arr;
}

/** Iceriden ogrenenler icin bos-ama-durust sonuc (insiderEngine sekliyle ayni). */
export function kapUnavailableInsider() {
  return {
    transactions: [],
    score: 0,
    hasRecentInsiderBuy: false,
    hasRecentInsiderSell: false,
    insiderNetBuys: 0,
    unavailable: true,
    reason: KAP_STATUS.reason,
  };
}
