// ── KAP BILDIRIM AKISI (v31.38) — saf siniflandirma + ince fetch katmani ──
//
// OLCULEN (2026-09-12, canli istek):
//
//   POST https://www.kap.org.tr/tr/api/disclosure/list/main
//   govde { fromDate:'dd.mm.yyyy', toDate:'dd.mm.yyyy', disclosureTypes:null,
//           memberTypes:['IGS'], mkkMemberOid:null | '<32 hex>' }
//
//   - 3 gun:  674 bildirim, 207 farkli hisse, 132 ms
//   - 14 gun: 2628 bildirim, 2,5 MB ham
//   - THYAO (mkkMemberOid) 60 gun: 11 bildirim
//   - proxy ince formati, 7 gun: 1087 bildirim, 267 KB ham / 50 KB gzip
//
// 2026-09-07 olcumu "kararli veri ucu yok" demisti. O olcum eksikti: yalniz
// sayfanin ilk JS parcalarina bakilmisti; uc adlari sabitler tablosu olan ayri
// bir parcadaydi (GET_NOTIFICATION_DATA → api/disclosure/list/main). Eski
// kapEngine'in gomulu OID tablosu da hataliydi (THYAO icin baska bir kimlik).
//
// SINIFLANDIRMA NEDEN SART: akisin cogu hisseyle ilgisiz rutin (14 gunde 771
// devre kesici / test kaydi, 322 borclanma araci ihraci). Ve bazi basliklar
// gorundugu gibi degil: "SPK Islem Yasagi Nedeniyle Pay Duyurusu" TEK duyuruda
// THYAO, AKBNK, GARAN dahil 68 hisseyi listeliyor — yasakli YATIRIMCILARIN
// paylari hakkinda, hissenin kendisine tedbir DEGIL. Onu sert filtre yapmak
// blue-chip'leri gunlerce AL listesinden silerdi. Sert filtre (kind 'risk')
// yalniz hissenin KENDISINE uygulanan islem tedbirleri icindir.

import { PROXY_BASE_URL } from './fetchEngine.js';
import { isKapRiskGuardEnabled } from './dataLayerPolicy.js';

export const KAP_DISCLOSURE_URL = 'https://www.kap.org.tr/tr/Bildirim/';
/** Tarama bu kadar gunluk akisi ceker (Pazartesi Cuma'yi da kapsasin). */
export const KAP_SCAN_DAYS = 7;
/** Islem tedbiri bu kadar gun "aktif risk" sayilir (muhafazakar). */
export const KAP_RISK_WINDOW_DAYS = 7;
/** Piyasa ekraninin varsayilan akis penceresi. */
export const KAP_FEED_DISPLAY_DAYS = 3;
export const KAP_OID_LEARNED_KEY = 'bist_kap_oid_learned';

const MAX_MARKET_DAYS = 14;
const MAX_SYMBOL_DAYS = 180;
const FEED_TTL_MS = 5 * 60 * 1000;
const SYMBOL_TTL_MS = 10 * 60 * 1000;
const IST_OFFSET_MS = 3 * 60 * 60 * 1000; // Istanbul UTC+3, 2016'dan beri DST yok
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Metin yardimcilari ────────────────────────────────────────────────────

/** Diyakritik-duyarsiz, kucuk harf, tek bosluk. Kurallar ASCII yazilir. */
export function normalizeTr(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s === '-' ? '' : s;
}

/** "12.09.2026 11:32:32" (Istanbul) → epoch ms. Gecersizse null. */
export function parseKapDate(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const ms = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss) - IST_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

/** epoch ms → KAP istek tarihi "dd.mm.yyyy" (Istanbul gunu). */
export function formatKapRequestDate(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Bugunden `days` takvim gunu geriye aralik (proxy ile ayni anlam). */
export function kapDateRange(days, now = Date.now()) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  return { fromDate: formatKapRequestDate(now - d * DAY_MS), toDate: formatKapRequestDate(now) };
}

