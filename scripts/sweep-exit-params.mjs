#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// sweep-exit-params.mjs — TRAILING PARAMETRE TARAMASI (v31.31)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: v31.30 kademeli kar almayi kaldirdi → cikis artik TAMAMEN
// trailing stop. Bu, uc sayiyi stratejinin KENDISI haline getirdi:
//   BREAKEVEN_PCT = 3 · TRAIL_ACTIVE_PCT = 5 · LOCK_FRACTION = 0.5
// Ucu de useLivePrices'tan miras alinmis varsayimlardi, hic olculmedi.
// Dorduncu eksen: baslangic stop genisligi (genSignal'in yapisal stop'unun
// katsayisi) — `signals.js` maxRisk clamp'i de hic dogrulanmamisti.
//
// ASIRI-UYUM UYARISI (bu yuzden walk-forward ZORUNLU):
// 144 kombinasyonu tek veri setinde taramak, sansla iyi gorunen bir kombinasyon
// bulmanin en kestirme yoludur. Bu script bu yuzden IKI bolum halinde raporlar:
//   1. Tum-veri siralamasi  -> SADECE fikir verir, karar VERDIRMEZ
//   2. Walk-forward         -> parametre yalniz in-sample'dan secilir, sonra
//                              gorulmemis out-of-sample'da olculur ve MEVCUT
//                              varsayilanla yan yana konur. Karar buradan cikar.
// IS-secimi mevcut varsayilani OOS'ta GECEMIYORSA degisiklik YAPILMAZ.
//
// KULLANIM:
//   node scripts/sweep-exit-params.mjs                  # 89 sembol, 5y (onbellekten)
//   node scripts/sweep-exit-params.mjs --regime BULL    # yalniz YUKSELIS
//   node scripts/sweep-exit-params.mjs --limit 40 --range 2y
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
const { PLAN_CONST } = await import(U('tradePlan.js'));

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const RANGE = arg('--range', '5y');
const LIMIT = parseInt(arg('--limit', '89'), 10);
const REGIME = arg('--regime', null);          // null = tum rejimler
const IS_MONTHS = parseInt(arg('--is-months', '12'), 10);
const OOS_MONTHS = parseInt(arg('--oos-months', '3'), 10);
const OUT = arg('--out', null);
// Tek-eksen modu: digerleri VARSAYILANDA sabit tutulup tek parametre ince
// taranir. Cok-eksenli gridde bir parametrenin GRID SINIRINDA secilmesi
// "optimum daha ileride olabilir" demektir — bunu ancak ince tarama gosterir.
const AXIS = arg('--axis', null);

const COST_PCT = 0.3;
// GERCEK BOYUTLANDIRMA KURALI (PaperTradeEngine v31.31 / calcPosition ile ayni):
// pozisyon = min(risk_butcesi / stop_mesafesi, sermaye_tavani).
// Ne ham yuzde getiri ne de R-katsayisi tek basina dogru: ilki farkli bahis
// boyutlarini karsilastirir, ikincisi tavani yok sayar (stop daraldikca R sonsuza
// gider ama tavan yuzunden pozisyon BUYUMEZ — yalniz stop-out artar).
// Portfoy getirisi = getiri% x pozisyon_orani. Karar bu sutundan verilir.
const RISK_PER_TRADE = 0.02;
const MAX_POS_FRACTION = 0.33;
const WARMUP = 210;
const LOOKBACK = 252;      // uretim paritesi (fetchSingle '1y')
const EVAL_TAIL = 8;
const MAX_FUTURE = 30;     // MAX_PLAN_BARS ile ayni
const CACHE_DIR = path.join(ROOT, '.replay-cache');

// ── GRID ──────────────────────────────────────────────────────────────
// Mevcut varsayilan: breakeven 3 / active 5 / lock 0.5 / stopScale 1.0
const GRID = {
  breakevenPct: [0, 2, 3, 5],          // 0 = basabas kademesi KAPALI
  trailActivePct: [3, 5, 8, 12],
  lockFraction: [0.3, 0.5, 0.7],
  stopScale: [0.75, 1.0, 1.35],        // genSignal stop mesafesinin katsayisi
};
const DEFAULT_COMBO = {
  breakevenPct: PLAN_CONST.BREAKEVEN_PCT,
  trailActivePct: PLAN_CONST.TRAIL_ACTIVE_PCT,
  lockFraction: PLAN_CONST.LOCK_FRACTION,
  stopScale: 1.0,
};
const comboKey = (c) => `be${c.breakevenPct}/act${c.trailActivePct}/lock${c.lockFraction}/stop${c.stopScale}`;
const isDefault = (c) => comboKey(c) === comboKey(DEFAULT_COMBO);

