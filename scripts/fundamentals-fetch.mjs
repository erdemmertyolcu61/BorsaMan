#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// fundamentals-fetch.mjs — İŞ YATIRIM MALİ TABLO GEÇMİŞİ (v31.57)
// ════════════════════════════════════════════════════════════════════
//
// Bilanço katmanını ÖLÇMEK için: taramanın evrenindeki her hisse için 20 çeyreklik
// İş Yatırım MaliTablo verisi (Hisse detayının kullandığı kaynak ve ayrıştırıcı:
// src/utils/financialStatements.js → buildMaliTabloUrl, mergeMaliTablo).
// Çıktı: .replay-cache/fin/<SEMBOL>.json  { group, merged, fetchedAt }
//
// Neden İş Yatırım: taramanın bugünkü bilanço kapısı Yahoo quoteSummary okuyor ve
// Yahoo'nun BIST temel verisi delikli (THYAO PD/DD 46 kat hatalı — CLAUDE.md).
//
// KULLANIM:
//   node scripts/fundamentals-fetch.mjs            # eksikleri çek
//   node scripts/fundamentals-fetch.mjs --refresh  # hepsini yeniden çek
//   node scripts/fundamentals-study.mjs            # ölçüm
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const U = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const OUT = path.join(ROOT, '.replay-cache', 'fin');
export const FIN_DIR = OUT;
const QUARTERS = 20;
const PER_REQ = 4;
const GROUPS = ['XI_29', 'XI_29K', 'UFRS_K', 'UFRS'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!t.trim().startsWith('{')) return { value: [] };
      return JSON.parse(t);
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  return { value: [] };
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const FS = await import(U('utils/financialStatements.js'));
  const { getStockList } = await import(U('utils/constants.js'));
  fs.mkdirSync(OUT, { recursive: true });
  const universe = [...new Set(getStockList('bistall'))].sort();
  const todo = universe.filter((s) => refresh || !fs.existsSync(path.join(OUT, `${s}.json`)));
  const { y, p } = FS.latestQuarterEnd(new Date());
  const ends = FS.quarterEndsBack(y, p, QUARTERS);
  const chunks = [];
  for (let i = 0; i < ends.length; i += PER_REQ) chunks.push(ends.slice(i, i + PER_REQ));
  console.log(`evren ${universe.length}, cekilecek ${todo.length}, ceyrek ${ends[ends.length - 1].y}/${ends[ends.length - 1].p} .. ${ends[0].y}/${ends[0].p}`);

  let ok = 0, none = 0, fail = 0;
  const one = async (sym) => {
    try {
      for (const group of GROUPS) {
        const first = await getJson(FS.buildMaliTabloUrl(sym, group, chunks[0]));
        const rows0 = Array.isArray(first?.value) ? first.value : [];
        if (!rows0.length) continue;
        const parts = [{ ok: true, rows: rows0, labels: chunks[0].map((q) => FS.periodLabel(q.y, q.p)) }];
        for (const c of chunks.slice(1)) {
          const j = await getJson(FS.buildMaliTabloUrl(sym, group, c));
          const rows = Array.isArray(j?.value) ? j.value : [];
          if (rows.length) parts.push({ ok: true, rows, labels: c.map((q) => FS.periodLabel(q.y, q.p)) });
        }
        fs.writeFileSync(path.join(OUT, `${sym}.json`), JSON.stringify({ group, merged: FS.mergeMaliTablo(parts), fetchedAt: Date.now() }));
        ok++;
        return;
      }
      fs.writeFileSync(path.join(OUT, `${sym}.json`), JSON.stringify({ group: null, merged: null, fetchedAt: Date.now() }));
      none++;
    } catch (e) {
      fail++;
      if (fail <= 5) console.log(`  hata ${sym}: ${e.message}`);
    }
  };
  const queue = todo.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      await one(s);
      await new Promise((res) => setTimeout(res, 150));
      const done = todo.length - queue.length;
      if (done % 50 === 0) console.log(`  ${done}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);
    }
  }));
  console.log(`yazildi ${ok} · tablo yok ${none} · hata ${fail} · ${((Date.now() - t0) / 1000).toFixed(0)} sn`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
