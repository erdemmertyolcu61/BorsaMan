#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// scan-window-review.mjs — BİR DÖNEMİN TARAMALARINI YENİDEN KUR VE ÖLÇ (v31.57)
// ════════════════════════════════════════════════════════════════════
//
// Telefonun kayıtları (sinyal takibi, karne) telefonda durur; sunucu tarafı takip
// (Upstash) kurulu olmadığı için başka kopyası yok. Bu betik dönemin her işlem günü
// için AKŞAM taramasını (18:15, o günün kapanışı) aynı kodla yeniden kurar:
//   - rejim (regimeGate.classifyBistRegime, XU100 o güne kadar)
//   - AL adayları: canlı seçim zincirinin kopyası (live-ranker-replica.mjs) → red sebebi,
//     yarın-potansiyeli, güven; gösterilen liste (ilk 8) ve paper'ın açacağı ilk 3
//   - gün içi hareket listesi: nextSession.rankMovers (uygulamadaki fonksiyon)
// ve sonuçları gerçek barlarla ölçer (giriş ertesi açılış, %0,3 maliyet).
// Telefondaki liste kendi taramasının kapsamına göre farklı olabilir — bu "sistemin o gün
// göreceği" listedir, telefonun kaydı değil.
//
// KULLANIM:
//   node scripts/scan-window-review.mjs --from 2026-11-09 --to 2026-11-20
// Veri: .replay-cache/<SEMBOL>_5y.json (feature-edge-study.mjs --fetch 1 --refresh)
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const CACHE = path.join(ROOT, '.replay-cache');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FROM = arg('--from', '2026-11-09');
const TO = arg('--to', '2026-11-20');
const OUT = arg('--out', null);
const LOOKBACK = 252;
const COST = 0.3;
const isNum = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f2 = (x, d = 2) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '  -');
const pct = (a, b) => (a / b - 1) * 100;

function loadBars(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8'))
      .filter((b) => b && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));
  } catch { return []; }
}

