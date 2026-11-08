// financialStatements.js — 16 çeyreklik İş Yatırım mali tablosu (v31.50)
//
// "Hisse detayı" sekmesinin temel analiz verisi. İş Yatırım MaliTablo uç noktası
// istek başına DÖRT dönem verir (year5/period5 yok sayılır — ölçüldü 2026-11-09),
// bu yüzden 16 çeyrek sonu dört istekte çekilir ve satır koduna göre birleştirilir.
//
// Ölçülmüş biçim (THYAO, XI_29, 2026-11-09):
//   - Gelir tablosu ve nakit akışı KÜMÜLATİF: 3C Satış Gelirleri 2026/3 258,0 mr,
//     2026/6 585,1 mr, 2026/9 981,0 mr. Tek çeyrek = bu kümülatif − bir önceki.
//   - Henüz açıklanmamış dönem null döner (KCHOL 2026/9), boş kalem 0.
//   - FAVÖK satırı yok. İş Yatırım'ın tanımı: brüt kâr − pazarlama − genel yönetim
//     − Ar-Ge + amortisman = 3H "Net Faaliyet Kar/Zararı" + 4B "Amortisman Giderleri".
//     THYAO 9A26: 20,56 mr + 92,56 mr = 113,1 mr.
//   - Bankalar UFRS / UFRS_K (192 satır, 3C = net faiz geliri), sigortalar UFRS
//     (405 satır, 3K = genel teknik bölüm dengesi). Onlarda FAVÖK yok.
//
// Enflasyon muhasebesi (TMS 29): her rapor kendi dönem sonunun satın alma gücüyle
// yayımlanır. Çeyreklik fark iki farklı TL'yi çıkarır — piyasada yaygın yöntem bu,
// ama ekran bunu dipnotta söyler.

import { getDataViaProxies } from './fetchEngine.js';
import { isLocalDevHost } from './proxyTarget.js';

export const FIN_HISTORY_QUARTERS = 16;
const PERIODS_PER_REQUEST = 4;
const CACHE_KEY = 'bist_fin_history_v1';
const CACHE_TTL = 12 * 60 * 60 * 1000;
const CACHE_MAX_SYMBOLS = 8;
const GROUPS = ['XI_29', 'UFRS_K', 'UFRS'];
const BASE_URL = 'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx';

// ── Dönem yardımcıları ───────────────────────────────────────────────────────

export const periodLabel = (y, p) => `${y}/${p}`;

export function parsePeriod(label) {
  const [y, p] = String(label).split('/').map(Number);
  return { y, p };
}

/** "2026/9" → "3Ç26" */
export function quarterName(label) {
  const { y, p } = parsePeriod(label);
  return `${p / 3}Ç${String(y).slice(2)}`;
}

/** Bugünden önce biten son çeyrek sonu. 9 Kasım 2026 → 2026/9. */
export function latestQuarterEnd(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 10) return { y, p: 9 };
  if (m >= 7) return { y, p: 6 };
  if (m >= 4) return { y, p: 3 };
  return { y: y - 1, p: 12 };
}

/** Yeniden eskiye `count` çeyrek sonu: [{y,p}, …]. */
export function quarterEndsBack(y, p, count) {
  const out = [];
  let yy = y, pp = p;
  for (let i = 0; i < count; i++) {
    out.push({ y: yy, p: pp });
    pp -= 3;
    if (pp <= 0) { pp = 12; yy -= 1; }
  }
  return out;
}

function shiftQuarters(label, back) {
  const { y, p } = parsePeriod(label);
  const list = quarterEndsBack(y, p, back + 1);
  const last = list[list.length - 1];
  return periodLabel(last.y, last.p);
}

export function parseIsyNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ── Birleştirme ──────────────────────────────────────────────────────────────

/**
 * Dört ayrı yanıtı tek tabloya çevirir.
 * @param {Array<{labels: string[], rows: Array}>} chunks  her biri bir MaliTablo yanıtı
 * @returns {{rows: Array<{code, tr, en, depth, values}>, labels: string[]}}
 */