/** "OYA, OYYAT" → ['OYA','OYYAT']. Ticker disi parcalar atilir. */
export function splitStockCodes(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const out = [];
  for (const part of value.split(/[,;\s]+/)) {
    const code = part.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{2,5}$/.test(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

// ── Siniflandirma ─────────────────────────────────────────────────────────
//
// kind:
//   risk    — hissenin kendisine islem tedbiri / temerrut / iflas → AL'dan cikar
//   caution — dikkat, ama filtre degil (devre kesici, yatirimci bazli SPK duyurusu)
//   event   — fiyati oynatabilecek sirket olayi (yon bilinmez; OLCULUR)
//   info    — ilgili ama notr
//   noise   — hisseyle ilgisiz rutin (borclanma araci, formlar, bultenler)

const risk = (type, label) => ({ kind: 'risk', type, label });
const caution = (type, label) => ({ kind: 'caution', type, label });
const event = (type, label) => ({ kind: 'event', type, label });
const info = (type, label) => ({ kind: 'info', type, label });
const noise = (type, label) => ({ kind: 'noise', type, label });

// Olculen 14 gunluk basliklardan (2026-09-12). Olay kurallarindan ONCE bakilir:
// "Sermaye Artirimindan Elde Edilen Fonun Kullanimi" gibi raporlar olay degil.
const NOISE_PATTERNS = [
  /pay disinda sermaye piyasasi araci/, /varant/, /borclanma araclari/, /kira sertifika/,
  /ihrac tavani/, /ihrac belgesi/, /tertip ihrac/, /izahname/, /fiyat tespit raporu/,
  /halka arz fiyatinin/, /bilgi formu/, /katilim finansi/, /piyasa yapiciligi/,
  /likidite saglayicilik/, /takasbank/, /haftalik rapor/, /yatirimci raporu/,
  /surdurulebilirlik raporu/, /faaliyet raporu/, /sorumluluk beyani/, /entegre rapor/,
  /fonun kullanim/, /hak kullanim/, /esas sozlesme/, /bagimsiz denetim/, /kurumsal yonetim/,
  /yonetim kurulu komite/, /sirket merkezi degisikligi/, /kamuyu aydinlatma platformu duyurusu/,
  /spk bulteni/, /islem iptali/, /islem gormeye baslamasi/, /genel kurul/,
];

export const KAP_TYPE_LABELS = Object.freeze({
  trading_measure: 'İşlem tedbiri',
  trading_halt: 'İşlem sırası kapatıldı',
  payment_default: 'Ödeme gerçekleşmedi',
  insolvency: 'Konkordato / iflas',
  circuit_breaker: 'Devre kesici',
  halt_reopen: 'İşleme yeniden açıldı',
  investor_ban_notice: 'SPK yatırımcı yasağı duyurusu',
  share_conversion: 'İşlem gören tipe dönüşüm',
  watch_market: 'Gözaltı Pazarı',
  lawsuit: 'Dava',
  contract_cancel: 'Sözleşme feshi',
  buyback: 'Geri alım',
  insider_trade: 'Pay alım-satım',
  new_business: 'Yeni iş',
  tender: 'İhale',
  dividend: 'Kâr payı',
  bonus_issue: 'Bedelsiz',
  capital_increase: 'Sermaye artırımı',
  earnings: 'Finansal rapor',
  rating: 'Derecelendirme',
  m_and_a: 'Birleşme / edinim',
  transfer: 'Transfer',
  index_change: 'Endeks değişikliği',
  block_trade: 'Toptan alış-satış',
  rumor_response: 'Haber açıklaması',
  material_event: 'Özel durum',
  routine: 'Rutin',
  other: 'Bildirim',
});

/** Olculecek "olay" tipleri (dataLayerEdge bunlari kovalar). */
export const KAP_EVENT_TYPES = Object.freeze([
  'buyback', 'insider_trade', 'new_business', 'tender', 'dividend', 'bonus_issue',
  'capital_increase', 'earnings', 'rating', 'm_and_a', 'transfer', 'index_change',
]);

/**
 * Tek bildirimi siniflandir. Girdi normalizeKapItems ciktisi (veya en azindan
 * { title, summary, klass, company }).
 */
export function classifyKapItem(item) {
  const t = normalizeTr(item?.title);
  const s = normalizeTr(item?.summary);
  const company = normalizeTr(item?.company);
  const both = `${t} ${s}`;
  const klass = String(item?.klass || '').toUpperCase();
  const fromExchange = company.includes('borsa istanbul');

  // RISK — hissenin kendisi
  if (fromExchange && /tedbir/.test(s)) {
    if (/volatilite/.test(s)) return risk('trading_measure', 'VBTS işlem tedbiri');
    if (/yatirimci bazinda/.test(s)) return risk('trading_measure', 'Yatırımcı bazında tedbir');
    return risk('trading_measure', 'İşlem tedbiri');
  }
  if (/islem sirasi/.test(t) || /sirasinin isleme/.test(s)) {
    if (/kapat/.test(s)) return risk('trading_halt', 'İşlem sırası kapatıldı');
    if (/acil/.test(s)) return caution('halt_reopen', 'İşleme yeniden açıldı');
  }
  if (/gerceklesmeyen (itfa|kupon|getiri)/.test(both)) return risk('payment_default', 'Gerçekleşmeyen itfa/kupon ödemesi');
  if (klass === 'ODA' && /konkordato|iflas/.test(both)) return risk('insolvency', 'Konkordato / iflas');

  // CAUTION — goster, filtreleme
  if (/devre kesici/.test(t)) return caution('circuit_breaker', 'Devre kesici devreye girdi');
  if (/islem yasagi/.test(both)) return caution('investor_ban_notice', 'SPK işlem yasağı duyurusu (yatırımcı bazlı)');
  if (/tipe donusum/.test(t)) return caution('share_conversion', 'Borsada işlem gören tipe dönüşüm');
  if (/gozalti pazar/.test(both)) return caution('watch_market', 'Gözaltı Pazarı');
  if (/dava/.test(t)) return caution('lawsuit', 'Dava gelişmesi');
  if (/sozlesme feshi/.test(t)) return caution('contract_cancel', 'Sözleşme feshi');

  // NOISE — olaylardan once
  if (NOISE_PATTERNS.some((re) => re.test(t))) return noise('routine', 'Rutin bildirim');

  // EVENT — yon bilinmez, olculur
  if (/paylarin geri alinmasi|geri alim/.test(t)) return event('buyback', 'Pay geri alımı');
  if (/pay alim satim bildirimi/.test(t)) return event('insider_trade', 'Pay alım satım bildirimi');
  if (/yeni is iliskisi/.test(t)) return event('new_business', 'Yeni iş ilişkisi');
  if (/ihale/.test(t)) return event('tender', 'İhale süreci / sonucu');
  if (/kar payi/.test(t)) return event('dividend', 'Kâr payı dağıtımı');
  if (/sermaye artirimi/.test(t)) {
    return /bedelsiz/.test(s)
      ? event('bonus_issue', 'Bedelsiz sermaye artırımı')
      : event('capital_increase', 'Sermaye artırımı');
  }
  if (klass === 'FR' && /finansal rapor/.test(t)) return event('earnings', 'Finansal rapor');
  if (/kredi derecelendirme/.test(t)) return event('rating', 'Kredi derecelendirmesi');
  if (/birlesme|duran varlik edinimi|pay alim teklifi/.test(t)) return event('m_and_a', 'Birleşme / satın alma');
  if (/transfer gorusme/.test(t)) return event('transfer', 'Transfer görüşmesi');
  if (/endeks sirketlerinde degisiklik/.test(t)) return event('index_change', 'Endeks değişikliği');

  // INFO
  if (/toptan alis satis/.test(both)) return info('block_trade', 'Toptan alış satış');
  if (/haber ve soylenti/.test(t)) return info('rumor_response', 'Haber/söylenti açıklaması');
  if (/ozel durum aciklamasi/.test(t)) return info('material_event', 'Özel durum açıklaması');
  return info('other', cleanText(item?.title) || 'Bildirim');
}

function isTestItem(title, summary, company) {
  return /^kap test/.test(normalizeTr(company))
    || normalizeTr(title) === 'test bildirimi'
    || normalizeTr(summary) === 'test bildirimi';
}

/**
 * Ham KAP dizisini (disclosureBasic) VEYA proxy'nin ince formatini
 * ({i,c,r,t,s,k,d,m,o}) tek sekle cevir. Test kayitlari atilir, en yeni once.
 *
 * `subjects` bildirimin KONUSU olan hisseler: sirketin kendi bildiriminde yalniz
 * kendi kodu; borsa/MKK duyurusunda (kendi kodu yok) relatedStocks. Olculdu: bir
 * portfoy yonetim sirketinin "Pay Alim Satim Bildirimi" relatedStocks'ta 29 hisse
 * listeliyordu — bunlari o hisselerin "olayi" saymak olcumu kirletirdi.
 */
export function normalizeKapItems(input) {
  const list = Array.isArray(input) ? input : (Array.isArray(input?.items) ? input.items : []);
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw.disclosureBasic;
    const src = b
      ? { id: b.disclosureIndex, codes: b.stockCode, related: b.relatedStocks, title: b.title, summary: b.summary, klass: b.disclosureClass, date: b.publishDate, company: b.companyTitle, oid: b.mkkMemberOid }
      : { id: raw.i, codes: raw.c, related: raw.r, title: raw.t, summary: raw.s, klass: raw.k, date: raw.d, company: raw.m, oid: raw.o };
    const id = Number(src.id);
    const ts = parseKapDate(src.date);
    if (!Number.isFinite(id) || ts == null) continue;
    const title = cleanText(src.title);
    const summary = cleanText(src.summary);
    const company = cleanText(src.company);
    if (isTestItem(title, summary, company)) continue;
    const primary = splitStockCodes(src.codes);
    const related = splitStockCodes(src.related);
    const item = {
      id, ts, title, summary, company,
      klass: String(src.klass || '').toUpperCase(),
      oid: typeof src.oid === 'string' ? src.oid : null,
      primary,
      symbols: [...new Set([...primary, ...related])],
      subjects: primary.length ? primary : related,
      url: KAP_DISCLOSURE_URL + id,
    };
    item.cls = classifyKapItem(item);
    out.push(item);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// ── Sembol indeksi ────────────────────────────────────────────────────────

/**
 * Hisse bazli ozet (bildirimin konusu olan hisseler uzerinden). Rutin (noise)
 * sayilmaz; risk ayri pencereyle tutulur.
 * @returns {{ bySymbol: Object<string, object>, noise: number, total: number, builtAt: number }}
 */
export function buildKapIndex(items, { now = Date.now(), eventWindowDays = KAP_SCAN_DAYS, riskWindowDays = KAP_RISK_WINDOW_DAYS } = {}) {
  const bySymbol = {};
  let noiseCount = 0;
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    const cls = it.cls || classifyKapItem(it);
    if (cls.kind === 'noise') { noiseCount++; continue; }
    const ageDays = (now - it.ts) / DAY_MS;
    for (const sym of it.subjects || it.symbols || []) {
      let e = bySymbol[sym];
      if (!e) {
        e = { symbol: sym, count: 0, lastTs: 0, headline: '', events: [], cautions: [], risk: null, items: [] };
        bySymbol[sym] = e;
      }
      if (ageDays <= eventWindowDays) {
        e.count++;
        if (it.ts > e.lastTs) { e.lastTs = it.ts; e.headline = it.summary || it.title; }
        if (cls.kind === 'event' && !e.events.includes(cls.type)) e.events.push(cls.type);
        if (cls.kind === 'caution' && !e.cautions.includes(cls.type)) e.cautions.push(cls.type);
        if (e.items.length < 5) {
          e.items.push({ id: it.id, ts: it.ts, title: it.title, summary: it.summary, kind: cls.kind, type: cls.type, label: cls.label, url: it.url });
        }
      }
      if (cls.kind === 'risk' && ageDays <= riskWindowDays) {
        (e._risks || (e._risks = [])).push({ type: cls.type, label: cls.label, ts: it.ts, id: it.id, url: it.url });
      }
      if (cls.type === 'halt_reopen' && it.ts > (e._reopenTs || 0)) e._reopenTs = it.ts;
    }
  }
  // Olculdu (TRILC, 11.09.2026): islem sirasi 09:20'de kapandi, 11:27'de acildi.
  // Sonradan acilan bir kapatma aktif risk degildir — yoksa hisse bir hafta boyunca
  // AL disinda kalirdi. Daha eski baska bir risk (VBTS gibi) varsa o gecerli kalir.
  for (const e of Object.values(bySymbol)) {
    const active = (e._risks || []).filter((r) => !(r.type === 'trading_halt' && (e._reopenTs || 0) > r.ts));
    e.risk = active.length ? active.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
    delete e._risks;
    delete e._reopenTs;
  }
  return { bySymbol, noise: noiseCount, total: list.length, builtAt: now };
}

/**
 * Tarama satirlarina KAP alanlarini yaz. Akis BASARILIYSA bildirimi olmayan
 * hisse de `kapChecked: true, kapCount: 0` alir — boylece olcum "bildirim yok"u
 * "o gun veri yoktu"dan ayirabilir.
 * @returns {number} en az bir bildirimi (veya aktif riski) olan satir sayisi
 */
export function attachKapFields(rows, index) {
  if (!Array.isArray(rows) || !index?.bySymbol) return 0;
  let tagged = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.symbol) continue;
    const e = index.bySymbol[r.symbol];
    r.kapChecked = true;
    if (!e) {
      r.kapCount = 0;
      r.kapCategories = [];
      continue;
    }
    r.kapCount = e.count;
    r.kapCategories = e.events.slice();
    r.kapCautions = e.cautions.slice();
    r.kapHeadline = e.headline;
    r.kapLastTs = e.lastTs || null;
    r.kapRisk = e.risk ? e.risk.type : null;
    r.kapRiskLabel = e.risk ? e.risk.label : null;
    if (e.count > 0 || e.risk) tagged++;
  }
  return tagged;
}

/** Bu satir AL listesinden cikarilmali mi? (politika bayragina bagli) */
export function isKapBuyBlocked(row) {
  return !!(row && row.kapRisk) && isKapRiskGuardEnabled();
}

// ── OID (sirket kimligi) cozumleme ────────────────────────────────────────
// Oncelik: canli akistan ogrenilen > depodaki anlik goruntu
// (src/data/kapMemberOids.json, /tr/bist-sirketler'den uretildi, 788 kod).

function readLearnedOids() {
  try {
    const raw = localStorage.getItem(KAP_OID_LEARNED_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** Akistaki sirket bildirimlerinden kod → OID eslesmesi ogren (kendi kendini onarir). */
export function learnKapOids(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const map = readLearnedOids();
  let changed = 0;
  for (const it of items) {
    if (!it?.oid || !/^[0-9a-f]{32}$/i.test(it.oid)) continue;
    for (const code of it.primary || []) {
      if (map[code] !== it.oid) { map[code] = it.oid; changed++; }
    }
  }
  if (changed) {
    try { localStorage.setItem(KAP_OID_LEARNED_KEY, JSON.stringify(map)); } catch { /* kota — kritik degil */ }
  }
  return changed;
}

let _snapshotPromise = null;
function loadOidSnapshot() {
  if (!_snapshotPromise) {
    _snapshotPromise = import('../data/kapMemberOids.json')
      .then((m) => (m?.default || m)?.oids || {})
      .catch(() => ({}));
  }
  return _snapshotPromise;
}

export async function resolveKapOid(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const learned = readLearnedOids();
  if (learned[sym]) return learned[sym];
  const snap = await loadOidSnapshot();
  return snap[sym] || null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────
// Uretim: kendi proxy'miz (POST'u sunucu yapar, ince format doner).
// Yerel gelistirme (PROXY_BASE_URL bos): Vite `/api/kap` KAP'a iletir.

const _cache = new Map();

function failure(reason) {
  return { ok: false, items: [], reason };
}

function errorReason(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network';
}

async function readProxyJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 400) {
    const text = await res.text().catch(() => '');
    // Eski dagitim yeni kaynak adini tanimaz — "bos" degil, "guncel degil".
    return { error: /invalid source/i.test(text) ? 'proxy_outdated' : 'http_400' };
  }
  if (!res.ok) return { error: `http_${res.status}` };
  return { json: await res.json() };
}

async function postKapViaDevServer(body, timeoutMs) {
  const res = await fetch('/api/kap/tr/api/disclosure/list/main', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { error: `http_${res.status}` };
  return { json: await res.json() };
}

function clampDays(days, max) {
  return Math.min(max, Math.max(1, Math.floor(Number(days) || 1)));
}

/**
 * Piyasa geneli bildirim akisi (tum hisseler, tek istek).
 * @returns {Promise<{ok: boolean, items: object[], days?: number, fetchedAt?: number, reason?: string}>}
 */
export async function fetchKapFeed({ days = KAP_FEED_DISPLAY_DAYS, force = false, timeoutMs = 12000 } = {}) {
  const d = clampDays(days, MAX_MARKET_DAYS);
  const now = Date.now();
  if (!force) {
    // Daha genis ve taze bir kayit varsa onu suz (tarama 7 gun ceker, ekran 3 ister).
    for (const [key, hit] of _cache) {
      if (!key.startsWith('feed:') || now - hit.ts >= FEED_TTL_MS) continue;
      if (hit.value.days >= d) {
        const cutoff = now - d * DAY_MS;
        return { ...hit.value, days: d, items: hit.value.items.filter((it) => it.ts >= cutoff) };
      }
    }
  }
  try {
    let r;
    if (PROXY_BASE_URL) {
      r = await readProxyJson(`${PROXY_BASE_URL}/api/proxy?source=kap_disclosures&days=${d}`, timeoutMs);
    } else {
      const { fromDate, toDate } = kapDateRange(d, now);
      r = await postKapViaDevServer({ fromDate, toDate, disclosureTypes: null, memberTypes: ['IGS'], mkkMemberOid: null }, timeoutMs);
    }
    if (r.error) return failure(r.error);
    const items = normalizeKapItems(r.json);
    learnKapOids(items);
    const value = { ok: true, items, days: d, fetchedAt: Date.now() };
    _cache.set(`feed:${d}`, { ts: Date.now(), value });
    return value;
  } catch (err) {
    return failure(errorReason(err));
  }
}

/** Tek sirketin bildirimleri (mkkMemberOid ile, varsayilan 60 gun). */
export async function fetchKapForSymbol(symbol, { days = 60, force = false, timeoutMs = 12000 } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  const d = clampDays(days, MAX_SYMBOL_DAYS);
  const key = `sym:${sym}:${d}`;
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.ts < SYMBOL_TTL_MS) return hit.value;
  const oid = await resolveKapOid(sym);
  if (!oid) return failure('no_oid');
  try {
    let r;
    if (PROXY_BASE_URL) {
      r = await readProxyJson(`${PROXY_BASE_URL}/api/proxy?source=kap_disclosures&days=${d}&oid=${oid}`, timeoutMs);
    } else {
      const { fromDate, toDate } = kapDateRange(d);
      r = await postKapViaDevServer({ fromDate, toDate, disclosureTypes: null, memberTypes: ['IGS'], mkkMemberOid: oid }, timeoutMs);
    }
    if (r.error) return failure(r.error);
    const value = { ok: true, items: normalizeKapItems(r.json), days: d, fetchedAt: Date.now(), oid };
    _cache.set(key, { ts: Date.now(), value });
    return value;
  } catch (err) {
    return failure(errorReason(err));
  }
}

/** Kullaniciya gosterilecek tek satirlik sebep. */
export function describeKapFailure(reason) {
  switch (reason) {
    case 'proxy_outdated': return 'Proxy bu veri yolunu henüz tanımıyor — proxy klasörünü yeniden deploy et.';
    case 'timeout': return 'KAP zamanında yanıt vermedi.';
    case 'no_oid': return 'Bu hisse için KAP şirket kimliği bulunamadı.';
    case 'network': return 'KAP verisine ağ üzerinden ulaşılamadı.';
    default: return `KAP verisine ulaşılamadı (${reason || 'bilinmeyen'}).`;
  }
}

/** Testler icin: modul onbellegini sifirla. */
export function _resetKapFeedCache() {
  _cache.clear();
  _snapshotPromise = null;
}
