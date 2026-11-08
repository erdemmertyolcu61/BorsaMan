// ── GUNLUK BAR TOPLU CEKIMI (v31.47) ─────────────────────────────────────────
// Tarama karnesi ve tahmin defteri gecmis kayitlari resmi gunluk kapanistan
// yerlestirir. Ikisi de taramanin kullandigi ayni anahtarla (`SYM_1y_1d`, scan
// modu) ceker: tarama az once cektiyse istek hic gitmez, ayni anda istenirse
// fetchSingle'in in-flight birlestirmesi tek istege indirir.
//
// Ag hatasi "veri yok" sayilmaz: sembol haritaya HIC konmaz, cagiran bir deneme
// yazmaz. Ayni oturumda iki kez bos donen sembol (delist, kaynak yok) bos dizi
// olarak doner ki cagiran onu denemeden sayip sonsuza kadar sira tutmasin.

import { fetchSingle } from './fetchEngine.js';

const _sessionFails = new Map();
const FAILS_BEFORE_EMPTY = 2;

/**
 * @param {string[]} symbols
 * @param {{concurrency?: number, range?: string}} [opts]
 * @returns {Promise<Record<string, Array>>} sembol → kronolojik gunluk barlar
 */
export async function fetchDailyBarsMap(symbols, { concurrency = 3, range = '1y' } = {}) {
  const queue = [...new Set((Array.isArray(symbols) ? symbols : []).filter(Boolean))];
  const out = {};
  if (!queue.length) return out;
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      let bars = null;
      try {
        const data = await fetchSingle(sym, range, '1d', true);
        bars = Array.isArray(data?.prices) && data.prices.length ? data.prices : null;
      } catch { bars = null; }
      if (bars) {
        out[sym] = bars;
        _sessionFails.delete(sym);
      } else {
        const n = (_sessionFails.get(sym) || 0) + 1;
        _sessionFails.set(sym, n);
        if (n >= FAILS_BEFORE_EMPTY) out[sym] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/** Test seam. */
export function _resetDailyBarsFails() { _sessionFails.clear(); }
