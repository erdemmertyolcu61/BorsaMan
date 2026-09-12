// ── VERI KATMANI OLCUMU (v31.38) — saf, test edilebilir ────────────────────
//
// Kullanici karari (2026-09-12): KAP bildirimleri ve hisse bazli yabanci orani
// "goster + olc, sonra ac". Bu modul "olc" kismi. Kayitli AL sinyallerini bu
// verilere gore kovalar ve her kovanin GERCEK sonucunu verir — liveEdge ile ayni
// getiri zinciri (plan-uyumlu getiri → kapanistan checkpoint → canli mandal),
// ayni MIN_SAMPLE. Kucuk ornekli kova "guvenilir degil" isaretlenir.
//
// Skor bu olcume henuz BAGLI DEGIL. Bir kova guvenilir hale gelip anlamli bir
// fark gosterdiginde dataLayerPolicy'deki bayrak acilir — tahminle degil.

import { realizedReturn, perfCheckpoint } from './signalPerfHistory.js';
import { learningReturn } from './planSimulation.js';
import { MIN_SAMPLE } from './liveEdge.js';

/** Haftalik yabanci orani degisimi bu esigin disindaysa giris/cikis sayilir (puan). */
export const FOREIGN_FLOW_BAND_PP = 0.3;

const FOREIGN_BUCKETS = ['inflow', 'flat', 'outflow'];
const KAP_BUCKETS = ['event', 'other', 'none', 'risk'];

export function foreignBucket(signal) {
  const w = signal?.foreignChangeWeek;
  if (typeof w !== 'number' || !Number.isFinite(w)) return 'unknown';
  if (w >= FOREIGN_FLOW_BAND_PP) return 'inflow';
  if (w <= -FOREIGN_FLOW_BAND_PP) return 'outflow';
  return 'flat';
}

/**
 * `kapChecked` yoksa sinyal KAP akisi calismadan (ya da v31.38 oncesi)
 * kaydedilmistir → "bildirim yok" sayilamaz, 'unknown'.
 */
export function kapBucket(signal) {
  if (!signal || signal.kapChecked !== true) return 'unknown';
  if (signal.kapRisk) return 'risk';
  if (Array.isArray(signal.kapCategories) && signal.kapCategories.length > 0) return 'event';
  if ((signal.kapCount || 0) > 0) return 'other';
  return 'none';
}

function settledReturn(signal) {
  const settled = signal.status === 'closed'
    || perfCheckpoint(signal, 'd5') != null
    || Number.isFinite(signal.planReturn);
  if (!settled) return null;
  const r = learningReturn(signal, realizedReturn(signal, null)) ?? signal.currentReturn;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

function finalize(cell, minSample) {
  return {
    n: cell.n,
    winRate: cell.n ? round1((cell.wins / cell.n) * 100) : null,
    avgReturn: cell.n ? round2(cell.sum / cell.n) : null,
    reliable: cell.n >= minSample,
  };
}

/**
 * @param {object[]} signals useSignalTracker kayitlari
 * @returns {{ settled: number, withForeign: number, withKap: number, minSample: number,
 *   foreign: Object<string, {n, winRate, avgReturn, reliable}>,
 *   kap: Object<string, {n, winRate, avgReturn, reliable}> }}
 */
export function computeDataLayerEdge(signals, { minSample = MIN_SAMPLE } = {}) {
  const foreign = Object.fromEntries(FOREIGN_BUCKETS.map((k) => [k, { n: 0, wins: 0, sum: 0 }]));
  const kap = Object.fromEntries(KAP_BUCKETS.map((k) => [k, { n: 0, wins: 0, sum: 0 }]));
  const add = (cell, ret) => { cell.n++; cell.sum += ret; if (ret > 0) cell.wins++; };
  let settled = 0;
  let withForeign = 0;
  let withKap = 0;

  for (const s of Array.isArray(signals) ? signals : []) {
    if (!s || s.cls !== 'buy') continue;
    const ret = settledReturn(s);
    if (ret == null) continue;
    settled++;
    const fb = foreignBucket(s);
    if (fb !== 'unknown') { withForeign++; add(foreign[fb], ret); }
    const kb = kapBucket(s);
    if (kb !== 'unknown') { withKap++; add(kap[kb], ret); }
  }

  return {
    settled, withForeign, withKap, minSample,
    foreign: Object.fromEntries(FOREIGN_BUCKETS.map((k) => [k, finalize(foreign[k], minSample)])),
    kap: Object.fromEntries(KAP_BUCKETS.map((k) => [k, finalize(kap[k], minSample)])),
  };
}
