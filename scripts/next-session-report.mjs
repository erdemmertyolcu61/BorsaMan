#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// next-session-report.mjs — ERTESI SEANS olcumu + model uretimi (v31.54)
// ════════════════════════════════════════════════════════════════════
//
// Satirlar: scripts/next-session-study.mjs (hisse × gun, evrenin tamami).
// Iki dogrusal lojistik model (ozellikler src/utils/nextSession.js):
//   hareket  P(zirve >= acilis + %3)   — "yarin kim hareket eder"
//   yesil    P(kapanis > onceki kapanis) — "yarin kim yesil kapatir"
//
// DISIPLIN — hicbir rakam modelin gordugu veriden gelmez:
//   ileri-yuruyus: Y yili icin model, kesif kumesinin (A, 89 hisse) Y'den ONCEKI
//   satirlariyla egitilir; dogrulama kumesinin (B, 168 hisse) Y yilinda sinanir.
//   "sonra" = kesif verisinin bittigi gunden (2026-08-28) sonraki tum hisseler.
//   Maliyet %0,3 (gidis-donus). Tek fiyatli (kilitli) seans alinamaz sayilir.
//   Kar-al dolumu: zirve seviyeyi en az %0,1 gecmeli.
//
// BOLUMLER (--only taban,model,kural,saatlik):
//   taban    yesil kapanis / gece / gun-ici taban oranlari
//   model    iki modelin ilk-K secimi: yesil orani, hareket orani
//   kural    gunluk barla: ac-kapa ve kar-al (+%T limit, olmazsa kapanista sat)
//   saatlik  ayni kural SAATLIK yolla (stop/kar sirasi gercek) — .replay-cache/h1 varsa
//
// KULLANIM:
//   node scripts/next-session-study.mjs                      # once satirlar
//   node --max-old-space-size=6000 scripts/next-session-report.mjs
//   node scripts/next-session-report.mjs --fetch-hourly      # Yahoo 60 dk × 730 gun -> .replay-cache/h1
//   node scripts/next-session-report.mjs --write-model       # TUM veriyle egit -> src/utils/nextSessionModel.js
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const CACHE = path.join(ROOT, '.replay-cache');
const H1 = path.join(CACHE, 'h1');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = arg('--only', 'taban,model,kural,saatlik').split(',');
const COST = 0.3;
const MOVE_PCT = 3;
const FILL_EPS = 0.1;
const isNum = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f2 = (x, d = 2) => (isNum(x) ? x.toFixed(d) : '  -');
const tstat = (v) => { const m = mean(v); const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))); return sd ? m / (sd / Math.sqrt(v.length)) : NaN; };

