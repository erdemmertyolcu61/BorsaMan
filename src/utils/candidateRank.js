// ── SAKIN KURULUM SIRALAMASI (v31.53) — saf, test edilebilir ──────────────
//
// SORU: tarama her gun onlarca aday uretir, panel 8-10 gosterir, paper 3 acar.
// Sonucu belirleyen sey SECIM. Secim anahtarlari (skor, yarin-potansiyeli +
// erken/kirilim bonuslari, guven skoru) siralayici olarak hic olculmemisti.
//
// OLCUM (scripts/feature-edge-study.mjs + feature-edge-report.mjs; sinyal gun
// kapanisinda, giris ertesi acilis, canli stop kurali, %0,3 maliyet; ayni gunun
// adaylari arasinda sira korelasyonu ve ilk-3 secimi):
//   - skor:                 adaylar arasinda TERS calisiyor (yuksek skor daha kotu)
//   - yarin-potansiyeli:    ayirmiyor (sira korelasyonu ~0)
//   - guven skoru:          ayirmiyor
//   - bu dosyadaki bilesik: ayiriyor — kesif kumesinde (89 hisse) ve ona hic
//     bakilmadan secildikten sonra denenen dogrulama kumesinde (168 baska hisse)
//     ayni yonde. Rakamlar CLAUDE.md "Olculmus kararlar" tablosunda.
//
// BILESIK: adaylar arasinda "daha sakin, daha az uzamis" olan once gelir.
//   1. dusuk gerceklesen oynaklik (son 20 gunluk degisimin standart sapmasi)
//   2. dusuk ADX (trend henuz olgunlasmamis / tukenmemis)
//   3. MA50'ye yakin ya da altinda (uzamamis)
//   4. yuksek giris kalitesi (son gunlerde sicramamis, MA20 cevresinde)
// Her ozellik o gunun adaylari icinde yuzdelik siraya cevrilir, dordu esit
// agirlikla ortalanir. Agirlik / esik UYDURULMADI: yonler kesif verisinin ilk
// yarisinda secildi, ikinci yarida ve dogrulama kumesinde degismeden sinandi.
//
// DURUST SINIR: bu bir SIRALAMA; adaylarin ortalama getirisini degistirmez,
// yalniz hangilerinin one gecegini. Olculen fark tarihseldir ve son iki yilda
// kuculmustur; ileriye garanti degildir.

/** [alan, yon] — yon +1: buyuk iyi, -1: kucuk iyi. Sirayi ve yonu olcmeden degistirme. */
export const CALM_FEATURES = Object.freeze([
  ['realizedVol20', -1],
  ['adx', -1],
  ['distFromMA50', -1],
  ['entryQuality', 1],
]);

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Son `n` gunluk yuzde degisimin standart sapmasi (%).
 * @param {Array<{close:number}>} prices eski → yeni
 * @returns {number|null} yeterli bar yoksa null
 */
export function realizedVol(prices, n = 20) {
  if (!Array.isArray(prices) || prices.length < n + 1) return null;
  let s = 0, s2 = 0, k = 0;
  for (let i = prices.length - n; i < prices.length; i++) {
    const a = prices[i - 1]?.close, b = prices[i]?.close;
    if (!(a > 0) || !(b > 0)) continue;
    const ch = (b / a - 1) * 100;
    s += ch; s2 += ch * ch; k++;
  }
  if (k < n * 0.8) return null;
  return Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2));
}

/**
 * Giris kalitesi (0-100): kovalama riski dusukse yuksek. useAIAdvisor.enhancePick'in
 * guven skorundaki bilesenin kendisi — oradan buraya tasindi ki siralama ile guven
 * skoru AYNI tanimi kullansin.
 * @param {object} p tarama satiri (todayPumpReal, recentPump, distFromMA20, obvTrend,
 *                   change, rsi, volRatio, entryTimingScore)
 * @param {boolean} [isSell=false] SAT'ta giris zamanlamasi harmani uygulanmaz
 */
