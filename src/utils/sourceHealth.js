// ── KAYNAK SAGLIGI IZLEME (v31.33) — saf, test edilebilir ────────────────
//
// NEDEN VAR: bu projede AYNI HATA UC KEZ olustu — bir dis veri katmani oldu ve
// AYLARCA kimse fark etmedi, cunku kod "best-effort" olup sessizce BOS donuyordu:
//
//   1. RSS haber hatti (v31.22'de bulundu) — HTML korumasi her feed'i atiyordu.
//      Skorda haber bileseni aylarca 0'di; "haber yok" gibi gorunuyordu.
//   2. Yabanci akis (foreignFlowEngine) — tum ucretsiz TR kaynaklari oldu.
//   3. KAP / iceriden ogrenenler (2026-09-07'de bulundu) — KAP Next.js'e gecti,
//      kullanilan tum rotalar kalkti. insider skoru sessizce 0 katki veriyordu.
//
// Ucunde de kod "calisiyor" gorunuyordu: istek basarili ya da yutulmus, sonuc
// bos, ve BOS ile YOK ayirt edilemiyordu. `catch {}` bunun mekanizmasi.
//
// Bu modul o ayrimi yapar: bir kaynak arka arkaya N kez BOS donerse "sessize
// dustu" diye isaretlenir ve BIR KEZ uyarilir (her taramada degil — gurultu
// yapmadan gorunur olmali). Kaynak veri dondurmeye baslarsa bayrak duser.
//
// Bilincli olarak SAF: zaman kaynagi enjekte edilebilir, depolama/DOM yok.
// Cagiran taraf uyariyi nasil gosterecegine kendi karar verir.

/** Bu kadar ardisik bos sonuctan sonra kaynak "sessiz" sayilir. */
export const SILENT_AFTER = 3;

/**
 * Kaynak saglik takipcisi olustur.
 * @param {{silentAfter?: number}} [opts]
 */
export function createSourceHealth(opts = {}) {
  const silentAfter = Number.isFinite(opts.silentAfter) ? opts.silentAfter : SILENT_AFTER;
  /** @type {Map<string, {empty:number, total:number, lastItems:number, warned:boolean}>} */
  const state = new Map();

  const entry = (name) => {
    let e = state.get(name);
    if (!e) { e = { empty: 0, total: 0, lastItems: 0, warned: false }; state.set(name, e); }
    return e;
  };

  /**
   * Bir kaynagin sonucunu kaydet.
   * @param {string} name kaynak adi (ornek: 'rss-haber', 'kap-insider')
   * @param {number} items donen kayit sayisi (0 = bos)
   * @returns {{silent:boolean, shouldWarn:boolean, streak:number}}
   *   shouldWarn yalnizca sessizlige DUSTUGU an bir kez true olur.
   */
  function record(name, items) {
    const e = entry(name);
    const n = Number.isFinite(items) && items > 0 ? items : 0;
    e.total += 1;
    e.lastItems = n;
    if (n > 0) {
      // Veri geldi → sayac ve uyari bayragi sifirlanir (kaynak dirildi).
      e.empty = 0;
      e.warned = false;
      return { silent: false, shouldWarn: false, streak: 0 };
    }
    e.empty += 1;
    const silent = e.empty >= silentAfter;
    const shouldWarn = silent && !e.warned;
    if (shouldWarn) e.warned = true;   // bir kez uyar, her taramada degil
    return { silent, shouldWarn, streak: e.empty };
  }

  /** Su an sessiz olan kaynaklarin adlari. */
  function silentSources() {
    return [...state.entries()]
      .filter(([, e]) => e.empty >= silentAfter)
      .map(([name]) => name);
  }

  /** Tum kaynaklarin durumu — tani/gosterim icin. */
  function snapshot() {
    return [...state.entries()].map(([name, e]) => ({
      name, empty: e.empty, total: e.total, lastItems: e.lastItems,
      silent: e.empty >= silentAfter,
    }));
  }

  function reset() { state.clear(); }

  return { record, silentSources, snapshot, reset };
}

/** Uyari metni — kullaniciya/loga tek satir. */
export function formatSilentWarning(name, streak) {
  return `VERI KAYNAGI SESSIZ: "${name}" arka arkaya ${streak} kez bos dondu. `
       + 'Bu katman su an skora HIC katki vermiyor (bos sonuc "olumsuz veri" demek degil).';
}
