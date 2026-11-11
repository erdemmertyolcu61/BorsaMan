#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// feature-edge-study.mjs — ADAYLARI NE AYIRIYOR? (v31.53)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: replay-signals.mjs skorun aday havuzu ICINDE siralama gucu
// olmadigini gosterdi (YUKSELIS'te "early" +2,08 > "flagged" +1,80 > "sniper"
// +1,66). Yukselis gununde evrenin ~%30'u aday; uygulama en fazla 10 gosterir,
// paper 3 acar. Yani sonucu belirleyen sey SECIM — ve secim anahtarlari
// (skor, yarin-potansiyeli, erken/kirilim bonuslari) siralayici olarak hic
// olculmedi. Bu script her aday icin bir satir + o gun bilinen ozellikleri
// uretir; analiz kismi hangi ozelligin (a) iyi GUNU, (b) gun icinde iyi
// HISSEYI ayirdigini olcer.
//
// DISIPLIN (replay ile ayni, uc duzeltmeyle):
//   - Sinyal bars[0..t]'nin son 252 bariyla, giris ertesi ACILIS, %0,3 maliyet.
//     genSignal canli taramadaki gibi HTF baglamiyla cagrilir; aday havuzu canli AL
//     filtresinin en genis kapisi (TUT + skor >= 45). Her satir canli secim zincirinin
//     kopyasindan da gecer (live-ranker-replica.mjs): red sebebi, yarin-potansiyeli,
//     guven, erken/kirilim bayraklari, canli stop (1,8×ATR kirpmasi).
//   - Rejim SINYAL gununun kapanisiyla (regT). replay eskiden `fill.date` rejimini
//     kullaniyordu: o gunun kapanisi giriste bilinmez (1 gun ileri bakis). Ikisi
//     de saklanir, fark raporlanir.
//   - Cikis sutunlari:
//       plan    ham stop, v31.53 ONCESI konvansiyon (her stop seviyeden dolar) — iyimser
//       planG   ham stop, bosluk-farkinda (= planSimulation, v31.53'ten beri)
//       planL   CANLI stop (kirpilmis), bosluk-farkinda, yalniz-trailing  ← varsayilan sonuc
//       planP   canli stop + paper motorunun v31.52'ye kadarki cikisi (hedef + 3. gun)
//       planPnt / planPng  ayni, sure cikisi / hedef olmadan (ayristirma)
//   - Bozuk barlar (|gunluk degisim| > %11,5 — bolunme/duzeltilmemis fiyat):
//     ileri penceresi boyle bir bar iceren islem `art`, geriye bakisi >%25 iceren
//     `artB` ile isaretlenir; analiz varsayilan olarak ikisini de disarida tutar.
//   - Kesif / dogrulama ayrimi: SET_A (89 hisse) bulgularin cikarildigi kume; onbellekteki
//     diger hisseler ve DISCOVERY_END sonrasi, kararlar verilirken gorulmedi.
//
// KULLANIM:
//   node scripts/feature-edge-study.mjs               # satirlari uret (onbellekten) + ozet
//   node scripts/feature-edge-study.mjs --rebuild     # satirlari yeniden uret (~5 dk, 257 hisse)
//   node scripts/feature-edge-study.mjs --fetch 3     # evrenden onbellekte olmayan her 3. hisseyi cek
//   node scripts/feature-edge-study.mjs --fetch 1 --refresh   # onbellektekileri de bugune guncelle
//   node scripts/feature-edge-report.mjs              # olcum raporu (asil cikti)
// Veri: Yahoo gunluk bar, .replay-cache/<SEMBOL>_5y.json (replay-signals.mjs ile ayni bicim).
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RANGE = arg('--range', '5y');
const REBUILD = argv.includes('--rebuild');

const CACHE = path.join(ROOT, '.replay-cache');
const ROWS_FILE = path.join(CACHE, `feature-rows-${RANGE}.json`);
const WARMUP = 210;
const LOOKBACK = 252;
const EVAL_TAIL = 8;
const MAX_BARS = 30;
const ART_FWD = 11.5;   // BIST gunluk marj %10; ustu = birlesmis gun / duzeltilmemis fiyat
const ART_BACK = 25;    // geriye bakista yalniz kaba bozulma (bolunme) elenir
export const COST_PCT = 0.3;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);

