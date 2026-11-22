#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// fundamentals-study.mjs — BİLANÇO ADAY SEÇİMİNE BİR ŞEY KATIYOR MU? (v31.57)
// ════════════════════════════════════════════════════════════════════
//
// Soru (kullanıcı, 22.11.2026): "hisseleri arka planda nasıl analiz ediyoruz — teknik,
// haber, bildirim, bilanço dahil mi; değilse ekle". Bugün taramada bilanço yalnız en iyi
// ~18 AL adayına Yahoo verisiyle uygulanan bir kapı (fundamentalQualityGate: sert red
// D/Ö>5, cari<0,4, net marj<−%25; ceza D/Ö>2, cari<0,8, zarar, 3 çeyrek düşen kâr).
// Eşikler ölçülmedi, Yahoo'nun BIST verisi delikli.
//
// Burada: İş Yatırım MaliTablo (fundamentals-fetch.mjs) → buildFinancialView (Hisse
// detayıyla aynı kod) → her aday satırına O GÜN YAYIMLANMIŞ OLAN son bilanço eklenir.
// Yayım gecikmesi temkinli: Q1/Q3 +60 gün, ilk yarı +75, yıl sonu +105 (yasal süreler
// 40–70 gün; erken açıklayanı geç saymak yalnız bilgi kaybettirir, ileri bakış yaratmaz).
//
// Ölçülenler (aday satırları: feature-edge-study, canlı filtreden geçen, sinyal günü):
//   1. kapsama — kaç adayın noktasal bilançosu var
//   2. bugünkü kapının İş verisiyle kopyası: elenen / cezalı / temiz adayların sonucu
//   3. faktörler: kazanç getirisi (1/FK), defter/piyasa, ÖK kârlılığı, net marj, kâr ve
//      satış büyümesi (12A, yıllık), borç/özkaynak, cari oran, zarar — gün-içi sıra
//      korelasyonu (o günün adayları arasında) + uç beşte birlik farkı
//   keşif (A, 89 hisse) / doğrulama (B, diğerleri) / sonrası (2026-08-28 sonrası) ayrı.
//
// KULLANIM:
//   node scripts/fundamentals-fetch.mjs
//   node --max-old-space-size=8000 scripts/fundamentals-study.mjs [--y planL]
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const FIN = path.join(ROOT, '.replay-cache', 'fin');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const YK = arg('--y', 'planL');
const COST = 0.3;
const isNum = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f2 = (x, d = 2) => (isNum(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '  -');
const tstat = (v) => { const a = v.filter(isNum); const m = mean(a); const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2))); return sd ? m / (sd / Math.sqrt(a.length)) : NaN; };

export const LAG_DAYS = { 3: 60, 6: 75, 9: 60, 12: 105 };

/** Bir dönem etiketinin ('2025/9') temkinli yayım günü. */
export function availableDate(label) {
  const [y, p] = String(label).split('/').map(Number);
  const end = new Date(Date.UTC(y, p, 0));             // ayın son günü
  end.setUTCDate(end.getUTCDate() + (LAG_DAYS[p] || 105));
  return end.toISOString().slice(0, 10);
}

