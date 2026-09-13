#!/usr/bin/env node
// ── KAP OLAY CALISMASI (v31.40) — "yeni is anlasmasi alan hisse SONRA yukseliyor mu?" ──
//
//   node scripts/kap-event-study.mjs              # onbellekten calisir (yoksa indirir)
//   node scripts/kap-event-study.mjs --refresh    # KAP + bar onbellegini yeniden indir
//
// NEDEN: kullanici "yeni is anlasmasi alan hisseler, hisseyi arttiracak her detay
// onemli" dedi. KAP olaylarini skora katmak (dataLayerPolicy.kapCatalystScoring)
// "goster + olc, sonra ac" kararina bagli. Canli olcum yavas birikir; ama KAP liste
// API'si GECMIS pencereleri de donduruyor ve Is Yatirim gecmis barlari var → olay
// calismasi bugun yapilabilir.
//
// DURUSTLUK KURALLARI (koda islenmis):
//  - GIRIS: bildirimden SONRA baslayan ilk seansin AGIRLIKLI ORTALAMA fiyati (AOF).
//    Seans icinde yayinlanan bildirimi sistem ancak aksam taramasinda gorur ve ertesi
//    gun alir; acilistan once yayinlanani 09:55 taramasi gorur, o gun alir. Ortalama
//    fiyat gercekci bir dolumdur — ne gunun dibi ne tepesi.
//  - ONCEDEN FIYATLANAN: bildirimden onceki son kapanistan giris fiyatina kadar olan
//    hareket ayrica raporlanir (kovalamak mi, erken mi?).
//  - MALIYET: gidis-donus %0,3 (tradingCosts.TOTAL_COST_PCT).
//  - LIKIDITE: girisden onceki 20 seansin ortalama islem hacmi >= 2 mn TL (tarama esigi).
//  - TEKRAR: ayni hissede ayni turden 10 seans icinde gelen bildirim tek olay sayilir.
//  - KIYAS: ayni giris gununde AYNI kuralla (AOF giris → h seans sonra kapanis) TUM likit
//    hisse-gunlerinin ortalamasi. Piyasa hareketi ve AOF-kapanis yapisal farki birlikte duser.
//  - ISTIKRAR: donem ikiye bolunur. Bir yarida pozitif digerinde negatif etki kanit sayilmaz.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { normalizeKapItems } from '../src/utils/kapFeed.js';
import { getStockList } from '../src/utils/constants.js';
import { TOTAL_COST_PCT } from '../src/utils/tradingCosts.js';

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const MONTHS = 24;
const KAP_DIR = '.replay-cache/kap';
const BAR_DIR = '.replay-cache/isy';
const HORIZONS = [0, 1, 3, 5, 10];
const MIN_VOL_TL = 2_000_000;
const DEDUP_SESSIONS = 10;
const SESSION_START_MIN = 9 * 60 + 40;
const SESSION_CLOSE_MIN = 18 * 60 + 10;
const COST = TOTAL_COST_PCT;                 // oran (0.003 = %0,3 gidis-donus)
const pad = (n) => String(n).padStart(2, '0');

// ── Veri (onbellekli) ─────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function monthList() {
  const out = [];
  const now = new Date();
  for (let k = MONTHS; k >= 1; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    out.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
  }
  return out;
}

