// ── PROXY HEDEFI COZUMLEME (v31.37) — saf, test edilebilir ───────────────
//
// OLCULEN PROBLEM: self-proxy fallback'i YALNIZ Capacitor native icin
// calisiyordu:
//
//     else if (window.Capacitor && window.Capacitor.isNativePlatform())
//
// Kullanici uygulamayi **PWA** olarak kullaniyor. PWA'da `window.Capacitor`
// TANIMSIZ → kosul dusuyor → `PROXY_BASE_URL = ''` → her istek public CORS
// proxy yarisina (AllOrigins / corsproxy.io) gidiyor. Oradan da rate-limit
// yiyip v31.25 adaptif throttle'i tabana indiriyor (4 paralel / 1500ms) ve
// 612 sembollük tarama yarim saati buluyor.
//
// Daralik gereksizdi: CALISAN bir self-proxy varken public yarisin tercih
// edilecegi hicbir durum yok. Tek istisnalar:
//   - localhost dev → Vite `/api/*` yollarini kendi proxy'siyle karsiliyor,
//     bu yuzden bos string DOGRU cevap.
//   - vercel.app origin'i → uygulama zaten proxy'nin yaninda, ayni origin.
//
// TAKAS (bilincli): varsayilan adres kullanicinin kendi Vercel dagitimi ve depo
// halka acik. Bu adres ZATEN kaynakta gomuluydu (native dali), yani maruziyet
// degismiyor; ustelik proxy yalnizca beyaz listedeki alan adlarina gidiyor —
// acik role degil. Kullanici Ayarlar'dan her zaman kendi adresini yazabilir.

/** Kullanici kendi adresini girmediyse kullanilacak dagitim. */
export const DEFAULT_PROXY_URL = 'https://proxy-delta-mocha-43.vercel.app';

/** localhost/127.0.0.1 → Vite dev proxy devrede, bos string dogru. */
export function isLocalDevHost(hostname) {
  const h = String(hostname || '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
}

/**
 * Hangi proxy tabani kullanilmali?
 *
 * @param {object} env
 * @param {string|null} [env.stored]   localStorage `bist_proxy_url`
 * @param {string} [env.hostname]      location.hostname
 * @param {string} [env.origin]        location.origin
 * @param {boolean} [env.capacitorNative]
 * @returns {{url: string, source: 'stored'|'same-origin'|'local-dev'|'default'}}
 */
export function resolveProxyBaseUrl(env = {}) {
  const { stored, hostname = '', origin = '', capacitorNative = false } = env;

  // 1) Kullanici acikca ayarladiysa her seyi ezer.
  const s = typeof stored === 'string' ? stored.trim().replace(/\/+$/, '') : '';
  if (s) return { url: s, source: 'stored' };

  // 2) Uygulama proxy'nin yaninda kosuyorsa ayni origin.
  if (hostname.includes('vercel.app') && origin) return { url: origin, source: 'same-origin' };

  // 3) Yerel gelistirme: Vite `/api/*` yollarini kendisi karsilar.
  if (isLocalDevHost(hostname)) return { url: '', source: 'local-dev' };

  // 4) Geri kalan HER SEY — PWA, Capacitor native, paketlenmis masaustu, duz
  //    tarayici — dagitilmis proxy'yi kullanir. Eskiden yalniz (4) native icin
  //    gecerliydi ve PWA public proxy yarisina dusuyordu.
  void capacitorNative;   // artik ayrimi yok; imzada belge amacli duruyor
  return { url: DEFAULT_PROXY_URL, source: 'default' };
}