export function mergeMaliTablo(chunks) {
  const byCode = new Map();
  const order = [];
  const labels = [];
  for (const chunk of chunks || []) {
    const chunkLabels = chunk?.labels || [];
    for (const l of chunkLabels) if (!labels.includes(l)) labels.push(l);
    for (const row of chunk?.rows || []) {
      const code = row?.itemCode;
      if (!code) continue;
      let entry = byCode.get(code);
      if (!entry) {
        const raw = String(row.itemDescTr || row.itemDescEng || code);
        entry = {
          code,
          tr: raw.trim().replace(/\s+/g, ' '),
          en: String(row.itemDescEng || '').trim(),
          depth: Math.min(3, Math.floor((raw.length - raw.trimStart().length) / 2)),
          values: {},
        };
        byCode.set(code, entry);
        order.push(code);
      }
      chunkLabels.forEach((l, i) => {
        const v = parseIsyNumber(row['value' + (i + 1)]);
        if (v != null || !(l in entry.values)) entry.values[l] = v;
      });
    }
  }
  return { rows: order.map(c => byCode.get(c)), labels };
}

/** Bir dönem ancak en az beş kalemi sıfırdan farklıysa açıklanmış sayılır. */
export function availableLabels(rows, labels) {
  return labels.filter(l => rows.filter(r => r.values[l] != null && r.values[l] !== 0).length >= 5);
}

export function detectStatementKind(rows) {
  const by = Object.fromEntries((rows || []).map(r => [r.code, r]));
  if (by['3DF'] && by['3H'] && by['1BL']) return 'industrial';
  if (by['3C'] && /FA[İI]Z/i.test(by['3C'].tr)) return 'bank';
  if (by['3K'] && /teknik/i.test(by['3K'].tr)) return 'insurance';
  return 'unknown';
}

/** Gelir tablosu (3…) ve sanayi nakit akışı (4…) akımdır; 4BE* döviz pozisyonu stoktur. */
export function isFlowCode(code, kind) {
  if (code.startsWith('3')) return true;
  if (kind === 'industrial' && code.startsWith('4')) return !code.startsWith('4BE');
  return false;
}

/** Kümülatif seriden tek çeyrek: 3. ay kendisi, diğerleri bir öncekiyle farkı. */
export function singleQuarter(values, label) {
  const cur = values?.[label];
  if (cur == null) return null;
  const { y, p } = parsePeriod(label);
  if (p === 3) return cur;
  const prev = values[periodLabel(y, p - 3)];
  return prev == null ? null : cur - prev;
}

/** Son dört tek çeyreğin toplamı; biri eksikse null. */
export function trailingFour(quarterly, label) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const v = quarterly[shiftQuarters(label, i)];
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

// ── Kalem tanımları ──────────────────────────────────────────────────────────

const DEFS = {
  industrial: {
    revenue: '3C', cogs: '3CA', grossProfit: '3D', marketing: '3DA', gna: '3DB', rnd: '3DC',
    otherOpIncome: '3DD', otherOpExpense: '3DE', operatingProfit: '3DF', netOperatingProfit: '3H',
    investIncome: '3HA', equityPickup: '3HAC', financeIncome: '3HB', financeExpense: '3HC',
    pretaxProfit: '3I', tax: '3IA', netProfit: '3L', netProfitParent: '3Z',
    depreciation: '4B', domesticSales: '4BC', exportSales: '4BD',
    opCashFlow: '4C', capex: '4CAI', investingCashFlow: '4CAK', fcf: '4CB',
    dividendsPaid: '4CBB', financingCashFlow: '4CBE',
    totalAssets: '1BL', currentAssets: '1A', cash: '1AA', shortInvestments: '1AB',
    receivables: '1AC', inventories: '1AF', nonCurrentAssets: '1AK', ppe: '1BG',
    currentLiabilities: '2A', shortFinDebt: '2AA', tradePayables: '2AAGAA',
    longLiabilities: '2B', longFinDebt: '2BA', equity: '2N', parentEquity: '2O',
    paidCapital: '2OA', minorityEquity: '2ODA', netFxPosition: '4BE',
  },
  bank: {
    interestIncome: '3A', interestExpense: '3B', netInterestIncome: '3C', netFees: '3CA',
    tradingPnl: '3CC', operatingIncome: '3CE', provisions: '3CF', otherOpExpense: '3CG',
    netOperatingProfit: '3CH', pretaxProfit: '3CL', tax: '3CM', netProfit: '3Z',
    netProfitGroup: '3ZA',
    totalAssets: '1Z', cash: '1A', loans: '1AF', deposits: '2A', equity: '2O',
    paidCapital: '2OA', minorityEquity: '2OVA',
  },
  insurance: {
    nonLifeTechIncome: '3A', nonLifeTechExpense: '3B', techBalance: '3K', netProfit: '3Z',
    totalAssets: '1Z', currentAssets: '1H', cash: '1A', currentLiabilities: '2I',
    equity: '2O', paidCapital: '2MEA',
  },
};

