// ── PLAN-UYUMLU GETIRI SIMULASYONU (v31.28) — saf, test edilebilir ────────
//
// OLCULEN UYUMSUZLUK: sistem SANA bir sey soyluyor, KENDISI baska bir sey
// ogreniyordu.
//   - `tradePlan.buildTradePlan` diyor ki: T1'de %40 sat, T2'de %30 sat,
//     +%3 karda stop'u basabasa cek, +%5 ustu karin yarisini kilitle.
//   - `signalCalibration.pushSignal` ise `realizedReturn` (d5 → d3 → d1) yani
//     "5 gun sonra ham fiyat neredeydi" uzerinden ogreniyordu.
//
// Bunlar ayni sey degil. 2. gun hedefe deyip 5. gunde girisin altina donen bir
// sinyal plana uyulsaydi KARDA kapanirdi; kalibrasyon onu KAYIP olarak
// ogreniyordu. Tersi de olur: hicbir hedefe degmeden 5. gunde tesadufen yukarida
// olan bir sinyal, plana gore trailing stop'tan cikmis olurdu.
//
// Bu modul "plana uyulsaydi ne olurdu"yu GUNLUK BARLARDAN yeniden kurar. Boylece
// sistem kendi talimatini olcup ondan ogrenir.
//
// Kaynak sabitler kopyalanmaz: `PLAN_CONST` tradePlan.js'ten, esikler
// useLivePrices'in gercekten uyguladigi degerlerle birebir ayni
// (TRAIL_BREAKEVEN_PCT=3, TRAIL_ACTIVE_PCT=5, TRAIL_LOCK_FRACTION=0.5).

import { istanbulDayKey } from './signalPerfHistory.js';
import { PLAN_CONST } from './tradePlan.js';

/** Plandaki kademeli kar alma oranlari — buildTradePlan ile ayni. */
export const PLAN_FRACTIONS = { t1: 0.40, t2: 0.30, t3: 0.30 };

/** Takip penceresi: sinyaller 10 gunde otomatik kapanir, 30 bar fazlasiyla yeter. */
export const MAX_PLAN_BARS = 30;

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Plana uyulsaydi elde edilecek getiriyi gunluk barlardan yeniden kurar.
 *
 * KONVANSIYONLAR (bilincli, dokumante):
 *  - Sadece CIKIS plani simule edilir, kademeli GIRIS degil. Geri cekilis/kirilim
 *    eklemelerinin dolup dolmadigi gun ici siralamaya baglidir ve gunluk bardan
 *    cikarilamaz. Tam pozisyonla giris varsayilir — varsayim uretmek yerine
 *    olculebilir olani olceriz.
 *  - Bir bar icinde ONCE stop kontrol edilir (signalOutcome ile ayni durust
 *    konvansiyon: ayni barda hem stop hem hedef gorulduyse stop kabul edilir —
 *    hangisinin once oldugu bilinemez, kanitlanamayan kari yazmak yerine kaybi yaz).
 *  - Trailing stop bar KAPANDIKTAN sonra guncellenir ve BIR SONRAKI bardan
 *    itibaren gecerlidir. Ayni bar icinde geriye donuk uygulamak ileriye bakmak
 *    olurdu (o seviye bar acilirken henuz yoktu).
 *  - Zirve `high` uzerinden takip edilir: useLivePrices canli fiyati gordugu icin
 *    gun ici tepeyi de gorur — gercek uygulamaya sadik olan bu.
 *  - Pencere sonunda kalan pozisyon son kapanistan cikarilir.
 *
 * @param {object} signal { entryPrice|price|entry, stop, target|t1, t2, t3, cls, timestamp }
 * @param {Array<{date:any, high?:number, low?:number, close:number}>} bars
 * @param {{maxBars?:number}} [opts]
 * @returns {{planReturn:number, exitReason:string, barsHeld:number, legs:Array}|null}
 */
