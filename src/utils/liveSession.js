// ── CANLI OTURUM BIRLESTIRME (v31.40) — saf, test edilmis ──────────────────
//
// OLCULEN HATA (2026-09-13 Pazar, gercek veriyle): tarama, toplu fiyat
// listesindeki (Is Yatirim TumHisseSenetleri) canli fiyati gunluk barlarla TAKVIM
// gunune bakarak birlestiriyordu: "bugun != son bar gunu → yeni bar ekle". Hafta
// sonu, acilistan once ve ertesi sabahki gun-sonu telafi taramasinda liste hala
// SON OTURUMU gosterir → son oturum (Cuma) "13 Eylul" diye ikinci kez eklendi.
// Bes hissede olculen sonuc:
//   - "bugunku degisim" her hissede %0,00 (BAHKM gercekte +%10 tavan, KONTR +%6,06)
//   - RSI/ATR/hacim ortalamalari ayni gunu iki kez gordu
//   - skor 5 puana kadar sisti (TSPOR 61,9 → 66,9: 65 kademesini gecti)
//   - tavan korumasi (pumpGuard) %0'i "sakin hisse" diye okudu
//
// Fiyat listesi her satirda OTURUM ZAMANINI tasiyor (`updateDate`,
// "2026-09-11T18:09:47.000+03"). Birlestirme artik oturum gunune bakar:
//   oturum == son bar gunu → ayni oturum: son bari guncelle
//   oturum  > son bar gunu → yeni oturum: bar ekle (yalniz gercek OHLC ile)
//   oturum  < son bar gunu → liste barlardan eski: dokunma
// Tarih tasimayan kaynakta (eski BigPara bicimi) `prevClose` ile konumlanir; o da
// yetmezse HICBIR SEY eklenmez — yanlis gune bar eklemektense eklememek dogru.
//
// Yan kazanc: birlestirilen son barin ACILISI gercek oturum acilisi olur. Is
// Yatirim gunluk verisi acilis tasimaz; parser yerine AOF (gunun agirlikli
// ortalamasi) koyuyor — 122 hisse x 20 gunde mum formasyonlarinin %47'sini
// degistirdigi olculdu.

import { istanbulDayKey } from './signalPerfHistory.js';

const PRICE_TOL = 0.002;                  // %0,2 — kurus yuvarlamasi
const SESSION_START_MIN = 9 * 60 + 40;    // 09:40 TRT acilis seansi

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function near(a, b, tol = PRICE_TOL) {
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 && Math.abs(a - b) / b <= tol;
}

/**
 * Oturum zamanini Date'e cevir. Is Yatirim ofseti "+03" diye yaziyor; ISO 8601
 * "+03:00" ister ve Safari (iPhone PWA) kisa bicimi OKUMAZ — normallestirilmezse
 * tarih sessizce gecersiz olur ve birlestirme en temkinli yola duser.
 * @returns {Date|null}
 */