async function main() {
  const { calcAll } = await import(U('utils/indicators.js'));
  const { genSignal } = await import(U('utils/signals.js'));
  const { classifyBistRegime } = await import(U('utils/regimeGate.js'));
  const { initEngine } = await import(U('engine/engineCore.js'));
  const NS = await import(U('utils/nextSession.js'));
  const { makeLiveReplica } = await import(pathToFileURL(path.join(HERE, 'live-ranker-replica.mjs')).href);
  const { simTrail } = await import(pathToFileURL(path.join(HERE, 'feature-edge-study.mjs')).href);
  await initEngine();
  const live = await makeLiveReplica();

  const xu = loadBars('XU100_5y.json');
  const xuC = xu.map((b) => b.close);
  const xuPos = new Map(xu.map((b, i) => [b.date, i]));
  const days = xu.map((b) => b.date).filter((d) => d >= FROM && d <= TO);
  if (!days.length) throw new Error(`XU100 barlarinda ${FROM}..${TO} yok — once feature-edge-study --fetch 1 --refresh`);
  const lastDate = xu[xu.length - 1].date;

  const files = fs.readdirSync(CACHE).filter((f) => /^[A-Z0-9]+_5y\.json$/.test(f) && !f.startsWith('XU100'));
  const perDay = new Map(days.map((d) => [d, { cands: [], movers: [], uni: [] }]));
  let nSym = 0;
  for (const f of files) {
    const sym = f.replace('_5y.json', '');
    const bars = loadBars(f);
    if (bars.length < 260) continue;
    const pos = new Map(bars.map((b, i) => [b.date, i]));
    nSym++;
    for (const d of days) {
      const t = pos.get(d);
      if (t == null || t < 210) continue;
      const nb = bars[t + 1] || null;
      const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
      const rec = perDay.get(d);
      // Evren tabanı: likit hisselerin ertesi gün kapanış→kapanış değişimi
      let tl = 0; for (let k = Math.max(0, t - 19); k <= t; k++) tl += bars[k].close * bars[k].volume; tl /= 20;
      const liquid = tl >= 2e6;
      if (nb && liquid) rec.uni.push({ cc1: pct(nb.close, bars[t].close), oc1: pct(nb.close, nb.open) });
      // Ertesi seans tahmini (uygulamadaki fonksiyon)
      const xi = xuPos.get(d);
      const fc = NS.forecastNextSession(hist, xi != null ? xuC.slice(Math.max(0, xi - 80), xi + 1) : null);
      if (fc && liquid && !fc.artifact) rec.movers.push({ symbol: sym, _ns: { ...fc, turnoverLog: Math.log10(tl) }, t, bars });
      // AL adayı
      let ind, sig, htf;
      try { ind = calcAll(hist); htf = live._deriveHTFContext(hist, ind); sig = genSignal(ind, hist, { htfContext: htf, sectorStrength: 0 }); } catch { continue; }
      if (!sig || sig.cls === 'sell' || (sig.cls !== 'buy' && !(sig.score >= 45))) continue;
      const L = live.buildResult(sym, ind, sig, hist, xi != null ? xuC.slice(Math.max(0, xi - 90), xi + 1) : [], htf);
      const early = live.detectEarly(L);
      const near = live.detectNear(L);
      const rej = live.rejectReason(L, early);
      const tp = live.calcTomorrowPotential(L);
      const cf = live.confidenceOf(L, tp);
      const { stop: stopL } = live.liveStopTarget(L);
      const r = { sym, sector: L.sector, sc: L.score, cls: sig.cls, rej, tp, confA: cf.conf, early: early.isEarly ? 1 : 0, near: near.isNear ? 1 : 0, close: bars[t].close, stopL, chg1: pct(bars[t].close, bars[t - 1].close) };
      if (nb) {
        const entry = nb.open;
        const tr = simTrail(entry, stopL, bars, t + 1, { gapAware: true });
        r.entry = entry; r.gap = pct(entry, bars[t].close);
        r.cc1 = pct(nb.close, bars[t].close); r.oc1 = pct(nb.close, entry);
        r.toDate = pct(bars[bars.length - 1].close, entry);
        r.plan = tr ? tr.ret : null; r.planExit = tr ? tr.exit : null; r.planHeld = tr ? tr.held : null;
        r.planOpen = tr ? (tr.exit === 'timeout' && t + 1 + tr.held >= bars.length - 1) : null;
        r.locked1 = nb.high === nb.low ? 1 : 0;
      }
      rec.cands.push(r);
    }
  }

  // ── seçim (canlı zincirin kopyası, feature-edge-report ile aynı kurallar) ──
  const bonus = (r) => (r.near ? 20 : 0) + (r.early ? 14 : 0);
  const finalKey = (r) => r.confA + (r.near ? 15 : r.early ? 10 : 0) + (r.sc >= 75 ? 20 : r.sc >= 65 ? -8 : 0);
  const isBuyLabel = (r) => r.cls === 'buy' || !!r.early || r.sc >= 55;
  const sectorLimit = (sorted, max = 8) => {
    const seen = new Map(); const lim = [];
    for (const p of sorted) { const c = seen.get(p.sector) || 0; if (c < (p.sector === 'Diger' ? 3 : 1)) { lim.push(p); seen.set(p.sector, c + 1); } if (lim.length >= max) break; }
    if (lim.length < Math.min(max, sorted.length)) for (const p of sorted) { if (lim.length >= max) break; if (!lim.includes(p)) lim.push(p); }
    return lim.slice(0, max);
  };
  const shownOf = (rs) => sectorLimit(rs.slice().sort((a, b) => (b.tp + bonus(b)) - (a.tp + bonus(a)))).sort((a, b) => finalKey(b) - finalKey(a));
  const tradeOf = (rs, reg) => {
    if (reg === 'BEAR') return [];
    if (reg === 'NEUTRAL') return rs.filter((r) => isBuyLabel(r) && r.sc >= 70).sort((a, b) => b.sc - a.sc).slice(0, 4);
    return shownOf(rs).filter((r) => isBuyLabel(r) && r.sc >= 55).sort((a, b) => b.sc - a.sc);
  };

  const report = { from: FROM, to: TO, dataThrough: lastDate, symbols: nSym, days: [] };
  console.log(`\n${FROM} → ${TO} · ${nSym} hisse · veri sonu ${lastDate} · giris ertesi acilis, %${COST} maliyet\n`);
  for (const d of days) {
    const rec = perDay.get(d);
    const xi = xuPos.get(d);
    const reg = classifyBistRegime(xuC.slice(0, xi + 1)).regime;
    const xuNext = xu[xi + 1] ? pct(xu[xi + 1].close, xu[xi].close) : null;
    const pass = rec.cands.filter((r) => r.rej == null);
    const shown = shownOf(pass).filter(isBuyLabel);
    const trade = tradeOf(pass, reg).slice(0, 3);
    const movers = NS.rankMovers(rec.movers, 5).map((m, i) => {
      const nb = m.bars[m.t + 1];
      const prev = m.bars[m.t].close;
      const st = nb ? NS.settleDayTrade(nb, NS.DAYTRADE_RULE, prev) : null;   // açılış sınırı dahil (uygulamadaki kural)
      return { rank: i + 1, symbol: m.symbol, pMove: m._ns.pMove, limitUpClose: m._ns.limitUpClose, openAtLimit: nb ? (nb.open / prev - 1) * 100 >= NS.LIMIT_PCT : null, ...(st || {}) };
    });
    const rejCount = {};
    for (const r of rec.cands) if (r.rej) rejCount[r.rej] = (rejCount[r.rej] || 0) + 1;
    report.days.push({ d, reg, xuNext, uniCc1: mean(rec.uni.map((u) => u.cc1)), uniGreen: mean(rec.uni.map((u) => (u.cc1 > 0 ? 1 : 0))), candidates: rec.cands.length, pass: pass.length, rejCount, shown, trade, movers });
  }

  // ── yazdır ──
  const line = (r) => `${r.sym.padEnd(6)} skor ${r.sc.toFixed(0).padStart(3)} ${r.cls === 'buy' ? 'AL ' : 'TUT'}  bosluk ${f2(r.gap, 1).padStart(5)}  ertesi kap-kap ${f2(r.cc1, 1).padStart(5)}  gun-ici ${f2(r.oc1, 1).padStart(5)}  plan ${f2(isNum(r.plan) ? r.plan - COST : null, 1).padStart(5)}${r.planOpen ? ' (acik)' : ''}  bugune ${f2(r.toDate, 1)}`;
  for (const x of report.days) {
    console.log(`── ${x.d} · rejim ${x.reg} · XU100 ertesi gun ${f2(x.xuNext)} · evren (likit) ertesi gun ${f2(x.uniCc1)}, yesil %${(x.uniGreen * 100).toFixed(0)} · aday ${x.candidates}, filtreden gecen ${x.pass}`);
    console.log(`   gosterilen AL (ilk 8): ${x.shown.slice(0, 8).map((r) => r.sym).join(' ') || '-'}`);
    console.log(`   paper acardi (ilk 3):`); for (const r of x.trade) console.log('     ' + line(r));
    if (!x.trade.length) console.log('     - (rejim kapisi ya da aday yok)');
    console.log(`   hareket listesi: ` + x.movers.map((m) => `${m.rank}.${m.symbol} ${Math.round(m.pMove * 100)}%${m.limitUpClose ? ' T' : ''} → ${m.locked ? 'KILITLI' : m.skipped ? `acilis ${f2(m.gapPct, 1)} ALINMADI` : f2(m.netPct, 1)}`).join(' | '));
  }
  const all = (k) => report.days.flatMap((x) => x[k]);
  const trades = all('trade').filter((r) => isNum(r.cc1));
  const shownAll = report.days.flatMap((x) => x.shown.slice(0, 8)).filter((r) => isNum(r.cc1));
  const mv3 = report.days.flatMap((x) => x.movers.filter((m) => m.rank <= 3));
  const mv3t = mv3.filter((m) => m.taken);
  console.log('\n══ OZET ══');
  console.log(`paper ilk 3 : ${trades.length} islem · ertesi gun yesil %${(mean(trades.map((r) => (r.cc1 > 0 ? 1 : 0))) * 100).toFixed(0)} · ertesi gun kap-kap ort ${f2(mean(trades.map((r) => r.cc1)))} · plan (trailing, net) ort ${f2(mean(trades.filter((r) => isNum(r.plan)).map((r) => r.plan - COST)))} · bugune kadar ort ${f2(mean(trades.map((r) => r.toDate)))}`);
  console.log(`gosterilen 8: ${shownAll.length} kayit · ertesi gun yesil %${(mean(shownAll.map((r) => (r.cc1 > 0 ? 1 : 0))) * 100).toFixed(0)} · ertesi gun kap-kap ort ${f2(mean(shownAll.map((r) => r.cc1)))}`);
  console.log(`evren taban : ertesi gun kap-kap ort ${f2(mean(report.days.map((x) => x.uniCc1)))} · yesil %${(mean(report.days.map((x) => x.uniGreen)) * 100).toFixed(0)}`);
  console.log(`hareket ilk3: ${mv3.length} secim · kilitli ${mv3.filter((m) => m.locked).length} · acilis siniri yuzunden alinmayan ${mv3.filter((m) => m.skipped).length} · alinan ${mv3t.length} → net ort ${f2(mean(mv3t.map((m) => m.netPct)))} · +%4 doldu ${mv3t.filter((m) => m.hit).length}/${mv3t.length} · kârli ${mv3t.filter((m) => m.netPct > 0).length}/${mv3t.length}`);
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, (k, v) => (k === 'bars' ? undefined : v), 1)); console.log(`yazildi ${OUT}`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