/** Satır tanımına göre seçilen kalemler, her dönem için ham (kümülatif/stok) değer. */
function pickMetrics(rows, kind) {
  const def = DEFS[kind] || {};
  const by = Object.fromEntries(rows.map(r => [r.code, r]));
  const out = {};
  for (const [key, code] of Object.entries(def)) {
    if (by[code]) out[key] = { code, values: by[code].values, flow: isFlowCode(code, kind) };
  }
  return out;
}

const ratio = (a, b) => (a != null && b != null && b !== 0 ? a / b : null);
const pct = (a, b) => { const r = ratio(a, b); return r == null ? null : r * 100; };
const growth = (cur, prev) => (cur != null && prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null);
const sumOrNull = (...xs) => (xs.every(x => x != null) ? xs.reduce((s, x) => s + x, 0) : null);

/**
 * Ham tablodan ekran görünümü.
 * @returns {{kind, labels, latest, quarters, annual, ttm, balance, statements}}
 */
export function buildFinancialView(merged) {
  const rows = merged?.rows || [];
  const kind = detectStatementKind(rows);
  const labels = availableLabels(rows, merged?.labels || []);
  if (!labels.length) return { kind, labels: [], latest: null, quarters: [], annual: [], ttm: null, rolling: [], balance: [], statements: rows };

  const m = pickMetrics(rows, kind);
  const qOf = (key) => {
    const item = m[key];
    if (!item) return {};
    const out = {};
    for (const l of labels) out[l] = item.flow ? singleQuarter(item.values, l) : (item.values[l] ?? null);
    return out;
  };
  const cumOf = (key) => m[key]?.values || {};
  const stockAt = (key, l) => m[key]?.values?.[l] ?? null;

  // Tek çeyrek serileri (akım kalemleri)
  const flowKeys = Object.keys(m).filter(k => m[k].flow);
  const Q = Object.fromEntries(flowKeys.map(k => [k, qOf(k)]));
  if (kind === 'industrial') {
    Q.ebitda = {};
    for (const l of labels) Q.ebitda[l] = sumOrNull(Q.netOperatingProfit?.[l], Q.depreciation?.[l]);
  }
  // Ana ortaklık payı: sanayide 3Z, bankada grubun kârı (3ZA, sıfırsa 3Z), sigortada 3Z.
  const parentKey = kind === 'industrial' ? 'netProfitParent'
    : kind === 'bank' && Object.values(Q.netProfitGroup || {}).some(v => v) ? 'netProfitGroup'
      : 'netProfit';
  Q.parentNet = Q[parentKey] || {};

  const valueAt = (key, l) => Q[key]?.[l] ?? null;
  const yoy = (key, l) => growth(valueAt(key, l), valueAt(key, shiftQuarters(l, 4)));

  const quarters = labels.map(l => {
    // 4. çeyrek = yıllık − 9 aylık; yıl sonu raporu farklı satın alma gücüyle/kurla yayımlanır
    const row = { label: l, name: quarterName(l), fromAnnual: parsePeriod(l).p === 12 };
    for (const k of Object.keys(Q)) row[k] = valueAt(k, l);
    if (kind === 'industrial') {
      row.grossMargin = pct(row.grossProfit, row.revenue);
      row.ebitdaMargin = pct(row.ebitda, row.revenue);
      row.operatingMargin = pct(row.operatingProfit, row.revenue);
      row.netMargin = pct(row.parentNet, row.revenue);
      row.revenueYoY = yoy('revenue', l);
      row.ebitdaYoY = yoy('ebitda', l);
    }
    if (kind === 'bank') row.netInterestYoY = yoy('netInterestIncome', l);
    row.parentNetYoY = yoy('parentNet', l);
    return row;
  });

  // Yıllık (12. ay kümülatifi) — açıklanmış yıl sonları
  const annual = labels.filter(l => parsePeriod(l).p === 12).map(l => {
    const row = { label: l, year: parsePeriod(l).y };
    for (const k of flowKeys) row[k] = cumOf(k)[l] ?? null;
    if (kind === 'industrial') row.ebitda = sumOrNull(row.netOperatingProfit, row.depreciation);
    row.parentNet = kind === 'industrial' ? row.netProfitParent
      : parentKey === 'netProfitGroup' ? row.netProfitGroup : row.netProfit;
    if (kind === 'industrial') {
      row.grossMargin = pct(row.grossProfit, row.revenue);
      row.ebitdaMargin = pct(row.ebitda, row.revenue);
      row.operatingMargin = pct(row.operatingProfit, row.revenue);
      row.netMargin = pct(row.parentNet, row.revenue);
    }
    return row;
  });
  for (const row of annual) {
    const prev = annual.find(a => a.year === row.year - 1);
    if (!prev) continue;
    row.revenueYoY = growth(row.revenue, prev.revenue);
    row.ebitdaYoY = growth(row.ebitda, prev.ebitda);
    row.netInterestYoY = growth(row.netInterestIncome, prev.netInterestIncome);
    row.parentNetYoY = growth(row.parentNet, prev.parentNet);
  }
  for (const row of annual) row.name = String(row.year);

  // Son 12 ay (12A) — en yeni açıklanmış çeyrek sonunda
  const latest = labels[0];
  const ttmAt = (key, l) => trailingFour(Q[key] || {}, l);
  const ttm = { label: latest };
  for (const k of Object.keys(Q)) ttm[k] = ttmAt(k, latest);
  ttm.prevParentNet = ttmAt('parentNet', shiftQuarters(latest, 4));
  ttm.parentNetGrowth = growth(ttm.parentNet, ttm.prevParentNet);
  if (kind === 'industrial') {
    ttm.prevRevenue = ttmAt('revenue', shiftQuarters(latest, 4));
    ttm.revenueGrowth = growth(ttm.revenue, ttm.prevRevenue);
    ttm.prevEbitda = ttmAt('ebitda', shiftQuarters(latest, 4));
    ttm.ebitdaGrowth = growth(ttm.ebitda, ttm.prevEbitda);
    ttm.grossMargin = pct(ttm.grossProfit, ttm.revenue);
    ttm.ebitdaMargin = pct(ttm.ebitda, ttm.revenue);
    ttm.netMargin = pct(ttm.parentNet, ttm.revenue);
    ttm.exportShare = pct(ttm.exportSales, sumOrNull(ttm.exportSales, ttm.domesticSales));
  }

  // Her çeyrek sonunda geriye dönük 12 ay — mevsimsellikten arınmış eğilim
  const rolling = labels.map(l => {
    const r = { label: l, name: quarterName(l) };
    for (const k of Object.keys(Q)) r[k] = ttmAt(k, l);
    if (kind === 'industrial') {
      r.grossMargin = pct(r.grossProfit, r.revenue);
      r.ebitdaMargin = pct(r.ebitda, r.revenue);
      r.operatingMargin = pct(r.operatingProfit, r.revenue);
      r.netMargin = pct(r.parentNet, r.revenue);
      r.revenueYoY = growth(r.revenue, ttmAt('revenue', shiftQuarters(l, 4)));
      r.ebitdaYoY = growth(r.ebitda, ttmAt('ebitda', shiftQuarters(l, 4)));
    }
    if (kind === 'bank') r.netInterestYoY = growth(r.netInterestIncome, ttmAt('netInterestIncome', shiftQuarters(l, 4)));
    r.parentNetYoY = growth(r.parentNet, ttmAt('parentNet', shiftQuarters(l, 4)));
    return r;
  });

  // Bilanço (çeyrek sonu stokları)
  const balance = labels.map(l => {
    const b = { label: l, name: quarterName(l) };
    for (const k of Object.keys(m).filter(key => !m[key].flow)) b[k] = stockAt(k, l);
    if (kind === 'industrial') {
      b.finDebt = sumOrNull(b.shortFinDebt, b.longFinDebt);
      b.netDebt = b.finDebt == null ? null : b.finDebt - (b.cash || 0) - (b.shortInvestments || 0);
      b.currentRatio = ratio(b.currentAssets, b.currentLiabilities);
      b.debtToEquity = ratio(b.finDebt, b.equity);
      b.liabilitiesToAssets = pct(sumOrNull(b.currentLiabilities, b.longLiabilities), b.totalAssets);
      const ebitdaTtm = ttmAt('ebitda', l);
      b.netDebtToEbitda = ebitdaTtm != null && ebitdaTtm > 0 ? ratio(b.netDebt, ebitdaTtm) : null;
    }
    if (kind === 'bank') b.loanToDeposit = pct(b.loans, b.deposits);
    if (kind === 'insurance') b.currentRatio = ratio(b.currentAssets, b.currentLiabilities);
    b.parentEquity = kind === 'industrial' ? b.parentEquity
      : b.equity != null ? b.equity - (b.minorityEquity || 0) : null;
    const ni = ttmAt('parentNet', l);
    b.roe = ni != null && b.parentEquity > 0 ? (ni / b.parentEquity) * 100 : null;
    b.roa = ni != null && b.totalAssets > 0 ? (ni / b.totalAssets) * 100 : null;
    return b;
  });

  return { kind, labels, latest, quarters, annual, ttm, rolling, balance, statements: rows };
}

