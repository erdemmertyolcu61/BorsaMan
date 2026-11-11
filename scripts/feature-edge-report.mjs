#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// feature-edge-report.mjs — ADAY SECIMI OLCUM RAPORU (v31.53)
// ════════════════════════════════════════════════════════════════════
//
// feature-edge-study.mjs'in urettigi aday satirlarini okur ve su sorulari
// yanitlar (hepsi net: %0,3 gidis-donus maliyeti dusulmus):
//   rejim   — rejim etiketi sinyal gunuyle mi giris gunuyle mi? (ileri bakis)
//   filtre  — canli AL filtresinin her red sebebi isini yapiyor mu?
//   ic      — hangi anahtar ayni gunun adaylarini siralayabiliyor?
//   secim   — ilk-K secimi: canli zincir / skor / sakinlik sirasi
//   cikis   — paper motorunun gercek cikisi vs yalniz-trailing
//   bosluk  — acilis boslugu girisi nasil etkiliyor?
//   skor    — rejim × skor kademesi (YATAY tabani icin)
//   portfoy — gercek boyutlandirma kuraliyla 3 pozisyonluk hesap simulasyonu
//
// v31.53'TE BU RAPORDAN CIKAN KARARLAR (ayrintisi CLAUDE.md "Olculmus kararlar"):
//   - cikis:  paper motorunun eski cikisi (hedefte tam satis + 3. gun) islem basina ~0,
//             yalniz-trailing +0,70; iki kumede ve her yilda ayni yon → motor hizalandi.
//   - rejim:  giris-gunu etiketi 1 gun ileri bakiyordu; durust etiketle siralama ayni
//             (YUKSELIS > YATAY > DUSUS) ama fark cok daha kucuk.
//   - secim:  skor / yarin-potansiyeli / guven adaylari SIRALAMIYOR. Sakinlik sirasi
//             iki kumede siraliyor, ama trailing cikisla 2024 ortasindan beri avantaji
//             yok (2026 ilk yari eksi) → secime girmedi, "goster + olc" katmani oldu.
//   - bosluk: ±%2 acilis boslugu kapisi dogrulama kumesinde tutmadi → eklenmedi.
//   - skor:   YATAY'da skor>=70 tabani ortalamanin ALTINDA secim yapiyor (iki kumede).
//             Kullanici karari oldugu icin degistirilmedi; rakamlar kullaniciya sunuldu.
//
// ORNEKLEMLER — bulgu nerede bulundu, nerede sinandi:
//   A kesif       89 hisse, <= 2026-08-28: butun kararlar buraya bakilarak verildi
//   B dogrulama   baska hisseler, ayni donem: kararlar verilirken hic gorulmedi
//   sonrasi       > 2026-08-28, tum hisseler: kararlardan sonra gelen veri
//
// KULLANIM:
//   node scripts/feature-edge-report.mjs                 # hepsi
//   node scripts/feature-edge-report.mjs --only secim,portfoy --k 3
// ════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRows, COST_PCT, DISCOVERY_END } from './feature-edge-study.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { calmRanks } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'utils', 'candidateRank.js')).href);

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const want = (s) => !ONLY.length || ONLY.includes(s);
const K = Number(arg('--k', 3));
const MIN_CANDS = 8;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tstat = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
const f2 = (v, w = 8) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '-').padStart(w);
const f3 = (v, w = 8) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '-').padStart(w);
const f1 = (v, w = 7) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) : '-').padStart(w);
const pct = (a, f) => ('%' + (100 * a.filter(f).length / (a.length || 1)).toFixed(1)).padStart(8);
const net = (key) => (r) => r[key] - COST_PCT;
const Y = net('planL');           // varsayilan sonuc: canli stop + yalniz-trailing, bosluk-farkinda

const rows = await loadRows();
const clean = rows.filter((r) => !r.art && !r.artB && isNum(r.planL) && isNum(r.planG));
const pass = clean.filter((r) => r.rej == null);

