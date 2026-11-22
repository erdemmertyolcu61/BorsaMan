#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// swing-ranker-study.mjs — AL LISTESI "HAREKET LISTESI GIBI" OLABILIR MI? (22.11.2026)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: kullanici — "AL listesini hareket listesi gibi iyilestirelim". Hareket listesi
// ogrenen bir model (ertesi seans ozellikleri → lojistik) + acik bir kuralla (+%4 kar-al)
// gorulmemis veride tuttu. AL listesinin sirasi ise olculdugu her seferde adaylari ayirmiyor.
// Bu calisma ayni yontemi AL aday havuzuna uygular: ayni ozellikler (src/utils/nextSession.js),
// cok gunluk hedefler, ileri-yuruyus (A'da egit, B'nin sonraki yilinda sina; "sonra" = tum
// hisseler, kesif sonu 2026-08-28'den sonra; egitim etiketleri test basindan 15+ gun once biter).
//
// HEDEFLER (her biri ayri model):
//   win65   +%6 limit kar-al, 5 seans icinde dolmazsa 5. kapanista sat → net > 0
//   wintrl  yalniz-trailing (stop 1,8×ATR, +%3 basabas, +%5 ustu yarisini kilitle) → net > 0
//   win810  +%8 kar-al, 10 seans → net > 0
//   sw5     5 seans icinde zirve >= acilis + %6
// CIKISLAR: planL (canli stop + yalniz-trailing = urunun kurali, feature-edge-study satirindan),
//   planP (paper motorunun v31.52'ye kadarki cikisi), tp1010 (+%10 / 10 seans), h10 (10 seans tut).
// "fark" = secimin o gunku AL havuzu ortalamasindan farki (gun bazinda), t onun uzerinden.
//
// SONUC (586 hisse; ayrintisi CLAUDE.md "Olculmus kararlar" › Ogrenen swing siralayicisi):
//   en iyi model (win65) ilk 3, trailing ile havuzdan +0,49 (t 1,8) — AMA havuz icinde 5 dilimde
//   sira TERS (en yuksek dilim +0,23, en dusuk +0,61), eski paper cikisiyla havuzun altinda,
//   yalniz YUKSELIS gunlerinde artı. Kazanc siralama gucu degil, oynak hisselerin kuyruk etkisi
//   → AL sirasina girmedi. Canli sira da havuzdan iyi degil (bilinen sonuc).
//
// KULLANIM (once satirlar):
//   node scripts/next-session-study.mjs
//   node scripts/feature-edge-study.mjs
//   node --max-old-space-size=8000 scripts/swing-ranker-study.mjs     # ~2 dk
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, '.replay-cache');
const NS = await import(pathToFileURL(path.join(ROOT, 'src', 'utils', 'nextSession.js')).href);
const { DISCOVERY_END: DISC } = await import(pathToFileURL(path.join(HERE, 'feature-edge-study.mjs')).href);
const { loadRows } = await import(pathToFileURL(path.join(HERE, 'next-session-study.mjs')).href);

const COST = 0.3, EPS = 0.1;
const TODAY = new Date().toISOString().slice(0, 10);
const isNum = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tst = (a) => (a.length > 2 ? mean(a) / (sdv(a) / Math.sqrt(a.length)) : NaN);
const f2 = (x, w = 6) => (isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-').padStart(w);

const { n, data: D } = loadRows();
const FEATS = NS.MODEL_FEATURES;
const okRow = (i) => D.liq[i] && !D.art[i] && !D.artB[i];

// ── cok gunluk sonuclar (barlardan; giris = t+1 acilisi) ──
const EX = Object.fromEntries(['h10', 'tp65', 'tp810', 'tp1010', 'trl', 'mx5', 'lockE'].map((k) => [k, new Float32Array(n).fill(NaN)]));
const loadBars = (s) => JSON.parse(fs.readFileSync(path.join(CACHE, `${s}_5y.json`), 'utf8'))
  .filter((b) => b && b.date < TODAY && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));