const FINE = {
  stopScale: [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5],
  breakevenPct: [0, 1, 2, 3, 4, 5, 7],
  trailActivePct: [2, 3, 4, 5, 7, 9, 12, 16],
  lockFraction: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85],
};

function buildGrid() {
  if (AXIS) {
    const vals = FINE[AXIS];
    if (!vals) { console.error(`--axis gecersiz: ${AXIS}. Secenekler: ${Object.keys(FINE).join(', ')}`); process.exit(1); }
    return vals.map(v => ({ ...DEFAULT_COMBO, [AXIS]: v }));
  }
  const out = [];
  for (const breakevenPct of GRID.breakevenPct)
    for (const trailActivePct of GRID.trailActivePct)
      for (const lockFraction of GRID.lockFraction)
        for (const stopScale of GRID.stopScale) {
          // Basabas esigi aktif-trailing esiginden BUYUK olamaz (mantiksiz).
          if (breakevenPct > 0 && breakevenPct >= trailActivePct) continue;
          out.push({ breakevenPct, trailActivePct, lockFraction, stopScale });
        }
  return out;
}

// ── veri ──────────────────────────────────────────────────────────────
const FALLBACK = ('ADEL AEFES AFYON AGESA AKBNK AKCNS AKENR AKFGY AKSA ALARK ALGYO ALKIM '
  + 'ANHYT ANSGR ARCLK ASELS AYDEM AYGAZ BASGZ BIENY BIMAS BRISA BRYAT BUCIM CANTE CCOLA '
  + 'CEMTS CIMSA DOAS DOHOL EGEEN EKGYO ENJSA ENKAI EREGL EUPWR FROTO GARAN GENIL GESAN '
  + 'GLYHO GOZDE GSDHO GUBRF HALKB HEKTS INDES ISGYO ISMEN KARSN KCHOL KLSER KONTR KORDS '
  + 'LOGO MAVI MPARK NETAS OBAMS OTKAR OYAKC PETKM PGSUS SAHOL SARKY SELEC SISE SKBNK '
  + 'SNGYO SOKM TATGD TAVHL TCELL THYAO TMSN TOASO TRGYO TSKB TTKOM TTRAK TUPRS TURSG '
  + 'ULKER ULUUN VAKBN VERUS VESTL YATAS YKBNK').split(' ');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBars(symbol, range) {
  const file = path.join(CACHE_DIR, `${symbol}_${range}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* yeniden cek */ }
  }
  const yf = symbol === 'XU100' ? 'XU100.IS' : `${symbol}.IS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yf}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${symbol} -> HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) throw new Error(`${symbol} -> bos yanit`);
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0)) continue;
    bars.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c });
  }
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

// ── 1) sinyalleri + gelecek barlari BIR KEZ topla ─────────────────────
// Tarama sirasinda genSignal'i yeniden calistirmak gerekmiyor: sinyal ve
// stop/hedef seviyeleri parametrelerden BAGIMSIZ. Yalniz cikis simulasyonu
// tekrarlanir → 144 kombinasyon ucuz.
function collectSignals(symbol, bars, regimeMap) {
  const out = [];
  const last = bars.length - EVAL_TAIL;
  for (let t = WARMUP; t < last; t++) {
    const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
    let sig;
    try { sig = genSignal(calcAll(hist), hist); } catch { continue; }
    if (!sig || sig.cls === 'sell') continue;
    if (sig.cls !== 'buy' && !(sig.score >= 55)) continue;
    const fill = bars[t + 1];
    if (!fill || !(fill.open > 0)) continue;
    if (!Number.isFinite(sig.stop) || sig.stop <= 0 || sig.stop >= fill.open) continue;
    out.push({
      symbol, date: fill.date, score: sig.score,
      regime: regimeMap.get(fill.date) || 'UNKNOWN',
      entry: fill.open, stop: sig.stop, t1: sig.t1, t2: sig.t2, t3: sig.t3,
      future: bars.slice(t + 1, t + 1 + MAX_FUTURE),
    });
  }
  return out;
}