export function parseSessionDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/T\d{2}:\d{2}/.test(s)) {
    s = s.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM-DD' → o gunun UTC gece yarisi (Istanbul ve UTC okumasinda ayni takvim gunu). */
export function dateFromDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/**
 * Su ana kadar BASLAMIS en son islem gunu (Istanbul): hafta ici 09:40'tan once
 * ya da hafta sonu bir onceki is gunu. Resmi tatiller modellenmez (depoda takvim yok).
 */
export function latestSessionDayKey(now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(t)) return '';
  let cursor = new Date(t + 3 * 3600 * 1000);                // TRT duvar saati
  const minutes = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
  const dow = cursor.getUTCDay();
  if (dow === 0 || dow === 6 || minutes < SESSION_START_MIN) cursor = new Date(cursor.getTime() - 86400000);
  for (let i = 0; i < 7; i++) {
    const d = cursor.getUTCDay();
    if (d !== 0 && d !== 6) break;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return cursor.toISOString().slice(0, 10);
}

/**
 * Canli fiyatin hangi OTURUMA ait oldugunu bul.
 * @returns {{sessionKey: string, basis: 'session_date'|'prev_close'|'unknown'}}
 */
export function resolveLiveSession(prices, live, { now = Date.now() } = {}) {
  const last = Array.isArray(prices) ? prices[prices.length - 1] : null;
  if (!last) return { sessionKey: '', basis: 'unknown' };
  const sessionDate = parseSessionDate(live?.sessionDate);
  if (sessionDate) return { sessionKey: istanbulDayKey(sessionDate), basis: 'session_date' };

  const lastKey = istanbulDayKey(last.date);
  const prev = prices[prices.length - 2];
  const pc = Number(live?.prevClose);
  if (pc > 0 && lastKey) {
    // Onceki kapanis son bardan ONCEKI barin kapanisi → canli fiyat son barin oturumu.
    if (prev && near(pc, Number(prev.close))) return { sessionKey: lastKey, basis: 'prev_close' };
    // Onceki kapanis son barin kapanisi → bir SONRAKI oturum. O da su ana kadar
    // baslamis en son islem gunu olmali; degilse celiski var → bilinmez say.
    if (near(pc, Number(last.close))) {
      const latest = latestSessionDayKey(now);
      if (latest && latest > lastKey) return { sessionKey: latest, basis: 'prev_close' };
    }
  }
  return { sessionKey: '', basis: 'unknown' };
}

/**
 * Canli fiyati gunluk barlara OTURUMUNA gore uygular. Dizi YERINDE degisir (tarama
 * ve overlay'in mevcut davranisi). Ayni cagri tekrarlanirsa ikinci bar eklenmez:
 * eklenen bar artik son bardir, ikinci cagri onu birlestirir.
 *
 * @param {Array<{date:any, open:number, high:number, low:number, close:number, volume:number}>} prices
 * @param {{price:number, open?:number, high?:number, low?:number, volume?:number, prevClose?:number, sessionDate?:any}} live
 * @param {{now?:number, marketOpen?:boolean}} [opts] marketOpen: surekli seans su an acik mi
 * @returns {{action:'merge'|'append'|'ignore', sessionKey:string, lastKey:string, basis:string, changePct:number|null}}
 */
export function mergeLiveQuote(prices, live, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const res = { action: 'ignore', sessionKey: '', lastKey: '', basis: 'unknown', changePct: null };
  const price = Number(live?.price);
  if (!Array.isArray(prices) || !prices.length || !(price > 0)) return res;
  const last = prices[prices.length - 1];
  if (!last || !(Number(last.close) > 0)) return res;

  res.lastKey = istanbulDayKey(last.date);
  const { sessionKey, basis } = resolveLiveSession(prices, live, { now });
  res.sessionKey = sessionKey;
  res.basis = basis;
  if (!sessionKey || !res.lastKey || sessionKey < res.lastKey) return res;

  const sessionIsLive = opts.marketOpen === true && sessionKey === istanbulDayKey(now);
  const open = Number(live.open), high = Number(live.high), low = Number(live.low);
  const volume = Number(live.volume), pc = Number(live.prevClose);

  if (sessionKey === res.lastKey) {
    const prev = prices[prices.length - 2];
    last.close = price;
    last.high = Math.max(Number(last.high) || price, high > 0 ? high : price, price);
    last.low = Math.min(Number(last.low) || price, low > 0 ? low : price, price);
    if (open > 0) {
      last.open = clamp(open, last.low, last.high);
      delete last._openApprox;
    }
    if (volume > 0) last.volume = volume;
    if (sessionIsLive) last._isForming = true;
    else delete last._isForming;
    res.action = 'merge';
    const base = pc > 0 ? pc : Number(prev?.close);
    if (base > 0) res.changePct = ((price - base) / base) * 100;
    return res;
  }

  // Yeni oturum: yalniz GERCEK OHLC ile. Sifir aralikli uydurma mum ATR/Bollinger'i
  // bozar. Tarih tasiyan kaynakta H=L gun (tavan kilidi) gercektir, kabul edilir.
  const realOhlc = open > 0 && high > 0 && low > 0
    && (basis === 'session_date' ? high >= low : high > low);
  if (!realOhlc) return res;
  const hi = Math.max(high, price, open);
  const lo = Math.min(low, price, open);
  const bar = {
    date: dateFromDayKey(sessionKey),
    open: clamp(open, lo, hi),
    high: hi,
    low: lo,
    close: price,
    volume: volume > 0 ? volume : 0,
  };
  if (sessionIsLive) bar._isForming = true;
  prices.push(bar);
  res.action = 'append';
  const base = pc > 0 ? pc : Number(last.close);
  if (base > 0) res.changePct = ((price - base) / base) * 100;
  return res;
}
