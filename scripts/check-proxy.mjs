#!/usr/bin/env node
// ── PROXY DOGRULAMA (v31.39) — yayindaki dagitima salt-okunur GET ───────────
//
//   npm run check:proxy                              # varsayilan dagitim
//   npm run check:proxy -- https://baska-proxy.vercel.app
//
// NEDEN: "deploy bitti" ile "yayindaki uclar guncel" ayni sey degil. Eski bir
// dagitim yeni kaynak adlarini `400 Invalid source parameter` ile reddeder ve
// istemci bunu `proxy_outdated` olarak gosterir. Bu betik uclara bakip ayirt eder.
//
// OLCULEN TUZAK (2026-09-12): kokten `vercel --prod --cwd proxy` dosyalari
// proxy/'den yukledi ama vercel.json'u KOKTEN aldi (Vite `npm run build` + `dist`
// + SPA rewrite) → build "Missing script: build" ile dustu, yayin eski kaldi.
// `npm run deploy:proxy` proxy/ ICINE girip deploy eder ve ardindan bu betigi kosar.

import { DEFAULT_PROXY_URL } from '../src/utils/proxyTarget.js';

const base = String(process.argv[2] || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
const TIMEOUT_MS = 25_000;

const CHECKS = [
  {
    // Mevcut rota: yeni dagitim eskiyi bozmadi mi?
    name: 'yahoo (mevcut rota)',
    path: '/api/proxy?source=yahoo&symbol=THYAO&range=5d&interval=1d',
    verify: j => {
      const n = j?.chart?.result?.[0]?.timestamp?.length;
      return n > 0 ? `THYAO ${n} bar` : null;
    },
  },
  {
    name: 'isy_foreign (hisse bazli yabanci orani)',
    path: '/api/proxy?source=isy_foreign',
    verify: j => (j?.ok === true && j.count >= 400 ? `${j.count} hisse` : null),
  },
  {
    // Tatil gunleri 0 bildirim donebilir; dogru sekil yeterli.
    name: 'kap_disclosures (KAP bildirim akisi)',
    path: '/api/proxy?source=kap_disclosures&days=3',
    verify: j => (j?.ok === true && Array.isArray(j.items)
      ? `${j.count} bildirim (${j.fromDate} - ${j.toDate})` : null),
  },
  {
    // v31.40: birlesik gunluk barlar (Is Yatirim gunleri + Yahoo gercek acilislari)
    name: 'bars (gunluk bar + gercek acilis)',
    path: '/api/proxy?source=bars&symbol=THYAO&days=60',
    verify: j => (j?.ok === true && j.count >= 20
      ? `${j.count} bar, gercek acilis ${j.openReal} / yaklasik ${j.openApprox} (${j.source})` : null),
  },
  {
    // v31.43: quoteSummary (v10) crumb ister — crumb enjeksiyonu eskiden yalniz /v8/ icindi,
    // bu yuzden advisor'in temel kalite kapisi 401 aliyordu.
    name: 'yahoo quoteSummary (temel veri, crumb)',
    path: '/api/proxy?url=' + encodeURIComponent(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/THYAO.IS?modules=financialData,defaultKeyStatistics'),
    verify: j => (j?.quoteSummary?.result?.[0]
      ? `modul ${Object.keys(j.quoteSummary.result[0]).join(',')}`
      : (j?.finance?.error?.description ? `HATA: ${j.finance.error.description}` : null)),
  },
  {
    // v31.43: bilanco — istemci artik bu yolu kullaniyor (Vite rotasi yalniz localhost'ta var)
    name: 'isyatirim MaliTablo (bilanco)',
    path: '/api/proxy?url=' + encodeURIComponent(
      'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo'
      + '?companyCode=THYAO&exchange=TRY&financialGroup=XI_29&year1=2026&period1=6'
      + '&year2=2026&period2=3&year3=2025&period3=12&year4=2025&period4=9'),
    verify: j => (Array.isArray(j?.value) && j.value.length > 20 ? `${j.value.length} satir` : null),
  },
];

async function probe(path) {
  const t0 = Date.now();
  const r = await fetch(base + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON degil, text raporlanir */ }
  return { status: r.status, json, text, ms: Date.now() - t0 };
}

console.log(`Proxy: ${base}\n`);
let failed = 0;
for (const c of CHECKS) {
  try {
    const { status, json, text, ms } = await probe(c.path);
    const detail = status === 200 ? c.verify(json) : null;
    if (detail) {
      console.log(`  OK    ${c.name}: ${detail} (${ms} ms)`);
    } else {
      failed++;
      console.log(`  HATA  ${c.name}: HTTP ${status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  } catch (e) {
    failed++;
    const why = e?.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000} sn zaman asimi` : e?.message;
    console.log(`  HATA  ${c.name}: ${why}`);
  }
}

// Bilgi amacli: yerel Express sunucusunun kaynagi yayinda mi? (proxy/.vercelignore)
try {
  const r = await fetch(`${base}/index.js`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  await r.arrayBuffer();
  console.log(r.status === 200
    ? '\n  UYARI /index.js hala statik servis ediliyor (.vercelignore oncesi dagitim).'
    : '\n  bilgi /index.js servis edilmiyor (beklenen).');
} catch { /* bilgi amacli; sonucu etkilemez */ }

if (failed) {
  console.log(`\n${failed} kontrol basarisiz. "Invalid source parameter" = yayindaki proxy eski.`);
  console.log('Deploy (depo kokunden): npm run deploy:proxy');
  process.exit(1);
}
console.log('\nProxy guncel.');