/** Trailing-only plan, planSimulation.simulatePlanReturn ile ayni kural.
 *  gapAware: bar stop'un altinda acildiysa cikis ACILISTAN (gercek stop emri). */
export function simTrail(entry, stop0, bars, start, { gapAware = false, maxBars = MAX_BARS, be = 3, act = 5, lock = 0.5 } = {}) {
  let stop = isNum(stop0) ? stop0 : null, peak = entry, held = 0, last = null;
  for (let i = start; i < bars.length && held < maxBars; i++) {
    const b = bars[i];
    held++; last = b.close;
    if (stop != null && b.low <= stop) {
      const px = gapAware ? Math.min(stop, b.open) : stop;
      return { ret: (px / entry - 1) * 100, exit: 'stop', held };
    }
    if (b.high > peak) peak = b.high;
    const pg = (peak / entry - 1) * 100;
    if (pg >= act) {
      const locked = entry + (peak - entry) * lock;
      if (stop == null || locked > stop) stop = locked;
    } else if (pg >= be) {
      if (stop == null || entry > stop) stop = entry;
    }
  }
  if (last == null) return null;
  return { ret: (last / entry - 1) * 100, exit: 'timeout', held };
}

const TODAY = new Date().toISOString().slice(0, 10);
/**
 * PaperTradeEngine'in (ML AUTO) GERCEKTE uyguladigi cikis — trailing YOK:
 *   sabit stop · hedefte pozisyonun TAMAMI satilir · acilistan >= 3 takvim gunu sonra
 *   brut kar +%1'in altindaysa kapatilir (TIME_EXIT; kontrol her fiyat turunda tekrarlanir,
 *   yani 3. gunden sonra +%1 fiilen bir taban olur).
 * Gunluk bardan: stop once (boslukta acilistan), sonra hedef (boslukta acilistan), sonra sure.
 * Sure cikisi bar ACILISINDA denenir, bar icinde +%1'in altina inerse o seviyeden.
 */
export function simPaperExit(entry, stop, target, bars, start, { maxBars = MAX_BARS, timeDays = 3, minGain = 1, timeExit = true, useTarget = true } = {}) {
  const dayOf = (b) => b.t ?? (b.t = Date.parse(b.date + 'T00:00:00Z') / 864e5);
  const t0 = dayOf(bars[start]);
  const floor = entry * (1 + minGain / 100);
  let held = 0, last = null;
  for (let i = start; i < bars.length && held < maxBars; i++) {
    const b = bars[i];
    held++; last = b.close;
    const aged = timeExit && dayOf(b) - t0 >= timeDays;
    if (aged && b.open < floor) return { ret: (b.open / entry - 1) * 100, exit: 'time', held };
    if (isNum(stop) && b.low <= stop) return { ret: (Math.min(stop, b.open) / entry - 1) * 100, exit: 'stop', held };
    if (useTarget && isNum(target) && b.high >= target) return { ret: (Math.max(target, b.open) / entry - 1) * 100, exit: 'target', held };
    if (aged && b.low < floor) return { ret: minGain, exit: 'time', held };
  }
  if (last == null) return null;
  return { ret: (last / entry - 1) * 100, exit: 'timeout', held };
}

function loadBars(file) {
  // Bugunun bari olusuyor olabilir (yarim seans) — kapanmis sayilmaz.
  return JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8'))
    .filter((b) => b && b.date < TODAY && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));
}

/** Kesif kumesi: bulgularin ILK cikarildigi 89 hisse (replay-signals.mjs FALLBACK listesi).
 *  Onbellekteki diger hisseler DOGRULAMA kumesidir (B) — bulgular onlara bakilmadan secildi. */
export const SET_A = new Set(('ADEL AEFES AFYON AGESA AKBNK AKCNS AKENR AKFGY AKSA ALARK ALGYO ALKIM '
  + 'ANHYT ANSGR ARCLK ASELS AYDEM AYGAZ BASGZ BIENY BIMAS BRISA BRYAT BUCIM CANTE CCOLA '
  + 'CEMTS CIMSA DOAS DOHOL EGEEN EKGYO ENJSA ENKAI EREGL EUPWR FROTO GARAN GENIL GESAN '
  + 'GLYHO GOZDE GSDHO GUBRF HALKB HEKTS INDES ISGYO ISMEN KARSN KCHOL KLSER KONTR KORDS '
  + 'LOGO MAVI MPARK NETAS OBAMS OTKAR OYAKC PETKM PGSUS SAHOL SARKY SELEC SISE SKBNK '
  + 'SNGYO SOKM TATGD TAVHL TCELL THYAO TMSN TOASO TRGYO TSKB TTKOM TTRAK TUPRS TURSG '
  + 'ULKER ULUUN VAKBN VERUS VESTL YATAS YKBNK').split(' '));