// ── 2) bir kombinasyonu bir sinyal kumesinde degerlendir ──────────────
function evaluate(rows, combo) {
  let sum = 0, wins = 0, n = 0, riskSum = 0, portSum = 0, posSum = 0;
  const vals = [];
  for (const r of rows) {
    // stopScale: girisle yapisal stop arasindaki MESAFEYI olcekler.
    const scaledStop = r.entry - (r.entry - r.stop) * combo.stopScale;
    if (!(scaledStop > 0) || scaledStop >= r.entry) continue;
    const riskPct = ((r.entry - scaledStop) / r.entry) * 100;   // baslangic riski %
    const res = simulatePlanReturn(
      { cls: 'buy', entryPrice: r.entry, stop: scaledStop, target: r.t1, t2: r.t2, t3: r.t3, timestamp: r.date },
      r.future,
      { breakevenPct: combo.breakevenPct, trailActivePct: combo.trailActivePct, lockFraction: combo.lockFraction });
    if (!res) continue;
    n += 1; sum += res.planReturn; vals.push(res.planReturn);
    riskSum += riskPct;
    // Gercek kural: risk butcesi / stop mesafesi, sermaye tavaniyla kirpilmis.
    const posFrac = Math.min(RISK_PER_TRADE / (riskPct / 100), MAX_POS_FRACTION);
    portSum += (res.planReturn - COST_PCT) / 100 * posFrac;
    posSum += posFrac;
    if (res.planReturn > 0) wins += 1;
  }
  if (!n) return null;
  const mean = sum / n;
  const sd = Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  const avgRisk = riskSum / n;
  // R-KATSAYISI = TOPLAM net getiri / TOPLAM alinan risk.
  // Oran-ORTALAMASI degil: kucuk paydali tek islemler onu patlatir (ilk yazimda
  // bu hataya dustum, sutun tumden negatif cikti). Dogru toplulastirma budur.
  //
  // NEDEN gerekli: `calcPosition` pozisyonu RISKE gore boyutlar
  // (maxRiskTL / riskPerShare) → 2x genis stop = 2x KUCUK pozisyon. Ham yuzde
  // getiriyi karsilastirmak farkli bahis boyutlarini karsilastirmak olur.
  return { n, net: mean - COST_PCT, wr: (wins / n) * 100, sd,
           avgRisk, rMult: avgRisk > 0 ? (mean - COST_PCT) / avgRisk : 0,
           // KARAR SUTUNU: islem basina PORTFOY getirisi (%), gercek boyutlandirma ile.
           portRet: (portSum / n) * 100, avgPos: (posSum / n) * 100 };
}

const r2 = (v) => Math.round(v * 100) / 100;
const pct = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${r2(v)}%`);

// ── main ──────────────────────────────────────────────────────────────
const syms = FALLBACK.slice(0, LIMIT);
const grid = buildGrid();
console.log(`TRAILING PARAMETRE TARAMASI — ${syms.length} sembol, ${RANGE}, ${grid.length} kombinasyon`);
console.log(`Mevcut varsayilan: ${comboKey(DEFAULT_COMBO)}${REGIME ? ` · rejim filtresi: ${REGIME}` : ''}\n`);

const indexBars = await fetchBars('XU100', RANGE);
const regimeMap = new Map();
{
  const closes = [];
  for (const b of indexBars) { closes.push(b.close); regimeMap.set(b.date, classifyBistRegime(closes).regime); }
}

let all = [];
for (let i = 0; i < syms.length; i++) {
  try {
    const bars = await fetchBars(syms[i], RANGE);
    if (bars.length < WARMUP + EVAL_TAIL + 20) continue;
    all.push(...collectSignals(syms[i], bars, regimeMap));
    process.stdout.write(`\r  toplaniyor ${i + 1}/${syms.length} — ${all.length} sinyal   `);
  } catch { /* atla */ }
  await sleep(30);
}
console.log('\n');
if (REGIME) all = all.filter(r => r.regime === REGIME);
if (!all.length) { console.error('Sinyal yok.'); process.exit(1); }
all.sort((a, b) => (a.date < b.date ? -1 : 1));
console.log(`TOPLAM ${all.length} sinyal · ${all[0].date} → ${all[all.length - 1].date}\n`);

// ── BOLUM 1: tum-veri siralamasi (SADECE fikir) ───────────────────────
const scored = grid.map(c => ({ combo: c, ...(evaluate(all, c) || { n: 0, net: -99, wr: 0, sd: 0 }) }))
  .filter(x => x.n > 0)
  .sort((a, b) => b.portRet - a.portRet);
const baseAll = scored.find(x => isDefault(x.combo));

console.log('1) TUM-VERI SIRALAMASI — asiri-uyuma acik, KARAR VERDIRMEZ');
console.log('  ' + '#'.padEnd(4) + 'kombinasyon'.padEnd(30) + 'n'.padStart(7) + 'PORTFOY'.padStart(10) + 'ham net'.padStart(9) + 'WR'.padStart(8));
console.log('  ' + '-'.repeat(67));
for (const [i, x] of scored.slice(0, 8).entries()) {
  console.log('  ' + `${i + 1}.`.padEnd(4) + comboKey(x.combo).padEnd(30) + String(x.n).padStart(7)
    + pct(x.portRet).padStart(10) + pct(x.net).padStart(9) + `%${r2(x.wr)}`.padStart(8));
}
if (baseAll) {
  const rank = scored.findIndex(x => isDefault(x.combo)) + 1;
  console.log('  ' + '-'.repeat(67));
  console.log('  ' + `${rank}.`.padEnd(4) + (comboKey(DEFAULT_COMBO) + '  <- MEVCUT').padEnd(30)
    + String(baseAll.n).padStart(7) + pct(baseAll.portRet).padStart(10)
    + pct(baseAll.net).padStart(9) + `%${r2(baseAll.wr)}`.padStart(8));
}

// ── BOLUM 1b: tek-eksen modunda YIL YIL kirilim ───────────────────────
// Bir parametre gercekten iyiyse her yil kazanmali; tek bir yila borcluysa
// bu tabloda hemen gorunur.
if (AXIS) {
  const years = [...new Set(all.map(r => r.date.slice(0, 4)))].sort();
  const usable = years.filter(y => all.filter(r => r.date.slice(0, 4) === y).length >= 300);
  console.log(`