async function fetchHourly() {
  fs.mkdirSync(H1, { recursive: true });
  const syms = fs.readdirSync(CACHE).filter((f) => f.endsWith('_5y.json') && !f.startsWith('XU100') && !f.startsWith('feature-')).map((f) => f.replace('_5y.json', ''));
  let ok = 0, fail = 0;
  for (const s of syms) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}.IS?range=730d&interval=60m`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);         // 422 = 730 gunden kisa gecmis
      const j = (await r.json())?.chart?.result?.[0]; const ts = j?.timestamp, q = j?.indicators?.quote?.[0];
      if (!ts || !q) throw new Error('bos');
      const days = {};
      for (let i = 0; i < ts.length; i++) {
        const b = [q.open[i], q.high[i], q.low[i], q.close[i]];
        if (!b.every((x) => isNum(x) && x > 0)) continue;
        const d = new Date((ts[i] + 3 * 3600) * 1000).toISOString().slice(0, 10);     // TRT gunu
        (days[d] = days[d] || []).push(b);
      }
      fs.writeFileSync(path.join(H1, `${s}.json`), JSON.stringify(days)); ok++;
    } catch { fail++; }
    await new Promise((res) => setTimeout(res, 200));
  }
  console.log(`saatlik: ${ok} hisse yazildi, ${fail} alinamadi (cogu 2 yildan yeni halka arz)`);
}

if (argv.includes('--fetch-hourly')) { await fetchHourly(); process.exit(0); }

const { loadRows } = await import(pathToFileURL(path.join(HERE, 'next-session-study.mjs')).href);
const { DISCOVERY_END: DISC } = await import(pathToFileURL(path.join(HERE, 'feature-edge-study.mjs')).href);
const NS = await import(U('utils/nextSession.js'));
const FEATS = NS.MODEL_FEATURES;
const { n, data: D } = loadRows();
const ok = (i) => D.liq[i] && !D.art[i] && !D.artB[i];
const all = []; for (let i = 0; i < n; i++) if (ok(i)) all.push(i);

// ── model: kirp → standartla → lojistik (IRLS + ridge) ──
function quantile(sorted, q) { const p = (sorted.length - 1) * q; const a = Math.floor(p); return sorted[a] + (sorted[Math.min(sorted.length - 1, a + 1)] - sorted[a]) * (p - a); }
function fitPrep(train) {
  const prep = {};
  for (const k of FEATS) {
    const v = []; for (const i of train) if (isNum(D[k][i])) v.push(D[k][i]);
    v.sort((a, b) => a - b);
    const lo = quantile(v, 0.01), hi = quantile(v, 0.99);
    const w = v.map((x) => Math.min(hi, Math.max(lo, x)));
    const m = mean(w);
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
const TARGETS = { move: (i) => (D.oh1[i] >= MOVE_PCT ? 1 : 0), green: (i) => (D.cc1[i] > 0 ? 1 : 0) };
function fitModels(train) {
  const prep = fitPrep(train); const { X, p } = design(train, prep); const out = { prep };
  for (const [k, yf] of Object.entries(TARGETS)) out[k] = logit(X, p, Float64Array.from(train.map(yf)));
  return out;
}

if (argv.includes('--write-model')) {
  const m = fitModels(all);
  const pack = (beta) => ({ intercept: +beta[0].toFixed(5), terms: FEATS.map((k, j) => [k, +m.prep[k].lo.toFixed(4), +m.prep[k].hi.toFixed(4), +m.prep[k].m.toFixed(5), +m.prep[k].sd.toFixed(5), +beta[j + 1].toFixed(5)]) });
  const model = { builtAt: new Date().toISOString().slice(0, 10), rows: all.length, dataThrough: all.reduce((a, i) => (D.nd[i] > a ? D.nd[i] : a), ''), movePct: MOVE_PCT, move: pack(m.move), green: pack(m.green) };
  const file = path.join(ROOT, 'src', 'utils', 'nextSessionModel.js');
  fs.writeFileSync(file, `// URETILMIS DOSYA — elle duzenleme. Kaynak: node scripts/next-session-report.mjs --write-model\n// Katsayilar ${model.rows} hisse-gun satirindan (likit, bozuk bar yok), veri sonu ${model.dataThrough}.\n// terms: [ozellik, alt kirpma, ust kirpma, ortalama, std sapma, katsayi]\nexport const NEXT_SESSION_MODEL = Object.freeze(${JSON.stringify(model, null, 1)});\n`);
  // uretim kodu ayni sayiyi veriyor mu? (olculen = gosterilen)
  const fresh = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const { X, p } = design(all.slice(0, 4000), m.prep); const eta = predict(X, p, m.move, 4000); let worst = 0;
  all.slice(0, 4000).forEach((i, r) => { const feat = Object.fromEntries(FEATS.map((k) => [k, D[k][i]])); const got = NS.scoreNextSession(feat, fresh.NEXT_SESSION_MODEL).pMove; worst = Math.max(worst, Math.abs(got - 1 / (1 + Math.exp(-eta[r])))); });
  console.log(`model yazildi: ${path.relative(ROOT, file)} — uretim skoru ile en buyuk fark ${worst.toExponential(1)}`);
  if (worst > 1e-3) { console.error('UYUSMAZLIK: scoreNextSession ile egitim tahmini ayni degil'); process.exit(1); }
  process.exit(0);
}