/**
 * Fiyatla değerleme. Pay adedi = ödenmiş sermaye (BIST'te nominal 1 TL).
 * @param {object} view  buildFinancialView çıktısı
 * @param {number} price güncel fiyat
 */
export function computeValuation(view, price) {
  if (!view?.latest || !(price > 0)) return null;
  const b = view.balance[0] || {};
  const t = view.ttm || {};
  const shares = b.paidCapital > 0 ? b.paidCapital : null;
  if (!shares) return null;
  const mcap = price * shares;
  const out = {
    price, shares, mcap,
    pe: t.parentNet > 0 ? mcap / t.parentNet : null,
    peLoss: t.parentNet != null && t.parentNet <= 0,
    pb: b.parentEquity > 0 ? mcap / b.parentEquity : null,
    eps: t.parentNet != null ? t.parentNet / shares : null,
    bvps: b.parentEquity != null ? b.parentEquity / shares : null,
    roe: b.roe ?? null,
  };
  if (view.kind === 'industrial') {
    out.netDebt = b.netDebt ?? null;
    out.ev = b.netDebt != null ? mcap + b.netDebt : null;
    out.evEbitda = out.ev != null && t.ebitda > 0 ? out.ev / t.ebitda : null;
    out.evSales = out.ev != null && t.revenue > 0 ? out.ev / t.revenue : null;
    out.ps = t.revenue > 0 ? mcap / t.revenue : null;
    out.fcfYield = t.fcf != null ? (t.fcf / mcap) * 100 : null;
    out.dividendYield = t.dividendsPaid != null ? (Math.abs(t.dividendsPaid) / mcap) * 100 : null;
  }
  return out;
}

