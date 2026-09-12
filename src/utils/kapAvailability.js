// ── KAP KULLANILABILIRLIGI — saf, test edilebilir ─────────────────────────
//
// IKI AYRI DURUM VAR (v31.38):
//
// 1) BILDIRIM AKISI — CALISIYOR (olculdu 2026-09-12)
//      POST https://www.kap.org.tr/tr/api/disclosure/list/main
//      3 gun: 674 bildirim / 207 hisse · THYAO (mkkMemberOid) 60 gun: 11 bildirim
//    Kod: kapFeed.js. Tarama (islem tedbiri filtresi + rozet), Piyasa ekrani ve
//    Tekil Analiz KAP paneli bunu kullanir.
//
// 2) ESKI JSON UCLARI — OLU (olculdu 2026-09-07)
//      /tr/api/iceridiogrenenler/<oid>  → 404  (iceriden ogrenen islemleri)
//      /tr/api/ozetFinansalBilgiler      → 404  (ozet finansal tablo)
//    insiderEngine ve fetchKAPSummaryFinancials bunlara bagli; kapali kalirlar.
//
// DURUST DUZELTME: 2026-09-07 notu "kararli veri ucu yok, sayfa veriyi istemcide
// yukluyor" diyordu. Olcum eksikti: yalniz ilk JS parcalarina bakilmisti, uc
// adlari ayri bir sabitler parcasindaydi. /tr/bildirim-sorgu-sonuc'un "bos 404
// kabugu" da BOS `member=` parametresiyle denendigi icindi — gecerli bir OID ile
// sayfa bildirimleri doner (kullanmiyoruz; JSON uc daha hafif).
//
// TASARIM (degismedi): sessizce bos donmek YASAK. Olu uclar `unavailable: true`
// + sebep dondurur; UI ve log "veri yok" ile "bildirim yok"u ayirir.

/** Eski JSON uclari (insider, ozet finansal). Tek kaynak — engine'ler bunu okur. */
export const KAP_STATUS = Object.freeze({
  available: false,
  measuredAt: '2026-09-07',
  reason: 'KAP iceriden-ogrenen ve ozet-finansal JSON uclari Next.js gecisinde kalkti (404). '
        + 'Bildirim akisi ayri bir uctan calisiyor (kapFeed.js) ama insider/ozet finansal verisi yok.',
  routes: Object.freeze([
    { url: '/tr/api/iceridiogrenenler/<oid>', status: 404 },
    { url: '/tr/api/ozetFinansalBilgiler', status: 404 },
    { url: '/tr/bildirim-sorgu-sonuc', status: 200, note: 'bos member= ile 404 kabugu; gecerli OID ile calisir (kullanilmiyor)' },
  ]),
});

/** Canli bildirim akisi (kapFeed.js). */
export const KAP_FEED_STATUS = Object.freeze({
  available: true,
  measuredAt: '2026-09-12',
  route: 'POST https://www.kap.org.tr/tr/api/disclosure/list/main',
  evidence: '3 gun: 674 bildirim / 207 hisse; THYAO (mkkMemberOid) 60 gun: 11 bildirim',
});

/** Eski insider / ozet-finansal uclarini denemeli miyiz? */
export function isKapAvailable() {
  return KAP_STATUS.available === true;
}

/** Bildirim akisini kullanabilir miyiz? */
export function isKapFeedAvailable() {
  return KAP_FEED_STATUS.available === true;
}

/** Kullanicidan/logdan gorunecek tek satirlik sebep (eski uclar icin). */
export function kapUnavailableNote() {
  return `KAP iceriden-ogrenen / ozet-finansal verisi yok (${KAP_STATUS.measuredAt} olcumu) — bildirim akisi ayri calisiyor.`;
}

/**
 * Bildirim listesi yerine dondurulen bos-ama-DURUST sonuc.
 * Dizi olmasi cagiranlarin `.length`/`.map` beklentisini korur; `unavailable`
 * bayragi "veri yok" ile "olumsuz veri" ayrimini mumkun kilar.
 */
export function kapUnavailableDisclosures(reason = KAP_STATUS.reason) {
  const arr = [];
  arr.unavailable = true;
  arr.reason = reason;
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