// ── ileri-yuruyus: gorulmemis veride skor ──
const folds = [
  ['2024', (i) => D.ab[i] === 'A' && D.nd[i] < '2024-01-01', (i) => D.ab[i] === 'B' && D.nd[i] >= '2024-01-01' && D.nd[i] < '2025-01-01'],
  ['2025', (i) => D.ab[i] === 'A' && D.nd[i] < '2025-01-01', (i) => D.ab[i] === 'B' && D.nd[i] >= '2025-01-01' && D.nd[i] < '2026-01-01'],
  ['2026', (i) => D.ab[i] === 'A' && D.nd[i] < '2026-01-01', (i) => D.ab[i] === 'B' && D.nd[i] >= '2026-01-01' && D.d[i] <= DISC],
  ['sonra', (i) => D.ab[i] === 'A' && D.d[i] <= DISC, (i) => D.d[i] > DISC],
];
const FN = folds.map((f) => f[0]);
const S = { move: new Float64Array(n).fill(NaN), green: new Float64Array(n).fill(NaN) };
const foldOf = new Array(n).fill(null);
for (const [name, trF, teF] of folds) {
  const train = all.filter(trF), test = all.filter(teF); const m = fitModels(train); const T = design(test, m.prep);
  for (const k of Object.keys(TARGETS)) { const sc = predict(T.X, T.p, m[k], test.length); test.forEach((i, r) => { S[k][i] = sc[r]; }); }
  test.forEach((i) => { foldOf[i] = name; });
}
const byD = new Map();
for (const i of all) { if (!foldOf[i]) continue; if (!byD.has(D.d[i])) byD.set(D.d[i], []); byD.get(D.d[i]).push(i); }
const days = [...byD].filter(([, ix]) => ix.length >= 20).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const top = (ix, key, k) => ix.slice().sort((a, b) => key(b) - key(a)).slice(0, k);
const pickBy = { hareket: (k) => (ix) => top(ix, (i) => S.move[i], k), yesil: (k) => (ix) => top(ix, (i) => S.green[i], k), taban: () => (ix) => ix };

if (ONLY.includes('taban')) {
  console.log('\n══ TABAN ORANLAR (likit evren, hisse-gun) ══');
  console.log('yil     n       yesil%  gun-ici>0%  kap-kap  gece   gun-ici  zirve>=ac+3%');
  const byY = new Map();
  for (const i of all) { const y = D.nd[i].slice(0, 4); if (!byY.has(y)) byY.set(y, []); byY.get(y).push(i); }
  for (const [y, ix] of [...byY].sort()) console.log(`${y}  ${String(ix.length).padStart(6)}   ${f2(mean(ix.map((i) => (D.cc1[i] > 0 ? 100 : 0))), 1).padStart(5)}   ${f2(mean(ix.map((i) => (D.oc1[i] > 0 ? 100 : 0))), 1).padStart(5)}      ${f2(mean(ix.map((i) => D.cc1[i]))).padStart(5)}   ${f2(mean(ix.map((i) => D.gap1[i]))).padStart(5)}  ${f2(mean(ix.map((i) => D.oc1[i]))).padStart(6)}   ${f2(mean(ix.map((i) => (D.oh1[i] >= MOVE_PCT ? 100 : 0))), 1).padStart(5)}`);
  const dayShare = new Map();
  for (const i of all) { if (!dayShare.has(D.d[i])) dayShare.set(D.d[i], { g: 0, n: 0 }); const o = dayShare.get(D.d[i]); o.n++; if (D.cc1[i] > 0) o.g++; }
  const sh = [...dayShare.values()].filter((o) => o.n >= 30).map((o) => o.g / o.n);
  console.log(`gun bazinda: hisselerin cogunlugunun yesil kapattigi gun orani %${f2(mean(sh.map((x) => (x > 0.5 ? 100 : 0))), 1)} (${sh.length} gun)`);
}