// ── Getirme ──────────────────────────────────────────────────────────────────

const looksLikeMaliTablo = (t) => typeof t === 'string' && t.length > 2 && t.trim().startsWith('{')
  && t.includes('"value"') && !t.includes('<!DOCTYPE');

async function fetchMaliTabloText(url) {
  const w = typeof window !== 'undefined' ? window : null;
  const capacitor = !!w?.Capacitor?.isNativePlatform?.();
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (!capacitor && isLocalDevHost(host)) {
    try {
      const u = new URL(url);
      const r = await fetch('/api/isyatirim' + u.pathname.replace('/_layouts/15/IsYatirim.Website/Common/Data.aspx', '') + u.search,
        { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (r.ok) { const t = await r.text(); if (looksLikeMaliTablo(t)) return t; }
    } catch { /* sonraki yol */ }
  }
  if (w?.electronAPI?.remoteFetch) {
    try {
      const res = await w.electronAPI.remoteFetch(url, { method: 'GET' });
      if (res?.success && looksLikeMaliTablo(res.text)) return res.text;
    } catch { /* sonraki yol */ }
  }
  try {
    const t = await getDataViaProxies(url, 15000);
    if (looksLikeMaliTablo(t)) return t;
  } catch { /* yok */ }
  return null;
}

export function buildMaliTabloUrl(symbol, group, periods) {
  const ps = periods.map((q, i) => `&year${i + 1}=${q.y}&period${i + 1}=${q.p}`).join('');
  return `${BASE_URL}/MaliTablo?companyCode=${encodeURIComponent(symbol)}&exchange=TRY&financialGroup=${group}${ps}`;
}

async function fetchChunk(symbol, group, periods) {
  const text = await fetchMaliTabloText(buildMaliTabloUrl(symbol, group, periods));
  if (text == null) return { ok: false, network: true };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false }; }
  const rows = Array.isArray(json?.value) ? json.value : [];
  return { ok: rows.length > 0, rows, labels: periods.map(q => periodLabel(q.y, q.p)) };
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { return {}; }
}

