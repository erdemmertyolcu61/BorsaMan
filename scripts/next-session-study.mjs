#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// next-session-study.mjs — YARIN HANGI HISSE YESIL KAPATIR, HANGISI HAREKET EDER? (v31.54)
// ════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: kullanici istegi — "onerilen hisselerin cogunlugu yesil kapatsin,
// gun icinde major hareket yapacak hisseleri seans oncesi bulalim". feature-edge-study
// yalniz AL adaylarini ve cok gunluk (trailing) sonucu olcuyordu; bu calisma
// EVRENIN TAMAMINI ve TEK SEANSI olcer.
//
// SATIR = bir hisse × bir gun. Ozellikler t gununun KAPANISINDA bilinenler
// (src/utils/nextSession.js — uygulamadaki ile ayni kod). Sonuclar t+1 seansi:
//   cc1   kapanis(t+1) / kapanis(t)      "yesil kapatti mi" — ekranda gorulen gunluk degisim
//   gap1  acilis(t+1)  / kapanis(t)      gece boslugu (seans oncesi listeyi goren alamaz)
//   oc1   kapanis(t+1) / acilis(t+1)     gun-ici: acilista al, kapanista sat
//   oh1   zirve(t+1)   / acilis(t+1)     acilistan gorulen en iyi fiyat ("major hareket")
//   ol1   dip(t+1)     / acilis(t+1)
//   s3 / s5   acilis(t+1) → kapanis(t+3) / (t+5)   swing ufku
//
// DISIPLIN:
//   - lock1: t+1 tek fiyatli seans (acilis = zirve = dip) — tavan/taban kilidi, ALINAMAZ.
//     "Yesil kapatti" sayilir ama al-sat getirisine girmez.
//   - art: |cc1| > %11,5 ya da izleyen 5 seansta boyle bir bar (bolunme / birlesmis gun);
//     artB: son 60 barda |degisim| > %25. Analiz ikisini disarida tutar.
//   - liq: 20 gunluk ortalama islem hacmi >= 2M TL (canli taramanin likidite tabani).
//   - br: o gun likit evrende yukselen hisse orani (gun-duzeyi; uygulama taramadan hesaplar).
//   - Kesif / dogrulama: feature-edge-study ile ayni SET_A (89 hisse) ve DISCOVERY_END.
//
// KULLANIM:
//   node scripts/next-session-study.mjs            # satirlari uret (.replay-cache/next-session-rows.json)
//   node scripts/next-session-report.mjs           # olcum raporu
// Veri: .replay-cache/<SEMBOL>_5y.json (feature-edge-study.mjs --fetch ile cekilir).
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const CACHE = path.join(ROOT, '.replay-cache');
const RANGE = '5y';
export const ROWS_FILE = path.join(CACHE, 'next-session-rows.json');
const WINDOW = 260;
const START = 200;
const ART_FWD = 11.5;
const TODAY = new Date().toISOString().slice(0, 10);
const isNum = Number.isFinite;

export const OUT_KEYS = ['cc1', 'gap1', 'oc1', 'oh1', 'ol1', 'hc1', 'rng1', 's3', 's5', 'lock1', 'art', 'artB', 'liq', 'br', 'brN'];

function loadBars(file) {
  return JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8'))
    .filter((b) => b && b.date < TODAY && [b.open, b.high, b.low, b.close].every((v) => isNum(v) && v > 0) && isNum(b.volume));
}

const pct = (a, b) => (a / b - 1) * 100;
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);

