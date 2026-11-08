// ── TCMB POLITIKA FAIZI (v31.47) — canli kaynak, saf ayristirici ──────────────
//
// OLCULEN HATA: makro panel "TCMB faiz %50" gosteriyordu. Bu bir sabit yedekti
// (macroContextEngine TCMB_FALLBACK_RAW, 2026-04-17 tarihli) ve canli bir kaynak
// hic baglanmamisti. TCMB'nin kendi sayfasi 2026-11-08'de okundu: bir hafta vadeli
// repo %36,00 (23.10.2026 karari). Ayni sayi JARVIS'e giden makro satirina da
// yaziliyordu, yani yapay zeka da 14 puan yanlis faizle yorum yapiyordu.
//
// Kaynak: tcmb.gov.tr "1 Hafta Repo" sayfasi — tarih / borc alma / borc verme
// satirlarindan olusan duz bir HTML tablosu, en yeni karar en altta. EVDS anahtari
// gerekmez. HTML oldugu icin istemci proxy zinciri (tryProxy) onu reddeder: PWA'da
// proxy sunucuda ayristirir (source=tcmb_rate), yerelde Vite /api/tcmb yolu HTML'i
// getirir ve burada ayristirilir.

import { PROXY_BASE_URL } from './fetchEngine.js';

export const TCMB_REPO_PATH = '/Main+Menu/Temel+Faaliyetler/Para+Politikasi/Merkez+Bankasi+Faiz+Oranlari/1+Hafta+Repo';
const CACHE_KEY = 'bist_tcmb_rate_cache_v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const ROW_RE = /<td[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)\s*<\/td>/g;

/**
 * @param {string} html TCMB "1 Hafta Repo" sayfasi
 * @returns {{rate:number, date:string, previousRate:number|null, previousDate:string|null}|null}
 */
export function parseTcmbRepoHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  const rows = [];
  ROW_RE.lastIndex = 0;
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    const rate = parseFloat(m[4].replace(',', '.'));
    if (!Number.isFinite(rate) || rate <= 0 || rate > 200) continue;
    rows.push({ date: `${m[3]}-${m[2]}-${m[1]}`, rate });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return { rate: last.rate, date: last.date, previousRate: prev?.rate ?? null, previousDate: prev?.date ?? null };
}

let _memory = null;

function readCache() {
  if (_memory && Date.now() - _memory.fetchedAt < CACHE_TTL_MS) return _memory;
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw && Number.isFinite(raw.rate) && Date.now() - raw.fetchedAt < CACHE_TTL_MS) {
      _memory = raw;
      return raw;
    }
  } catch { /* yok say */ }
  return null;
}

function writeCache(v) {
  _memory = v;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* kota */ }
}

/**
 * Canli politika faizi. Basarisizlikta sessiz bos degil, sebep doner
 * ({unavailable:true, reason}) — cagiran son bilinen degeri "eski" diye etiketler.
 */
export async function fetchTcmbPolicyRate() {
  const cached = readCache();
  if (cached) return cached;
  try {
    let parsed = null;
    if (PROXY_BASE_URL) {
      const res = await fetch(`${PROXY_BASE_URL}/api/proxy?source=tcmb_rate`, { signal: AbortSignal.timeout(10000) });
      if (res.status === 400) return { unavailable: true, reason: 'proxy_outdated' };
      if (!res.ok) return { unavailable: true, reason: `http_${res.status}` };
      const j = await res.json();
      if (j?.ok && Number.isFinite(j.rate)) {
        parsed = { rate: j.rate, date: j.date, previousRate: j.previousRate ?? null, previousDate: j.previousDate ?? null };
      }
    } else {
      const res = await fetch(`/api/tcmb${TCMB_REPO_PATH}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { unavailable: true, reason: `http_${res.status}` };
      parsed = parseTcmbRepoHtml(await res.text());
    }
    if (!parsed) return { unavailable: true, reason: 'parse' };
    const out = { ...parsed, fetchedAt: Date.now(), source: 'tcmb.gov.tr' };
    writeCache(out);
    return out;
  } catch (e) {
    return { unavailable: true, reason: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/** Test seam. */
export function _resetTcmbRateCache() { _memory = null; }
