// ── ADAPTİF TARAMA HIZI (v31.25) — saf, test edilebilir ───────────────────
//
// ÖLÇÜLEN PROBLEM: BigPara ardışık hızlı isteklerde 401 ("You do not have
// permission...") döndürüyor; aynı URL 20 saniye bekleyince 200 dönüyor. Yani
// bu bir yetki hatası değil, ÜST KAYNAK KISITLAMASI (throttling).
//
// Tarama 612 sembolü 20'lik gruplar hâlinde 60 ms arayla istiyor. Kısıtlama
// devreye girdiğinde bu istekler "veri yok" sayılıp sembol düşüyordu — daha
// önce ölçülen 111/612 kapsamanın muhtemel sebeplerinden biri. Devre kesici de
// yardımcı olmuyor: o, kaynağı tamamen kapatıyor, oysa doğru tepki
// YAVAŞLAMAK.
//
// Bu modül tarama sırasında hızı kısıtlamaya göre uyarlar: kısıtlama sinyali
// geldikçe yavaşlar, temiz geçişlerde kademeli hızlanır. Saf — zaman/ağ
// bilmez, yalnız durum makinesidir.

export const THROTTLE_STATUSES = [401, 403, 429, 503];

/** Bir yanıtın üst-kaynak kısıtlaması olup olmadığını söyler. */
export function isThrottleSignal(status) {
  return THROTTLE_STATUSES.includes(status);
}

const DEFAULTS = {
  baseDelayMs: 60,
  maxDelayMs: 1500,
  baseConcurrency: 20,
  minConcurrency: 4,
  /** Bu kadar ardışık temiz grup sonrası bir kademe hızlan. */
  recoverAfterCleanBatches: 3,
};

/**
 * Tarama boyunca yaşayan hız denetleyicisi.
 *
 * Kasıtlı olarak asimetrik: kısıtlama görülünce HIZLA yavaşlar (gecikme x2,
 * eşzamanlılık yarıya), temiz geçişlerde YAVAŞÇA hızlanır. Kısıtlanmış bir
 * kaynağa geri saldırmanın maliyeti, biraz yavaş taramaktan yüksek.
 *
 * @param {object} [opts]
 * @returns {{ current: () => {delayMs:number, concurrency:number},
 *             onBatch: (r:{throttled?:number, ok?:number}) => void,
 *             stats: () => object }}
 */
export function createThrottleController(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let delayMs = cfg.baseDelayMs;
  let concurrency = cfg.baseConcurrency;
  let cleanStreak = 0;
  let throttleEvents = 0;
  let batches = 0;

  const clamp = () => {
    delayMs = Math.max(cfg.baseDelayMs, Math.min(cfg.maxDelayMs, Math.round(delayMs)));
    concurrency = Math.max(cfg.minConcurrency, Math.min(cfg.baseConcurrency, Math.round(concurrency)));
  };

  return {
    current: () => ({ delayMs, concurrency }),

    /**
     * Bir grup tamamlandığında çağrılır.
     * @param {{throttled?:number, ok?:number}} r
     */
    onBatch(r = {}) {
      batches++;
      const throttled = r.throttled || 0;
      if (throttled > 0) {
        throttleEvents += throttled;
        cleanStreak = 0;
        delayMs = delayMs * 2 || cfg.baseDelayMs * 2;
        concurrency = concurrency / 2;
      } else {
        cleanStreak++;
        if (cleanStreak >= cfg.recoverAfterCleanBatches) {
          cleanStreak = 0;
          // Kademeli geri dönüş — bir anda taban hıza atlamak kısıtlamayı
          // hemen geri tetikler.
          delayMs = delayMs * 0.7;
          concurrency = concurrency + 2;
        }
      }
      clamp();
    },

    stats: () => ({ delayMs, concurrency, throttleEvents, batches, cleanStreak }),
  };
}
