#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// signal-event-study.mjs — OLU SINYALLER GERCEKTE NE SOYLUYOR? (v31.43)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: Rust'a tasirken (v31.42) bir grup kuralin HIC calismadigi
// goruldu: gostergeler nesne donduruyor ({type:'spring',...}), tuketiciler
// metin ('spring') ya da `true` bekliyor; `squeezeRelease` hic uretilmiyor.
// Bunlari "tasarlandigi gibi" acmak skoru degistirir. Once su sorulur:
// bu olaylar BIST'te sonraki getiri hakkinda bir sey soyluyor mu, hangi yonde?
//
// YONTEM (KAP olay calismasiyla ayni disiplin):
//   - 89 hisse x 5 yil onbellekli gunluk bar (.replay-cache/*_5y.json).
//   - Her gun, uretimdeki gibi son 252 barla calcAll (lookahead yok).
//   - Giris: olaydan SONRAKI seansin ACILISI. Cikis: ayni gun kapanis ("yarin",
//     advisor'in yarin-potansiyeli puanlarinin ufku) ve 5 / 10 seans sonra kapanis.
//   - Kiyas: ayni giris gununde TUM hisselerin ayni kuralla getirisi (piyasa-goreli).
//   - Tekrar: ayni hissede ayni olay son 5 seansta gorulduyse sayilmaz
//     (ust uste gunler ayni olayi iki kez sayip t-degerini sisirmesin).
//   - Istikrar: iki yari (tarih medyani) + rejim (XU100: BULL/NEUTRAL/BEAR).
//
// KULLANIM:
//   node scripts/signal-event-study.mjs
//   node scripts/signal-event-study.mjs --out reports/signal-event-study.json
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;

const { calcAll, calcKeltner } = await import(U('utils/indicators.js'));
const { classifyBistRegime } = await import(U('utils/regimeGate.js'));
const { initEngine } = await import(U('engine/engineCore.js'));
await initEngine(); // parity-tested against the JS engine; only faster

const argv = process.argv.slice(2);
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null; })();

const CACHE = path.join(ROOT, '.replay-cache');
const WARMUP = 210;
const LOOKBACK = 252;
const DEDUP = 5;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'))
  .filter((b) => b && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));

const index = load('XU100_5y.json');
const regimeByDate = new Map();
{
  const closes = [];
  for (const b of index) { closes.push(b.close); regimeByDate.set(b.date, classifyBistRegime(closes).regime); }
}

const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('_5y.json') && !f.startsWith('XU100'));
const events = [];
const universe = new Map(); // entry date -> { s5, n5, s10, n10 }

const squeezedAt = (bu, bl, ku, kl, i) =>
  i >= 0 && bu[i] != null && ku[i] != null && bu[i] < ku[i] && bl[i] > kl[i];

