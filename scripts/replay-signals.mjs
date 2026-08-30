#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// replay-signals.mjs — GECMISI YENIDEN OYNAT (v31.29)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: v31.28'de uc degisiklik yapildi (YATAY tabani, plan-uyumlu
// ogrenme, konviksiyon boyutu) ve hepsi "3-4 hafta veri biriksin, sonra
// olceriz" notuyla birakildi. Ileri veri icin beklemek gerekiyor — ama
// GECMIS zaten var. Bu arac uretim sinyal motorunu (genSignal + calcAll,
// mock degil, gercek moduller) tarihsel barlar uzerinde gun gun yeniden
// calistirir ve su sorulari BUGUN cevaplar:
//
//   1. Kademeli cikis plani, ham tutmaya gore daha mi iyi? (v31.28-B'nin
//      dayandigi varsayim — hic olculmemisti)
//   2. YATAY skor tabani gercekte nerede olmali? (70 ARITMETIKLE secildi,
//      olcumle degil)
//   3. Rejim tablosu, bu ayki duzeltmelerden sonra hala ayni mi?
//
// DURUSTLUK KURALLARI (koda islenmis):
//   - Sinyal SADECE bars[0..t] ile uretilir, degerlendirme bars[t+1..] ile.
//     Ayni bari hem karar hem sonuc icin kullanmak (lookahead) en sik
//     backtest yalanidir.
//   - Giris SONRAKI BARIN ACILISI. Sinyali kapanista goruyorsun, o kapanistan
//     alamazsin. Uygulama kayitlarinda entry=kapanis; burada bilerek daha
//     muhafazakar olani kullaniliyor.
//   - Stop/hedef seviyeleri genSignal'in verdigi MUTLAK fiyatlardir; giris
//     kaydiginda onlar kaymaz (yapisal seviyeler).
//   - Maliyet: her islemde %0.3 gidis-donus (tradingCosts.TOTAL_COST_PCT).
//   - Kalibrasyon KAPALI kalir (setSignalCalibration cagrilmaz) — gecmisten
//     ogrenilmis bir carpanin ayni gecmisi puanlamasi dairesel olurdu.
//
// KULLANIM:
//   node scripts/replay-signals.mjs                       # varsayilan 40 sembol, 2y
//   node scripts/replay-signals.mjs --limit 89 --range 2y
//   node scripts/replay-signals.mjs --symbols THYAO,GARAN,SISE
//   node scripts/replay-signals.mjs --out reports/replay.json
//   node scripts/replay-signals.mjs --no-cache            # onbellegi yoksay
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', 'utils', f)).href;

const { calcAll } = await import(U('indicators.js'));
const { genSignal } = await import(U('signals.js'));
const { simulatePlanReturn } = await import(U('planSimulation.js'));
const { classifyBistRegime } = await import(U('regimeGate.js'));

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const RANGE = arg('--range', '2y');
const LIMIT = parseInt(arg('--limit', '89'), 10);
const OUT = arg('--out', null);
const USE_CACHE = !has('--no-cache');
const EXPLICIT = arg('--symbols', null);

const COST_PCT = 0.3;            // tradingCosts.TOTAL_COST_PCT x 100
const WARMUP = 210;              // MA200 + biraz pay — oncesinde gosterge yok
// URETIM PARITESI: useAIAdvisor `fetchSingle(sym, '1y', '1d')` cagiriyor, yani
// genSignal canli taramada ~252 bar goruyor. Replay'in TUM gecmisi vermesi
// uretimle uyumsuzdu (calcSR/calcFibonacci pencereye duyarli) ve gereksiz yavasti.
const LOOKBACK = 252;
const EVAL_TAIL = 8;             // degerlendirme icin en az bu kadar ileri bar
const CACHE_DIR = path.join(ROOT, '.replay-cache');

