#!/usr/bin/env node
// ── prebuild: ML kural anlik goruntusu (v31.39) ─────────────────────────────
//
// src/utils/mlRules.js `src/data/mlRules.json`'u STATIK import eder; dosya yoksa
// Vite build'i kirilir. Eski prebuild her ortamda sessizce BOS bir yedek yaziyordu.
//
// OLCULEN SONUC (2026-09-12): kok .vercelignore'daki `data` satiri src/data/'yi
// Vercel build'inden siliyordu. Prebuild bos yedegi yazdi, build "basarili" oldu
// ve PWA 2026-07'den beri 120 kural yerine 0 kuralla yayinlandi. Yayindaki
// mlRules chunk'inda "empty fallback" metni vardi. Web/mobil ML boost'u hic
// calismadi, kimse fark etmedi.
//
// Yeni kural: dosya DEPODA. Build ortaminda (Vercel / CI) yoksa bu bir hatadir,
// yuksek sesle dus. Yalniz yerelde (taze klon, dosya silinmis) bos yedek yazilir
// ve bu da acikca soylenir.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const FILE = 'src/data/mlRules.json';

if (!existsSync(FILE)) {
  if (process.env.VERCEL || process.env.CI) {
    console.error(`[prebuild] ${FILE} build ortaminda YOK, ama dosya depoda kayitli.`);
    console.error('[prebuild] Muhtemel sebep: .vercelignore / checkout onu disarida birakti.');
    console.error('[prebuild] Bos yedekle devam edilmiyor: web/mobil ML skorlamasi sessizce kapanirdi.');
    process.exit(1);
  }
  mkdirSync('src/data', { recursive: true });
  writeFileSync(FILE, JSON.stringify({ rules: [], _meta: { note: 'empty fallback' } }));
  console.warn(`[prebuild] ${FILE} yoktu. BOS yedek yazildi; bu build'de web ML skorlamasi devre disi.`);
}