const t0 = Date.now();
for (const [fi, f] of files.entries()) {
  const sym = f.replace('_5y.json', '');
  const bars = load(f);
  const lastSeen = new Map();
  for (let t = WARMUP; t + 11 < bars.length; t++) {
    const entry = bars[t + 1].open;
    const r5 = (bars[t + 6].close / entry - 1) * 100;
    const r10 = (bars[t + 11].close / entry - 1) * 100;
    const r1 = (bars[t + 1].close / entry - 1) * 100;   // "yarin": acilistan kapanisa
    const date = bars[t + 1].date;
    const u = universe.get(date) || { s1: 0, s5: 0, n5: 0, s10: 0, n10: 0 };
    u.s1 += r1; u.s5 += r5; u.n5++; u.s10 += r10; u.n10++;
    universe.set(date, u);

    const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
    const ind = calcAll(hist);
    const n = hist.length;
    const types = [];
    const ws = ind.wyckoffSpring?.type;
    if (ws === 'spring' || ws === 'utad') types.push(ws);
    const vc = ind.volumeClimax?.type;
    if (vc) types.push(vc);
    if (ind.diConvergence?.type === 'converging') types.push(ind.plusDI >= ind.minusDI ? 'di_conv_upTrend' : 'di_conv_downTrend');
    if (ind.supertrend?.flip === 'bullish') types.push('st_flip_bull');
    if (ind.supertrend?.flip === 'bearish') types.push('st_flip_bear');
    // Wyckoff phase states (pumpGuard / early-accumulation compare against these)
    const ph = ind.wyckoffPhase;
    if (['accumulation', 'markup', 'distribution', 'markdown'].includes(ph)) types.push(`phase_${ph}`);
    // pumpGuard's continuation claim: after a >= +7% day, does a markup phase continue?
    const chg = (bars[t].close / bars[t - 1].close - 1) * 100;
    if (chg >= 7) types.push(ph === 'markup' ? 'pump7_markup' : ph === 'distribution' ? 'pump7_distribution' : 'pump7_other');

    // TTM release: squeezed on the previous bar, out of the squeeze on this one
    const kel = calcKeltner(hist, 20, 14, 1.5);
    const { upper: bu, lower: bl } = ind.bollinger;
    const was = squeezedAt(bu, bl, kel.upper, kel.lower, n - 2);
    const now = squeezedAt(bu, bl, kel.upper, kel.lower, n - 1);
    if (was && !now) {
      let run = 0;
      for (let i = n - 2; i >= 0 && squeezedAt(bu, bl, kel.upper, kel.lower, i); i--) run++;
      const dir = (ind.ttmSqueeze?.momentum ?? 0) > 0 ? 'up' : 'down';
      types.push(`sqz_release_${dir}`);
      if (run >= 5) types.push(`sqz_fire5_${dir}`);
    }

    for (const type of types) {
      const prev = lastSeen.get(type);
      lastSeen.set(type, t);
      if (prev != null && t - prev <= DEDUP) continue;
      const pre5 = t >= 5 ? (bars[t].close / bars[t - 5].close - 1) * 100 : null;
      events.push({ sym, type, date, r1, r5, r10, pre5,
        regime: regimeByDate.get(date) || regimeByDate.get(bars[t].date) || 'UNKNOWN' });
    }
  }
  process.stdout.write(`\r  ${fi + 1}/${files.length} ${sym.padEnd(6)} ${events.length} olay   `);
}
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(0)} sn\n`);

// excess = own return - same-entry-day universe mean
for (const e of events) {
  const u = universe.get(e.date);
  e.x1 = e.r1 - u.s1 / u.n5;
  e.x5 = e.r5 - u.s5 / u.n5;
  e.x10 = e.r10 - u.s10 / u.n10;
}
const dates = [...universe.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function tstat(a) {
  if (a.length < 3) return NaN;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : NaN;
}
const f2 = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '  -  ');
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');

const ORDER = ['spring', 'utad', 'selling_climax', 'buying_climax', 'volume_exhaustion',
  'di_conv_upTrend', 'di_conv_downTrend', 'sqz_release_up', 'sqz_release_down',
  'sqz_fire5_up', 'sqz_fire5_down', 'st_flip_bull', 'st_flip_bear',
  'phase_accumulation', 'phase_markup', 'phase_distribution', 'phase_markdown',
  'pump7_markup', 'pump7_distribution', 'pump7_other'];

console.log(`OLAY CALISMASI — ${files.length} hisse, ${dates[0]} → ${dates[dates.length - 1]}, giris=ertesi acilis, piyasa-goreli (fazla getiri %)`);
console.log('  ' + 'olay'.padEnd(20) + 'n'.padStart(6) + 'faz1'.padStart(7) + 't1'.padStart(6) + 'once5'.padStart(8) + 'ham5'.padStart(8)
  + 'faz5'.padStart(8) + 't5'.padStart(6) + 'isabet5'.padStart(9) + 'faz10'.padStart(8) + 't10'.padStart(6)
  + '  1.yari10'.padStart(11) + '  2.yari10'.padStart(11) + '  BULL10'.padStart(9) + '  YATAY10'.padStart(10) + '  DUSUS10'.padStart(10));
console.log('  ' + '-'.repeat(143));
const summary = {};
for (const type of ORDER) {
  const ev = events.filter((e) => e.type === type);
  if (!ev.length) continue;
  const x1 = ev.map((e) => e.x1), x5 = ev.map((e) => e.x5), x10 = ev.map((e) => e.x10);
  const h1 = ev.filter((e) => e.date < mid).map((e) => e.x10);
  const h2 = ev.filter((e) => e.date >= mid).map((e) => e.x10);
  const reg = (r) => ev.filter((e) => e.regime === r).map((e) => e.x10);
  const s = {
    n: ev.length, x1: mean(x1), t1: tstat(x1), pre5: mean(ev.map((e) => e.pre5).filter(isNum)), raw5: mean(ev.map((e) => e.r5)),
    x5: mean(x5), t5: tstat(x5), hit5: (100 * x5.filter((v) => v > 0).length) / x5.length,
    x10: mean(x10), t10: tstat(x10), h1: mean(h1), h2: mean(h2), nh1: h1.length, nh2: h2.length,
    bull: mean(reg('BULL')), neutral: mean(reg('NEUTRAL')), bear: mean(reg('BEAR')),
    nBull: reg('BULL').length, nNeutral: reg('NEUTRAL').length, nBear: reg('BEAR').length,
  };
  summary[type] = s;
  console.log('  ' + type.padEnd(20) + String(s.n).padStart(6) + f2(s.x1).padStart(7) + f1(s.t1).padStart(6) + f2(s.pre5).padStart(8) + f2(s.raw5).padStart(8)
    + f2(s.x5).padStart(8) + f1(s.t5).padStart(6) + (`%${s.hit5.toFixed(0)}`).padStart(9)
    + f2(s.x10).padStart(8) + f1(s.t10).padStart(6)
    + `${f2(s.h1)}`.padStart(11) + `${f2(s.h2)}`.padStart(11)
    + `${f2(s.bull)}`.padStart(9) + `${f2(s.neutral)}`.padStart(10) + `${f2(s.bear)}`.padStart(10));
}
console.log('\n  faz = fazla getiri (hisse - ayni gun tum hisseler), %; t = |t|>2 anlamli sayilir; yari/rejim sutunlari faz10.');

if (OUT) {
  const file = path.resolve(ROOT, OUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), symbols: files.length,
    from: dates[0], to: dates[dates.length - 1], summary }, null, 2));
  console.log(`  yazildi: ${OUT}`);
}