// ── universe ──────────────────────────────────────────────────────────
// Egitim DB'sindeki gercek BIST isimleri; yoksa likit bir varsayilan liste.
// Egitim DB'sindeki (data/bist_ml_training_3yr.db) 89 gercek BIST ismi.
const FALLBACK = ('ADEL AEFES AFYON AGESA AKBNK AKCNS AKENR AKFGY AKSA ALARK ALGYO ALKIM '
  + 'ANHYT ANSGR ARCLK ASELS AYDEM AYGAZ BASGZ BIENY BIMAS BRISA BRYAT BUCIM CANTE CCOLA '
  + 'CEMTS CIMSA DOAS DOHOL EGEEN EKGYO ENJSA ENKAI EREGL EUPWR FROTO GARAN GENIL GESAN '
  + 'GLYHO GOZDE GSDHO GUBRF HALKB HEKTS INDES ISGYO ISMEN KARSN KCHOL KLSER KONTR KORDS '
  + 'LOGO MAVI MPARK NETAS OBAMS OTKAR OYAKC PETKM PGSUS SAHOL SARKY SELEC SISE SKBNK '
  + 'SNGYO SOKM TATGD TAVHL TCELL THYAO TMSN TOASO TRGYO TSKB TTKOM TTRAK TUPRS TURSG '
  + 'ULKER ULUUN VAKBN VERUS VESTL YATAS YKBNK').split(' ');

function universe() {
  if (EXPLICIT) return EXPLICIT.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return FALLBACK.slice(0, LIMIT);
}

// ── veri cekme (diske onbellekli) ─────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBars(symbol, range) {
  const key = `${symbol}_${range}.json`;
  const file = path.join(CACHE_DIR, key);
  if (USE_CACHE && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* yeniden cek */ }
  }
  const yf = symbol === 'XU100' ? 'XU100.IS' : `${symbol}.IS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yf}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${symbol} -> HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) throw new Error(`${symbol} -> bos yanit`);

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    // Yahoo tatil gunlerinde null satir doner — atla, uydurma.
    if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0)) continue;
    bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
                open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

// ── rejim haritasi: XU100 tarih -> BULL/NEUTRAL/BEAR ──────────────────
function buildRegimeMap(indexBars) {
  const map = new Map();
  const closes = [];
  for (const b of indexBars) {
    closes.push(b.close);
    map.set(b.date, classifyBistRegime(closes).regime);   // sadece o gune kadarki veri
  }
  return map;
}

// ── replay ────────────────────────────────────────────────────────────
function replaySymbol(symbol, bars, regimeMap) {
  const out = [];
  const last = bars.length - EVAL_TAIL;
  for (let t = WARMUP; t < last; t++) {
    // KARAR: sadece t'ye kadar VE en fazla son 252 bar (uretim penceresi).
    const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
    let ind, sig;
    try {
      ind = calcAll(hist);
      sig = genSignal(ind, hist);
    } catch { continue; }
    // Uygulamanin GERCEK aday havuzu genSignal'in kati cls==='buy'undan genis:
    // useAIAdvisor score>=55 olan TUT'lari da AL'a cevirir (v29 reclassify).
    // Ikisini de yakala, raporda ayir.
    if (!sig || sig.cls === 'sell') continue;
    if (sig.cls !== 'buy' && !(sig.score >= 55)) continue;

    const fill = bars[t + 1];                   // GIRIS: sonraki barin acilisi
    if (!fill || !(fill.open > 0)) continue;
    const entry = fill.open;
    const future = bars.slice(t + 1);           // SONUC: sadece t+1'den sonrasi

    const shape = { cls: 'buy', entryPrice: entry, stop: sig.stop, target: sig.t1,
                    t2: sig.t2, t3: sig.t3, timestamp: fill.date };
    const planned = simulatePlanReturn(shape, future);
    if (!planned) continue;

    // CIKIS POLITIKASI VARYANTLARI — ayni giris/stop/hedeflerle farkli kar alma
    // kurallari. Mevcut 40/30/30 bir TASARIM tercihiydi, hic olculmemisti.
    const vTrail = simulatePlanReturn(shape, future, { trailOnly: true });
    const vHalf = simulatePlanReturn(shape, future, { fractions: [0.5, 0, 0] });
    const vT1 = simulatePlanReturn(shape, future, { fractions: [1, 0, 0] });

    // Ham karsilastirma: 5 islem gunu tut, kapanista cik (kalibrasyonun
    // v31.28 oncesi ogrendigi metrigin ta kendisi).
    const d5bar = bars[t + 6];
    const rawD5 = d5bar ? ((d5bar.close - entry) / entry) * 100 : null;

    out.push({
      symbol, date: fill.date,
      score: Math.round(sig.score * 10) / 10,
      signal: sig.signal,
      cls: sig.cls,
      strictBuy: sig.cls === 'buy',
      regime: regimeMap.get(fill.date) || regimeMap.get(bars[t].date) || 'UNKNOWN',
      rr: sig.rr ?? null,
      planReturn: planned.planReturn,
      planExit: planned.exitReason,
      vTrail: vTrail ? vTrail.planReturn : null,
      vTrailBars: vTrail ? vTrail.barsHeld : null,
      vHalf: vHalf ? vHalf.planReturn : null,
      vT1: vT1 ? vT1.planReturn : null,
      barsHeld: planned.barsHeld,
      rawD5: rawD5 == null ? null : Math.round(rawD5 * 100) / 100,
    });
  }
  return out;
}

// ── istatistik ────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r2 = (v) => Math.round(v * 100) / 100;

function summarize(rows, key) {
  const plan = rows.map(r => r.planReturn);
  const raw = rows.map(r => r.rawD5).filter(x => x != null);
  return {
    key, n: rows.length,
    planNet: r2(mean(plan) - COST_PCT),
    planWR: r2((plan.filter(x => x > 0).length / (plan.length || 1)) * 100),
    rawNet: raw.length ? r2(mean(raw) - COST_PCT) : null,
    rawWR: raw.length ? r2((raw.filter(x => x > 0).length / raw.length) * 100) : null,
  };
}

const pct = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}%`);