1b) YIL YIL — eksen: ${AXIS} · yil hucreleri = PORTFOY getirisi/islem`);
  console.log('  ' + AXIS.padEnd(10) + usable.map(y => y.padStart(8)).join('')
    + 'ham net'.padStart(9) + 'risk%'.padStart(8) + 'poz%'.padStart(7)
    + 'PORTFOY'.padStart(10));
  console.log('  ' + '-'.repeat(10 + usable.length * 8 + 34));
  for (const c of grid) {
    const cells = usable.map(y => {
      const e2 = evaluate(all.filter(r => r.date.slice(0, 4) === y), c);
      return (e2 ? pct(e2.portRet) : 'n/a').padStart(8);
    });
    const tot = evaluate(all, c);
    const mark = isDefault(c) ? '  <- MEVCUT' : '';
    console.log('  ' + String(c[AXIS]).padEnd(10) + cells.join('')
      + (tot ? pct(tot.net) : 'n/a').padStart(9)
      + (tot ? r2(tot.avgRisk).toString() : 'n/a').padStart(8)
      + (tot ? r2(tot.avgPos).toString() : 'n/a').padStart(7)
      + (tot ? pct(tot.portRet) : 'n/a').padStart(10) + mark);
  }
}

// ── BOLUM 2: WALK-FORWARD (karar burada) ──────────────────────────────
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const dstr = (d) => d.toISOString().slice(0, 10);
const t0 = new Date(all[0].date), tEnd = new Date(all[all.length - 1].date);
const windows = [];
for (let st = t0; addMonths(st, IS_MONTHS + OOS_MONTHS) <= tEnd; st = addMonths(st, OOS_MONTHS)) {
  const isEnd = addMonths(st, IS_MONTHS);
  windows.push({ isStart: dstr(st), isEnd: dstr(isEnd), oosEnd: dstr(addMonths(isEnd, OOS_MONTHS)) });
}

console.log(`\n2) WALK-FORWARD — ${IS_MONTHS}ay IS / ${OOS_MONTHS}ay OOS, ${windows.length} pencere`);
console.log('   Parametre yalniz IS\'ten secilir, OOS\'ta koru koruna uygulanir.\n');
console.log('  ' + 'OOS donemi'.padEnd(26) + 'IS secimi'.padEnd(28) + 'OOS n'.padStart(7)
  + 'secim OOS'.padStart(11) + 'mevcut OOS'.padStart(12));
console.log('  ' + '-'.repeat(84));

const pickedNets = [], baseNets = [];
for (const w of windows) {
  const inIS = all.filter(r => r.date >= w.isStart && r.date < w.isEnd);
  const inOOS = all.filter(r => r.date >= w.isEnd && r.date < w.oosEnd);
  if (inIS.length < 100 || inOOS.length < 30) continue;

  let best = null;
  for (const c of grid) {
    const e = evaluate(inIS, c);
    if (e && e.n >= 100 && (best == null || e.portRet > best.portRet)) best = { combo: c, ...e };
  }
  const oosPick = best ? evaluate(inOOS, best.combo) : null;
  const oosBase = evaluate(inOOS, DEFAULT_COMBO);
  if (oosPick) pickedNets.push(oosPick.portRet);
  if (oosBase) baseNets.push(oosBase.portRet);

  console.log('  ' + `${w.isEnd} -> ${w.oosEnd}`.padEnd(26)
    + (best ? comboKey(best.combo) : 'yok').padEnd(28)
    + String(inOOS.length).padStart(7)
    + (oosPick ? pct(oosPick.portRet) : 'n/a').padStart(11)
    + (oosBase ? pct(oosBase.portRet) : 'n/a').padStart(12));
}

const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const posPct = (a) => (a.length ? Math.round(100 * a.filter(x => x > 0).length / a.length) : 0);
console.log('  ' + '-'.repeat(84));
console.log(`  IS-secimi : medyan OOS ${pct(med(pickedNets))} · pozitif pencere %${posPct(pickedNets)} (${pickedNets.length})`);
console.log(`  MEVCUT    : medyan OOS ${pct(med(baseNets))} · pozitif pencere %${posPct(baseNets)} (${baseNets.length})`);

const delta = (med(pickedNets) ?? 0) - (med(baseNets) ?? 0);
console.log('');
if (pickedNets.length < 4) {
  console.log('  KARAR: pencere sayisi yetersiz — DEGISIKLIK YAPMA.');
} else if (delta > 0.15) {
  console.log(`  KARAR: IS-secimi mevcudu OOS'ta ${pct(delta)} geciyor — degisiklik DUSUNULEBILIR.`);
  console.log('         Once hangi parametrenin tutarli secildigine bak (asagida).');
} else {
  console.log(`  KARAR: IS-secimi mevcudu OOS'ta GECEMIYOR (fark ${pct(delta)}) —`);
  console.log('         parametreyi veriden secmek asiri-uyum. MEVCUT DEGERLER KALSIN.');
}