const SAMPLES = [
  ['A kesif', (r) => r.ab === 'A' && r.d <= DISCOVERY_END],
  ['B dogrulama', (r) => r.ab === 'B' && r.d <= DISCOVERY_END],
  ['sonrasi', (r) => r.d > DISCOVERY_END],
  ['tumu', () => true],
];
const groupByDay = (rs) => { const m = new Map(); for (const r of rs) { if (!m.has(r.d)) m.set(r.d, []); m.get(r.d).push(r); } return m; };

console.log(`ADAY SATIRLARI: ${rows.length} · temiz ${clean.length} · canli filtreden gecen ${pass.length}`);
for (const [name, f] of SAMPLES) {
  const p = pass.filter(f); const g = groupByDay(p);
  const ds = [...g.keys()].sort();
  console.log(`  ${name.padEnd(13)} ${String(p.length).padStart(7)} aday · ${new Set(p.map((r) => r.sym)).size} hisse · ${ds.length} gun (${ds[0] || '-'} → ${ds[ds.length - 1] || '-'}) · gun basina ${(p.length / (ds.length || 1)).toFixed(0)}`);
}

// ── ortak: siralayicilar ────────────────────────────────────────────
const toLive = (r) => ({ realizedVol20: r.rv20, adx: r.adx, distFromMA50: r.m50, entryQuality: r.eq });
const calm = (rs) => calmRanks(rs.map(toLive));
function pctRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).filter((x) => isNum(x[0])).sort((a, b) => a[0] - b[0]);
  const out = new Array(vals.length).fill(0.5); const n = idx.length;
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const rk = n > 1 ? ((i + j) / 2) / (n - 1) : 0.5; for (let k = i; k <= j; k++) out[idx[k][1]] = rk; i = j + 1; }
  return out;
}
const calm3 = (rs) => { const a = pctRanks(rs.map((r) => r.rv20)), b = pctRanks(rs.map((r) => r.adx)), c = pctRanks(rs.map((r) => r.m50)); return rs.map((_, i) => 1 - (a[i] + b[i] + c[i]) / 3); };
const topBy = (rs, key, k) => rs.map((r, i) => [key[i], r]).sort((a, b) => b[0] - a[0]).slice(0, k).map((x) => x[1]);
const bonus = (r) => (r.near ? 20 : 0) + (r.early ? 14 : 0);
const finalKey = (r) => r.confA + (r.near ? 15 : r.early ? 10 : 0) + (r.sc >= 75 ? 20 : r.sc >= 65 ? -8 : 0);
const isBuyLabel = (r) => r.cls === 'buy' || !!r.early || r.sc >= 55;      // useAIAdvisor "v29 FIX: reclassify"
/** useAIAdvisor "SEKTOR KONSANTRASYON SINIRI": ozel sektor 1, 'Diger' 3, 8'e tamamla. */
function sectorLimit(sorted, max = 8) {
  const seen = new Map(); const lim = [];
  for (const p of sorted) { const c = seen.get(p.sector) || 0; if (c < (p.sector === 'Diger' ? 3 : 1)) { lim.push(p); seen.set(p.sector, c + 1); } if (lim.length >= max) break; }
  if (lim.length < Math.min(max, sorted.length)) for (const p of sorted) { if (lim.length >= max) break; if (!lim.includes(p)) lim.push(p); }
  return lim.slice(0, max);
}
/** Canli zincir: yarin-potansiyeli + bonus → sektor siniri → 8 → guven + konviksiyon sirasi. */
const liveShown = (rs) => sectorLimit(rs.slice().sort((a, b) => (b.tp + bonus(b)) - (a.tp + bonus(a)))).sort((a, b) => finalKey(b) - finalKey(a));
/** Onerilen zincir: sakinlik sirasi → sektor siniri → 8 (sira korunur). */
const calmShown = (rs) => sectorLimit(topBy(rs, calm(rs), rs.length));