if (ONLY.includes('model')) {
  console.log('\n══ MODEL: ilk-5 secim, gorulmemis veri ══');
  for (const [nm, sel] of [['hareket ilk5', pickBy.hareket(5)], ['yesil ilk5', pickBy.yesil(5)], ['taban', pickBy.taban()]]) {
    const acc = Object.fromEntries(FN.map((f) => [f, { g: [], mv: [], oc: [], hi: [], lo: [], maj: [] }]));
    for (const [, ix] of days) {
      const p = sel(ix); const a = acc[foldOf[ix[0]]]; const tr = p.filter((i) => !D.lock1[i]);
      const g = mean(p.map((i) => (D.cc1[i] > 0 ? 1 : 0))); a.g.push(g); a.maj.push(g > 0.5 ? 1 : 0);
      if (tr.length) { a.mv.push(mean(tr.map((i) => (D.oh1[i] >= MOVE_PCT ? 1 : 0)))); a.oc.push(mean(tr.map((i) => D.oc1[i]))); a.hi.push(mean(tr.map((i) => D.oh1[i]))); a.lo.push(mean(tr.map((i) => D.ol1[i]))); }
    }
    console.log(`${nm.padEnd(13)} ` + FN.map((f) => `${f}: yesil %${f2(mean(acc[f].g) * 100, 0)} (cogunluk-yesil gun %${f2(mean(acc[f].maj) * 100, 0)}) hareket>=3 %${f2(mean(acc[f].mv) * 100, 0)} zirve ${f2(mean(acc[f].hi), 1)} dip ${f2(mean(acc[f].lo), 1)} gun-ici ${f2(mean(acc[f].oc))}`).join(' | '));
  }
}

