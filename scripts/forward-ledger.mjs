#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// forward-ledger.mjs — SINYAL LISTELERININ ILERI OLCUM DEFTERI (v31.60, 23.11.2026)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: kullanici — "sinyal kismi uygulamanin asil amaci, detayli izleyelim; gercekten
// tutarliysa onun ustune yogunlasacagiz". Telefonun kayitlari yalniz telefonda (sunucu tarafi
// takip kurulu degil) ve telefon ancak aksam acilirsa sonuc yazar. Bu defter telefondan
// BAGIMSIZ: her kapanis icin listeyi uygulamanin kendi fonksiyonlariyla kurar, ertesi seanslarin
// resmi barlariyla yerlestirir ve onceden yazilmis olcutlere (src/utils/forwardVerdict.js) gore
// durumu basar.
//
// DISIPLIN:
//   - Model DONDURULUR: defter ilk kuruldugunda src/utils/nextSessionModel.js'in kopyasi deftere
//     yazilir (builtAt 2026-11-22, 2026-11-20'ye kadarki veriyle egitildi) ve sonraki her liste o
//     kopyayla kurulur. Model yeniden egitilse de defter degismez.
//   - Liste DEGISMEZ: bir dayanak gunu icin liste bir kez kurulur (yalniz o gune kadarki barlarla).
//   - Kural uygulamadaki ile ayni: hareket = rankMovers + settleDayTrade (ilk 3, +%4, acilis
//     siniri); AL = canli secim zincirinin kopyasi (live-ranker-replica) + alListScorecard.settleAlPick
//     (acilista giris, stop alti acilis alinmaz, yalniz trailing, 30 seans).
//   - Taban: ayni gun ayni kurali TUM likit hisselere uygulamak (hareket) / tum AL adaylarina (AL).
//   - Bar Yahoo'dan (gercek acilis). Bugunun bari 19:00 TRT'den once kesin sayilmaz.
//
// FARKLAR (telefonla): evren 586 hisse (telefon 623 tarar; 400 bardan kisa halka arzlar yok),
// KAP islem tedbiri ve sektor gucu yok, AL listesi canli zincirin kopyasi (gun sonu dali).
//
// KULLANIM:
//   node scripts/forward-ledger.mjs --fetch      # barlari tazele (son 1 ay, ~3 dk) + defteri guncelle + rapor
//   node scripts/forward-ledger.mjs              # yalniz guncelle + rapor (onbellekteki barlarla)
//   node scripts/forward-ledger.mjs --days 30    # rapordaki seans satiri sayisi
// Defter: .replay-cache/forward-ledger.json (yeniden kurulabilir: ayni barlar + defterdeki model)
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const CACHE = path.join(ROOT, '.replay-cache');
const LEDGER_FILE = path.join(CACHE, 'forward-ledger.json');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SHOW_DAYS = Number(arg('--days', 12));

export const START_BASIS = '2026-11-20';     // ilk dayanak gunu → ilk yargilanan seans 2026-11-23
export const PINNED_MODEL = '2026-11-22';
const LOOKBACK = 252;
const CLOSE_READY_MIN = 19 * 60;             // TRT: gun sonu bari bundan sonra kesin
const isNum = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const f2 = (x, d = 2) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '-');
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const ident = (d) => (typeof d === 'string' ? d.slice(0, 10) : '');
const dd = (k) => (k ? `${k.slice(8, 10)}.${k.slice(5, 7)}` : '');

function trtNow() {
  const d = new Date(Date.now() + 3 * 3600e3);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const NOW = trtNow();
const closedDay = (d) => d < NOW.day || (d === NOW.day && NOW.min >= CLOSE_READY_MIN);

function readBars(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8'))
      .filter((b) => b && typeof b.date === 'string' && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));
  } catch { return []; }
}
const symbolFiles = () => fs.readdirSync(CACHE).filter((f) => /^[A-Z0-9]+_5y\.json$/.test(f) && !f.startsWith('XU100'));

