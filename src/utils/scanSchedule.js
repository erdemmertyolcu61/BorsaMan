// ── TARAMA ZAMANLAMASI (v31.25) — saf, test edilebilir ────────────────────
//
// PROBLEM (ölçüldü): "sinyaller her gün sonu birikmeli" isteği karşılanmıyordu.
// İki ayrı boşluk vardı:
//
//   1. Kapanış taraması 18:15'te YALNIZ o bir dakikalık pencerede uygulama
//      açıksa tetikleniyordu. Kullanıcı 20:00'de açarsa o günün kapanış
//      taraması HİÇ çalışmıyordu.
//   2. Günde-bir-kez populate (v31.17) `bist_last_scan_day` damgasını HERHANGİ
//      bir tarama için basıyordu. Sabah 09:55 taraması koştuysa gün damgalanmış
//      oluyor ve akşam ayrı bir kapanış taraması hiç yapılmıyordu — yani
//      kaydedilen şey günün KAPANIŞI değil, sabahki görüntüydü.
//
// ÇÖZÜM: kapanış taramasının KENDİ damgası olsun ve tetikleyici saat değil,
// "hangi işlem gününün kapanışı kaydedildi" olsun. Böylece uygulama gün içinde
// ne zaman açılırsa açılsın o günün kapanışı bir kez yakalanır.

import { lastSettledTradingDay, istanbulDayKey } from './signalPerfHistory.js';

export const EOD_SCAN_DAY_KEY = 'bist_last_eod_scan_day';

/**
 * O ana kadar kapanışı kesinleşmiş son işlem günü için kapanış taraması
 * yapılmalı mı?
 *
 * Tetikleyici bir SAAT değil, bir GÜN karşılaştırması — bu yüzden:
 *   - 18:15'i kaçırmak bir şey kaybettirmez (22:00'de açmak da yakalar),
 *   - ertesi sabah açılış öncesi açmak hâlâ dünün kapanışını yakalar
 *     (günlük kapanış barı değişmediği için veri aynı, kayıt dürüst),
 *   - gün başına tam olarak bir kez çalışır (damga aynı güne basılır).
 *
 * @param {number|Date} now
 * @param {string|null} lastEodDay  son kapanış taramasının damgası ('YYYY-MM-DD')
 * @returns {{ should: boolean, targetDay: string, reason: string }}
 */
export function shouldRunEndOfDayScan(now = Date.now(), lastEodDay = null) {
  const targetDay = lastSettledTradingDay(now);
  if (!targetDay) return { should: false, targetDay: '', reason: 'gun-hesaplanamadi' };
  if (lastEodDay === targetDay) {
    return { should: false, targetDay, reason: 'bu-gun-zaten-kaydedildi' };
  }
  return { should: true, targetDay, reason: 'kapanis-kaydi-eksik' };
}

/**
 * Kapanış taraması gerçekten bir gün GERİDE mi kalmış (yani kaçırılmış bir gün
 * telafi ediliyor), yoksa normal akış mı? Yalnızca loglama/şeffaflık için —
 * kullanıcı "dünün kaydı şimdi alındı" bilgisini görebilsin.
 */
export function isEodCatchUp(now = Date.now(), targetDay = '') {
  return !!targetDay && targetDay !== istanbulDayKey(now);
}
