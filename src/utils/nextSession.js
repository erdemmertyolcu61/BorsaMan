// ════════════════════════════════════════════════════════════════════
// nextSession.js — ERTESI SEANS ozellikleri (v31.54)
// ════════════════════════════════════════════════════════════════════
//
// Bir hissenin kapanmis gunluk barlarindan, "yarinki seans" hakkinda konusmak
// icin kullanilan olculeri cikarir. SAF: ag yok, saat yok, depolama yok.
//
// Ayni fonksiyon hem uygulamada (tarama + Tekil Analiz) hem olcumde
// (scripts/next-session-study.mjs) calisir — olculen sey ile gosterilen sey
// ayni koddan gelsin diye. Bir ozelligi degistirirsen calismayi yeniden kos.
//
// Bilerek KULLANILMAYANLAR: acilis fiyatina dayanan olculer (bosluk, gun-ici
// govde). Is Yatirim acilis vermez, proxy Yahoo'dan alir ve bazi barlarda
// yaklasiktir (`_openApprox`) — canlida gurultulu olurdu.
// ════════════════════════════════════════════════════════════════════

import { NEXT_SESSION_MODEL } from './nextSessionModel.js';

const isNum = Number.isFinite;

/** En az bu kadar kapanmis bar gerekir (60 gunluk getiri + 1). */
export const MIN_BARS = 61;
/** BIST gunluk fiyat marji %10: tavan/taban esigi. */
export const LIMIT_PCT = 9.5;
/** Son 60 barda bundan buyuk gunluk degisim = bolunme / duzeltilmemis fiyat: ozellikler bozuk.
 *  Olcum bu satirlari disarida tuttu (study: artB); uygulama da tahmini guvenilmez isaretler. */
export const ARTIFACT_PCT = 25;
export const ARTIFACT_LOOKBACK = 60;

function std(a, from, to) {
  let s = 0, n = 0;
  for (let i = from; i < to; i++) { s += a[i]; n++; }
  if (n < 2) return null;
  const m = s / n;
  let q = 0;
  for (let i = from; i < to; i++) q += (a[i] - m) * (a[i] - m);
  return Math.sqrt(q / (n - 1));
}

function avg(a, from, to) {
  let s = 0, n = 0;
  for (let i = Math.max(0, from); i < to; i++) { s += a[i]; n++; }
  return n ? s / n : null;
}