function table(title, groups) {
  console.log(`
${title}`);
  console.log('  ' + 'grup'.padEnd(24) + 'n'.padStart(6) + 'PLAN net'.padStart(11)
    + 'PLAN WR'.padStart(9) + 'HAM net'.padStart(11) + 'HAM WR'.padStart(9) + 'fark'.padStart(11));
  console.log('  ' + '-'.repeat(81));
  for (const g of groups) {
    if (!g.n) continue;
    const diff = (g.rawNet != null) ? r2(g.planNet - g.rawNet) : null;
    console.log('  ' + String(g.key).padEnd(24)
      + String(g.n).padStart(6)
      + pct(g.planNet).padStart(11)
      + (`%${g.planWR}`).padStart(9)
      + pct(g.rawNet).padStart(11)
      + (g.rawWR == null ? 'n/a' : `%${g.rawWR}`).padStart(9)
      + (diff == null ? 'n/a' : `${diff >= 0 ? '+' : ''}${diff}pp`).padStart(11));
  }
}

// ── main ──────────────────────────────────────────────────────────────
const syms = universe();
console.log(`GECMIS REPLAY — ${syms.length} sembol, ${RANGE}, uretim motoru (genSignal+calcAll)`);
console.log(`Giris: sonraki bar ACILISI · Maliyet: %${COST_PCT} · Kalibrasyon: KAPALI (dairesellik onlemi)\n`);

let indexBars;
try {
  indexBars = await fetchBars('XU100', RANGE);
  console.log(`XU100: ${indexBars.length} bar`);
} catch (e) {
  console.error('XU100 cekilemedi — rejim kirilimi yapilamaz:', e.message);
  process.exit(1);
}
const regimeMap = buildRegimeMap(indexBars);

const all = [];
const failed = [];
for (let i = 0; i < syms.length; i++) {
  const s = syms[i];
  try {
    const bars = await fetchBars(s, RANGE);
    if (bars.length < WARMUP + EVAL_TAIL + 20) { failed.push(`${s} (yetersiz bar: ${bars.length})`); continue; }
    const rows = replaySymbol(s, bars, regimeMap);
    all.push(...rows);
    process.stdout.write(`\r  ${i + 1}/${syms.length} ${s.padEnd(7)} ${bars.length} bar -> ${rows.length} AL sinyali   `);
  } catch (e) {
    failed.push(`${s} (${e.message})`);
  }
  await sleep(120);   // BigPara/Yahoo burst kisitlamasinin altinda kal
}
console.log('\n');