async function ensureKap() {
  mkdirSync(KAP_DIR, { recursive: true });
  for (const [y, m] of monthList()) {
    const file = `${KAP_DIR}/${y}-${pad(m)}.json`;
    if (existsSync(file) && !REFRESH) continue;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const body = { fromDate: `01.${pad(m)}.${y}`, toDate: `${pad(last)}.${pad(m)}.${y}`, disclosureTypes: null, memberTypes: ['IGS'], mkkMemberOid: null };
    const r = await fetch('https://www.kap.org.tr/tr/api/disclosure/list/main', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'tr', Origin: 'https://www.kap.org.tr', Referer: 'https://www.kap.org.tr/tr/bildirim-sorgu' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const raw = JSON.parse(await r.text());
    const slim = raw.map(x => x?.disclosureBasic).filter(b => b && Number.isFinite(Number(b.disclosureIndex))).map(b => ({
      i: Number(b.disclosureIndex), c: b.stockCode || '', r: b.relatedStocks || '', t: b.title || '', s: b.summary || '',
      k: b.disclosureClass || null, d: b.publishDate || null, m: b.companyTitle || '', o: b.stockCode ? b.mkkMemberOid || null : null,
    }));
    writeFileSync(file, JSON.stringify(slim));
    console.log('KAP indirildi', file, slim.length);
    await sleep(1500);
  }
}

async function ensureBars(symbols, startKey) {
  mkdirSync(BAR_DIR, { recursive: true });
  const [y, m, d] = startKey.split('-');
  const start = `${d}-${m}-${y}`;
  const now = new Date();
  const end = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  const missing = symbols.filter(s => REFRESH || !existsSync(`${BAR_DIR}/${s}.json`));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(async (sym) => {
      const url = `https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?hisse=${sym}&startdate=${start}&enddate=${end}`;
      try {
        const t = await (await fetch(url, { headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.isyatirim.com.tr/' }, signal: AbortSignal.timeout(40000) })).text();
        const v = JSON.parse(t).value || [];
        const rows = v.map(x => { const [dd, mm, yy] = String(x.HGDG_TARIH).split('-'); return [`${yy}-${mm}-${dd}`, +x.HGDG_KAPANIS, +x.HGDG_AOF, +x.HGDG_MIN, +x.HGDG_MAX, +x.HGDG_HACIM]; });
        writeFileSync(`${BAR_DIR}/${sym}.json`, JSON.stringify(rows));
      } catch { /* hisse atlanir, raporda gorunur */ }
    }));
    if (missing.length > 40 && i % 80 === 0) console.log('bar indirme', Math.min(i + 4, missing.length), '/', missing.length);
  }
}

// ── Takvim ve barlar ──────────────────────────────────────────────────────
function loadBars(symbols) {
  const bars = new Map();
  for (const s of symbols) {
    const f = `${BAR_DIR}/${s}.json`;
    if (!existsSync(f)) continue;
    const rows = JSON.parse(readFileSync(f, 'utf8')).filter(r => r[1] > 0);
    if (rows.length < 30) continue;
    const byDay = new Map(rows.map(r => [r[0], { c: r[1], vwap: r[2] > 0 ? r[2] : r[1], volTl: r[5] || 0 }]));
    bars.set(s, byDay);
  }
  return bars;
}

function lowerBound(arr, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < key) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Istanbul duvar saati: [gun anahtari, gunun dakikasi]. */
function trtParts(ts) {
  const d = new Date(ts + 3 * 3600 * 1000);
  return [d.toISOString().slice(0, 10), d.getUTCHours() * 60 + d.getUTCMinutes()];
}

// ── Calisma ───────────────────────────────────────────────────────────────
async function main() {
  const universe = getStockList('bistall');
  await ensureKap();
  const first = monthList()[0];
  const startBars = new Date(Date.UTC(first[0], first[1] - 1, 1) - 60 * 86400000).toISOString().slice(0, 10);
  await ensureBars(universe, startBars);

  const bars = loadBars(universe);
  const sessionSet = new Set();
  for (const s of ['THYAO', 'GARAN', 'AKBNK', 'ASELS']) for (const k of (bars.get(s)?.keys() || [])) sessionSet.add(k);
  const sessions = [...sessionSet].sort();

  let raw = [];
  for (const f of readdirSync(KAP_DIR).filter(x => /^\d{4}-\d{2}\.json$/.test(x)).sort()) {
    raw = raw.concat(JSON.parse(readFileSync(`${KAP_DIR}/${f}`, 'utf8')));
  }
  const items = normalizeKapItems(raw).filter(it => it.primary?.length && Number.isFinite(it.ts));

  // Kiyas: giris gunu i, ufuk h icin tum likit hisselerin (AOF → kapanis) ortalamasi.
  const liquidAt = (byDay, idx) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, idx - 20); j < idx; j++) { const b = byDay.get(sessions[j]); if (b) { sum += b.volTl; n++; } }
    return n >= 10 && sum / n >= MIN_VOL_TL;
  };
  const baseMemo = new Map();
  const baseline = (idx, h) => {
    const key = idx * 16 + h;
    if (baseMemo.has(key)) return baseMemo.get(key);
    let sum = 0, n = 0;
    const eDay = sessions[idx], xDay = sessions[idx + h];
    for (const byDay of bars.values()) {
      const e = byDay.get(eDay), x = byDay.get(xDay);
      if (!e || !x || !liquidAt(byDay, idx)) continue;
      sum += x.c / e.vwap - 1 - COST; n++;
    }
    const v = n >= 50 ? sum / n : null;
    baseMemo.set(key, v);
    return v;
  };

  const events = [];
  const lastKept = new Map();
  for (const it of items.sort((a, b) => a.ts - b.ts)) {
    const kind = it.cls?.kind;
    if (kind !== 'event' && kind !== 'caution') continue;
    const type = it.cls.type === 'new_business'
      ? (/ozel durum/i.test(it.cls.label.normalize('NFD').replace(/[̀-ͯ]/g, '')) ? 'new_business:summary' : 'new_business:title')
      : it.cls.type;
    const sym = it.primary.find(s => bars.has(s));
    if (!sym) continue;
    const byDay = bars.get(sym);
    const [dayKey, minutes] = trtParts(it.ts);
    // Giris: bildirimden SONRA baslayan ilk seans.
    let entryIdx = lowerBound(sessions, dayKey);
    if (sessions[entryIdx] === dayKey && minutes >= SESSION_START_MIN) entryIdx++;
    // Onceden fiyatlanan hareketin tabani: bildirimden ONCE kapanmis son seans.
    let baseIdx = lowerBound(sessions, dayKey) - 1;
    if (sessions[baseIdx + 1] === dayKey && minutes >= SESSION_CLOSE_MIN) baseIdx++;
    if (entryIdx >= sessions.length || baseIdx < 0) continue;
    const dedupKey = `${sym}|${type}`;
    if (lastKept.has(dedupKey) && entryIdx - lastKept.get(dedupKey) < DEDUP_SESSIONS) continue;
    const entry = byDay.get(sessions[entryIdx]);
    const base = byDay.get(sessions[baseIdx]);
    if (!entry || !base || !liquidAt(byDay, entryIdx)) continue;
    lastKept.set(dedupKey, entryIdx);
    const ev = { sym, type, day: sessions[entryIdx], preMove: entry.vwap / base.c - 1, ret: {}, ex: {} };
    for (const h of HORIZONS) {
      const x = byDay.get(sessions[entryIdx + h]);
      const b = sessions[entryIdx + h] ? baseline(entryIdx, h) : null;
      if (!x || b == null) continue;
      ev.ret[h] = x.c / entry.vwap - 1 - COST;
      ev.ex[h] = ev.ret[h] - b;
    }
    events.push(ev);
  }

  // ── Rapor ───────────────────────────────────────────────────────────────
  const fmtPct = (v) => (v == null ? '   -  ' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}`.padStart(6));
  const stats = (arr) => {
    const n = arr.length;
    if (!n) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const sorted = [...arr].sort((a, b) => a - b);
    return { n, mean, median: sorted[Math.floor(n / 2)], win: arr.filter(v => v > 0).length / n, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
  };
  const mid = sessions[Math.floor(sessions.length / 2)];
  const types = [...new Set(events.map(e => e.type))].sort();
  console.log(`\nKAP olay calismasi — ${items.length} sirket bildirimi, ${events.length} likit olay, ${sessions[0]} → ${sessions.at(-1)}, maliyet %${(TOTAL_COST_PCT * 100).toFixed(1)}`);
  console.log('Getiri: giris gununun AOF fiyatindan h seans sonraki kapanisa, maliyet dusulmus. FAZLA = ayni gun tum likit hisselere gore.');
  console.log('istikrar: ilk yari / ikinci yari (h=5 FAZLA), * = n<30\n');
  console.log('tur                          n   oncedn  | h=0 FAZLA  h=1 FAZLA  h=3 FAZLA  h=5 FAZLA  h=10 FAZLA | h=5 kazanma  t(h=5) | istikrar h=5');
  for (const type of types) {
    const ev = events.filter(e => e.type === type);
    if (ev.length < 8) continue;
    const pre = stats(ev.map(e => e.preMove));
    const cells = HORIZONS.map(h => stats(ev.filter(e => e.ex[h] != null).map(e => e.ex[h])));
    const s5r = stats(ev.filter(e => e.ret[5] != null).map(e => e.ret[5]));
    const h1 = stats(ev.filter(e => e.ex[5] != null && e.day < mid).map(e => e.ex[5]));
    const h2 = stats(ev.filter(e => e.ex[5] != null && e.day >= mid).map(e => e.ex[5]));
    console.log(
      `${(type + (ev.length < 30 ? '*' : '')).padEnd(27)} ${String(ev.length).padStart(4)}  ${fmtPct(pre?.mean)}  | `
      + cells.map(c => `${fmtPct(c?.mean)}   `).join('  ')
      + `| ${s5r ? `%${(s5r.win * 100).toFixed(0)}`.padStart(5) : '   - '}     ${cells[3] ? cells[3].t.toFixed(1).padStart(5) : '   - '} | ${fmtPct(h1?.mean)} (${h1?.n || 0}) / ${fmtPct(h2?.mean)} (${h2?.n || 0})`,
    );
  }

  // Yeni is: onceden fiyatlanma kovalari (kovalamak zarar mi?)
  const nb = events.filter(e => e.type.startsWith('new_business'));
  console.log('\nYeni is (baslik + ozet) — giristen once ne kadar fiyatlanmisti?');
  for (const [label, lo, hi] of [['<= %0', -1, 0], ['%0 - %3', 0, 0.03], ['%3 - %7', 0.03, 0.07], ['> %7', 0.07, 9]]) {
    const b = nb.filter(e => e.preMove > lo && e.preMove <= hi);
    const s5 = stats(b.filter(e => e.ex[5] != null).map(e => e.ex[5]));
    const s1 = stats(b.filter(e => e.ex[1] != null).map(e => e.ex[1]));
    console.log(`  oncedn ${label.padEnd(8)} n=${String(b.length).padStart(4)} | h=1 FAZLA ${fmtPct(s1?.mean)} | h=5 FAZLA ${fmtPct(s5?.mean)} kazanma ${s5 ? (s5.win * 100).toFixed(0) : '-'}%`);
  }

  const out = `reports/kap-event-study-${new Date().toISOString().slice(0, 10)}.json`;
  mkdirSync('reports', { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [sessions[0], sessions.at(-1)], costPct: TOTAL_COST_PCT, events }, null, 0));
  console.log(`\nOlay listesi: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