// ── rejim ───────────────────────────────────────────────────────────
if (want('rejim')) {
  console.log('\n══ REJIM ETIKETI: sinyal gunu (bilinen) vs giris gunu (replay — 1 gun ileri bakis) ══');
  console.log('  canli filtreden gecen adaylar, yalniz-trailing net %; [yari: <2024-08 | >=2024-08]');
  for (const [lab, key] of [['sinyal gunu', 'regT'], ['giris gunu ', 'regF']]) {
    console.log('  ' + lab + ['BULL', 'NEUTRAL', 'BEAR'].map((k) => {
      const rs = pass.filter((r) => r[key] === k);
      return `   ${k} n=${rs.length} ${f2(mean(rs.map(Y)), 6)} [${f2(mean(rs.filter((r) => r.d < '2024-08-01').map(Y)), 6)} |${f2(mean(rs.filter((r) => r.d >= '2024-08-01').map(Y)), 6)}]`;
    }).join(''));
  }
  console.log('  yil × rejim (sinyal gunu), gun ortalamasi [gun]:');
  const g = groupByDay(pass);
  for (const y of ['2022', '2023', '2024', '2025', '2026']) {
    console.log('   ' + y + ['BULL', 'NEUTRAL', 'BEAR'].map((k) => {
      const dm = [...g.entries()].filter(([d, rs]) => d.startsWith(y) && rs[0].regT === k).map(([, rs]) => mean(rs.map(Y)));
      return `   ${k} ${f2(mean(dm), 6)} [${dm.length}]`;
    }).join(''));
  }
}

// ── filtre ──────────────────────────────────────────────────────────
if (want('filtre')) {
  console.log('\n══ CANLI AL FILTRESI: her red sebebi (reddedilenler alinsaydi ne olurdu) ══');
  console.log('  ' + ''.padEnd(22) + 'n'.padStart(7) + 'net'.padStart(8) + 'A'.padStart(8) + 'B'.padStart(8) + 'isabet'.padStart(8));
  const line = (lab, rs) => console.log('  ' + lab.padEnd(22) + String(rs.length).padStart(7) + f2(mean(rs.map(Y))) + f2(mean(rs.filter((r) => r.ab === 'A').map(Y))) + f2(mean(rs.filter((r) => r.ab === 'B').map(Y))) + pct(rs, (r) => Y(r) > 0));
  line('gecen', pass);
  line('reddedilen (hepsi)', clean.filter((r) => r.rej != null));
  for (const k of [...new Set(clean.map((r) => r.rej).filter(Boolean))].sort()) line('  ' + k, clean.filter((r) => r.rej === k));
}

// ── gun-ici sira korelasyonu ────────────────────────────────────────
function spearman(a, b) {
  const ra = pctRanks(a), rb = pctRanks(b); const ma = mean(ra), mb = mean(rb);
  let n = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : NaN;
}
if (want('ic')) {
  const KEYS = {
    'skor': (rs) => rs.map((r) => r.sc), 'yarin-pot.': (rs) => rs.map((r) => r.tp), 'yarin+bonus': (rs) => rs.map((r) => r.tp + bonus(r)),
    'guven': (rs) => rs.map((r) => r.confA), 'canli sira': (rs) => rs.map(finalKey), 'SAKINLIK': calm, 'sakin3': calm3,
    'giris kal.': (rs) => rs.map((r) => r.eq), '-oynaklik': (rs) => rs.map((r) => -r.rv20), '-adx': (rs) => rs.map((r) => -r.adx), '-ma50 uz.': (rs) => rs.map((r) => -r.m50),
    'goreli guc': (rs) => rs.map((r) => r.rsS), 'top-10 pot.': (rs) => rs.map((r) => r.tg), 'likidite': (rs) => rs.map((r) => r.liq), 'mom.sagligi': (rs) => rs.map((r) => r.mh),
    'erken say.': (rs) => rs.map((r) => r.earlyCnt), 'kirilim say.': (rs) => rs.map((r) => r.nearCnt), 'rsi': (rs) => rs.map((r) => r.rsi), 'cmf': (rs) => rs.map((r) => r.cmf), 'r/r': (rs) => rs.map((r) => r.rr),
  };
  console.log('\n══ GUN-ICI SIRA KORELASYONU: anahtar ayni gunun adaylarini siralayabiliyor mu? ══');
  console.log(`  Spearman, >=${MIN_CANDS} adayli gunler, sonuc = yalniz-trailing net; her hucre: ort (t)`);
  console.log('  ' + 'anahtar'.padEnd(13) + SAMPLES.map(([n]) => n.padStart(17)).join(''));
  for (const [name, fn] of Object.entries(KEYS)) {
    let line = '  ' + name.padEnd(13);
    for (const [, f] of SAMPLES) {
      const ics = [];
      for (const rs of groupByDay(pass.filter(f)).values()) { if (rs.length < MIN_CANDS) continue; const ic = spearman(fn(rs), rs.map(Y)); if (Number.isFinite(ic)) ics.push(ic); }
      line += (f3(mean(ics), 8) + ' (' + f1(tstat(ics), 5) + ')').padStart(17);
    }
    console.log(line);
  }
}