if (!all.length) { console.error('Hic AL sinyali uretilemedi.'); process.exit(1); }
console.log(`TOPLAM: ${all.length} AL sinyali${failed.length ? ` · ${failed.length} sembol atlandi` : ''}`);
if (failed.length) console.log('  atlanan: ' + failed.slice(0, 6).join(', ') + (failed.length > 6 ? ' ...' : ''));

// 1) Genel — plan vs ham
const strict = all.filter(x => x.strictBuy);
console.log(`  kirilim: ${strict.length} kati AL (genSignal cls=buy) + ${all.length - strict.length} advisor adayi (score>=55 TUT)`);

table('1) GENEL — kademeli plan cikisi vs ham 5-gun tutma',
  [summarize(all, 'tum adaylar'), summarize(strict, 'sadece kati AL')]);

// 2) Rejim kirilimi
const REG = ['BULL', 'NEUTRAL', 'BEAR'];
const tier = (s) => s >= 75 ? 'sniper (>=75)' : s >= 65 ? 'flagged (65-74)' : 'early (<65)';
table('2) REJIME GORE',
  REG.map(r => summarize(all.filter(x => x.regime === r), r)));

// 3) Skor kademesi
table('3) KONVIKSIYON KADEMESINE GORE',
  ['sniper (>=75)', 'flagged (65-74)', 'early (<65)']
    .map(k => summarize(all.filter(x => tier(x.score) === k), k)));

// 3b) Kademe x rejim - asil karar yuzeyi
console.log('\n3b) KADEME x REJIM (v31.28 kararlarinin dayandigi yuzey)');
console.log('  ' + 'hucre'.padEnd(26) + 'n'.padStart(6) + 'PLAN net'.padStart(11) + 'WR'.padStart(9));
console.log('  ' + '-'.repeat(52));
for (const r of REG) {
  for (const k of ['sniper (>=75)', 'flagged (65-74)', 'early (<65)']) {
    const sub2 = all.filter(x => x.regime === r && tier(x.score) === k);
    if (!sub2.length) continue;
    const st = summarize(sub2, k);
    console.log('  ' + `${r}/${k}`.padEnd(26) + String(st.n).padStart(6)
      + pct(st.planNet).padStart(11) + (`%${st.planWR}`).padStart(9)
      + (st.n < 30 ? '   (dusuk ornek)' : ''));
  }
}

// 4) YATAY icin skor tabani taramasi — 70 ARITMETIKLE secilmisti
const neutral = all.filter(x => x.regime === 'NEUTRAL');
if (neutral.length) {
  console.log('\n4) YATAY SKOR TABANI TARAMASI (v31.28 tabani=70 aritmetikle secildi)');
  console.log('  ' + 'taban'.padEnd(10) + 'n'.padStart(7) + 'PLAN net'.padStart(11) + 'WR'.padStart(9) + '   toplam katki');
  console.log('  ' + '-'.repeat(52));
  for (const f of [50, 54, 58, 62, 66, 70, 74, 78]) {
    const sub = neutral.filter(x => x.score >= f);
    if (!sub.length) { console.log('  ' + String(f).padEnd(10) + '0'.padStart(7) + '  (aday yok)'); continue; }
    const s = summarize(sub, f);
    console.log('  ' + String(f).padEnd(10) + String(s.n).padStart(7)
      + ((s.planNet >= 0 ? '+' : '') + `${s.planNet}%`).padStart(11)
      + `%${s.planWR}`.padStart(9)
      + `   ${r2(s.planNet * s.n)}`.padStart(14));
  }
  console.log('  ("toplam katki" = net x adet — tabani yukseltmek adedi de dusurur)');
}