function saveCache(symbol, data) {
  try {
    const c = loadCache();
    c[symbol] = { ts: Date.now(), data };
    const keys = Object.keys(c).sort((a, b) => c[b].ts - c[a].ts);
    for (const k of keys.slice(CACHE_MAX_SYMBOLS)) delete c[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* kota — önbelleksiz devam */ }
}

/**
 * 16 çeyreklik tablo. Döner: { group, merged, fetchedAt } ya da
 * { unavailable: true, reason: 'network' | 'no_statements' } — boş ile yok ayrı.
 */
export async function fetchFinancialHistory(symbol, { force = false, now = new Date() } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return { unavailable: true, reason: 'no_symbol' };
  if (!force) {
    const hit = loadCache()[sym];
    if (hit && Date.now() - hit.ts < CACHE_TTL && hit.data?.merged) return { ...hit.data, cached: true };
  }
  const { y, p } = latestQuarterEnd(now);
  const ends = quarterEndsBack(y, p, FIN_HISTORY_QUARTERS);
  const chunks = [];
  for (let i = 0; i < ends.length; i += PERIODS_PER_REQUEST) chunks.push(ends.slice(i, i + PERIODS_PER_REQUEST));

  // Tablo türü önceden bilinmez (sanayi XI_29, banka/sigorta UFRS_K / UFRS): üç
  // tür ilk dört dönem için paralel denenir, sırayla denemek yavaş bir ağda
  // (ör. tarama sürerken) tek bir zaman aşımını üçe katlıyordu.
  const probes = await Promise.all(GROUPS.map(g => fetchChunk(sym, g, chunks[0])));
  const sawNetworkFailure = probes.some(p => p.network);
  for (let gi = 0; gi < GROUPS.length; gi++) {
    const group = GROUPS[gi];
    const first = probes[gi];
    if (!first.ok) continue;
    const rest = await Promise.all(chunks.slice(1).map(c => fetchChunk(sym, group, c)));
    const merged = mergeMaliTablo([first, ...rest.filter(r => r.ok)]);
    const data = {
      group, merged, fetchedAt: Date.now(),
      missingChunks: rest.filter(r => !r.ok).length,
    };
    if (!data.missingChunks) saveCache(sym, data);
    return data;
  }
  return { unavailable: true, reason: sawNetworkFailure ? 'network' : 'no_statements' };
}