async function snapshots() {
  const FS = await import(U('utils/financialStatements.js'));
  const out = new Map();
  for (const f of fs.readdirSync(FIN).filter((x) => x.endsWith('.json'))) {
    const sym = f.replace('.json', '');
    let j; try { j = JSON.parse(fs.readFileSync(path.join(FIN, f), 'utf8')); } catch { continue; }
    if (!j?.merged) continue;
    let v; try { v = FS.buildFinancialView(j.merged); } catch { continue; }
    if (!v?.labels?.length) continue;
    const snaps = [];
    for (const l of v.labels) {
      const b = v.balance.find((x) => x.label === l) || {};
      const r = v.rolling.find((x) => x.label === l) || {};
      const qi = v.labels.indexOf(l);
      const q3 = v.labels.slice(qi, qi + 3).map((x) => v.quarters.find((q) => q.label === x)?.parentNet);
      const declining = q3.length === 3 && q3.every(isNum) && q3[0] < q3[1] && q3[1] < q3[2];   // en yeni < önceki < daha önceki
      const nm = isNum(r.netMargin) ? r.netMargin : (isNum(r.parentNet) && r.revenue > 0 ? (r.parentNet / r.revenue) * 100 : null);
      snaps.push({
        label: l, avail: availableDate(l), kind: v.kind,
        net: r.parentNet ?? null, revenue: r.revenue ?? null, netYoY: r.parentNetYoY ?? null, revYoY: r.revenueYoY ?? null,
        nm, roe: b.roe ?? null, eq: b.parentEquity ?? null, shares: b.paidCapital > 0 ? b.paidCapital : null,
        de: b.debtToEquity ?? null, cr: b.currentRatio ?? null, declining,
      });
    }
    snaps.sort((a, b) => (a.avail < b.avail ? -1 : 1));
    out.set(sym, snaps);
  }
  return out;
}

/** Bugünkü kapı (fundamentalEngine.fundamentalQualityGate) — İş verisiyle aynı eşikler. */
export function gateOf(s) {
  if (!s) return null;
  if ((isNum(s.de) && s.de > 5) || (isNum(s.cr) && s.cr < 0.4) || (isNum(s.nm) && s.nm < -25)) return 'red';
  let pen = 0;
  if (isNum(s.de) && s.de > 2) pen += 6;
  if (isNum(s.cr) && s.cr < 0.8) pen += 4;
  if (isNum(s.nm) && s.nm < 0) pen += 5;
  if (s.declining) pen += 4;
  return pen > 0 ? 'ceza' : 'temiz';
}

function rank(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(vals.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
  return r;
}
function corr(a, b) { const ma = mean(a), mb = mean(b); let s = 0, qa = 0, qb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); qa += (a[i] - ma) ** 2; qb += (b[i] - mb) ** 2; } return qa && qb ? s / Math.sqrt(qa * qb) : NaN; }