// 5) Plan cikis sebebi dagilimi
const byExit = {};
for (const r of all) (byExit[r.planExit] ||= []).push(r.planReturn);
console.log('\n5) PLAN CIKIS SEBEBI');
for (const [k, v] of Object.entries(byExit).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(10)} ${String(v.length).padStart(6)}  ort ${r2(mean(v)) >= 0 ? '+' : ''}${r2(mean(v))}%`);
}


// 5b) CIKIS POLITIKASI KARSILASTIRMASI
// Mevcut 40/30/30 plani bir TASARIM tercihiydi, hic olculmemisti. Ayni
// giris/stop/hedeflerle farkli kar-alma kurallarini yan yana koyar.
{
  const pol = [
    ['mevcut plan 40/30/30', 'planReturn'],
    ['trailing-only (kos)', 'vTrail'],
    ['%50 T1 + trailing', 'vHalf'],
    ['%100 T1 (erken al)', 'vT1'],
    ['ham 5 gun tut (stopsuz)', 'rawD5'],
  ];
  const show = (rows, label) => {
    console.log(`
5b) CIKIS POLITIKASI - ${label}`);
    console.log('  ' + 'politika'.padEnd(26) + 'net'.padStart(9) + 'WR'.padStart(9)
      + 'std'.padStart(8) + 'en kotu %5'.padStart(12) + 'net/risk'.padStart(10));
    console.log('  ' + '-'.repeat(74));
    for (const [name, key] of pol) {
      const v = rows.map(r => r[key]).filter(x => x != null);
      if (!v.length) continue;
      const mu = v.reduce((a, x) => a + x, 0) / v.length;
      const m = mu - COST_PCT;
      const sd = Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / v.length);
      const srt = v.slice().sort((a, b) => a - b);
      const p5 = srt[Math.floor(v.length * 0.05)];
      const wr = (100 * v.filter(x => x > 0).length / v.length);
      console.log('  ' + name.padEnd(26) + pct(r2(m)).padStart(9) + `%${r2(wr)}`.padStart(9)
        + r2(sd).toString().padStart(8) + pct(r2(p5)).padStart(12)
        + (sd ? (m / sd).toFixed(3) : '-').padStart(10));
    }
  };
  show(all, `tum adaylar (n=${all.length})`);
  const bullRows = all.filter(x => x.regime === 'BULL');
  show(bullRows, `YALNIZ YUKSELIS (n=${bullRows.length})`);
}

// ── 6) WALK-FORWARD: secilen taban GELECEGE genelleniyor mu? ──────────
// Onceki kosuda YATAY tabani "iki donemde de pozitif kalan tek deger" diye
// 70'te birakilmisti — ama o, TUM veriye bakip secilen bir esikti. Gercek
// soru: gecmise bakarak taban secmek, GORULMEMIS doneme aktarilabiliyor mu?
// Her pencerede taban SADECE in-sample'dan secilir, sonra out-of-sample'da
// koru koruna uygulanir. Sabit tabanlarla yan yana raporlanir.
const IS_MONTHS = parseInt(arg('--is-months', '9'), 10);
const OOS_MONTHS = parseInt(arg('--oos-months', '3'), 10);
const MIN_IS = parseInt(arg('--min-is', '40'), 10);   // altinda taban secme
const FLOORS = [50, 54, 58, 62, 66, 70, 74];

const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const dstr = (d) => d.toISOString().slice(0, 10);

function netOf(rows) {
  if (!rows.length) return null;
  return rows.reduce((a, r) => a + r.planReturn, 0) / rows.length - COST_PCT;
}

const sorted = all.slice().sort((a, b) => a.date < b.date ? -1 : 1);
const t0 = new Date(sorted[0].date), tEnd = new Date(sorted[sorted.length - 1].date);
const windows = [];
for (let st = t0; addMonths(st, IS_MONTHS + OOS_MONTHS) <= tEnd; st = addMonths(st, OOS_MONTHS)) {
  const isEnd = addMonths(st, IS_MONTHS), oosEnd = addMonths(isEnd, OOS_MONTHS);
  windows.push({ isStart: dstr(st), isEnd: dstr(isEnd), oosEnd: dstr(oosEnd) });
}

console.log(`
6) WALK-FORWARD — YATAY tabani (${IS_MONTHS}ay IS / ${OOS_MONTHS}ay OOS, ${windows.length} pencere)`);
if (!windows.length) {
  console.log('  Yeterli tarih araligi yok — daha uzun --range gerekiyor.');
} else {
  console.log('  ' + 'OOS donemi'.padEnd(24) + 'IS secimi'.padStart(10) + 'IS net'.padStart(10)
    + 'OOS n'.padStart(8) + 'OOS net'.padStart(10) + '   sabit70   sabit54');
  console.log('  ' + '-'.repeat(80));
  const picked = [], fixed70 = [], fixed54 = [], chosenFloors = [];
  for (const w of windows) {
    const inIS = sorted.filter(r => r.regime === 'NEUTRAL' && r.date >= w.isStart && r.date < w.isEnd);
    const inOOS = sorted.filter(r => r.regime === 'NEUTRAL' && r.date >= w.isEnd && r.date < w.oosEnd);
    if (!inOOS.length) continue;

    // IS'te en iyi tabani sec (yeterli ornek sarti ile) — OOS'a HIC bakmadan.
    let best = null;
    for (const f of FLOORS) {
      const sub = inIS.filter(r => r.score >= f);
      if (sub.length < MIN_IS) continue;
      const n = netOf(sub);
      if (n != null && (best == null || n > best.net)) best = { floor: f, net: n, n: sub.length };
    }
    const oosPick = best ? netOf(inOOS.filter(r => r.score >= best.floor)) : null;
    const o70 = netOf(inOOS.filter(r => r.score >= 70));
    const o54 = netOf(inOOS.filter(r => r.score >= 54));
    if (oosPick != null) { picked.push(oosPick); chosenFloors.push(best.floor); }
    if (o70 != null) fixed70.push(o70);
    if (o54 != null) fixed54.push(o54);

    console.log('  ' + `${w.isEnd} -> ${w.oosEnd}`.padEnd(24)
      + (best ? String(best.floor) : 'yok').padStart(10)
      + (best ? pct(r2(best.net)) : '-').padStart(10)
      + String(inOOS.length).padStart(8)
      + (oosPick == null ? '-' : pct(r2(oosPick))).padStart(10)
      + (o70 == null ? '     -' : pct(r2(o70)).padStart(10))
      + (o54 == null ? '     -' : pct(r2(o54)).padStart(10)));
  }
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return r2(b[Math.floor(b.length / 2)]); };
  const posPct = (a) => a.length ? Math.round(100 * a.filter(x => x > 0).length / a.length) : 0;
  console.log('  ' + '-'.repeat(80));
  console.log(`  IS-secimi   : medyan OOS ${pct(med(picked))} · pozitif pencere %${posPct(picked)} (${picked.length})`);
  console.log(`  sabit 70    : medyan OOS ${pct(med(fixed70))} · pozitif pencere %${posPct(fixed70)} (${fixed70.length})`);
  console.log(`  sabit 54    : medyan OOS ${pct(med(fixed54))} · pozitif pencere %${posPct(fixed54)} (${fixed54.length})`);
  if (chosenFloors.length) {
    const tally = {};
    for (const f of chosenFloors) tally[f] = (tally[f] || 0) + 1;
    console.log("  IS secimi hangi tabanlari sectiy: " + Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([f, c]) => `${f}x${c}`).join(' '));
  }
  console.log("  (IS-secimi sabit 70i GECEMIYORSA, tabani veriden secmek asiri-uyum demektir)");
}

if (OUT) {
  const file = path.resolve(ROOT, OUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    meta: { generatedAt: new Date().toISOString(), range: RANGE, symbols: syms.length,
            costPct: COST_PCT, entry: 'next_bar_open', calibration: 'disabled' },
    signals: all,
  }, null, 1));
  console.log(`\nJSON yazildi: ${OUT} (${all.length} kayit)`);
}
console.log('\nNOT: bu bir GECMIS olcumudur — gelecegi garanti etmez. Ornek sayisi dusuk');
console.log('     hucrelerde (n<50) sonuc yonlendirici, kanit degildir.');