/** Wilder RSI, son deger. */
function rsiLast(c, period) {
  const n = c.length;
  if (n < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  for (let i = period + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}

const r = (v, d = 3) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * Endeks (XU100) kapanis dizisinden gun-duzeyi olculer. Dizi, hissenin son
 * bariyla AYNI gunde bitmeli.
 * @param {number[]} closes
 */
export function indexFeatures(closes) {
  const c = Array.isArray(closes) ? closes.filter((v) => isNum(v) && v > 0) : [];
  const n = c.length;
  if (n < 21) return null;
  const t = n - 1;
  const ch = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ch[i] = (c[i] / c[i - 1] - 1) * 100;
  let streak = 0;
  for (let i = t; i > 0; i--) {
    const s = Math.sign(ch[i]);
    if (s === 0 || (streak !== 0 && s !== Math.sign(streak))) break;
    streak += s;
  }
  return {
    xChg1: r(ch[t]),
    xRet5: t >= 5 ? r((c[t] / c[t - 5] - 1) * 100) : null,
    xRet20: t >= 20 ? r((c[t] / c[t - 20] - 1) * 100) : null,
    xD20: r((c[t] / avg(c, t - 19, t + 1) - 1) * 100),
    xRv20: r(std(ch, t - 19, t + 1)),
    xStreak: streak,
  };
}

/**
 * Hissenin kapanmis gunluk barlarindan ertesi seans ozellikleri.
 * @param {Array<{high:number,low:number,close:number,volume:number}>} bars kronolojik, son bar = son KAPANMIS seans
 * @param {object|null} idx `indexFeatures` ciktisi (yoksa endeks olculeri null = model ortalamasi)
 * @returns {object|null} bar yetersizse null
 */
export function nextSessionFeatures(bars, idx = null) {
  if (!Array.isArray(bars)) return null;
  const n = bars.length;
  if (n < MIN_BARS) return null;
  const c = new Array(n), h = new Array(n), l = new Array(n), v = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    c[i] = Number(b?.close);
    if (!(c[i] > 0)) return null;
    h[i] = Number(b.high) > 0 ? Number(b.high) : c[i];
    l[i] = Number(b.low) > 0 ? Number(b.low) : c[i];
    if (h[i] < c[i]) h[i] = c[i];
    if (l[i] > c[i]) l[i] = c[i];
    v[i] = Number(b.volume) > 0 ? Number(b.volume) : 0;
  }
  const t = n - 1;
  const ch = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ch[i] = (c[i] / c[i - 1] - 1) * 100;
  const ret = (k) => (t - k >= 0 ? (c[t] / c[t - k] - 1) * 100 : null);

  // gunun mumu
  const span = h[t] - l[t];
  const clv = span > 0 ? (c[t] - l[t]) / span : 0.5;
  const rng = (span / c[t - 1]) * 100;

  // ATR14 (%), gercek aralik
  let trSum = 0;
  for (let i = t - 13; i <= t; i++) {
    trSum += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  const atr = (trSum / 14 / c[t]) * 100;

  const rv5 = std(ch, t - 4, t + 1);
  const rv20 = std(ch, t - 19, t + 1);

  const vol20 = avg(v, t - 20, t);                 // bugun haric
  const vol60 = avg(v, t - 60, t - 5);
  const vol5 = avg(v, t - 4, t + 1);
  let tl = 0;
  for (let i = t - 19; i <= t; i++) tl += c[i] * v[i];
  tl /= 20;

  const m20 = avg(c, t - 19, t + 1);
  const m50 = t >= 49 ? avg(c, t - 49, t + 1) : null;
  const m200 = t >= 199 ? avg(c, t - 199, t + 1) : null;

  let hi20 = -Infinity, lo20 = Infinity;
  for (let i = t - 19; i <= t; i++) { if (h[i] > hi20) hi20 = h[i]; if (l[i] < lo20) lo20 = l[i]; }
  let hi252 = null;
  if (t >= 251) { hi252 = -Infinity; for (let i = t - 251; i <= t; i++) if (h[i] > hi252) hi252 = h[i]; }

  let streak = 0;
  for (let i = t; i > 0; i--) {
    const s = Math.sign(ch[i]);
    if (s === 0 || (streak !== 0 && s !== Math.sign(streak))) break;
    streak += s;
  }
  let up10 = 0;
  for (let i = t - 9; i <= t; i++) if (ch[i] > 0) up10++;

  let nr7 = true;
  for (let i = t - 6; i < t; i++) if (h[i] - l[i] <= span) { nr7 = false; break; }

  const limUp = ch[t] >= LIMIT_PCT && clv >= 0.9;
  const limDn = ch[t] <= -LIMIT_PCT && clv <= 0.1;
  let art = 0;
  for (let i = Math.max(1, t - ARTIFACT_LOOKBACK + 1); i <= t; i++) if (Math.abs(ch[i]) > ARTIFACT_PCT) { art = 1; break; }

  const f = {
    chg1: r(ch[t]), chg2: r(ch[t - 1]),
    ret3: r(ret(3)), ret5: r(ret(5)), ret10: r(ret(10)), ret20: r(ret(20)), ret60: r(ret(60)),
    clv: r(clv), rng: r(rng), atr: r(atr), rngX: atr > 0 ? r(rng / atr) : null,
    rv5: r(rv5), rv20: r(rv20), rvR: rv20 > 0 ? r(rv5 / rv20) : null,
    volR: vol20 > 0 ? r(v[t] / vol20) : null,
    volR5: vol60 > 0 ? r(vol5 / vol60) : null,
    tl: tl > 0 ? r(Math.log10(tl)) : null,
    d20: r((c[t] / m20 - 1) * 100),
    d50: m50 ? r((c[t] / m50 - 1) * 100) : null,
    d200: m200 ? r((c[t] / m200 - 1) * 100) : null,
    hi20: r((c[t] / hi20 - 1) * 100), lo20: r((c[t] / lo20 - 1) * 100),
    hi252: hi252 ? r((c[t] / hi252 - 1) * 100) : null,
    rsi14: r(rsiLast(c.slice(Math.max(0, n - 120)), 14), 1),
    rsi2: r(rsiLast(c.slice(Math.max(0, n - 30)), 2), 1),
    streak, up10,
    limUp: limUp ? 1 : 0, limDn: limDn ? 1 : 0, nr7: nr7 ? 1 : 0,
    xChg1: null, xRet5: null, xRet20: null, xD20: null, xRv20: null, xStreak: null,
  };
  f.art = art;          // kalite bayragi — model ozelligi degil
  if (idx) {
    Object.assign(f, {
      xChg1: idx.xChg1, xRet5: idx.xRet5, xRet20: idx.xRet20, xD20: idx.xD20, xRv20: idx.xRv20, xStreak: idx.xStreak,
    });
  }
  return f;
}

/** Ozellik adlari — satir dosyasinin sutun sirasi. */
export const FEATURE_KEYS = Object.freeze([
  'chg1', 'chg2', 'ret3', 'ret5', 'ret10', 'ret20', 'ret60', 'clv', 'rng', 'atr', 'rngX',
  'rv5', 'rv20', 'rvR', 'volR', 'volR5', 'tl', 'd20', 'd50', 'd200', 'hi20', 'lo20', 'hi252',
  'rsi14', 'rsi2', 'streak', 'up10', 'limUp', 'limDn', 'nr7',
  'xChg1', 'xRet5', 'xRet20', 'xD20', 'xRv20', 'xStreak',
]);

/** Modelin kullandigi ozellikler (hepsi). */
export const MODEL_FEATURES = FEATURE_KEYS;

/**
 * Olculmus gun-ici kural (scripts/next-session-report.mjs, gorulmemis veri):
 * hareket listesinin ilk `topN` hissesi, acilista alis, +%takeProfitPct limit satis,
 * dolmazsa kapanista satis. Dar stop (%3–4) sonucu eksiye ceviriyor; genis stop
 * (%5) getiriyi azaltip en kotu islemi sinirliyor.
 */
export const DAYTRADE_RULE = Object.freeze({
  topN: 3,            // kuralin olculdugu derinlik (ilk 10'da avantaj yok)
  shownN: 5,          // ekranda gosterilen
  movePct: 3,         // "hareket" = zirve >= acilis + %3
  takeProfitPct: 4,
  wideStopPct: 5,
  fillEpsPct: 0.1,    // limit emrin dolmasi icin zirve seviyeyi bu kadar gecmeli
  costPct: 0.3,
  minTurnoverLog: Math.log10(2e6),
});

function linear(part, feat) {
  let z = part.intercept;
  for (const [k, lo, hi, m, sd, b] of part.terms) {
    const x = feat[k];
    if (!isNum(x)) continue;                       // eksik ozellik = egitim ortalamasi
    z += b * ((Math.min(hi, Math.max(lo, x)) - m) / sd);
  }
  return z;
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Ozelliklerden iki olasilik: pMove = P(zirve >= acilis + %3), pGreen = P(kapanis > onceki kapanis).
 * @returns {{pMove:number,pGreen:number}|null}
 */
export function scoreNextSession(feat, model = NEXT_SESSION_MODEL) {
  if (!feat || !model?.move?.terms?.length || !model?.green?.terms?.length) return null;
  return { pMove: sigmoid(linear(model.move, feat)), pGreen: sigmoid(linear(model.green, feat)) };
}

function pack(feat, sc) {
  return {
    pMove: Math.round(sc.pMove * 1000) / 1000,
    pGreen: Math.round(sc.pGreen * 1000) / 1000,
    atrPct: feat.atr, turnoverLog: feat.tl, limitUpClose: feat.limUp === 1, limitDownClose: feat.limDn === 1, chg1: feat.chg1,
    artifact: feat.art === 1,
  };
}

/** Barlardan dogrudan tahmin (ozellik + skor). Bar yetersizse null. */
export function forecastNextSession(bars, indexCloses = null, model = NEXT_SESSION_MODEL) {
  const feat = nextSessionFeatures(bars, indexCloses ? indexFeatures(indexCloses) : null);
  const sc = scoreNextSession(feat, model);
  return sc ? pack(feat, sc) : null;
}

/**
 * Uygulamadaki fiyat dizisinden tahmin. Yalniz KAPANMIS barlar kullanilir: son bar
 * seans icinde olusuyorsa (`_isForming`) atilir — tahmin her zaman "son kapanistan
 * sonraki ilk seans" icindir, `basisDay` o son kapanisin gunudur.
 *
 * @param {Array} prices       gunluk barlar (son bar canli olabilir)
 * @param {Array} indexBars    XU100 gunluk barlari [{date, close}] ya da null
 * @param {(d:any)=>string} dayKeyFn  bar tarihi → 'YYYY-MM-DD' (istanbulDayKey)
 * @param {Map} [cache]        dayanak gunu → endeks olculeri (tarama boyunca paylasilir)
 */
export function forecastFromScanBars(prices, indexBars, dayKeyFn, cache = null, model = NEXT_SESSION_MODEL) {
  if (!Array.isArray(prices) || typeof dayKeyFn !== 'function') return null;
  const bars = prices[prices.length - 1]?._isForming === true ? prices.slice(0, -1) : prices;
  if (bars.length < MIN_BARS) return null;
  const basisDay = dayKeyFn(bars[bars.length - 1]?.date);
  if (!basisDay) return null;
  let idx = cache ? cache.get(basisDay) : undefined;
  if (idx === undefined) {
    const closes = [];
    for (const b of Array.isArray(indexBars) ? indexBars : []) {
      const k = dayKeyFn(b?.date);
      if (k && k <= basisDay && Number(b.close) > 0) closes.push(Number(b.close));
    }
    idx = closes.length ? indexFeatures(closes.slice(-80)) : null;
    if (cache) cache.set(basisDay, idx);
  }
  const feat = nextSessionFeatures(bars.length > 260 ? bars.slice(-260) : bars, idx);
  const sc = scoreNextSession(feat, model);
  return sc ? { ...pack(feat, sc), basisDay } : null;
}

/**
 * Tarama satirlarindan hareket listesi: likit ve fiyat serisi temiz olanlar, pMove'a gore azalan.
 * @param {Array<{symbol:string,_ns:object}>} rows `_ns` = forecastNextSession ciktisi
 */
export function rankMovers(rows, n = DAYTRADE_RULE.shownN) {
  return (Array.isArray(rows) ? rows : [])
    .filter((x) => x && x.symbol && x._ns && !x._ns.artifact && isNum(x._ns.pMove) && isNum(x._ns.turnoverLog) && x._ns.turnoverLog >= DAYTRADE_RULE.minTurnoverLog)
    .sort((a, b) => b._ns.pMove - a._ns.pMove || String(a.symbol).localeCompare(String(b.symbol)))
    .slice(0, n);
}

/**
 * Kuralin bir seanstaki sonucu — resmi gunluk bardan. Giris = acilis.
 * @param {{open:number,high:number,low:number,close:number}} bar
 * @returns {{moved:boolean,hit:boolean,grossPct:number,netPct:number,highPct:number,lowPct:number,closePct:number,locked:boolean}|null}
 */
export function settleDayTrade(bar, rule = DAYTRADE_RULE) {
  const o = Number(bar?.open), h = Number(bar?.high), l = Number(bar?.low), c = Number(bar?.close);
  if (!(o > 0 && h > 0 && l > 0 && c > 0)) return null;
  const highPct = (h / o - 1) * 100, closePct = (c / o - 1) * 100;
  const locked = h === l;                              // tek fiyatli seans: alinamaz
  const hit = !locked && highPct >= rule.takeProfitPct + rule.fillEpsPct;
  const grossPct = hit ? rule.takeProfitPct : closePct;
  return {
    moved: highPct >= rule.movePct, hit, locked,
    grossPct: r(grossPct, 2), netPct: locked ? 0 : r(grossPct - rule.costPct, 2),
    highPct: r(highPct, 2), lowPct: r((l / o - 1) * 100, 2), closePct: r(closePct, 2),
  };
}

/**
 * Ekranda alintilanan olcum (tek yerden). Kaynak: scripts/next-session-report.mjs, 14.11.2026:
 * 257 hisse, ileri-yuruyus (model A kumesinin gecmisiyle egitilir, B kumesinin sonraki yilinda sinanir).
 * Rakamlari degistirmeden once raporu yeniden kos.
 */
export const NEXT_SESSION_EVIDENCE = Object.freeze({
  period: '2024–2026',
  baseMovePct: 27,          // likit evrende zirve >= acilis + %3 olan hisse-gun orani
  baseGreenPct: 47,         // likit evrende yesil kapatan hisse-gun orani
  top5MovedPct: [62, 68],   // hareket listesi ilk 5: gercekten hareket eden oran (yil yil)
  bestGreenPct: 52,         // yesil modeli ilk 5: ulasilan en iyi yesil orani
  daily: { avgNet: 0.44, t: 4.3, openToClose: -0.09 },                     // ilk 3, gunluk bar, 715 gun
  hourly: { avgNet: 0.62, t: 5.5, winPct: 64, posDayPct: 61, halves: 6, halvesPositive: 6, p5: -7.8, worstDay: -12.1, withWideStop: 0.41, tightStop: -0.19 },
});
