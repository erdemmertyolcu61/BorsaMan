#!/usr/bin/env node
// ── ARKA PLAN SINYAL TAKIBI (v31.27) ──────────────────────────────────────
//
// GitHub Actions cron tarafindan calistirilir. Uygulama KAPALIYKEN bile:
//   1) Upstash'ten kayitli cihazlari + takip edilen sinyalleri okur
//   2) Sembollerin guncel fiyatlarini ceker
//   3) trackingAlerts.js ile — tarayicidakiyle AYNI saf mantik — hangi
//      uyarilarin atilacagina karar verir
//   4) Web Push ile telefona bildirim gonderir
//
// Neden bu is var: mobil WebView arka planda JS'i donduruyor (OS siniri), bu
// yuzden "kapaliyken haber ver" istegi ancak sunucu tarafinda cozulebilir.
//
// Ortam degiskenleri (GitHub repo secrets):
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...)
//   PROXY_BASE_URL (opsiyonel — fiyat icin kendi Vercel proxy'n)

import webpush from 'web-push';
import { buildTrackingAlerts, formatAlert } from '../src/utils/trackingAlerts.js';

const DRY_RUN = process.argv.includes('--dry-run');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const PROXY = (process.env.PROXY_BASE_URL || '').replace(/\/+$/, '');

const PRICE_GAP_MS = 1500;   // BigPara burst kisitlamasinin altinda kal
const log = (...a) => console.log('[track]', ...a);

// ── Upstash REST yardimcilari ──────────────────────────────────────────────
async function redis(path, opts = {}) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Upstash env degiskenleri eksik');
  const res = await fetch(`${REDIS_URL}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`redis ${path} → ${res.status}`);
  return res.json();
}

const getJson = async (key) => {
  const r = await redis(`get/${encodeURIComponent(key)}`);
  if (!r?.result) return null;
  try { return typeof r.result === 'string' ? JSON.parse(r.result) : r.result; }
  catch { return null; }
};

// ── Fiyat cekme ────────────────────────────────────────────────────────────
// Kendi proxy'n varsa oradan (whitelist + edge cache), yoksa dogrudan.
async function fetchPrice(symbol) {
  const remote = `https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/${symbol}`;
  const url = PROXY ? `${PROXY}/api/proxy?url=${encodeURIComponent(remote)}` : remote;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://bigpara.hurriyet.com.tr/',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    // Alan adi `kapanis` — uygulamanin kendi ayristiricisiyla (fetchEngine
    // fetchBigParaQuote) BIREBIR ayni. Ilk yazimda `son` demistim; dogrulama
    // sirasinda yakalandi. Yanlis alan adi bu isi SESSIZCE hicbir bildirim
    // atmayan bir noop'a cevirirdi.
    const p = parseFloat(j?.data?.hisseYuzeysel?.kapanis);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/**
 * BigPara ardisik hizli isteklerde kisitliyor (olculdu: 401, 20s sonra 200).
 * Bu is aceleci degil — kucuk gruplar + aralarda nefes.
 */
async function fetchPrices(symbols) {
  const out = {};
  // SIRALI, aralikli. Ilk surum 5 paralel istek atiyordu ve dogrulama sirasinda
  // sembollerin bir kismi 401 aldi — tam olarak taramada dusundugumuz tuzak.
  // Bu is aceleci degil: en fazla ~40 sembol, 10 dakika butce. Kaciran bir
  // sembol "bildirim gelmedi" demek, o yuzden yavas ama eksiksiz olmali.
  for (const sym of symbols) {
    const p = await fetchPrice(sym);
    if (p != null) out[sym] = p;
    await new Promise(r => setTimeout(r, PRICE_GAP_MS));
  }
  return out;
}

const istanbulDay = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

// ── Ana akis ───────────────────────────────────────────────────────────────
async function main() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!DRY_RUN) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('VAPID anahtarlari eksik');
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:noreply@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }

  const devicesRes = await redis('smembers/bist:track:devices');
  const devices = devicesRes?.result || [];
  if (!devices.length) { log('kayitli cihaz yok — cikiliyor'); return; }
  log(`${devices.length} cihaz`);

  const dayKey = istanbulDay();

  for (const id of devices) {
    const rec = await getJson(`bist:track:${id}`);
    if (!rec?.subscription || !Array.isArray(rec.signals) || !rec.signals.length) {
      log(`${id}: takip edilen sinyal yok`);
      continue;
    }
    const sentKey = `bist:track:sent:${id}`;
    const sent = (await getJson(sentKey)) || [];

    const symbols = [...new Set(rec.signals.map(s => s.symbol))];
    const prices = await fetchPrices(symbols);
    log(`${id}: ${Object.keys(prices).length}/${symbols.length} fiyat alindi`);

    const { alerts, keys } = buildTrackingAlerts(rec.signals, prices, { sent, dayKey, max: 6 });
    if (!alerts.length) { log(`${id}: uyari yok`); continue; }

    for (const a of alerts) {
      const { title, body } = formatAlert(a);
      log(`${id}: ${a.kind} ${a.symbol} ${a.pct}%${DRY_RUN ? ' (dry-run)' : ''}`);
      if (DRY_RUN) continue;
      try {
        await webpush.sendNotification(rec.subscription, JSON.stringify({
          title, body, tag: `bist-${a.symbol}-${a.kind}`, renotify: true, symbol: a.symbol, url: '/',
        }));
      } catch (err) {
        // 404/410 = abonelik olmus; kaydi birak, bir sonraki acilista yenilenir.
        log(`${id}: push basarisiz (${err.statusCode || err.message})`);
      }
    }

    if (!DRY_RUN) {
      // Gonderilenleri hatirla — ayni olay tekrar bildirilmesin. Liste sinirli
      // tutulur; eski anahtarlar zaten kapanmis sinyallere ait.
      const merged = [...new Set([...sent, ...keys])].slice(-300);
      await redis(`set/${encodeURIComponent(sentKey)}?EX=${60 * 60 * 24 * 45}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
    }
  }
  log('bitti');
}

main().catch((err) => { console.error('[track] HATA:', err.message); process.exit(1); });