// ── ilk-K secimi ────────────────────────────────────────────────────
const STRATS = {
  'hepsi (taban)': (rs) => rs,
  'canli liste ilk K': (rs, k) => liveShown(rs).slice(0, k),
  'canli paper (skor) K': (rs, k) => liveShown(rs).filter((p) => isBuyLabel(p) && p.sc >= 55).sort((a, b) => b.sc - a.sc).slice(0, k),
  'skor ilk K': (rs, k) => topBy(rs, rs.map((r) => r.sc), k),
  'yarin+bonus ilk K': (rs, k) => topBy(rs, rs.map((r) => r.tp + bonus(r)), k),
  'guven ilk K': (rs, k) => topBy(rs, rs.map((r) => r.confA), k),
  'SAKINLIK ilk K': (rs, k) => topBy(rs, calm(rs), k),
  'SAKINLIK zinciri ilk K': (rs, k) => calmShown(rs).slice(0, k),
  'SAKINLIK zinciri (AL) K': (rs, k) => calmShown(rs).filter(isBuyLabel).slice(0, k),
  'sakin3 (kalitesiz) ilk K': (rs, k) => topBy(rs, calm3(rs), k),
  'SAKINLIK son K (ters)': (rs, k) => topBy(rs, calm(rs).map((v) => -v), k),
};
function evalStrat(sel, sampleRows, key = 'planL', dayFilter = () => true) {
  const y = net(key); const dm = []; const trades = [];
  for (const [d, rs0] of groupByDay(sampleRows)) {
    const rs = rs0.filter((r) => isNum(r[key]));
    if (rs.length < MIN_CANDS || !dayFilter(rs[0])) continue;
    const pick = sel(rs, K);
    if (!pick.length) continue;
    dm.push({ d, m: mean(pick.map(y)), base: mean(rs.map(y)) });
    trades.push(...pick);
  }
  return { dm, trades, y };
}
if (want('secim')) {
  console.log(`\n══ ILK-${K} SECIMI: gun ortalamasi net %, parantez = tabandan fark (t) ══`);
  for (const [sname, f] of SAMPLES) {
    const sr = pass.filter(f);
    console.log(`\n  ${sname}`);
    console.log('  ' + 'strateji'.padEnd(26) + 'gun'.padStart(5) + 'ort'.padStart(8) + 'fark'.padStart(8) + 't'.padStart(7) + 'isabet'.padStart(8) + 'medyan'.padStart(8) + '5.yuzd.'.padStart(8) + '   r5 fark (t)');
    for (const [name, sel] of Object.entries(STRATS)) {
      const { dm, trades, y } = evalStrat(sel, sr);
      const diff = dm.map((x) => x.m - x.base);
      const ys = trades.map(y).sort((a, b) => a - b);
      const r5 = evalStrat(sel, sr, 'r5'); const d5 = r5.dm.map((x) => x.m - x.base);
      console.log('  ' + name.padEnd(26) + String(dm.length).padStart(5) + f2(mean(dm.map((x) => x.m))) + f2(mean(diff)) + f1(tstat(diff), 7) + pct(trades, (r) => y(r) > 0) + f2(ys[Math.floor(ys.length / 2)]) + f2(ys[Math.floor(ys.length * 0.05)])
        + '   ' + f2(mean(d5), 6) + ' (' + f1(tstat(d5), 5) + ')');
    }
  }
  console.log('\n  rejime gore (tumu) — SAKINLIK ilk K − taban | canli paper − taban | skor ilk K − taban:');
  for (const reg of ['BULL', 'NEUTRAL', 'BEAR']) {
    const cell = (name) => { const { dm } = evalStrat(STRATS[name], pass, 'planL', (r) => r.regT === reg); const diff = dm.map((x) => x.m - x.base); return `${f2(mean(diff), 6)} (${f1(tstat(diff), 5)})`; };
    console.log(`   ${reg.padEnd(8)} ${cell('SAKINLIK ilk K')} | ${cell('canli paper (skor) K')} | ${cell('skor ilk K')}`);
  }
  console.log('  yila gore (tumu) — taban | canli paper | SAKINLIK ilk K:');
  for (const yv of ['2022', '2023', '2024', '2025', '2026']) {
    const cell = (name) => { const { dm } = evalStrat(STRATS[name], pass.filter((r) => r.d.startsWith(yv))); return f2(mean(dm.map((x) => x.m)), 7); };
    console.log(`   ${yv} ${cell('hepsi (taban)')} | ${cell('canli paper (skor) K')} | ${cell('SAKINLIK ilk K')}`);
  }
  // isim etkisi mi, durum etkisi mi
  const symMean = new Map(); { const g = new Map(); for (const r of pass) { if (!g.has(r.sym)) g.set(r.sym, []); g.get(r.sym).push(r.planL); } for (const [s, a] of g) symMean.set(s, mean(a)); }
  const dRaw = [], dDm = [];
  for (const rs of groupByDay(pass).values()) { if (rs.length < MIN_CANDS) continue; const pick = topBy(rs, calm(rs), K); dRaw.push(mean(pick.map((r) => r.planL)) - mean(rs.map((r) => r.planL))); dDm.push(mean(pick.map((r) => r.planL - symMean.get(r.sym))) - mean(rs.map((r) => r.planL - symMean.get(r.sym)))); }
  console.log(`  isim mi durum mu? SAKINLIK ilk ${K} − taban: ham ${f2(mean(dRaw), 6)} (t ${tstat(dRaw).toFixed(1)}) · hissenin kendi ortalamasi cikarilinca ${f2(mean(dDm), 6)} (t ${tstat(dDm).toFixed(1)})`);
}