export async function buildRows() {
  const { nextSessionFeatures, indexFeatures, FEATURE_KEYS } = await import(U('utils/nextSession.js'));
  const { SET_A } = await import(pathToFileURL(path.join(HERE, 'feature-edge-study.mjs')).href);

  const xu = loadBars(`XU100_${RANGE}.json`);
  const xuC = xu.map((b) => b.close);
  const xuPos = new Map(xu.map((b, i) => [b.date, i]));
  const idxCache = new Map();
  const idxAt = (date) => {
    if (idxCache.has(date)) return idxCache.get(date);
    const i = xuPos.get(date);
    const f = i == null ? null : indexFeatures(xuC.slice(Math.max(0, i - 60), i + 1));
    idxCache.set(date, f);
    return f;
  };

  const files = fs.readdirSync(CACHE).filter((f) => f.endsWith(`_${RANGE}.json`) && !f.startsWith('XU100') && !f.startsWith('feature-'));
  const cols = ['sym', 'ab', 'd', 'nd', ...FEATURE_KEYS, ...OUT_KEYS];
  const data = Object.fromEntries(cols.map((k) => [k, []]));
  const t0 = Date.now();
  let nSym = 0;
  for (const f of files) {
    const sym = f.replace(`_${RANGE}.json`, '');
    const bars = loadBars(f);
    const n = bars.length;
    if (n < START + 30) continue;
    nSym++;
    const ab = SET_A.has(sym) ? 'A' : 'B';
    const c = bars.map((b) => b.close);
    const ch = c.map((x, i) => (i ? pct(x, c[i - 1]) : 0));
    for (let t = START; t < n - 1; t++) {
      const feat = nextSessionFeatures(bars.slice(Math.max(0, t - WINDOW + 1), t + 1), idxAt(bars[t].date));
      if (!feat) continue;
      const nb = bars[t + 1];
      let art = Math.abs(ch[t + 1]) > ART_FWD;
      for (let k = 2; k <= 5 && !art; k++) if (t + k < n && Math.abs(ch[t + k]) > ART_FWD) art = true;
      const artB = feat.art === 1;           // uygulamadaki ile ayni bayrak (nextSession.ARTIFACT_PCT)
      data.sym.push(sym); data.ab.push(ab); data.d.push(bars[t].date); data.nd.push(nb.date);
      for (const k of FEATURE_KEYS) data[k].push(feat[k]);
      data.cc1.push(r3(pct(nb.close, c[t])));
      data.gap1.push(r3(pct(nb.open, c[t])));
      data.oc1.push(r3(pct(nb.close, nb.open)));
      data.oh1.push(r3(pct(nb.high, nb.open)));
      data.ol1.push(r3(pct(nb.low, nb.open)));
      data.hc1.push(r3(pct(nb.high, c[t])));
      data.rng1.push(r3(((nb.high - nb.low) / c[t]) * 100));
      data.s3.push(t + 3 < n ? r3(pct(c[t + 3], nb.open)) : null);
      data.s5.push(t + 5 < n ? r3(pct(c[t + 5], nb.open)) : null);
      data.lock1.push(nb.high === nb.low ? 1 : 0);
      data.art.push(art ? 1 : 0); data.artB.push(artB ? 1 : 0);
      data.liq.push(isNum(feat.tl) && feat.tl >= Math.log10(2e6) ? 1 : 0);
      data.br.push(null); data.brN.push(null);
    }
  }
  // gun-duzeyi genislik: likit evrende o gun yukselenlerin orani
  const N = data.sym.length;
  const up = new Map(), cnt = new Map();
  for (let i = 0; i < N; i++) {
    if (!data.liq[i] || data.artB[i]) continue;
    cnt.set(data.d[i], (cnt.get(data.d[i]) || 0) + 1);
    if (data.chg1[i] > 0) up.set(data.d[i], (up.get(data.d[i]) || 0) + 1);
  }
  for (let i = 0; i < N; i++) {
    const m = cnt.get(data.d[i]) || 0;
    data.brN[i] = m;
    data.br[i] = m >= 20 ? r3((up.get(data.d[i]) || 0) / m) : null;
  }
  fs.writeFileSync(ROWS_FILE, JSON.stringify({ cols, n: N, built: TODAY, data }));
  console.log(`${nSym} hisse, ${N} satir, ${((Date.now() - t0) / 1000).toFixed(0)} sn -> ${path.relative(ROOT, ROWS_FILE)}`);
  return { cols, n: N, data };
}

export function loadRows() {
  if (!fs.existsSync(ROWS_FILE)) throw new Error('once: node scripts/next-session-study.mjs');
  return JSON.parse(fs.readFileSync(ROWS_FILE, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRows().catch((e) => { console.error(e); process.exit(1); });
}
