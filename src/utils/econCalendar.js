// ── MAKROEKONOMIK TAKVIM (v31.48) — gercek kaynak, saf ayristirici ────────────
//
// v31.47'de eski "takvim" kaldirildi: istemcide uretilmis 8 sahte etkinlikti
// (bugun+2 gun, bugun+5 ... ve uydurma beklentiler). Kullanici takvimi gercek
// haliyle istedi. Olculen kaynaklar (2026-11-08):
//   - doviz.com/ekonomik-takvim: sunucu tarafinda HTML olarak ~1.600 satir, Turkiye
//     dahil (TUFE, sanayi uretimi, cari denge, guven endeksleri...) gerceklesen /
//     beklenti / onceki degerleriyle. Anahtar gerekmez. Sekmeler: bugun, yarin, bu
//     hafta, bu ay — ay sekmesi ayin sonuna kadar gider. (borsapy ayni veriyi
//     doviz.com'un tokenli API'sinden ceker; biz herkese acik sayfayi okuyoruz.)
//   - ForexFactory haftalik JSON calisiyor ama Turkiye yok; kullanilmadi.
//   - TCMB PPK toplantilari 2026 icin duyurulmus takvimden (asagida). doviz.com ayin
//     sonrasini gostermedigi icin PPK gunu ayrica eklenir.
//
// Ayristirici proxy'de (api/proxy.js, source=econ_calendar) birebir kopya olarak da
// var; bir test ikisinin ayni ciktiyi verdigini kilitler. Yerelde Vite
// /api/doviz-takvim yolu sayfayi getirir ve burada ayristirilir.

import { PROXY_BASE_URL } from './fetchEngine.js';

export const ECON_REGIONS = {
  'Türkiye': 'TR', 'ABD': 'US', 'Euro Bölgesi': 'EU', 'Almanya': 'DE',
  'İngiltere': 'GB', 'Çin': 'CN', 'Japonya': 'JP',
};
const MONTHS = {
  Ocak: 1, Şubat: 2, Mart: 3, Nisan: 4, Mayıs: 5, Haziran: 6,
  Temmuz: 7, Ağustos: 8, Eylül: 9, Ekim: 10, Kasım: 11, Aralık: 12,
};

// TCMB, 2026 PPK toplanti takvimi (Aralik 2025'te duyuruldu; karar 14:00).
// Repo tablosundaki 23.01 / 23.10 tarihleri kararin ertesi gunu yururluge girisidir.
export const PPK_DATES_2026 = [
  '2026-01-22', '2026-03-12', '2026-04-22', '2026-06-11',
  '2026-07-23', '2026-09-10', '2026-10-22', '2026-12-10',
];

const strip = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function dayKeyFromTurkish(text) {
  const m = /^(\d{1,2})\s+(\S+)\s+(\d{4})$/.exec(strip(text));
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * doviz.com/ekonomik-takvim HTML'i → etkinlik listesi (tekil, kronolojik).
 * Yalniz ECON_REGIONS ulkeleri; Turkiye icin dusuk onem de tutulur, digerleri orta+.
 * @returns {Array<{d:string,t:string|null,c:string,imp:'low'|'mid'|'high',ev:string,act:string|null,exp:string|null,prev:string|null}>}
 */
export function parseDovizCalendarHtml(html) {
  if (typeof html !== 'string' || !html) return [];
  const headRe = /<div class="text-center mt-8 mb-8 text-bold">([^<]+)<\/div>/g;
  const heads = [];
  let m;
  while ((m = headRe.exec(html)) !== null) heads.push({ at: m.index, end: headRe.lastIndex, d: dayKeyFromTurkish(m[1]) });
  const seen = new Set();
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!h.d) continue;
    const block = html.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : html.length);
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    let r;
    while ((r = rowRe.exec(block)) !== null) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let c;
      while ((c = cellRe.exec(r[1])) !== null) cells.push(c[1]);
      if (cells.length < 7) continue;
      const code = ECON_REGIONS[strip(cells[1])];
      if (!code) continue;
      const impM = /importance\s+(low|mid|high)/.exec(cells[2]);
      const imp = impM ? impM[1] : 'low';
      if (code !== 'TR' && imp === 'low') continue;
      const ev = strip(cells[3]).replace(/\s*\(-\)\s*$/, '').replace(/\s+\)/g, ')').replace(/\(\s+/g, '(');
      const t = /^\d{1,2}:\d{2}$/.test(strip(cells[0])) ? strip(cells[0]) : null;
      const key = `${h.d}|${t}|${code}|${ev}`;
      if (!ev || seen.has(key)) continue;
      seen.add(key);
      const val = (x) => strip(x) || null;
      out.push({ d: h.d, t, c: code, imp, ev, act: val(cells[4]), exp: val(cells[5]), prev: val(cells[6]) });
    }
  }
  return out.sort((a, b) => (a.d + (a.t || '99:99') < b.d + (b.t || '99:99') ? -1 : a.d + (a.t || '99:99') > b.d + (b.t || '99:99') ? 1 : 0));
}