// ── cikis politikasi ────────────────────────────────────────────────
if (want('cikis')) {
  console.log('\n══ CIKIS: paper motorunun gercekte uyguladigi vs yalniz-trailing (ayni giris, ayni stop) ══');
  console.log('  ' + ''.padEnd(13) + 'n'.padStart(7) + 'TRAILING'.padStart(10) + 'PAPER'.padStart(8) + 'sure yok'.padStart(10) + 'hedef yok'.padStart(10) + '   tutma(bar) trailing/paper   paper cikis dagilimi');
  const line = (lab, rs) => {
    const ex = (k) => (100 * rs.filter((r) => r.exitP === k).length / (rs.length || 1)).toFixed(0);
    console.log('  ' + lab.padEnd(13) + String(rs.length).padStart(7) + f2(mean(rs.map(net('planL'))), 10) + f2(mean(rs.map(net('planP')))) + f2(mean(rs.map(net('planPnt'))), 10) + f2(mean(rs.map(net('planPng'))), 10)
      + `   ${mean(rs.map((r) => r.heldL)).toFixed(1)} / ${mean(rs.map((r) => r.heldP)).toFixed(1)}`.padEnd(30) + `stop %${ex('stop')} · hedef %${ex('target')} · sure %${ex('time')} · 30 bar %${ex('timeout')}`);
  };
  const ok = pass.filter((r) => isNum(r.planP) && isNum(r.planPnt) && isNum(r.planPng));
  for (const [name, f] of SAMPLES) line(name, ok.filter(f));
  for (const yv of ['2022', '2023', '2024', '2025', '2026']) line('  ' + yv, ok.filter((r) => r.d.startsWith(yv)));
  const perBar = (key, held) => mean(ok.map(net(key))) / mean(ok.map((r) => r[held]));
  console.log(`  bar basina net (sermaye verimliligi): trailing ${f3(perBar('planL', 'heldL'), 7)} · paper ${f3(perBar('planP', 'heldP'), 7)}`);
}