/** Son 1 ayi Yahoo'dan cek, onbellekteki 5 yillik seriyle tarihe gore birlestir. */
async function refreshBars() {
  const syms = ['XU100', ...symbolFiles().map((f) => f.replace('_5y.json', ''))];
  let ok = 0, fail = 0;
  for (const sym of syms) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.IS?range=1mo&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json())?.chart?.result?.[0];
      const ts = r?.timestamp, q = r?.indicators?.quote?.[0];
      if (!Array.isArray(ts) || !q) throw new Error('bos yanit');
      const fresh = new Map();
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
        if (![o, h, l, c].every((x) => isNum(x) && x > 0)) continue;
        fresh.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), { open: o, high: h, low: l, close: c, volume: isNum(v) ? v : 0 });
      }
      const file = path.join(CACHE, `${sym}_5y.json`);
      const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      const byDate = new Map(old.map((b) => [b.date, b]));
      for (const [date, b] of fresh) byDate.set(date, { date, ...b });
      fs.writeFileSync(file, JSON.stringify([...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))));
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 3) console.log(`  bar hatasi ${sym}: ${e.message}`);
      if (fail >= 10 && ok === 0) { console.log('  Yahoo\'ya ulasilamiyor — onbellekle devam'); break; }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`bar tazeleme: ${ok} sembol, ${fail} hata`);
}