/** PPK gunlerini ekle (o gun zaten bir TCMB faiz satiri yoksa). */
export function withPpkDates(events, ppkDates = PPK_DATES_2026) {
  const list = Array.isArray(events) ? events.slice() : [];
  for (const d of ppkDates) {
    const has = list.some(e => e.d === d && e.c === 'TR' && /faiz/i.test(e.ev));
    if (!has) list.push({ d, t: '14:00', c: 'TR', imp: 'high', ev: 'TCMB faiz kararı (PPK)', act: null, exp: null, prev: null, ppk: true });
  }
  return list.sort((a, b) => ((a.d + (a.t || '99:99')) < (b.d + (b.t || '99:99')) ? -1 : 1));
}

/** Sıradaki PPK gunu (bugun dahil) ya da null. */
export function nextPpkDate(todayKey, ppkDates = PPK_DATES_2026) {
  return ppkDates.find(d => d >= todayKey) || null;
}

/**
 * Ekranda gosterilecek dilimler.
 *  upcoming: bugunden itibaren `days` gun — Turkiye orta+ , diger ulkeler yuksek
 *  recentTr: son `recentDays` gunde aciklanmis Turkiye orta+ verileri
 */
export function selectCalendarView(events, todayKey, { days = 7, recentDays = 10, recentLimit = 5 } = {}) {
  const addDays = (key, n) => {
    const t = Date.parse(`${key}T12:00:00Z`) + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const until = addDays(todayKey, days);
  const since = addDays(todayKey, -recentDays);
  const list = Array.isArray(events) ? events : [];
  const upcoming = list.filter(e => e.d >= todayKey && e.d <= until
    && (e.c === 'TR' ? e.imp !== 'low' : e.imp === 'high'));
  // Once yuksek onem (enflasyon, sanayi uretimi...), sonra en yeni; haftalik rezerv
  // gibi orta onemli rutin veriler enflasyonu ekrandan itmesin.
  const rank = (e) => (e.imp === 'high' ? 0 : 1);
  const recentTr = list.filter(e => e.c === 'TR' && e.d < todayKey && e.d >= since && e.act && e.imp !== 'low')
    .sort((a, b) => rank(a) - rank(b) || (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .slice(0, recentLimit);
  return { upcoming, recentTr };
}

const CACHE_KEY = 'bist_econ_calendar_v1';
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * @returns {Promise<{events:Array, fetchedAt:number}|{unavailable:true, reason:string}>}
 */
export async function fetchEconCalendar() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw && Array.isArray(raw.events) && Date.now() - raw.fetchedAt < CACHE_TTL_MS) return raw;
  } catch { /* yok say */ }
  try {
    let events;
    if (PROXY_BASE_URL) {
      const res = await fetch(`${PROXY_BASE_URL}/api/proxy?source=econ_calendar`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 400) return { unavailable: true, reason: 'proxy_outdated' };
      if (!res.ok) return { unavailable: true, reason: `http_${res.status}` };
      const j = await res.json();
      if (!j?.ok || !Array.isArray(j.events)) return { unavailable: true, reason: 'shape' };
      events = j.events;
    } else {
      const res = await fetch('/api/doviz-takvim', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { unavailable: true, reason: `http_${res.status}` };
      events = parseDovizCalendarHtml(await res.text());
    }
    if (!events.length) return { unavailable: true, reason: 'empty' };
    const out = { events, fetchedAt: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch { /* kota */ }
    return out;
  } catch (e) {
    return { unavailable: true, reason: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