// ── acilis boslugu ──────────────────────────────────────────────────
if (want('bosluk')) {
  console.log('\n══ ACILIS BOSLUGU: giris acilisi / sinyal kapanisi (%), canli filtreden gecenler ══');
  console.log('  stop altinda acilanlar haric (paper o emri zaten iptal ediyor); net %, [gun-ici fark (t)]');
  const live = pass.filter((r) => r.gap > -r.stopLPct);
  console.log('  ' + 'bosluk'.padEnd(12) + 'n'.padStart(7) + SAMPLES.map(([n]) => n.padStart(13)).join('') + '   gun-ici fark');
  for (const [lo, hi] of [[-99, -2], [-2, -1], [-1, -0.3], [-0.3, 0.3], [0.3, 1], [1, 2], [2, 3], [3, 99]]) {
    const inB = (r) => r.gap >= lo && r.gap < hi;
    const diffs = [];
    for (const rs of groupByDay(live).values()) { const a = rs.filter(inB), b = rs.filter((r) => !inB(r)); if (a.length && b.length >= 5) diffs.push(mean(a.map(Y)) - mean(b.map(Y))); }
    console.log('  ' + `${lo}..${hi}`.padEnd(12) + String(live.filter(inB).length).padStart(7) + SAMPLES.map(([, f]) => f2(mean(live.filter((r) => inB(r) && f(r)).map(Y)), 13)).join('') + `   ${f2(mean(diffs), 6)} (${f1(tstat(diffs), 5)})`);
  }
  console.log(`  stop altinda acilan (iptal edilen) emir: ${pass.length - live.length} (%${(100 * (pass.length - live.length) / pass.length).toFixed(1)})`);
}

// ── rejim × skor ────────────────────────────────────────────────────
if (want('skor')) {
  console.log('\n══ REJIM (sinyal gunu) × SKOR KADEMESI: canli filtreden gecenler, net % ══');
  const tiers = [[45, 55], [55, 65], [65, 70], [70, 75], [75, 101]];
  console.log('  ' + ''.padEnd(9) + tiers.map(([lo, hi]) => `${lo}-${hi === 101 ? '' : hi}`.padStart(22)).join(''));
  for (const reg of ['BULL', 'NEUTRAL', 'BEAR']) {
    console.log('  ' + reg.padEnd(9) + tiers.map(([lo, hi]) => { const rs = pass.filter((r) => r.regT === reg && r.sc >= lo && r.sc < hi); return `n=${rs.length} ${f2(mean(rs.map(Y)), 6)} ${pct(rs, (r) => Y(r) > 0).trim()}`.padStart(22); }).join(''));
  }
  console.log('  YATAY gunlerinde secim kurali (gun ortalamasi, en fazla 4 aday):');
  for (const [name, f] of SAMPLES) {
    const g = groupByDay(pass.filter((r) => f(r) && r.regT === 'NEUTRAL'));
    const a = [], b = [], base = []; let daysA = 0, daysAll = 0;
    for (const rs of g.values()) {
      if (rs.length < MIN_CANDS) continue;
      daysAll++; base.push(mean(rs.map(Y)));
      const cur = rs.filter((r) => isBuyLabel(r) && r.sc >= 70).sort((x, y) => y.sc - x.sc).slice(0, 4);
      if (cur.length) { daysA++; a.push(mean(cur.map(Y))); }
      const alt = calmShown(rs).filter(isBuyLabel).slice(0, 4);
      if (alt.length) b.push(mean(alt.map(Y)));
    }
    console.log(`   ${name.padEnd(13)} taban ${f2(mean(base), 6)} · skor>=70 (bugunku kural) ${f2(mean(a), 6)} [${daysA}/${daysAll} gun aday var] · sakinlik ilk 4 ${f2(mean(b), 6)}`);
  }
}