/** +X% limit kar-al, H seans; ilk gunden sonra acilis seviyenin ustundeyse acilistan dolar. */
function takeProfit(bars, t, X, H) {
  if (t + H >= bars.length) return NaN;
  const e = bars[t + 1].open, lvl = e * (1 + X / 100), fill = e * (1 + (X + EPS) / 100);
  for (let k = 1; k <= H; k++) {
    const b = bars[t + k];
    if (k > 1 && b.open >= lvl) return (b.open / e - 1) * 100;
    if (b.high >= fill) return X;
  }
  return (bars[t + H].close / e - 1) * 100;
}
/** Yalniz-trailing (planSimulation kurali), bosluk-farkinda; stop = giris − %stopPct. */
function trail(bars, t, stopPct, maxBars = 30) {
  const e = bars[t + 1].open; let stop = e * (1 - stopPct / 100), peak = e, held = 0, last = null;
  for (let i = t + 1; i < bars.length && held < maxBars; i++) {
    const b = bars[i]; held++; last = b.close;
    if (b.low <= stop) return (Math.min(stop, b.open) / e - 1) * 100;
    if (b.high > peak) peak = b.high;
    const pg = (peak / e - 1) * 100;
    if (pg >= 5) { const l = e + (peak - e) * 0.5; if (l > stop) stop = l; } else if (pg >= 3 && e > stop) stop = e;
  }
  return held < maxBars ? NaN : (last / e - 1) * 100;          // pencere bitmediyse sonuc yok
}
const bySym = new Map();
for (let i = 0; i < n; i++) if (okRow(i)) { if (!bySym.has(D.sym[i])) bySym.set(D.sym[i], []); bySym.get(D.sym[i]).push(i); }
for (const [s, ix] of bySym) {
  const bars = loadBars(s); const pos = new Map(bars.map((b, i) => [b.date, i]));
  for (const i of ix) {
    const t = pos.get(D.d[i]); if (t == null || t + 1 >= bars.length) continue;
    const e = bars[t + 1].open;
    EX.lockE[i] = bars[t + 1].high === bars[t + 1].low ? 1 : 0;
    if (t + 10 < bars.length) EX.h10[i] = (bars[t + 10].close / e - 1) * 100;
    EX.tp65[i] = takeProfit(bars, t, 6, 5); EX.tp810[i] = takeProfit(bars, t, 8, 10); EX.tp1010[i] = takeProfit(bars, t, 10, 10);
    EX.trl[i] = trail(bars, t, Math.min(12, 1.8 * (D.atr[i] || 3)));
    if (t + 5 < bars.length) { let m = 0; for (let k = 1; k <= 5; k++) m = Math.max(m, bars[t + k].high); EX.mx5[i] = (m / e - 1) * 100; }
  }
}

// ── AL aday havuzu: feature-edge-study satirlari (dosya satir satir — iki buyuk dosya birden belege sigmaz) ──
const cand = new Map();
{
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(CACHE, 'feature-rows-5y.json')), crlfDelay: Infinity });
  let cols = null;
  for await (const line of rl) {
    if (!cols) { cols = JSON.parse(line.slice(0, line.indexOf(',"data":[')) + '}').cols; continue; }
    const s = line.trim(); if (!s.startsWith('[')) continue;
    const a = JSON.parse(s.endsWith(',') ? s.slice(0, -1) : s); const o = {}; cols.forEach((c, k) => { o[c] = a[k]; });
    if (o.art || o.artB || o.rej != null) continue;                       // yalniz canli filtreden gecenler
    cand.set(o.sym + '|' + o.d, { tp: o.tp, near: o.near, early: o.early, confA: o.confA, sc: o.sc, sector: o.sector, planL: o.planL, planP: o.planP, reg: o.regT });
  }
}
const cOf = new Array(n).fill(null);
for (let i = 0; i < n; i++) if (okRow(i)) cOf[i] = cand.get(D.sym[i] + '|' + D.d[i]) || null;