// Hangi parametre degerleri IS tarafindan tutarli seciliyor? (istikrar sinyali)
{
  const tally = { breakevenPct: {}, trailActivePct: {}, lockFraction: {}, stopScale: {} };
  for (const w of windows) {
    const inIS = all.filter(r => r.date >= w.isStart && r.date < w.isEnd);
    if (inIS.length < 100) continue;
    let best = null;
    for (const c of grid) {
      const e = evaluate(inIS, c);
      if (e && e.n >= 100 && (best == null || e.portRet > best.portRet)) best = { combo: c, ...e };
    }
    if (!best) continue;
    for (const k of Object.keys(tally)) {
      const v = best.combo[k];
      tally[k][v] = (tally[k][v] || 0) + 1;
    }
  }
  console.log('\n3) IS HANGI DEGERLERI SECIYOR (istikrar gostergesi)');
  for (const [k, counts] of Object.entries(tally)) {
    const items = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!items.length) continue;
    const total = items.reduce((a, [, c]) => a + c, 0);
    const top = items[0];
    const stable = top[1] / total >= 0.6 ? ' ISTIKRARLI' : ' dagilmis';
    console.log(`  ${k.padEnd(16)} ${items.map(([v, c]) => `${v}x${c}`).join(' ').padEnd(34)}`
      + `mevcut=${DEFAULT_COMBO[k]}${stable}`);
  }
}

if (OUT) {
  const file = path.resolve(ROOT, OUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    meta: { generatedAt: new Date().toISOString(), range: RANGE, symbols: syms.length,
            signals: all.length, regime: REGIME, grid: GRID, default: DEFAULT_COMBO },
    ranking: scored.slice(0, 30).map(x => ({ combo: x.combo, n: x.n, net: r2(x.net), wr: r2(x.wr) })),
    walkForward: { windows: windows.length, pickedMedian: med(pickedNets), baseMedian: med(baseNets) },
  }, null, 1));
  console.log(`\nJSON: ${OUT}`);
}
console.log('\nNOT: gecmis olcumudur, gelecegi garanti etmez. Bolum 1 asiri-uyuma aciktir;');
console.log('     baglayici olan Bolum 2 (walk-forward) sonucudur.');