/** Kesif verisinin bittigi gun: sonrasi hicbir karar verilirken gorulmedi. */
export const DISCOVERY_END = '2026-08-28';

const sma = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
const ret = (a, i, n) => (i - n >= 0 && a[i - n] > 0 ? (a[i] / a[i - n] - 1) * 100 : null);

/** Bir degerin siralanmis dizideki yuzdeligi (0–100). */
function pctRank(sorted, v) {
  if (!sorted || sorted.length < 10 || !isNum(v)) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return (lo / (sorted.length - 1 || 1)) * 100;
}

async function buildRows() {
  const { calcAll } = await import(U('utils/indicators.js'));
  const { genSignal } = await import(U('utils/signals.js'));
  const { simulatePlanReturn } = await import(U('utils/planSimulation.js'));
  const { classifyBistRegime } = await import(U('utils/regimeGate.js'));
  const { initEngine } = await import(U('engine/engineCore.js'));
  const { makeLiveReplica } = await import(pathToFileURL(path.join(HERE, 'live-ranker-replica.mjs')).href);
  await initEngine();
  const live = await makeLiveReplica();

  // ── endeks: rejim + trend olculeri (yalniz o gune kadarki veri) ──
  const xu = loadBars(`XU100_${RANGE}.json`);
  const xuC = xu.map((b) => b.close);
  const xuIdx = new Map(xu.map((b, i) => [b.date, i]));
  const xuByDate = new Map();
  {
    const closes = [];
    for (let i = 0; i < xu.length; i++) {
      closes.push(xuC[i]);
      const m20 = sma(xuC, i, 20), m50 = sma(xuC, i, 50), m200 = sma(xuC, i, 200);
      xuByDate.set(xu[i].date, {
        reg: classifyBistRegime(closes).regime,
        x20: m20 ? (xuC[i] / m20 - 1) * 100 : null,
        x50: m50 ? (xuC[i] / m50 - 1) * 100 : null,
        x200: m200 ? (xuC[i] / m200 - 1) * 100 : null,
        xr5: ret(xuC, i, 5), xr20: ret(xuC, i, 20), xr63: ret(xuC, i, 63),
      });
    }
  }

  // ── 1. gecis: hisse bazli ozellik dizileri + kesitsel tablolar ──
  const files = fs.readdirSync(CACHE).filter((f) => f.endsWith(`_${RANGE}.json`) && !f.startsWith('XU100') && !f.startsWith('feature-'));
  const data = new Map();
  const cross = new Map();     // sinyal tarihi -> { r20:[], r63:[], r126:[], r252:[], a20, a50, a200, n }
  const fwd = new Map();       // giris tarihi  -> { s5, n5, s10, n10 }
  for (const f of files) {
    const sym = f.replace(`_${RANGE}.json`, '');
    const bars = loadBars(f);
    if (bars.length < WARMUP + EVAL_TAIL + 20) continue;
    const c = bars.map((b) => b.close);
    const n = bars.length;
    const F = { chg: new Array(n).fill(null), m20: [], m50: [], m200: [], r5: [], r20: [], r63: [], r126: [], r252: [], hi252: [], hi63: [], tl20: [], rv20: [] };
    const tl = bars.map((b) => b.close * b.volume);
    for (let i = 0; i < n; i++) {
      if (i > 0) F.chg[i] = (c[i] / c[i - 1] - 1) * 100;
      F.m20[i] = sma(c, i, 20); F.m50[i] = sma(c, i, 50); F.m200[i] = sma(c, i, 200);
      F.r5[i] = ret(c, i, 5); F.r20[i] = ret(c, i, 20); F.r63[i] = ret(c, i, 63);
      F.r126[i] = ret(c, i, 126); F.r252[i] = ret(c, i, 252);
      let h252 = 0, h63 = 0;
      for (let k = Math.max(0, i - 251); k <= i; k++) { if (bars[k].high > h252) h252 = bars[k].high; if (k >= i - 62 && bars[k].high > h63) h63 = bars[k].high; }
      F.hi252[i] = h252; F.hi63[i] = h63;
      F.tl20[i] = sma(tl, i, 20);
      if (i >= 20) {
        let s = 0, s2 = 0;
        for (let k = i - 19; k <= i; k++) { s += F.chg[k]; s2 += F.chg[k] ** 2; }
        F.rv20[i] = Math.sqrt(Math.max(0, s2 / 20 - (s / 20) ** 2));
      } else F.rv20[i] = null;

      // Kesitsel tablolar. Artefakt barin 252 gun icindeki getirileri tabloyu kirletmesin.
      const d = bars[i].date;
      let x = cross.get(d);
      if (!x) { x = { r20: [], r63: [], r126: [], r252: [], a20: 0, a50: 0, a200: 0, n20: 0, n50: 0, n200: 0, up5: 0, n5: 0 }; cross.set(d, x); }
      if (isNum(F.r20[i])) x.r20.push(F.r20[i]);
      if (isNum(F.r63[i])) x.r63.push(F.r63[i]);
      if (isNum(F.r126[i])) x.r126.push(F.r126[i]);
      if (isNum(F.r252[i])) x.r252.push(F.r252[i]);
      if (F.m20[i]) { x.n20++; if (c[i] > F.m20[i]) x.a20++; }
      if (F.m50[i]) { x.n50++; if (c[i] > F.m50[i]) x.a50++; }
      if (F.m200[i]) { x.n200++; if (c[i] > F.m200[i]) x.a200++; }
      if (isNum(F.r5[i])) { x.n5++; if (F.r5[i] > 0) x.up5++; }

      // Evren ileri getirisi (giris = i+1 acilisi)
      if (i + 11 < n) {
        const e = bars[i + 1].open, fd = bars[i + 1].date;
        const u = fwd.get(fd) || { s5: 0, s10: 0, n: 0 };
        u.s5 += (bars[i + 6].close / e - 1) * 100; u.s10 += (bars[i + 11].close / e - 1) * 100; u.n++;
        fwd.set(fd, u);
      }
    }
    data.set(sym, { bars, F });
  }
  for (const x of cross.values()) { for (const k of ['r20', 'r63', 'r126', 'r252']) x[k].sort((a, b) => a - b); }

  // ── 2. gecis: motor + aday satirlari ──
  const rows = [];
  let mismatch = 0, checked = 0;
  const t0 = Date.now();
  let si = 0;
  for (const [sym, { bars, F }] of data) {
    si++;
    const n = bars.length;
    const last = n - EVAL_TAIL;
    for (let t = WARMUP; t < last; t++) {
      const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
      // Canli tarama ile ayni cagri: HTF baglami mevcut barlardan turetilir (sektor gucu notr).
      // `sig0` = replay-signals.mjs'in cagrisi (baglamsiz) — yalniz fark raporu icin.
      let ind, sig, sig0, htf;
      try {
        ind = calcAll(hist);
        htf = live._deriveHTFContext(hist, ind);
        sig0 = genSignal(ind, hist);
        sig = genSignal(ind, hist, { htfContext: htf, sectorStrength: 0 });
      } catch { continue; }
      if (!sig || sig.cls === 'sell') continue;
      // Havuz = canli AL filtresinin en genis kapisi (TUT + skor>=45). Onceki surum >=55 idi.
      if (sig.cls !== 'buy' && !(sig.score >= 45)) continue;
      const fill = bars[t + 1];
      if (!fill || !(fill.open > 0)) continue;
      const entry = fill.open;

      const canon = simulatePlanReturn({ cls: 'buy', entryPrice: entry, stop: sig.stop, target: sig.t1, t2: sig.t2, t3: sig.t3, timestamp: fill.date }, bars.slice(t + 1));
      if (!canon) continue;
      // `mine` = v31.53 oncesi konvansiyon (her stop seviyeden dolar) — iyimserligi olcmek icin.
      // `gap`  = bosluk-farkinda; planSimulation v31.53'ten beri bununla birebir ayni olmali.
      const mine = simTrail(entry, sig.stop, bars, t + 1);
      const gap = simTrail(entry, sig.stop, bars, t + 1, { gapAware: true });
      checked++;
      if (!gap || Math.abs(gap.ret - canon.planReturn) > 0.011 || gap.held !== canon.barsHeld) mismatch++;

      // Canli secim zinciri (seans-disi dali) — bkz. live-ranker-replica.mjs
      const xi0 = xuIdx.get(bars[t].date);
      const L = live.buildResult(sym, ind, sig, hist, xi0 != null ? xuC.slice(Math.max(0, xi0 - 90), xi0 + 1) : [], htf);
      const early = live.detectEarly(L);
      const near = live.detectNear(L);
      const rej = live.rejectReason(L, early);
      const tp = live.calcTomorrowPotential(L);
      const cf = live.confidenceOf(L, tp);
      const { stop: stopL, target: targetL } = live.liveStopTarget(L);
      const gapL = simTrail(entry, stopL, bars, t + 1, { gapAware: true });
      // Paper ML motorunun gercek cikisi + ayristirma (hedefsiz / sure cikissiz)
      const pap = simPaperExit(entry, stopL, targetL, bars, t + 1);
      const papNoTime = simPaperExit(entry, stopL, targetL, bars, t + 1, { timeExit: false });
      const papNoTgt = simPaperExit(entry, stopL, targetL, bars, t + 1, { useTarget: false });

      // artefakt isaretleri
      let art = 0, artB = 0;
      for (let k = t + 1; k <= Math.min(n - 1, t + MAX_BARS); k++) if (Math.abs(F.chg[k]) > ART_FWD) { art = 1; break; }
      for (let k = Math.max(1, t + 1 - LOOKBACK); k <= t; k++) if (Math.abs(F.chg[k]) > ART_BACK) { artB = 1; break; }

      const p = bars[t].close;
      const d = bars[t].date;
      const x = cross.get(d);
      const xi = xuByDate.get(d) || {};
      const u = fwd.get(fill.date);
      const r5 = t + 6 < n ? (bars[t + 6].close / entry - 1) * 100 : null;
      const r10 = t + 11 < n ? (bars[t + 11].close / entry - 1) * 100 : null;
      const day = bars[t];
      rows.push({
        sym, ab: SET_A.has(sym) ? 'A' : 'B', d, fd: fill.date,
        xd: bars[Math.min(n - 1, t + (mine ? mine.held : canon.barsHeld))].date,
        xdG: gap ? bars[Math.min(n - 1, t + gap.held)].date : null,
        // sinyal
        sc: r1(L.score), raw: r1(sig.rawScore), cls: sig.cls === 'buy' ? 'buy' : 'hold',
        sc0: r1(sig0?.score), cls0: sig0 ? (sig0.cls === 'buy' ? 'buy' : sig0.cls === 'sell' ? 'sell' : 'hold') : null,
        rr: r2(sig.rr), edge: r1(sig.edge), grade: sig.setupGrade ?? null,
        stopPct: r2((p - sig.stop) / p * 100), stopOverEntry: sig.stop >= entry ? 1 : 0,
        // canli secim zinciri
        sector: L.sector, rej, tp, early: early.isEarly ? 1 : 0, earlyCnt: early.count,
        near: near.isNear ? 1 : 0, nearCnt: near.count,
        confA: cf.conf, eq: cf.eq, mh: cf.mh, liq: cf.liq, tg: cf.tg, rsS: r1(L.rsScore), et: L.entryTimingScore,
        rPump: r2(L.recentPump), cPump: r2(L.cumulativePump), mom: r1(L.momentumScore),
        htfT: L.htfTrend, htfW: L.htfWeeklyTrend,
        stopLPct: r2(isNum(stopL) ? (p - stopL) / p * 100 : null),
        planL: gapL ? r2(gapL.ret) : null, exitL: gapL ? gapL.exit : null, heldL: gapL ? gapL.held : null,
        xdL: gapL ? bars[Math.min(n - 1, t + gapL.held)].date : null,
        tgtLPct: r2(isNum(targetL) ? (targetL / p - 1) * 100 : null),
        planP: pap ? r2(pap.ret) : null, exitP: pap ? pap.exit : null, heldP: pap ? pap.held : null,
        xdP: pap ? bars[Math.min(n - 1, t + pap.held)].date : null,
        planPnt: papNoTime ? r2(papNoTime.ret) : null, planPng: papNoTgt ? r2(papNoTgt.ret) : null,
        atrPct: r2(isNum(sig.atr) ? sig.atr / p * 100 : null),
        rsi: r1(ind.lastRSI), mfi: r1(ind.mfi), cmf: r2(ind.cmf), adx: r1(ind.adx),
        di: r1(isNum(ind.plusDI) && isNum(ind.minusDI) ? ind.plusDI - ind.minusDI : null),
        obv: ind.obvTrend ?? null, wy: ind.wyckoffPhase ?? null, vr: r2(ind.volRatio),
        boll: r1(sig.bollPct), m20: r2(sig.ma20pct), m50: r2(sig.ma50pct),
        st: ind.supertrend?.trend === 'UP' ? 1 : 0, sq: ind.ttmSqueeze?.squeezeOn ? 1 : 0,
        cloud: ind.ichimoku?.cloudPosition ?? null,
        fired: Array.isArray(sig.firedSignals) ? sig.firedSignals.join('|') : '',
        // hisse (fiyat / hacim)
        chg1: r2(F.chg[t]), ret3: r2(ret(bars.map((b) => b.close), t, 3)), ret5: r2(F.r5[t]), ret20: r2(F.r20[t]),
        ret63: r2(F.r63[t]), ret126: r2(F.r126[t]), ret252: r2(F.r252[t]),
        dHi252: r2((p / F.hi252[t] - 1) * 100), dHi63: r2((p / F.hi63[t] - 1) * 100),
        m200: r2(F.m200[t] ? (p / F.m200[t] - 1) * 100 : null),
        golden: F.m50[t] && F.m200[t] ? (F.m50[t] > F.m200[t] ? 1 : 0) : null,
        tl20: r2(F.tl20[t] / 1e6), rv20: r2(F.rv20[t]),
        clv: r2(day.high > day.low ? (day.close - day.low) / (day.high - day.low) : 0.5),
        // kesitsel
        rs20: r1(pctRank(x?.r20, F.r20[t])), rs63: r1(pctRank(x?.r63, F.r63[t])),
        rs126: r1(pctRank(x?.r126, F.r126[t])), rs252: r1(pctRank(x?.r252, F.r252[t])),
        vsXu63: r2(isNum(F.r63[t]) && isNum(xi.xr63) ? F.r63[t] - xi.xr63 : null),
        // piyasa (sinyal gunu)
        br20: r1(x && x.n20 ? (x.a20 / x.n20) * 100 : null), br50: r1(x && x.n50 ? (x.a50 / x.n50) * 100 : null),
        br200: r1(x && x.n200 ? (x.a200 / x.n200) * 100 : null), brUp5: r1(x && x.n5 ? (x.up5 / x.n5) * 100 : null),
        x20: r2(xi.x20), x50: r2(xi.x50), x200: r2(xi.x200), xr5: r2(xi.xr5), xr20: r2(xi.xr20), xr63: r2(xi.xr63),
        regT: xi.reg || 'UNKNOWN',
        regF: (xuByDate.get(fill.date) || {}).reg || xi.reg || 'UNKNOWN',
        // giris
        gap: r2((entry / p - 1) * 100),
        // sonuc (brut %)
        plan: mine ? r2(mine.ret) : null, exit: mine ? mine.exit : null, held: mine ? mine.held : null,
        planG: gap ? r2(gap.ret) : null, exitG: gap ? gap.exit : null, heldG: gap ? gap.held : null,
        r1d: r2((fill.close / entry - 1) * 100), r5: r2(r5), r10: r2(r10),
        x5: r2(isNum(r5) && u ? r5 - u.s5 / u.n : null), x10: r2(isNum(r10) && u ? r10 - u.s10 / u.n : null),
        art, artB,
      });
    }
    process.stdout.write(`\r  ${si}/${data.size} ${sym.padEnd(6)} ${rows.length} aday   `);
  }
  console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(0)} sn · simTrail/planSimulation uyusmazligi: ${mismatch}/${checked}`);
  // Sutun-dizisi bicimi: ayni veri, dosya ~3 kat kucuk (250+ sembolde nesne-dizisi >150 MB).
  const cols = Object.keys(rows[0] || {});
  const out = fs.createWriteStream(ROWS_FILE);
  out.write(JSON.stringify({ generatedAt: new Date().toISOString(), range: RANGE, symbols: data.size, cols }).slice(0, -1) + ',"data":[\n');
  for (let i = 0; i < rows.length; i++) out.write((i ? ',\n' : '') + JSON.stringify(cols.map((c) => rows[i][c] ?? null)));
  out.write('\n]}');
  await new Promise((res) => out.end(res));
  console.log(`  yazildi: ${path.relative(ROOT, ROWS_FILE)} (${rows.length} satir, ${data.size} sembol)`);
  return rows;
}

export async function loadRows() {
  if (!REBUILD && fs.existsSync(ROWS_FILE)) {
    const j = JSON.parse(fs.readFileSync(ROWS_FILE, 'utf8'));
    if (Array.isArray(j.rows)) return j.rows;                       // eski bicim
    return j.data.map((a) => { const o = {}; for (let i = 0; i < j.cols.length; i++) o[j.cols[i]] = a[i]; return o; });
  }
  return buildRows();
}

/**
 * Yahoo'dan gunluk bar cek → .replay-cache (replay-signals.mjs ile ayni bicim ve anahtar).
 * step: evrendeki (getStockList('bistall')) onbellekte OLMAYAN her `step`'inci hisse.
 * refresh: onbellektekileri (XU100 dahil) de yeniden cek — son gune kadar uzatir.
 */
async function fetchBars({ step = 3, refresh = false } = {}) {
  const { getStockList } = await import(U('utils/constants.js'));
  const have = new Set(fs.readdirSync(CACHE).filter((f) => f.endsWith(`_${RANGE}.json`) && !f.startsWith('feature-')).map((f) => f.replace(`_${RANGE}.json`, '')));
  const missing = [...new Set(getStockList('bistall'))].sort().filter((s) => !have.has(s)).filter((_, i) => i % Math.max(1, step) === 0);
  const todo = refresh ? [...new Set([...have, 'XU100', ...missing])] : missing;
  console.log(`  cekilecek: ${todo.length} sembol (onbellekte ${have.size})`);
  let ok = 0, short = 0, fail = 0;
  for (const sym of todo) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.IS?range=${RANGE}&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json())?.chart?.result?.[0];
      const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
      if (!Array.isArray(ts) || !q) throw new Error('bos yanit');
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (![o, h, l, c].every((x) => isNum(x) && x > 0)) continue;       // tatil satiri — uydurma
        bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: isNum(v) ? v : 0 });
      }
      if (bars.length < WARMUP + 190) { short++; continue; }                // yeni halka arz: yeterli gecmis yok
      fs.writeFileSync(path.join(CACHE, `${sym}_${RANGE}.json`), JSON.stringify(bars));
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 5) console.log(`  hata ${sym}: ${e.message}`);
      if (fail >= 8 && ok === 0) { console.log('  kaynaga ulasilamiyor — duruyor'); break; }
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  console.log(`  yazildi ${ok} · kisa gecmis (atlandi) ${short} · hata ${fail}`);
}

// ── ozet (dogrudan calistirilinca) ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f2 = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '  -  ');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv.includes('--fetch')) {
    await fetchBars({ step: Number(arg('--fetch', '3')) || 3, refresh: argv.includes('--refresh') });
    if (!REBUILD) process.exit(0);
  }
  const rows = await loadRows();
  const clean = rows.filter((r) => !r.art && !r.artB);
  console.log(`\nADAY SATIRLARI — ${rows.length} (temiz ${clean.length}; ileri pencerede bozuk bar ${rows.filter((r) => r.art).length}, geride ${rows.filter((r) => r.artB).length})`);
  const line = (label, rs) => console.log('  ' + label.padEnd(34) + String(rs.length).padStart(7)
    + f2(mean(rs.map((r) => r.plan)) - COST_PCT).padStart(9) + f2(mean(rs.map((r) => r.planG)) - COST_PCT).padStart(11)
    + (`%${(100 * rs.filter((r) => r.planG > COST_PCT).length / (rs.length || 1)).toFixed(1)}`).padStart(9));
  console.log('  ' + ''.padEnd(34) + 'n'.padStart(7) + 'plan net'.padStart(9) + 'bosluklu'.padStart(11) + 'isabet'.padStart(9));
  line('tum satirlar', rows);
  line('temiz', clean);
  line('  giris stop altinda acildi', clean.filter((r) => r.stopOverEntry));
  for (const k of ['BULL', 'NEUTRAL', 'BEAR']) line(`  rejim (sinyal gunu) ${k}`, clean.filter((r) => r.regT === k));
  for (const k of ['BULL', 'NEUTRAL', 'BEAR']) line(`  rejim (giris gunu, replay) ${k}`, clean.filter((r) => r.regF === k));
}