// ── model: next-session-report.mjs ile ayni (kirp → standartla → ridge lojistik, IRLS) ──
function quantile(s, q) { const p = (s.length - 1) * q; const a = Math.floor(p); return s[a] + (s[Math.min(s.length - 1, a + 1)] - s[a]) * (p - a); }
function fitPrep(train) {
  const prep = {};
  for (const k of FEATS) {
    const v = []; for (const i of train) if (isNum(D[k][i])) v.push(D[k][i]);
    v.sort((a, b) => a - b);
    const lo = quantile(v, 0.01), hi = quantile(v, 0.99); const w = v.map((x) => Math.min(hi, Math.max(lo, x))); const m = mean(w);
    prep[k] = { lo, hi, m, sd: Math.sqrt(mean(w.map((x) => (x - m) ** 2))) || 1 };
  }
  return prep;
}
function design(rows, prep) {
  const p = FEATS.length + 1; const X = new Float64Array(rows.length * p);
  rows.forEach((i, r) => { X[r * p] = 1; FEATS.forEach((k, j) => { const raw = D[k][i]; const pr = prep[k]; X[r * p + 1 + j] = isNum(raw) ? (Math.min(pr.hi, Math.max(pr.lo, raw)) - pr.m) / pr.sd : 0; }); });
  return { X, p };
}
function solve(A, b, p) {
  const L = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { let s = A[i * p + j]; for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k]; L[i * p + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * p + j]; }
  const y = new Float64Array(p); for (let i = 0; i < p; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * p + k] * y[k]; y[i] = s / L[i * p + i]; }
  const x = new Float64Array(p); for (let i = p - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < p; k++) s -= L[k * p + i] * x[k]; x[i] = s / L[i * p + i]; }
  return x;
}
function predict(X, p, beta, N) { const s = new Float64Array(N); for (let r = 0; r < N; r++) { let t = 0; const o = r * p; for (let i = 0; i < p; i++) t += X[o + i] * beta[i]; s[r] = t; } return s; }
function logit(X, p, y, lambda = 5) {
  const N = y.length; let beta = new Float64Array(p);
  for (let it = 0; it < 8; it++) {
    const eta = predict(X, p, beta, N); const A = new Float64Array(p * p), b = new Float64Array(p);
    for (let r = 0; r < N; r++) {
      const mu = 1 / (1 + Math.exp(-eta[r])); const w = Math.max(mu * (1 - mu), 1e-6); const z = eta[r] + (y[r] - mu) / w; const o = r * p;
      for (let i = 0; i < p; i++) { const wx = w * X[o + i]; if (wx === 0) continue; b[i] += wx * z; for (let j = 0; j <= i; j++) A[i * p + j] += wx * X[o + j]; }
    }
    for (let i = 0; i < p; i++) { for (let j = 0; j < i; j++) A[j * p + i] = A[i * p + j]; if (i > 0) A[i * p + i] += lambda; }
    beta = solve(A, b, p);
  }
  return beta;
}
const TARGETS = {
  win65: ['tp65', (v) => v > COST], wintrl: ['trl', (v) => v > COST], win810: ['tp810', (v) => v > COST], sw5: ['mx5', (v) => v >= 6 + EPS],
};
const all = []; for (let i = 0; i < n; i++) if (okRow(i)) all.push(i);
const minus = (d, k) => new Date(Date.parse(d) - k * 864e5).toISOString().slice(0, 10);
// egitim etiketi en fazla 30 seans ileri bakar → egitim test basindan >= 15 takvim gunu once biter
const folds = [
  ['2024', (i) => D.ab[i] === 'A' && D.nd[i] < '2023-12-15', (i) => D.ab[i] === 'B' && D.nd[i] >= '2024-01-01' && D.nd[i] < '2025-01-01'],
  ['2025', (i) => D.ab[i] === 'A' && D.nd[i] < '2024-12-15', (i) => D.ab[i] === 'B' && D.nd[i] >= '2025-01-01' && D.nd[i] < '2026-01-01'],
  ['2026', (i) => D.ab[i] === 'A' && D.nd[i] < '2025-12-15', (i) => D.ab[i] === 'B' && D.nd[i] >= '2026-01-01' && D.d[i] <= DISC],
  ['sonra', (i) => D.ab[i] === 'A' && D.d[i] <= minus(DISC, 16), (i) => D.d[i] > DISC],
];
const FN = folds.map((f) => f[0]);
const SC = Object.fromEntries(Object.keys(TARGETS).map((k) => [k, new Float64Array(n).fill(NaN)]));
const foldOf = new Array(n).fill(null);
for (const [name, trF, teF] of folds) {
  const tr0 = all.filter(trF), test = all.filter(teF);
  for (const [k, [col, yes]] of Object.entries(TARGETS)) {
    const train = tr0.filter((i) => isNum(EX[col][i])); const prep = fitPrep(train); const { X, p } = design(train, prep);
    const beta = logit(X, p, Float64Array.from(train.map((i) => (yes(EX[col][i]) ? 1 : 0))));
    const T = design(test, prep); const sc = predict(T.X, T.p, beta, test.length); test.forEach((i, r) => { SC[k][i] = sc[r]; });
  }
  test.forEach((i) => { foldOf[i] = name; });
}
const byD = new Map();
for (const i of all) { if (!foldOf[i]) continue; if (!byD.has(D.d[i])) byD.set(D.d[i], []); byD.get(D.d[i]).push(i); }
const days = [...byD].filter(([, ix]) => ix.length >= 20).sort((a, b) => (a[0] < b[0] ? -1 : 1));