async function main() {
  const { loadRows, DISCOVERY_END } = await import(pathToFileURL(path.join(HERE, 'feature-edge-study.mjs')).href);
  const snaps = await snapshots();
  const rows = (await loadRows()).filter((r) => r.rej == null && !r.art && !r.artB && isNum(r[YK]));
  console.log(`bilanco: ${snaps.size} hisse · aday satiri (filtreden gecen): ${rows.length} · sonuc: ${YK} (net, %${COST} maliyet)`);

  // noktasal bilanço ekle
  let has = 0;
  for (const r of rows) {
    const list = snaps.get(r.sym);
    let s = null;
    if (list) for (const x of list) { if (x.avail <= r.d) s = x; else break; }
    // fiyat: sinyal günü kapanışı (aday satırında giriş + boşluktan geri çıkar)
    r._f = s;
    if (s) {
      has++;
      const price = isNum(r.gap) && isNum(r.stopPct) ? null : null;
      void price;
    }
  }
  console.log(`noktasal bilancosu olan aday: ${has} (%${((has / rows.length) * 100).toFixed(0)})`);

  // fiyat yok satırda — kazanç getirisi ve defter/piyasa için kapanış barlardan
  const CACHE = path.join(ROOT, '.replay-cache');
  const closeOf = new Map();
  for (const sym of new Set(rows.filter((r) => r._f).map((r) => r.sym))) {
    try {
      const bars = JSON.parse(fs.readFileSync(path.join(CACHE, `${sym}_5y.json`), 'utf8'));
      closeOf.set(sym, new Map(bars.map((b) => [b.date, b.close])));
    } catch { /* yok */ }
  }
  for (const r of rows) {
    const s = r._f; if (!s) continue;
    const p = closeOf.get(r.sym)?.get(r.d);
    const mcap = p > 0 && s.shares ? p * s.shares : null;
    r.fEY = mcap && isNum(s.net) ? (s.net / mcap) * 100 : null;
    r.fBP = mcap && isNum(s.eq) ? s.eq / mcap : null;
    r.fROE = s.roe; r.fNM = s.nm; r.fNetYoY = s.netYoY; r.fRevYoY = s.revYoY;
    r.fDE = s.de; r.fCR = s.cr; r.fLoss = isNum(s.net) ? (s.net <= 0 ? 1 : 0) : null;
    r.fGate = gateOf(s);
  }

  const samples = {
    'A kesif   ': (r) => r.ab === 'A' && r.d <= DISCOVERY_END,
    'B dogrulama': (r) => r.ab === 'B' && r.d <= DISCOVERY_END,
    'sonrasi   ': (r) => r.d > DISCOVERY_END,
  };
  const Y = (r) => r[YK] - COST;

  console.log('\n══ 1. BUGUNKU BILANCO KAPISI (Is verisiyle kopya) — aday basina net ══');
  console.log('ornek        | red: n  ort      | ceza: n  ort      | temiz: n  ort     | bilancosuz: n  ort');
  for (const [nm, fn] of Object.entries(samples)) {
    const g = (k) => rows.filter((r) => fn(r) && (k === 'yok' ? !r._f : r.fGate === k));
    const cell = (k) => { const a = g(k); return `${String(a.length).padStart(6)} ${f2(mean(a.map(Y))).padStart(6)}`; };
    console.log(`${nm} | ${cell('red')}   | ${cell('ceza')}    | ${cell('temiz')}   | ${cell('yok')}`);
  }
  console.log('yil bazinda (tumu): ' + ['2022', '2023', '2024', '2025', '2026'].map((y) => {
    const a = rows.filter((r) => r.d.startsWith(y));
    const m = (k) => mean(a.filter((r) => r.fGate === k).map(Y));
    return `${y} red ${f2(m('red'))} / temiz ${f2(m('temiz'))}`;
  }).join(' | '));

  console.log('\n══ 2. FAKTORLER — gun-ici sira korelasyonu (o gunun bilancolu adaylari, >=8) ve ust-alt beste bir ══');
  const FACT = [['fEY', 'kazanc getirisi (1/FK)'], ['fBP', 'defter / piyasa'], ['fROE', 'OK karliligi'], ['fNM', 'net marj'], ['fNetYoY', 'kar buyumesi 12A'], ['fRevYoY', 'satis buyumesi 12A'], ['fDE', 'borc / ozkaynak'], ['fCR', 'cari oran'], ['fLoss', 'zarar (1/0)']];
  for (const [k, label] of FACT) {
    const parts = [];
    for (const [nm, fn] of Object.entries(samples)) {
      const byD = new Map();
      for (const r of rows) { if (!fn(r) || !isNum(r[k])) continue; if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(r); }
      const ics = [], spread = [];
      for (const rs of byD.values()) {
        if (rs.length < 8) continue;
        const c = corr(rank(rs.map((r) => r[k])), rank(rs.map(Y)));
        if (isNum(c)) ics.push(c);
        const s = rs.slice().sort((a, b) => a[k] - b[k]); const q = Math.max(1, Math.floor(s.length / 5));
        spread.push(mean(s.slice(-q).map(Y)) - mean(s.slice(0, q).map(Y)));
      }
      parts.push(`${nm.trim()} IC ${f2(mean(ics), 3)} (t ${f2(tstat(ics), 1)}) ust-alt ${f2(mean(spread))}`);
    }
    console.log(`${label.padEnd(24)} ${parts.join(' | ')}`);
  }

  console.log('\n══ 3. ZARAR EDEN SIRKET — aday basina net, yil bazinda (tumu) ══');
  for (const y of ['2022', '2023', '2024', '2025', '2026']) {
    const a = rows.filter((r) => r.d.startsWith(y) && r.fLoss != null);
    const l = a.filter((r) => r.fLoss === 1), w = a.filter((r) => r.fLoss === 0);
    console.log(`${y}: zarar n=${l.length} ${f2(mean(l.map(Y)))} | karli n=${w.length} ${f2(mean(w.map(Y)))}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
