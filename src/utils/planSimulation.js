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

/**
 * v31.30 — VARSAYILAN POLITIKA: TRAILING-ONLY.
 *
 * OLCULDU (89 sembol / 5 yil / 26.855 sinyal, scripts/replay-signals.mjs):
 *   politika              net(tum)   net(YUKSELIS)   ort kazanc   ort kayip
 *   40/30/30 kademeli      +0.27%       +0.99%         +4.75%      -4.87%
 *   TRAILING-ONLY          +1.30%       +2.03%         +7.18%      -4.80%
 *   %50 T1 + trailing      +0.30%       +1.04%
 *   %100 T1                -0.71%       +0.06%
 *
 * Kademeli kar alma getirinin YARISINDAN FAZLASINI yok ediyordu ve karsiliginda
 * asagi koruma SAGLAMIYORDU (asagi-std 3.10 -> 2.18, ort kayip neredeyse ayni).
 * Korumayi saglayan sey STOP; hedefte satmak yalnizca kazananlari kirpiyor.
 * 5 yilin 5'inde de trailing-only kademeli plani yendi. Tutma suresi ayni
 * (islemlerin %95'i ayni bar sayisi) — sermaye verimliligi kiyasi adil.
 *
 * Hedefler artik SATIS noktasi degil, referans seviye (stop'un sikilastigi yer).
 */
export const DEFAULT_TRAIL_ONLY = true;

/** Kademeli mod acikca istenirse kullanilan oranlar (buildTradePlan ile ayni). */
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
 * @param {{maxBars?:number, fractions?:number[], trailOnly?:boolean}} [opts]
 *   fractions: T1/T2/T3 kademe oranlari (varsayilan PLAN_FRACTIONS 40/30/30).
 *   trailOnly: hedeflerde HIC satma, tamamini trailing stop tasisin — "kazanani
 *     kos" politikasi. Cikis politikasi karsilastirmasi icin (replay-signals.mjs).
 *   breakevenPct / trailActivePct / lockFraction: trailing esikleri (varsayilan
 *     PLAN_CONST). Parametre taramasi icin override edilebilir.
 * @returns {{planReturn:number, exitReason:string, barsHeld:number, legs:Array}|null}
 */
export function simulatePlanReturn(signal, bars, opts = {}) {
  const entry = signal?.entryPrice ?? signal?.entry ?? signal?.price;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Array.isArray(bars) || !bars.length) return null;
  const startKey = istanbulDayKey(signal?.timestamp);
  if (!startKey) return null;

  const maxBars = Number.isFinite(opts.maxBars) ? opts.maxBars : MAX_PLAN_BARS;
  // v31.31: trailing parametreleri disaridan verilebilir. Cikis artik TAMAMEN
  // trailing stop oldugu icin (v31.30) bu uc sayi stratejinin KENDISI — sabit
  // birakmak yerine olculebilir olmalari gerekiyordu. Varsayilan hala
  // PLAN_CONST (= useLivePrices'in gercekten uyguladigi degerler).
  const beP = Number.isFinite(opts.breakevenPct) ? opts.breakevenPct : PLAN_CONST.BREAKEVEN_PCT;
  const acP = Number.isFinite(opts.trailActivePct) ? opts.trailActivePct : PLAN_CONST.TRAIL_ACTIVE_PCT;
  const lockF = Number.isFinite(opts.lockFraction) ? opts.lockFraction : PLAN_CONST.LOCK_FRACTION;
  const isBuy = signal?.cls !== 'sell';
  const dir = isBuy ? 1 : -1;

  // Yon duzeltmeli getiri: AL'da yukari, SAT'ta asagi pozitiftir.
  const pctOf = (price) => ((price - entry) / entry) * 100 * dir;

  // Hedef kademeleri. Takip edilen sinyaller cogunlukla tek `target` tasir
  // (App.jsx recordAdvisorPick: target = pick.target || pick.t1) — o zaman %40
  // hedefte alinir, kalan %60 trailing stop'a biner. Plan tam olarak bunu soyler.
  const fr = Array.isArray(opts.fractions) && opts.fractions.length === 3
    ? opts.fractions
    : [PLAN_FRACTIONS.t1, PLAN_FRACTIONS.t2, PLAN_FRACTIONS.t3];
  // Acikca `fractions` verilmisse kademeli mod istenmis demektir; aksi halde
  // varsayilan olcume dayali politikadir (trailing-only).
  const trailOnly = opts.trailOnly ?? (Array.isArray(opts.fractions) ? false : DEFAULT_TRAIL_ONLY);
  const levels = [];
  if (!trailOnly) {
    const t1 = Number.isFinite(signal?.t1) ? signal.t1 : (Number.isFinite(signal?.target) ? signal.target : null);
    if (t1 != null && fr[0] > 0) levels.push({ key: 't1', at: t1, fraction: fr[0] });
    if (Number.isFinite(signal?.t2) && fr[1] > 0) levels.push({ key: 't2', at: signal.t2, fraction: fr[1] });
    if (Number.isFinite(signal?.t3) && fr[2] > 0) levels.push({ key: 't3', at: signal.t3, fraction: fr[2] });
  }

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
    if (peakGain >= acP) {
      const locked = entry + (peak - entry) * lockF;
      if (newStop == null || (isBuy ? locked > newStop : locked < newStop)) newStop = locked;
    } else if (peakGain >= beP) {
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