// ── canli AL zinciri (feature-edge-report.mjs ile ayni) ──
const bonus = (c) => (c.near ? 20 : 0) + (c.early ? 14 : 0);
const finalKey = (c) => c.confA + (c.near ? 15 : c.early ? 10 : 0) + (c.sc >= 75 ? 20 : c.sc >= 65 ? -8 : 0);
function sectorLimit(sorted, max = 8) {
  const seen = new Map(); const lim = [];
  for (const i of sorted) { const c = seen.get(cOf[i].sector) || 0; if (c < (cOf[i].sector === 'Diger' ? 3 : 1)) { lim.push(i); seen.set(cOf[i].sector, c + 1); } if (lim.length >= max) break; }
  if (lim.length < Math.min(max, sorted.length)) for (const i of sorted) { if (lim.length >= max) break; if (!lim.includes(i)) lim.push(i); }
  return lim.slice(0, max);
}
const pool = (ix) => ix.filter((i) => cOf[i]);
const liveShown = (ix) => sectorLimit(ix.slice().sort((a, b) => (cOf[b].tp + bonus(cOf[b])) - (cOf[a].tp + bonus(cOf[a])))).sort((a, b) => finalKey(cOf[b]) - finalKey(cOf[a]));
const topBy = (ix, key, k) => ix.slice().sort((a, b) => key(b) - key(a)).slice(0, k);
const SEL = { 'havuz hepsi': (ix) => pool(ix), 'canli ilk3': (ix) => liveShown(pool(ix)).slice(0, 3), 'canli ilk8': (ix) => liveShown(pool(ix)) };
for (const m of Object.keys(TARGETS)) for (const k of [3, 8]) SEL[`${m} ilk${k}`] = (ix) => topBy(pool(ix), (i) => SC[m][i], k);
SEL['win65 ALT3'] = (ix) => topBy(pool(ix), (i) => -SC.win65[i], 3);
const val = (ex, i) => (ex === 'planL' || ex === 'planP' ? (isNum(cOf[i]?.[ex]) ? cOf[i][ex] : NaN) : EX[ex][i]);
const half = (d) => d.slice(2, 4) + (d.slice(5, 7) <= '06' ? 'a' : 'b');
function evalSel(sel, ex, dayOk = () => true) {
  const byF = Object.fromEntries(FN.map((f) => [f, []])); const trs = []; const exc = []; const excH = new Map();
  for (const [d, ix] of days) {
    if (!dayOk(ix)) continue;
    const pv = pool(ix).filter((i) => !EX.lockE[i]).map((i) => val(ex, i)).filter(isNum);
    const v = sel(ix).filter((i) => !EX.lockE[i]).map((i) => val(ex, i)).filter(isNum).map((x) => x - COST);
    if (!v.length || pv.length < 8) continue;
    byF[foldOf[ix[0]]].push(...v); trs.push(...v); exc.push(mean(v) - (mean(pv) - COST));
    const h = half(d); if (!excH.has(h)) excH.set(h, []); excH.get(h).push(mean(v) - (mean(pv) - COST));
  }
  trs.sort((a, b) => a - b);
  return { byF, trs, exc, excH };
}
for (const ex of ['planL', 'planP', 'tp1010', 'h10']) {
  console.log(`\n══ CIKIS ${ex} — islem basina net (%${COST} maliyet), gorulmemis veri; fark = secim − gunun havuzu ══`);
  console.log('secim'.padEnd(14) + FN.map((f) => f.padStart(7)).join('') + '   tumu   fark t(fark) kazanan    p5     n | yarim yil farki');
  for (const [nm, sel] of Object.entries(SEL)) {
    const r = evalSel(sel, ex); const hs = [...r.excH].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    console.log(nm.padEnd(14) + FN.map((f) => f2(mean(r.byF[f]), 7)).join('') + f2(mean(r.trs), 7) + f2(mean(r.exc), 7) + f2(tst(r.exc), 7)
      + ('%' + (100 * r.trs.filter((x) => x > 0).length / (r.trs.length || 1)).toFixed(0)).padStart(8) + f2(r.trs[Math.floor(r.trs.length * 0.05)], 7) + String(r.trs.length).padStart(6)
      + ' | ' + hs.map(([h, v]) => `${h} ${f2(mean(v), 5)}`).join(' ') + `  (+ ${hs.filter(([, v]) => mean(v) > 0).length}/${hs.length})`);
  }
}
console.log('\n══ SIRALAMA GUCU: havuz icinde model skoruna gore 5 dilim (1 = en yuksek), islem basina net ══');
for (const m of ['win65', 'wintrl']) for (const ex of ['planL', 'tp1010']) {
  const q = [[], [], [], [], []];
  for (const [, ix] of days) {
    const P = pool(ix).filter((i) => !EX.lockE[i] && isNum(val(ex, i))); if (P.length < 10) continue;
    P.sort((a, b) => SC[m][b] - SC[m][a]); P.forEach((i, r) => q[Math.min(4, Math.floor((r / P.length) * 5))].push(val(ex, i) - COST));
  }
  console.log(`${m.padEnd(7)} ${ex.padEnd(7)} ` + q.map((v, k) => `${k + 1}: ${f2(mean(v))}`).join('  '));
}
console.log('\n══ REJIM (sinyal gunu), planL ══');
for (const reg of ['BULL', 'NEUTRAL', 'BEAR']) for (const nm of ['havuz hepsi', 'canli ilk3', 'win65 ilk3']) {
  const r = evalSel(SEL[nm], 'planL', (ix) => pool(ix)[0] != null && cOf[pool(ix)[0]].reg === reg);
  console.log(`${reg.padEnd(8)} ${nm.padEnd(12)} net ${f2(mean(r.trs))}  fark ${f2(mean(r.exc))} (t ${f2(tst(r.exc), 5)})  n ${r.trs.length} | ` + FN.map((f) => `${f} ${f2(mean(r.byF[f]), 5)}`).join(' '));
}
const prof = (lbl, sel) => { const P = []; for (const [, ix] of days) P.push(...sel(ix)); console.log(`${lbl.padEnd(12)} ` + ['atr', 'rv20', 'ret20', 'ret60', 'd50', 'hi252', 'rsi14', 'volR'].map((k) => `${k} ${mean(P.map((i) => D[k][i]).filter(isNum)).toFixed(2)}`).join('  ')); };
console.log('\n══ SECILENLERIN PROFILI ══');
prof('havuz', SEL['havuz hepsi']); prof('canli ilk3', SEL['canli ilk3']); prof('win65 ilk3', SEL['win65 ilk3']);
