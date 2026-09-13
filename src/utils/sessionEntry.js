// ── SONRAKI SEANSTA GIRIS (v31.40) — saf, test edilmis ─────────────────────
//
// Kullanici: "tum hisseleri dogru fiyat ve dogru gunde almak cok onemli."
// Seans DISINDA uretilen AL (aksam 18:15 gun-sonu taramasi, hafta sonu, acilis oncesi)
// o anki son kapanistan ALINAMAZ. Iki yerde bu yanlis yapiliyordu:
//  1. Paper ML motoru pozisyonu tarama biter bitmez aciyordu: Pazar gunu Cuma
//     kapanisindan. Gercekte ancak Pazartesi acilisinda alinabilir ve o acilis
//     bosluklu olabilir.
//  2. Sinyal takibi girisi son kapanis sayip giris gununu DAHIL ediyordu. Aksam
//     taramasinda "giris gunu" zaten kapanmis seanstir: sinyalden ONCE olmus dip
//     stop'u, tepe trailing'i tetikleyebiliyordu (geriye bakan hata).
//
// Kural: seans disi sinyalin girisi, sinyalin gordugu son oturumdan SONRAKI ilk seansin
// ACILISI. Gunluk barlar v31.40'tan beri gercek acilis tasir (yoksa `_openApprox`).
// O seansin bari/acilisi henuz yoksa giris BEKLER: sonuc, gun-gun seri ve plan getirisi
// hesaplanmaz. Seans ICINDE uretilen sinyal eskisi gibi o anki fiyattan girer.
//
// Bilinen sinir: resmi tatiller modellenmez (depoda takvim yok). Paper emri "bir sonraki
// is gunu" seansinda dolar; arada tatil varsa emir iptal edilir ve loglanir — yanlis
// gunun acilisindan dolmaktansa dolmamak.

import { istanbulDayKey } from './signalPerfHistory.js';
import { latestSessionDayKey, parseSessionDate } from './liveSession.js';

export const ENTRY_BASIS = Object.freeze({ LIVE: 'live', NEXT_SESSION: 'next_session' });
export const PENDING_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' sonrasindaki ilk hafta ici gun. */
export function nextWeekdayKey(key) {
  if (!DAY_KEY_RE.test(String(key || ''))) return '';
  let t = Date.parse(`${key}T12:00:00Z`) + 86400000;
  for (let i = 0; i < 7; i++) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    t += 86400000;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Kayit aninda giris esasini belirle.
 * @param {{marketOpen:boolean, now?:number, sessionDay?:string|null}} p
 *   sessionDay: sinyalin dayandigi verinin oturum gunu (tarama `_sessionDay`)
 */
export function planEntry({ marketOpen, now = Date.now(), sessionDay = null } = {}) {
  if (marketOpen) return { entryBasis: ENTRY_BASIS.LIVE, entryAfterSession: null };
  const seen = DAY_KEY_RE.test(String(sessionDay || '')) ? sessionDay : latestSessionDayKey(now);
  return { entryBasis: ENTRY_BASIS.NEXT_SESSION, entryAfterSession: seen || null };
}

/** Seans disi sinyal ve henuz dolmadi mi? */
export function isEntryPending(signal) {
  return signal?.entryBasis === ENTRY_BASIS.NEXT_SESSION && !signal?.entryFillDay;
}

/**
 * Seans disi sinyalin dolumu: entryAfterSession'dan sonraki ILK barin acilisi.
 * @returns {{day:string, price:number, approx:boolean}|null}
 */
export function resolveNextSessionFill(signal, bars) {
  if (signal?.entryBasis !== ENTRY_BASIS.NEXT_SESSION) return null;
  const after = signal.entryAfterSession;
  if (!after || !Array.isArray(bars)) return null;
  for (const b of bars) {
    const k = istanbulDayKey(b?.date);
    if (!k || k <= after) continue;
    const open = Number(b.open);
    const close = Number(b.close);
    const price = open > 0 ? open : close;
    if (!(price > 0)) continue;
    return { day: k, price, approx: !(open > 0) || b._openApprox === true };
  }
  return null;
}

/** Kayitta hesaplanan kayma oranini sonradan dolan fiyata uygula (AL yukari, SAT asagi). */
export function applyEntrySlippage(price, signal) {
  const slip = Number(signal?.entrySlippagePct) || 0;
  if (!(slip > 0) || !(price > 0)) return price;
  return signal?.cls === 'sell' ? price * (1 - slip) : price * (1 + slip);
}

/**
 * Sonuc / gun-gun seri / plan hesaplarina verilecek sinyal gorunumu.
 * Eski ve seans ici sinyaller aynen doner. Seans disi sinyalde giris fiyati ve
 * baslangic gunu DOLUMLA degistirilir; dolum henuz yoksa null → hicbir sey hesaplanmaz.
 * Giris gunu bari dahil edilir: dolum acilista oldugu icin o gunun butun hareketi
 * giristen SONRADIR (aksam kaydinin geriye bakan hatasi burada yok).
 */
export function settlementView(signal, bars) {
  if (!signal || signal.entryBasis !== ENTRY_BASIS.NEXT_SESSION) return signal;
  if (signal.entryFillDay && Number(signal.entryPrice) > 0) {
    return { ...signal, timestamp: signal.entryFillDay };
  }
  const fill = resolveNextSessionFill(signal, bars);
  if (!fill) return null;
  return { ...signal, entryPrice: applyEntrySlippage(fill.price, signal), timestamp: fill.day };
}

/**
 * Bekleyen paper emri icin karar (canli toplu fiyat kaydina gore).
 * @param {{symbol:string, createdAt:number, afterSession:string, pick?:{stop?:number}}} order
 * @param {{open?:number, sessionDate?:any}|undefined} live
 * @returns {{action:'wait'|'fill'|'cancel', reason?:string, price?:number, sessionKey?:string, openedAt?:number}}
 */
export function decidePendingFill(order, live, now = Date.now()) {
  if (!order || !DAY_KEY_RE.test(String(order.afterSession || ''))) return { action: 'cancel', reason: 'invalid' };
  if (now - (Number(order.createdAt) || 0) > PENDING_MAX_AGE_MS) return { action: 'cancel', reason: 'expired' };
  const sessionDate = parseSessionDate(live?.sessionDate);
  const sessionKey = sessionDate ? istanbulDayKey(sessionDate) : '';
  if (!sessionKey || sessionKey <= order.afterSession) return { action: 'wait' };
  const expected = nextWeekdayKey(order.afterSession);
  if (sessionKey !== expected) return { action: 'cancel', reason: 'missed_session', sessionKey, expected };
  const open = Number(live.open);
  if (!(open > 0)) return { action: 'wait' };           // seans basladi, acilis henuz yayinda degil
  const stop = Number(order.pick?.stop);
  if (stop > 0 && open <= stop) return { action: 'cancel', reason: 'gap_below_stop', price: open, sessionKey };
  return { action: 'fill', price: open, sessionKey, openedAt: Date.parse(`${sessionKey}T06:55:00Z`) };
}