export function entryQualityOf(p, isSell = false) {
  if (!p) return 50;
  const pump = Math.max(p.todayPumpReal || 0, p.recentPump || 0);
  const ma20Dist = Math.abs(p.distFromMA20 || 0);
  let q = pump <= 1 ? 95 : pump <= 2 ? 85 : pump <= 3 ? 60 : pump <= 4 ? 40 : pump <= 5 ? 25 : pump <= 7 ? 15 : 5;
  // MA20'den uzak = uzamis trend
  if (ma20Dist > 10) q = Math.max(5, q - 40);
  else if (ma20Dist > 7) q = Math.max(10, q - 30);
  else if (ma20Dist > 5) q = Math.max(20, q - 20);
  else if (ma20Dist > 3) q = Math.max(30, q - 10);
  else if (ma20Dist < 2) q = Math.min(98, q + 8);
  // Fiyat yukselirken OBV dagitim = tuzak
  if (p.obvTrend === 'distribution' && (p.change || 0) > 0 && (p.rsi || 50) > 55) q = Math.max(5, q - 35);
  // Yukselis + zayif hacim
  if ((p.volRatio || 1) < 0.8 && (p.change || 0) > 1) q = Math.max(10, q - 20);
  // Giris zamanlamasi (MA20 destek / RSI / Bollinger / sessiz cekilme) harmani
  if (p.entryTimingScore != null && !isSell) {
    const timing = Math.max(0, Math.min(100, 50 + p.entryTimingScore / 2));
    q = Math.round(q * 0.6 + timing * 0.4);
  }
  return q;
}

/** Degerlerin 0..1 yuzdelik sirasi (esitler ortak sira alir); sayi olmayan → 0,5 (notr). */
function percentileRanks(values) {
  const idx = [];
  for (let i = 0; i < values.length; i++) if (isNum(values[i])) idx.push([values[i], i]);
  idx.sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0.5);
  const n = idx.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const rk = n > 1 ? ((i + j) / 2) / (n - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k][1]] = rk;
    i = j + 1;
  }
  return out;
}

/**
 * Adaylarin sakinlik sirasi: 0-100, yuksek = o gunun adaylari icinde daha sakin kurulum.
 * GORELI bir olcudur — yalniz AYNI aday listesi icinde anlamlidir, taramalar arasi
 * karsilastirilmaz. Tek adayda ya da hic ozellik yokken 50 doner.
 *
 * @param {object[]} candidates CALM_FEATURES alanlarini tasiyan satirlar
 *                              (entryQuality yoksa entryQualityOf ile hesaplanir)
 * @returns {number[]} candidates ile ayni sirada 0-100
 */
export function calmRanks(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return [];
  const cols = CALM_FEATURES.map(([field]) => percentileRanks(list.map((c) => {
    if (!c) return null;
    if (field === 'entryQuality' && !isNum(c.entryQuality)) return entryQualityOf(c);
    return c[field];
  })));
  return list.map((_, i) => {
    let s = 0;
    for (let f = 0; f < CALM_FEATURES.length; f++) s += CALM_FEATURES[f][1] > 0 ? cols[f][i] : 1 - cols[f][i];
    return Math.round((s / CALM_FEATURES.length) * 1000) / 10;
  });
}

/** Adaylara `_calmRank` damgalar (yeni nesneler doner, girdi degismez). */
export function stampCalmRank(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const ranks = calmRanks(list);
  return list.map((c, i) => (c && typeof c === 'object' ? { ...c, _calmRank: ranks[i] } : c));
}

/** Siralama karsilastiricisi: yuksek `_calmRank` once; damgasiz satirlar sona, kendi sirasiyla. */
export function byCalmRankDesc(a, b) {
  const x = isNum(a?._calmRank) ? a._calmRank : -1;
  const y = isNum(b?._calmRank) ? b._calmRank : -1;
  return y - x;
}