// ── portfoy simulasyonu ─────────────────────────────────────────────
// PaperTradeEngine kurali: en fazla 3 acik pozisyon, elde olana yeniden girilmez;
// boyut = min(nakit×%2×carpan / stop mesafesi, nakit×%33×carpan, nakit), en az 3.000 TL;
// carpan = rejim (YUKSELIS 1 / YATAY 0,8) × konviksiyon (skor>=75: 1, >=65: 0,75, alti: 0,5) × YATAY 0,5;
// DUSUS'te pozisyon acilmaz (izle-only). Giris ertesi acilis; acilis stop'un altindaysa emir iptal.
const TIER = (sc) => (sc >= 75 ? 1 : sc >= 65 ? 0.75 : 0.5);
const multOf = (r, reg) => TIER(r.sc) * (reg === 'NEUTRAL' ? 0.8 * 0.5 : 1);
const SELECT = {
  /** bugunku zincir + paper'in skor siralamasi + YATAY skor>=70 + gunluk garanti */
  canli: (rs, reg, allOfDay) => {
    if (reg === 'BEAR') return [];
    if (reg === 'NEUTRAL') {
      const g = rs.filter((r) => isBuyLabel(r) && r.sc >= 70).sort((a, b) => b.sc - a.sc).slice(0, 4);
      if (g.length) return g;
      const pool = allOfDay.filter((r) => Math.max(r.chg1 || 0, r.rPump || 0) < 7 && (r.cPump || 0) < 15 && (r.rsi || 50) <= 78 && (r.mfi || 50) <= 82);
      const best = pool.sort((a, b) => b.sc - a.sc)[0];
      return best && best.cls === 'buy' && best.sc >= 55 ? [best] : [];
    }
    return liveShown(rs).filter((r) => isBuyLabel(r) && r.sc >= 55).sort((a, b) => b.sc - a.sc);
  },
  /** yalniz siralama degisir: YUKSELIS'te sakinlik zinciri; YATAY kurali (skor>=70) aynen */
  sakin: (rs, reg, allOfDay) => (reg === 'BULL' ? calmShown(rs).filter(isBuyLabel) : SELECT.canli(rs, reg, allOfDay)),
  /** + YATAY'da skor>=70 yerine sakinlik ilk 4 (tavan 4 ve yarim boyut aynen) */
  'sakin+yatay': (rs, reg) => (reg === 'BEAR' ? [] : calmShown(rs).filter(isBuyLabel).slice(0, reg === 'NEUTRAL' ? 4 : 8)),
};
function portfolio(sampleRows, { select, exit = 'planL', exitDate = 'xdL', gapGuard = null, slots = 3, capital = 100000 }) {
  const passDay = groupByDay(sampleRows.filter((r) => r.rej == null && isNum(r[exit])));
  const allDay = groupByDay(sampleRows);
  const dates = [...new Set([...passDay.keys(), ...sampleRows.map((r) => r[exitDate]).filter(Boolean)])].sort();
  let cash = capital, peak = capital, maxDD = 0, open = [], n = 0, wins = 0, sumRet = 0, cancelled = 0, invested = 0, steps = 0;
  const yearEq = new Map();
  for (const d of dates) {
    // 1) bugun kapanan pozisyonlar
    open = open.filter((p) => { if (p.exitDate > d) return true; const net = p.ret - COST_PCT; cash += p.size * (1 + net / 100); n++; sumRet += net; if (net > 0) wins++; return false; });
    // 2) aksam taramasi → ertesi acilis
    const rs = passDay.get(d);
    if (rs && rs.length >= 1) {
      const reg = rs[0].regT;
      const held = new Set(open.map((p) => p.sym));
      const queue = select(rs, reg, allDay.get(d) || rs).filter((r) => !held.has(r.sym)).slice(0, Math.max(0, slots - open.length));
      for (const r of queue) {
        const stopDist = 1 - (1 - r.stopLPct / 100) / (1 + r.gap / 100);
        if (!(stopDist > 0)) { cancelled++; continue; }                                   // gap_below_stop
        if (gapGuard && (r.gap >= gapGuard.up || r.gap <= -gapGuard.down)) { cancelled++; continue; }
        const m = multOf(r, reg);
        const size = Math.min((cash * 0.02 * m) / stopDist, cash * 0.33 * m, cash);
        if (!(size >= 3000)) continue;
        cash -= size;
        open.push({ sym: r.sym, size, exitDate: r[exitDate], ret: r[exit] });
      }
    }
    const eq = cash + open.reduce((s, p) => s + p.size, 0);
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
    invested += (eq - cash) / eq; steps++;
    yearEq.set(d.slice(0, 4), eq);
  }
  const eq = cash + open.reduce((s, p) => s + p.size, 0);
  return { total: (eq / capital - 1) * 100, maxDD, n, win: 100 * wins / (n || 1), avg: sumRet / (n || 1), cancelled, exposure: 100 * invested / (steps || 1), yearEq };
}
if (want('portfoy')) {
  console.log('\n══ PORTFOY SIMULASYONU: 100.000 TL, en fazla 3 pozisyon, paper motorunun boyut kurali ══');
  console.log('  nominal TL, yeniden yatirimli; getiriler hayatta-kalan hisselerle ve enflasyon duzeltmesiz — MUTLAK degil KARSILASTIRMA icin');
  const runs = [
    ['canli secim · PAPER cikisi   (bugunku paper)', { select: SELECT.canli, exit: 'planP', exitDate: 'xdP' }],
    ['canli secim · TRAILING', { select: SELECT.canli }],
    ['sakin secim · PAPER cikisi', { select: SELECT.sakin, exit: 'planP', exitDate: 'xdP' }],
    ['sakin secim · TRAILING', { select: SELECT.sakin }],
    ['sakin secim · TRAILING · bosluk kapisi ±%2', { select: SELECT.sakin, gapGuard: { up: 2, down: 2 } }],
    ['sakin+yatay · TRAILING', { select: SELECT['sakin+yatay'] }],
    ['sakin+yatay · TRAILING · bosluk kapisi ±%2', { select: SELECT['sakin+yatay'], gapGuard: { up: 2, down: 2 } }],
  ];
  for (const [sname, f] of SAMPLES) {
    const sr = clean.filter(f);
    console.log(`\n  ${sname}`);
    console.log('  ' + 'kural'.padEnd(46) + 'toplam %'.padStart(10) + 'maks dusus'.padStart(11) + 'islem'.padStart(7) + 'isabet'.padStart(8) + 'ort net'.padStart(9) + 'iptal'.padStart(7) + 'yatirimda'.padStart(10));
    for (const [name, opt] of runs) {
      const r = portfolio(sr, opt);
      console.log('  ' + name.padEnd(46) + f1(r.total, 10) + ('-%' + r.maxDD.toFixed(1)).padStart(11) + String(r.n).padStart(7) + ('%' + r.win.toFixed(1)).padStart(8) + f2(r.avg, 9) + String(r.cancelled).padStart(7) + ('%' + r.exposure.toFixed(0)).padStart(10));
    }
  }
}