async function main() {
  if (argv.includes('--fetch')) await refreshBars();

  const NS = await import(U('utils/nextSession.js'));
  const { classifyBistRegime } = await import(U('utils/regimeGate.js'));
  const { settleAlPick } = await import(U('utils/alListScorecard.js'));
  const { moversVerdict, verdictText, MOVERS_FORWARD_PLAN: PLAN } = await import(U('utils/forwardVerdict.js'));

  // ── defter + dondurulmus model ──
  let L;
  if (fs.existsSync(LEDGER_FILE)) L = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  else {
    const { NEXT_SESSION_MODEL } = await import(U('utils/nextSessionModel.js'));
    if (NEXT_SESSION_MODEL.builtAt !== PINNED_MODEL) throw new Error(`Defter ${PINNED_MODEL} modeliyle baslar; src'deki model ${NEXT_SESSION_MODEL.builtAt}. git show ile o surumu kullan.`);
    L = { version: 1, createdAt: new Date().toISOString(), startBasis: START_BASIS, model: NEXT_SESSION_MODEL, days: [] };
  }
  const MODEL = L.model;

  // ── barlar ──
  const xu = readBars('XU100_5y.json').filter((b) => closedDay(b.date));
  const xuC = xu.map((b) => b.close);
  const xuPos = new Map(xu.map((b, i) => [b.date, i]));
  const BARS = new Map();
  for (const f of symbolFiles()) {
    const bars = readBars(f).filter((b) => closedDay(b.date));
    if (bars.length >= 260) BARS.set(f.replace('_5y.json', ''), bars);
  }
  const dataThrough = xu.length ? xu[xu.length - 1].date : '';
  const have = new Set(L.days.map((d) => d.basisDay));
  const toBuild = xu.map((b) => b.date).filter((d) => d >= L.startBasis && !have.has(d));

  // ── yeni dayanak gunleri: listeleri kur (yalniz o gune kadarki barlarla) ──
  if (toBuild.length) {
    const { calcAll } = await import(U('utils/indicators.js'));
    const { genSignal } = await import(U('utils/signals.js'));
    const { initEngine } = await import(U('engine/engineCore.js'));
    const { makeLiveReplica } = await import(pathToFileURL(path.join(HERE, 'live-ranker-replica.mjs')).href);
    await initEngine();
    const live = await makeLiveReplica();
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

    for (const d of toBuild) {
      const xi = xuPos.get(d);
      const reg = classifyBistRegime(xuC.slice(0, xi + 1)).regime;
      const idxCloses = xuC.slice(Math.max(0, xi - 80), xi + 1);
      const moverRows = [], eligible = [], cands = [];
      for (const [sym, bars] of BARS) {
        const t = bars.findIndex((b) => b.date === d);
        if (t < 210) continue;
        const hist = bars.slice(Math.max(0, t + 1 - LOOKBACK), t + 1);
        let tl = 0; for (let k = t - 19; k <= t; k++) tl += bars[k].close * bars[k].volume; tl /= 20;
        const fc = NS.forecastNextSession(hist, idxCloses, MODEL);
        if (fc && tl >= 2e6 && !fc.artifact) {
          moverRows.push({ symbol: sym, _ns: { ...fc, turnoverLog: Math.log10(tl) }, prevClose: bars[t].close });
          eligible.push(sym);
        }
        let ind, sig, htf;
        try { ind = calcAll(hist); htf = live._deriveHTFContext(hist, ind); sig = genSignal(ind, hist, { htfContext: htf, sectorStrength: 0 }); } catch { continue; }
        if (!sig || sig.cls === 'sell' || (sig.cls !== 'buy' && !(sig.score >= 45))) continue;
        const Lr = live.buildResult(sym, ind, sig, hist, xuC.slice(Math.max(0, xi - 90), xi + 1), htf);
        const early = live.detectEarly(Lr);
        const rej = live.rejectReason(Lr, early);
        if (rej != null) continue;
        const tp = live.calcTomorrowPotential(Lr);
        const cf = live.confidenceOf(Lr, tp);
        const { stop } = live.liveStopTarget(Lr);
        cands.push({ symbol: sym, sector: Lr.sector, sc: Lr.score, cls: sig.cls, tp, confA: cf.conf, early: early.isEarly ? 1 : 0, near: live.detectNear(Lr).isNear ? 1 : 0, stop: r2(stop), ref: r2(bars[t].close) });
      }
      const movers = NS.rankMovers(moverRows, 5).map((m, i) => ({
        rank: i + 1, symbol: m.symbol, pMove: m._ns.pMove, pGreen: m._ns.pGreen, limitUpClose: !!m._ns.limitUpClose, prevClose: m.prevClose, result: null,
      }));
      // AL listesi: rejim kapisi (YATAY skor>=70 en fazla 4, DUSUS 58 + izle) → guven sirasi → ilk 3
      const buys = cands.filter(isBuyLabel);
      let list;
      if (reg === 'BULL') list = shownOf(buys);
      else list = buys.filter((r) => r.sc >= (reg === 'BEAR' ? 58 : 70)).sort((a, b) => b.sc - a.sc).slice(0, 4).sort((a, b) => finalKey(b) - finalKey(a));
      const al = list.slice(0, 3).map((r, i) => ({ rank: i + 1, symbol: r.symbol, sc: r2(r.sc), stop: r.stop, ref: r.ref, watchOnly: reg === 'BEAR', result: null }));
      L.days.push({
        basisDay: d, regime: reg, builtAt: new Date().toISOString(), universe: BARS.size,
        movers, moversBase: { symbols: eligible, result: null },
        al, alPool: buys.map((r) => ({ symbol: r.symbol, stop: r.stop, result: null })),
      });
      console.log(`liste kuruldu: ${d} (rejim ${reg}) · hareket ${movers.slice(0, 3).map((m) => m.symbol).join(' ')} · AL ${al.map((p) => p.symbol).join(' ') || '-'}`);
    }
    L.days.sort((a, b) => (a.basisDay < b.basisDay ? -1 : 1));
  }

  // ── yerlestir (yalniz kesin barlarla) ──
  for (const day of L.days) {
    const xi = xuPos.get(day.basisDay);
    const nd = xi != null ? xu[xi + 1]?.date : null;          // yargilayan seans (endeks takvimi)
    day.judgedSession = nd || null;
    if (nd) {
      for (const m of day.movers) {
        if (m.result) continue;
        const nb = BARS.get(m.symbol)?.find((b) => b.date === nd);
        if (!nb) continue;
        const res = NS.settleDayTrade(nb, NS.DAYTRADE_RULE, m.prevClose);
        if (res) m.result = { ...res, day: nd };
      }
      if (!day.moversBase.result) {
        const v = [];
        for (const sym of day.moversBase.symbols) {
          const bars = BARS.get(sym); if (!bars) continue;
          const t = bars.findIndex((b) => b.date === nd); if (t < 1) continue;
          const res = NS.settleDayTrade(bars[t], NS.DAYTRADE_RULE, bars[t - 1].close);
          if (res && res.taken) v.push(res.netPct);
        }
        if (v.length >= 20) day.moversBase.result = { n: v.length, avgNet: r2(mean(v)), day: nd };
      }
      if (xi != null && xu[xi + 1]) day.xuNext = r2((xu[xi + 1].close / xu[xi].close - 1) * 100);
    }
    for (const p of [...day.al, ...day.alPool]) {
      if (p.watchOnly || (p.result && p.result.status !== 'open')) continue;
      const bars = BARS.get(p.symbol); if (!bars) continue;
      const res = settleAlPick(p, bars, day.basisDay, ident);
      if (res) p.result = res;
    }
  }
  L.updatedAt = new Date().toISOString();
  L.dataThrough = dataThrough;
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(L));

  // ── RAPOR ──
  const judged = L.days.filter((d) => d.movers.some((m) => m.result));
  console.log(`\n══ ILERI OLCUM DEFTERI · model ${MODEL.builtAt} (dondurulmus) · veri sonu ${dataThrough} · evren ${L.days[L.days.length - 1]?.universe ?? '-'} hisse ══`);
  console.log(`Plan (onceden yazildi ${PLAN.writtenAt}): ilk seans ${PLAN.firstSession}, kontrol noktalari ${PLAN.checkpoints.map((c) => c.sessions).join(' / ')} seans, karar ${PLAN.finalSessions}. seansta.`);

  console.log('\n── GUN ICI HAREKET LISTESI (ilk 3: acilista al, +%4 limit sat, olmazsa kapanista; acilis +%5,67 ustundeyse alma; %0,3 maliyet) ──');
  console.log('seans   liste (dayanak)       ilk 3 sonuc                                            gun ort   tum likit, ayni kural   XU100');
  const dayNets = [], trades = [], baseDiff = [];
  let locked = 0, skipped = 0, hits = 0;
  for (const d of judged) {
    const top = d.movers.filter((m) => m.rank <= 3 && m.result);
    const taken = top.filter((m) => m.result.taken);
    locked += top.filter((m) => m.result.locked).length;
    skipped += top.filter((m) => m.result.skipped).length;
    hits += taken.filter((m) => m.result.hit).length;
    const nets = taken.map((m) => m.result.netPct);
    if (nets.length) { dayNets.push(mean(nets)); trades.push(...nets); if (d.moversBase.result) baseDiff.push(mean(nets) - d.moversBase.result.avgNet); }
  }
  for (const d of judged.slice(-SHOW_DAYS)) {
    const top = d.movers.filter((m) => m.rank <= 3);
    const cell = (m) => `${m.symbol} ${!m.result ? '?' : m.result.locked ? 'kilitli' : m.result.skipped ? 'alinmadi' : f2(m.result.netPct, 1)}`;
    const nets = top.filter((m) => m.result?.taken).map((m) => m.result.netPct);
    console.log(`${dd(d.judgedSession)}   ${dd(d.basisDay)}                 ${top.map(cell).join(' | ').padEnd(54)} ${f2(mean(nets)).padStart(6)}   ${f2(d.moversBase.result?.avgNet).padStart(6)}                 ${f2(d.xuNext).padStart(6)}`);
  }
  const t = dayNets.length >= 3 ? mean(dayNets) / (sdv(dayNets) / Math.sqrt(dayNets.length)) : null;
  const avg = trades.length ? mean(trades) : null;
  const equity = (dayNets.reduce((p, x) => p * (1 + x / 100), 1) - 1) * 100;
  console.log(`\nTOPLAM: ${dayNets.length} seans · ${trades.length} islem · kilitli ${locked} · acilis siniri yuzunden alinmayan ${skipped}`);
  console.log(`  islem basina net ${f2(avg)} (gecmis ${f2(PLAN.backtestAvgNet)}) · kârli %${trades.length ? Math.round(100 * trades.filter((x) => x > 0).length / trades.length) : '-'} (gecmis %${PLAN.backtestWinPct}) · +%4 doldu ${hits}/${trades.length}`);
  console.log(`  arti seans %${dayNets.length ? Math.round(100 * dayNets.filter((x) => x > 0).length / dayNets.length) : '-'} · gun bazinda t ${f2(t)} · her gun tum sermaye birlesik ${f2(equity)}% · ayni kuralla tum likit hisselere gore fark ${f2(mean(baseDiff))} / seans`);
  const v = moversVerdict({ sessions: dayNets.length, avgNet: avg, dayT: t });
  console.log(`  DURUM: ${verdictText(v, dayNets.length)}`);

  console.log('\n── AL LISTESI (ilk 3: acilista al, stop alti acilis alinmaz, yalniz trailing, en fazla 30 seans; %0,3 maliyet) ──');
  const alClosed = [], alOpen = [], poolClosed = [];
  let alSkip = 0, alWatch = 0;
  for (const d of L.days) {
    for (const p of d.al) {
      if (p.watchOnly) { alWatch++; continue; }
      if (!p.result) continue;
      if (p.result.status === 'skipped') alSkip++;
      else if (p.result.status === 'closed') alClosed.push(p.result.netPct);
      else alOpen.push(p.result.netPct);
    }
    for (const p of d.alPool) if (p.result?.status === 'closed') poolClosed.push(p.result.netPct);
  }
  for (const d of L.days.slice(-SHOW_DAYS)) {
    if (!d.al.length) { console.log(`${dd(d.basisDay)} listesi (${d.regime}): AL yok`); continue; }
    const cell = (p) => `${p.symbol} ${p.watchOnly ? 'izle' : !p.result ? 'bekliyor' : p.result.status === 'skipped' ? 'alinmadi' : `${f2(p.result.netPct, 1)}${p.result.status === 'open' ? ` (suruyor ${p.result.sessions}. seans)` : ` (${p.result.sessions} seans)`}`}`;
    console.log(`${dd(d.basisDay)} listesi (${d.regime}): ${d.al.map(cell).join(' | ')}`);
  }
  console.log(`TOPLAM: kapanan ${alClosed.length} islem, ort ${f2(mean(alClosed))}, kârli ${alClosed.filter((x) => x > 0).length} · suren ${alOpen.length} (su an ort ${f2(mean(alOpen))}) · stop alti acilis ${alSkip} · izle ${alWatch}`);
  console.log(`  tum AL adaylari ayni kuralla (kapananlar): ${poolClosed.length} islem, ort ${f2(mean(poolClosed))} · gecmis (2022–2026): ilk 3 +0,46, tum adaylar +0,67`);

  const last = L.days[L.days.length - 1];
  if (last && !last.movers.some((m) => m.result)) {
    console.log(`\n── SIRADAKI SEANS ICIN (${dd(last.basisDay)} kapanisina gore) — telefondaki listeyle karsilastir ──`);
    console.log(`  hareket: ${last.movers.map((m) => `${m.rank}.${m.symbol} %${Math.round(m.pMove * 100)}${m.limitUpClose ? ' (tavan kapatti)' : ''}`).join(' · ')}`);
    console.log(`  AL     : ${last.al.map((p) => `${p.rank}.${p.symbol} stop ${p.stop}${p.watchOnly ? ' (izle)' : ''}`).join(' · ') || '-'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