export function simulatePlanReturn(signal, bars, opts = {}) {
  const entry = signal?.entryPrice ?? signal?.entry ?? signal?.price;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Array.isArray(bars) || !bars.length) return null;
  const startKey = istanbulDayKey(signal?.timestamp);
  if (!startKey) return null;

  const maxBars = Number.isFinite(opts.maxBars) ? opts.maxBars : MAX_PLAN_BARS;
  const isBuy = signal?.cls !== 'sell';
  const dir = isBuy ? 1 : -1;

  // Yon duzeltmeli getiri: AL'da yukari, SAT'ta asagi pozitiftir.
  const pctOf = (price) => ((price - entry) / entry) * 100 * dir;

  // Hedef kademeleri. Takip edilen sinyaller cogunlukla tek `target` tasir
  // (App.jsx recordAdvisorPick: target = pick.target || pick.t1) — o zaman %40
  // hedefte alinir, kalan %60 trailing stop'a biner. Plan tam olarak bunu soyler.
  const levels = [];
  const t1 = Number.isFinite(signal?.t1) ? signal.t1 : (Number.isFinite(signal?.target) ? signal.target : null);
  if (t1 != null) levels.push({ key: 't1', at: t1, fraction: PLAN_FRACTIONS.t1 });
  if (Number.isFinite(signal?.t2)) levels.push({ key: 't2', at: signal.t2, fraction: PLAN_FRACTIONS.t2 });
  if (Number.isFinite(signal?.t3)) levels.push({ key: 't3', at: signal.t3, fraction: PLAN_FRACTIONS.t3 });

  let stop = Number.isFinite(signal?.stop) ? signal.stop : null;
  let remaining = 1;
  let realized = 0;
  let peak = entry;
  let barsHeld = 0;
  let exitReason = 'open';
  let lastClose = null;
  const legs = [];
  const taken = new Set();

  for (const b of bars) {
    if (remaining <= 0 || barsHeld >= maxBars) break;
    const k = istanbulDayKey(b?.date);
    if (!k || k < startKey) continue;                 // girisden onceki barlar
    const close = b?.close;
    if (!Number.isFinite(close) || close <= 0) continue;
    const high = Number.isFinite(b?.high) && b.high > 0 ? b.high : close;
    const low = Number.isFinite(b?.low) && b.low > 0 ? b.low : close;
    barsHeld += 1;
    lastClose = close;

    // Lehimize / aleyhimize uc noktalar (yone gore)
    const fav = isBuy ? high : low;
    const adv = isBuy ? low : high;

    // 1) STOP ONCE — ayni bar belirsizliginde stop kazanir (durust taraf).
    if (stop != null && (isBuy ? adv <= stop : adv >= stop)) {
      realized += remaining * pctOf(stop);
      legs.push({ key: 'stop', at: r2(stop), fraction: r2(remaining), pct: r2(pctOf(stop)), day: k });
      remaining = 0;
      exitReason = 'stop';
      break;
    }

    // 2) HEDEFLER — bir barda birden fazla kademe gorulebilir (gap gunu).
    for (const lv of levels) {
      if (taken.has(lv.key)) continue;
      if (isBuy ? fav >= lv.at : fav <= lv.at) {
        const frac = Math.min(lv.fraction, remaining);
        if (frac <= 0) continue;
        realized += frac * pctOf(lv.at);
        legs.push({ key: lv.key, at: r2(lv.at), fraction: r2(frac), pct: r2(pctOf(lv.at)), day: k });
        remaining -= frac;
        taken.add(lv.key);
      }
    }
    if (remaining <= 0) { exitReason = 'targets'; break; }

    // 3) TRAILING — bar kapandiktan SONRA, sonraki bardan itibaren gecerli.
    if (isBuy ? fav > peak : fav < peak) peak = fav;
    const peakGain = pctOf(peak);
    let newStop = stop;
    if (peakGain >= PLAN_CONST.TRAIL_ACTIVE_PCT) {
      const locked = entry + (peak - entry) * PLAN_CONST.LOCK_FRACTION;
      if (newStop == null || (isBuy ? locked > newStop : locked < newStop)) newStop = locked;
    } else if (peakGain >= PLAN_CONST.BREAKEVEN_PCT) {
      if (newStop == null || (isBuy ? entry > newStop : entry < newStop)) newStop = entry;
    }
    stop = newStop;   // asla gevsemez (yalniz lehimize hareket eder)
  }

  // Pencere sonunda kalan pozisyon son kapanistan cikar.
  if (remaining > 0 && lastClose != null) {
    realized += remaining * pctOf(lastClose);
    legs.push({ key: 'timeout', at: r2(lastClose), fraction: r2(remaining), pct: r2(pctOf(lastClose)) });
    exitReason = exitReason === 'open' ? 'timeout' : exitReason;
    remaining = 0;
  }
  if (lastClose == null) return null;                 // giristen sonra hic bar yok

  return { planReturn: r2(realized), exitReason, barsHeld, legs };
}

/**
 * Kalibrasyonun ogrenecegi getiri.
 * Plan simulasyonu VARSA o kullanilir (sistemin kendi talimatinin sonucu);
 * yoksa ham checkpoint getirisine duser — hicbir veri kaybolmaz.
 * @param {object} signal
 * @param {number|null} fallback  realizedReturn(sig, null) sonucu
 */
export function learningReturn(signal, fallback = null) {
  const p = signal?.planReturn;
  if (Number.isFinite(p)) return p;
  return Number.isFinite(fallback) ? fallback : null;
}