function report(label, series, extra = '') {
  const eq = series.flatMap((s) => s.day); const tr = series.flatMap((s) => s.tr).sort((a, b) => a - b);
  let cum = 0, peak = 0, dd = 0; for (const x of eq) { cum += x; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  console.log(`${label.padEnd(30)} net ${f2(mean(eq)).padStart(6)} (t ${f2(tstat(eq), 1).padStart(5)})  kazanan %${f2(mean(tr.map((x) => (x > 0 ? 100 : 0))), 0)}  arti-gun %${f2(mean(eq.map((x) => (x > 0 ? 100 : 0))), 0)}  en kotu gun ${f2(Math.min(...eq), 1)}  p5 islem ${f2(tr[Math.floor(tr.length * 0.05)], 1)}  maxDD ${f2(dd, 0)} | ${series.map((s) => `${s.key} ${f2(mean(s.day))}`).join('  ')}${extra}`);
}
function collect(sel, rule, keyOf, from = '') {
  const g = new Map(); let miss = 0, skipped = 0;
  for (const [, ix] of days) {
    if (D.nd[ix[0]] < from) continue;
    const v = [];
    for (const i of sel(ix)) {
      if (D.lock1[i]) continue;
      const r = rule(i);
      if (r === undefined) { skipped++; continue; }          // kural "alma" dedi (ör. açılış tavana yakın)
      if (r == null) { miss++; continue; }
      v.push(r - COST);
    }
    if (!v.length) continue;
    const k = keyOf(ix[0]); if (!g.has(k)) g.set(k, { key: k, day: [], tr: [] });
    g.get(k).day.push(mean(v)); g.get(k).tr.push(...v);
  }
  return { series: [...g.values()], miss, skipped };
}

if (ONLY.includes('kural')) {
  console.log('\n══ KURAL (gunluk bar): acilista al; +%T limit kar-al, olmazsa kapanista sat — islem basina net ══');
  const tp = (T) => (i) => (D.oh1[i] >= T + FILL_EPS ? T : D.oc1[i]);
  for (const k of [3, 5, 10]) {
    report(`hareket ilk${k}  ac-kapa`, collect(pickBy.hareket(k), (i) => D.oc1[i], (i) => foldOf[i]).series);
    for (const T of [3, 4, 5]) report(`hareket ilk${k}  kar-al +%${T}`, collect(pickBy.hareket(k), tp(T), (i) => foldOf[i]).series);
  }
  // v31.57: açılış önceki kapanışın +%GAP_CAP üstündeyse +%T kâr-al tavanın (+%10) üstünde kalır → dolamaz.
  // O gün kural "açılışta al, kapanışta sat"a döner (beklentisi eksi). Sınır kuraldan türetilir.
  const capOf = (T) => ((1 + 10 / 100) / (1 + (T + FILL_EPS) / 100) - 1) * 100;
  for (const k of [3, 5]) {
    for (const [lab, cap] of [['tavan (+%9,5)', 9.5], [`kar-al tavanin ustu (+%${capOf(4).toFixed(2)})`, capOf(4)], ['+%4', 4], ['+%3', 3]]) {
      const c = collect(pickBy.hareket(k), (i) => (D.gap1[i] >= cap ? undefined : tp(4)(i)), (i) => foldOf[i]);
      report(`hareket ilk${k}  +%4, bosluk>=${lab} alma`, c.series, `  (atlanan ${c.skipped})`);
    }
    const only = collect(pickBy.hareket(k), (i) => (D.gap1[i] >= capOf(4) ? tp(4)(i) : undefined), (i) => foldOf[i]);
    report(`hareket ilk${k}  YALNIZ bosluk>=${capOf(4).toFixed(2)}`, only.series, `  (n ${only.series.reduce((a, x) => a + x.tr.length, 0)})`);
  }
  report('yesil ilk5    ac-kapa', collect(pickBy.yesil(5), (i) => D.oc1[i], (i) => foldOf[i]).series);
  report('yesil ilk5    kar-al +%4', collect(pickBy.yesil(5), tp(4), (i) => foldOf[i]).series);
  report('taban         ac-kapa', collect(pickBy.taban(), (i) => D.oc1[i], (i) => foldOf[i]).series);
}

if (ONLY.includes('saatlik')) {
  if (!fs.existsSync(H1)) { console.log('\n(saatlik bolum atlandi: once --fetch-hourly)'); } else {
    const hc = new Map();
    const hour = (s) => { if (!hc.has(s)) { const f = path.join(H1, `${s}.json`); hc.set(s, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null); } return hc.get(s); };
    let first = '9999'; for (const f of fs.readdirSync(H1).slice(0, 40)) { const d = Object.keys(JSON.parse(fs.readFileSync(path.join(H1, f), 'utf8'))).sort()[5]; if (d && d < first) first = d; }
    // giris = gunun ilk saatlik barinin acilisi; ayni saatte hem stop hem kar degdiyse `pess` karar verir
    const walk = ({ tp = null, sl = null, pess = true, exitBar = null }) => (i) => {
      const bars = hour(D.sym[i])?.[D.nd[i]]; if (!bars || bars.length < 5) return null;
      const e = bars[0][0]; const TP = tp != null ? e * (1 + (tp + FILL_EPS) / 100) : Infinity; const SL = sl != null ? e * (1 - sl / 100) : -Infinity;
      for (let k = 0; k < bars.length; k++) {
        const hitT = bars[k][1] >= TP, hitS = bars[k][2] <= SL;
        if (hitT && hitS) return pess ? -sl : tp;
        if (hitS) return -sl; if (hitT) return tp;
        if (exitBar != null && k >= exitBar) return (bars[k][3] / e - 1) * 100;
      }
      return (bars[bars.length - 1][3] / e - 1) * 100;
    };
    const half = (i) => D.nd[i].slice(2, 4) + (D.nd[i].slice(5, 7) <= '06' ? 'H1' : 'H2');
    console.log(`\n══ KURAL (SAATLIK yol, ${first} sonrasi): stop/kar sirasi gercek, gorulmemis veri ══`);
    for (const k of [3, 5]) {
      const run = (label, opt) => { const c = collect(pickBy.hareket(k), walk(opt), half, first); report(`ilk${k}  ${label}`, c.series, k === 3 && label === 'ac-kapa' ? `  (saatlik verisi olmayan secim: ${c.miss})` : ''); };
      run('ac-kapa', {});
      run('kar-al +%3', { tp: 3 }); run('kar-al +%4', { tp: 4 }); run('kar-al +%5', { tp: 5 });
      run('kar-al +%4, stop -%3', { tp: 4, sl: 3 }); run('kar-al +%4, stop -%5', { tp: 4, sl: 5 }); run('kar-al +%4, stop -%7', { tp: 4, sl: 7 });
      run('kar-al +%4, 3. saatte cik', { tp: 4, exitBar: 2 });
      {
        const cap = ((1.10) / (1 + (4 + FILL_EPS) / 100) - 1) * 100;
        const w = walk({ tp: 4 });
        const c = collect(pickBy.hareket(k), (i) => (D.gap1[i] >= cap ? undefined : w(i)), half, first);
        report(`ilk${k}  kar-al +%4, bosluk>=${cap.toFixed(2)} alma`, c.series, `  (atlanan ${c.skipped})`);
      }
      run('yalniz stop -%4 (hedefsiz)', { sl: 4 });
    }
  }
}
