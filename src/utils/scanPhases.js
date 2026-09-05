// ── TARAMA FAZ TAKIBI (v31.32) — saf, test edilebilir ─────────────────────
//
// OLCULEN PROBLEM: kullanici "hem mobilde hem PC'de 612/612 tarandiginda
// kaliyor" dedi. Kod incelendiginde sonsuz dongu YOK — asil sebep gorunurluk:
// `setScanProgress({done: 612, total: 612})` ANA DONGU biter bitmez yaziliyor,
// ama arkasindan hala uzun bir son-islem zinciri var (yeniden-deneme gecisi
// 90s butce + haber 10s + temel 6s + zenginlestirme 12s + Claude 25s ...).
// O sure boyunca ilerleme cubugu %100'de, sayac 612/612'de duruyor ve hicbir
// sey degismiyor → kullanici hakli olarak "dondu" diye okuyor.
//
// Bu modul iki isi yapar:
//   1. Hangi fazda oldugumuzu isimlendirir (UI "612/612 · haber taraniyor..."
//      yazabilsin)
//   2. Faz surelerini olcer → tarama sonunda dokum loglanir. Bir dahaki
//      "yavas" raporunda TAHMIN etmek yerine hangi fazin ne kadar surdugunu
//      okuyabiliriz.
//
// Saf tutuldu: zaman kaynagi enjekte edilebilir, React/DOM bagimliligi yok.

/** Bir fazin "uzun surdu" sayilma esigi (ms) — dokumun basina cikar. */
export const SLOW_PHASE_MS = 5000;

/**
 * Faz takipcisi olustur.
 * @param {() => number} [now] zaman kaynagi (test icin enjekte edilebilir)
 */
export function createPhaseTracker(now = () => Date.now()) {
  const timings = [];
  let current = null;
  let startedAt = null;
  const t0 = now();

  /** Yeni faza gec; oncekini kapat. `null` verilirse yalniz kapatir. */
  function mark(name) {
    const t = now();
    if (current !== null && startedAt !== null) {
      timings.push({ name: current, ms: Math.max(0, t - startedAt) });
    }
    current = name || null;
    startedAt = current === null ? null : t;
    return current;
  }

  /** Takibi bitir ve dokumu dondur. */
  function finish() {
    mark(null);
    const totalMs = Math.max(0, now() - t0);
    // Ayni ad birden fazla kez gecerse topla (or. yeniden deneme turlari).
    const merged = new Map();
    for (const e of timings) merged.set(e.name, (merged.get(e.name) || 0) + e.ms);
    const phases = [...merged.entries()]
      .map(([name, ms]) => ({ name, ms, pct: totalMs > 0 ? (ms / totalMs) * 100 : 0 }))
      .sort((a, b) => b.ms - a.ms);
    return { totalMs, phases, slow: phases.filter(p => p.ms >= SLOW_PHASE_MS) };
  }

  return { mark, finish, get current() { return current; } };
}

/**
 * Dokumu tek satirlik okunabilir bir ozete cevir.
 * @param {{totalMs:number, phases:Array<{name:string,ms:number,pct:number}>}} summary
 * @param {number} [top] en yavas kac faz gosterilsin
 */
export function formatPhaseSummary(summary, top = 4) {
  if (!summary || !Array.isArray(summary.phases) || !summary.phases.length) return '';
  const s = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const parts = summary.phases.slice(0, top).map(p => `${p.name} ${s(p.ms)}`);
  return `Tarama ${s(summary.totalMs)} — ${parts.join(' · ')}`;
}
