// ── SONUCU BARLARDAN BELIRLEME (v31.26) — saf, test edilebilir ────────────
//
// ÖLÇÜLEN PROBLEM: kullanıcı ekran görüntüsünde BAHKM'yi gösterdi — giriş 127.90,
// hedef 137.49 (+%7,5), gün-gün serisi **+%24,5**. Hedef fazlasıyla geçilmiş ama
// sinyal hâlâ "AÇIK".
//
// SEBEP: `determineOutcome` TEK bir yerden çağrılıyordu — `checkSignals` içindeki
// canlı fiyat kontrolü. O da yalnız uygulama AÇIKKEN, o ANKİ fiyatla çalışıyor.
// Hedefin geçildiği an uygulama kapalıysa kimse geriye bakmıyordu. Gün-gün
// doldurma (v31.22) tarihsel barları zaten çekiyordu ama sadece getiri serisini
// yazıp hedef/stop geçilmiş mi HİÇ sormuyordu — yani kanıt elimizdeydi,
// kullanmıyorduk.
//
// Bunun ikinci bir etkisi vardı: hiçbir sinyal kapanmadığı için güvenilirlik
// skoru formülün "sıfır örneklem" tabanı olan 15'te sıkışıp kalıyordu.

import { istanbulDayKey } from './signalPerfHistory.js';

/**
 * Yumuşak eşikler — canlı yoldakiyle (determineOutcome) birebir aynı.
 * Hedef/stop gibi sert bir seviye geçilmediyse, takip penceresinin sonunda
 * kapanış bu eşikleri aşmışsa sonuç yazılır.
 */
export const SOFT_WIN_PCT = 5;
export const SOFT_LOSS_PCT = -3;

/**
 * Bir sinyalin sonucunu GÜNLÜK BARLARDAN belirler.
 *
 * Konvansiyonlar (bilinçli ve dürüst):
 *  - Hedef/stop için gün içi `high`/`low` kullanılır: fiyat oraya DEĞDİYSE emir
 *    dolardı. `close` kullanmak gerçekte gerçekleşmiş bir çıkışı yok saymak olurdu.
 *  - Aynı gün hem stop hem hedef seviyesine değildiyse **STOP kabul edilir**.
 *    Günlük bardan hangisinin önce olduğu bilinemez; kanıtlayamadığımız bir
 *    kazancı yazmaktansa kaybı yazmak dürüst olan.
 *  - `high`/`low` yoksa `close`'a düşer (bazı kaynaklar OHLC vermiyor).
 *
 * @param {object} signal  { entryPrice|price, target, stop, cls, timestamp }
 * @param {Array<{date:any, high?:number, low?:number, close:number}>} bars
 * @returns {{outcome:string, date:string, price:number, source:'bar'}|null}
 */
export function evaluateOutcomeFromBars(signal, bars) {
  const entry = signal?.entryPrice ?? signal?.price;
  if (!entry || !(entry > 0) || !Array.isArray(bars) || !bars.length) return null;
  const startKey = istanbulDayKey(signal?.timestamp);
  if (!startKey) return null;

  const isSell = signal?.cls === 'sell';
  const target = Number.isFinite(signal?.target) ? signal.target : null;
  const stop = Number.isFinite(signal?.stop) ? signal.stop : null;

  let lastClose = null;
  let lastKey = null;
  let sawBar = false;

  for (const b of bars) {
    const k = istanbulDayKey(b?.date);
    if (!k || k < startKey) continue;                 // girişten önceki barlar
    const close = b?.close;
    if (!Number.isFinite(close) || close <= 0) continue;
    const high = Number.isFinite(b?.high) ? b.high : close;
    const low = Number.isFinite(b?.low) ? b.low : close;
    sawBar = true;
    lastClose = close;
    lastKey = k;

    // Giriş günü, sinyal gün içinde verildiği için o günün tamamını saymak
    // haksız olurdu — ama günlük bardan saatini ayıramayız. Giriş gününü
    // atlamak da gerçek bir aynı-gün stopunu kaçırır. Dahil ediyoruz ve bunu
    // burada belirtiyoruz: aynı-gün sonuçlar bar çözünürlüğünün sınırıdır.
    const hitStop = stop != null && (isSell ? high >= stop : low <= stop);
    const hitTarget = target != null && (isSell ? low <= target : high >= target);

    if (hitStop) return { outcome: 'STOP_HIT', date: k, price: stop, source: 'bar' };
    if (hitTarget) return { outcome: 'TARGET_HIT', date: k, price: target, source: 'bar' };
  }

  if (!sawBar) return null;

  // Sert seviye geçilmedi — son kapanışa yumuşak eşikleri uygula.
  const pct = ((lastClose - entry) / entry) * 100 * (isSell ? -1 : 1);
  if (pct >= SOFT_WIN_PCT) return { outcome: 'WIN', date: lastKey, price: lastClose, source: 'bar' };
  if (pct <= SOFT_LOSS_PCT) return { outcome: 'LOSS', date: lastKey, price: lastClose, source: 'bar' };
  return null;                                        // hâlâ açık
}

/** Sonuç bir kapanışı ifade ediyor mu (sinyal artık aktif değil)? */
export function isClosingOutcome(outcome) {
  return outcome === 'TARGET_HIT' || outcome === 'STOP_HIT'
      || outcome === 'WIN' || outcome === 'LOSS';
}
