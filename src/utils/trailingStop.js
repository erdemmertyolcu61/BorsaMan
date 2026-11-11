// ── YALNIZ-TRAILING CIKIS, SEANS BAZLI (v31.53) — saf, test edilebilir ─────
//
// OLCULEN UYUMSUZLUK: "Olculmus kararlar" cikisi yalniz trailing stop diyor
// (planSimulation bunu olcer, sinyal takibi ve tahmin karnesi bununla yerlesir),
// ama paper ML motoru BASKA bir cikis uyguluyordu: sabit stop + hedefte pozisyonun
// TAMAMINI satmak + 3. gunden sonra +%1 altinda kapatmak. Yani ileri test,
// onerilen stratejiyi degil olculmus en kotu cikis ailesini ("hedefte sat")
// calistiriyordu. Karsilastirma: scripts/feature-edge-report.mjs --only cikis,portfoy.
//
// Bu modul planSimulation'in KURALINI canli fiyat kaydina uygular — ayni sabitler
// (PLAN_CONST), ayni konvansiyon:
//   - Stop bir seans boyunca SABITTIR; bir seansin zirvesi stop'u ancak SONRAKI
//     seanstan itibaren sikilastirir. (Ayni seans icinde zirve mi dip mi once
//     oldu bilinemez; ayni gunun zirvesiyle cekilen stop'u ayni gunun dibine
//     uygulamak ileriye bakmak olurdu.)
//   - Seansin dibi stop'a degdiyse stop emri dolmustur — uygulama o sirada kapali
//     olsa ve fiyat sonra toparlansa bile (mobil WebView arka planda donar).
//   - Seans stop'un ALTINDA acildiysa dolum acilistan (bosluk), yoksa seviyeden.
//   - En fazla MAX_PLAN_BARS seans; sonra son fiyattan cikilir.

import { PLAN_CONST } from './tradePlan.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Zirveye gore olmasi gereken stop. Asla gevsemez: mevcut stop'tan dusuk deger donmez.
 * @param {{entry:number, stop:number|null, peak:number}} p
 * @returns {number|null}
 */
export function ratchetStop({ entry, stop, peak }, c = PLAN_CONST) {
  const cur = isNum(stop) ? stop : null;
  if (!(entry > 0) || !isNum(peak)) return cur;
  const gainPct = (peak / entry - 1) * 100;
  let next = cur;
  if (gainPct >= c.TRAIL_ACTIVE_PCT) {
    const locked = entry + (peak - entry) * c.LOCK_FRACTION;
    if (next == null || locked > next) next = locked;
  } else if (gainPct >= c.BREAKEVEN_PCT) {
    if (next == null || entry > next) next = entry;
  }
  return next;
}

/**
 * Bir fiyat kontrolunde AL pozisyonunun trailing durumunu ilerletir.
 *
 * @param {{stop:number|null, peak:number, session:string|null, sessions:number}} state
 *        onceki durum (ilk cagri icin `initTrailState`)
 * @param {object} q
 * @param {number} q.entry
 * @param {number} q.price       kontrol anindaki fiyat
 * @param {string} q.sessionKey  fiyatin ait oldugu oturum gunu (YYYY-MM-DD)
 * @param {number} [q.open]      oturum acilisi
 * @param {number} [q.high]      oturum zirvesi
 * @param {number} [q.low]       oturum dibi
 * @param {boolean} [q.wholeSession=false] pozisyon bu oturumun TAMAMINDA acik miydi?
 *        (acilista dolduysa ya da onceki bir oturumda acildiysa true). false iken
 *        oturumun acilis/zirve/dip degerleri giristen ONCEYE ait olabilir, kullanilmaz.
 * @param {number} [q.maxSessions]
 * @returns {{state:object, exit:null|{reason:'stop'|'timeout', level:number|null, basis:'gap'|'level'|'live'}}}
 *   exit.basis: 'gap' → oturum acilisi stop'un altinda (dolum = open, level alaninda);
 *               'level' → oturum dibi stop'a degdi, fiyat su an ustunde (dolum = stop);
 *               'live' → fiyat su an stop'ta/altinda (cagiran `resolveExitPrice` ile cozer).
 */
export function advanceTrail(state, q, c = PLAN_CONST) {
  const { entry, price, sessionKey } = q;
  const st = { stop: null, peak: entry, session: null, sessions: 0, ...(state || {}) };
  if (!(entry > 0) || !(price > 0) || !sessionKey) return { state: st, exit: null };

  // 1) Yeni seans: onceki seanslarin zirvesi artik stop'u cekebilir.
  const newSession = st.session !== sessionKey;
  if (newSession) {
    if (st.session) st.stop = ratchetStop({ entry, stop: st.stop, peak: st.peak }, c);
    st.session = sessionKey;
    st.sessions = (st.sessions || 0) + 1;
  }

  const whole = q.wholeSession === true;
  const open = whole && q.open > 0 ? q.open : null;
  const low = whole && q.low > 0 ? Math.min(q.low, price) : price;
  const high = whole && q.high > 0 ? Math.max(q.high, price) : price;

  // 2) Stop: seans boyunca sabit seviye.
  if (isNum(st.stop) && low <= st.stop) {
    if (open != null && open < st.stop) return { state: st, exit: { reason: 'stop', level: open, basis: 'gap' } };
    if (price <= st.stop) return { state: st, exit: { reason: 'stop', level: st.stop, basis: 'live' } };
    return { state: st, exit: { reason: 'stop', level: st.stop, basis: 'level' } };
  }

  // 3) Zirve (stop'u bir SONRAKI seansta ceker).
  if (high > (st.peak || 0)) st.peak = high;

  // 4) Sure siniri — olculen pencere.
  const maxSessions = isNum(q.maxSessions) ? q.maxSessions : null;
  if (maxSessions != null && newSession && st.sessions > maxSessions) {
    return { state: st, exit: { reason: 'timeout', level: null, basis: 'live' } };
  }
  return { state: st, exit: null };
}

/** Yeni acilan pozisyonun baslangic durumu. */
export function initTrailState(entry, stop) {
  return { stop: isNum(stop) ? stop : null, peak: entry, session: null, sessions: 0 };
}
