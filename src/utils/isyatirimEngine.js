// isyatirimEngine.js — Is Yatirim bilanco (financial statements) fetch + scoring
// Ports MaliTablo (financial tables) from isyatirim.com.tr, with multi-proxy fallback,
// localStorage cache, DuPont decomposition, Altman Z-Score, Piotroski F-Score.

import { getDataViaProxies } from './fetchEngine.js';
import { isLocalDevHost } from './proxyTarget.js';

const BASE_URL = 'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx';
const CACHE_KEY = 'bist_isyatirim_cache_v4';   // v31.44: period plan + TTM ratios changed the shape
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}

function saveCache(sym, data) {
  try {
    const c = loadCache();
    c[sym] = { data, ts: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > 50) {
      keys.sort((a, b) => c[a].ts - c[b].ts);
      for (let i = 0; i < keys.length - 50; i++) delete c[keys[i]];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {}
}

function getCached(sym) {
  const c = loadCache();
  return c[sym] && Date.now() - c[sym].ts < CACHE_TTL ? c[sym].data : null;
}

function normalizeTR(str) {
  return str.toLowerCase()
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/ş/g, 's').replace(/Ş/g, 's')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .trim();
}

/**
 * v31.43: which routes to try for an İş Yatırım MaliTablo request, in order.
 *
 * The old first route was the Vite dev-server rewrite `/api/isyatirim/...`, which
 * exists only on localhost: the deployed PWA got a 404 there, and the public CORS
 * proxies behind it failed too (measured 2026-09-19: allorigins 408, codetabs
 * fail). The balance-sheet panel therefore never received data on the phone,
 * while the same URL through our own `/api/proxy?url=` returned 147 rows. This is
 * the order fetchEngine already uses for its other İş Yatırım calls.
 *
 * @param {{localDev?: boolean, electron?: boolean}} env
 * @returns {Array<'vite'|'electron'|'proxies'>}
 */
export function planIsyRoutes({ localDev = false, electron = false } = {}) {
  const routes = [];
  if (localDev) routes.push('vite');        // Vite dev proxy — localhost only
  if (electron) routes.push('electron');    // desktop IPC bridge, no CORS
  routes.push('proxies');                   // own proxy first (same origin on the PWA), then public ones
  return routes;
}

const looksLikeMaliTablo = (t) => typeof t === 'string' && t.length > 100
  && (t.includes('"value"') || t.includes('"itemCode"')) && !t.includes('<!DOCTYPE');

function detectIsyEnv() {
  const w = typeof window !== 'undefined' ? window : null;
  const capacitorNative = !!w?.Capacitor?.isNativePlatform?.();
  const hostname = typeof location !== 'undefined' ? location.hostname : '';
  return {
    // Capacitor also serves from "localhost", but there is no Vite server behind it
    localDev: !capacitorNative && isLocalDevHost(hostname),
    electron: !!w?.electronAPI?.remoteFetch,
  };
}

async function fetchWithProxy(url) {
  for (const route of planIsyRoutes(detectIsyEnv())) {
    try {
      let text = null;
      if (route === 'vite') {
        const u = new URL(url);
        const viteUrl = '/api/isyatirim' + u.pathname.replace('/_layouts/15/IsYatirim.Website/Common/Data.aspx', '') + u.search;
        const r = await fetch(viteUrl, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
        if (r.ok) text = await r.text();
      } else if (route === 'electron') {
        const res = await window.electronAPI.remoteFetch(url, { method: 'GET' });
        if (res?.success) text = res.text;
      } else {
        text = await getDataViaProxies(url, 12000);
      }
      if (looksLikeMaliTablo(text)) return text;
    } catch { /* next route */ }
  }
  return null;
}

function parseFinancialData(rows, symbol, periodLabels, periodPlan) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = {
    symbol,
    source: 'isyatirim',
    fetchedAt: new Date().toISOString(),
    periods: periodLabels || [],
    metrics: {},
  };

  const MAP = {
    'hasilat': 'revenue',
    'satis gelirleri': 'revenue',
    'satis gelirleri (net)': 'revenue',
    'net satis gelirleri': 'revenue',
    'brut kar (zarar)': 'grossProfit',
    'brut kar': 'grossProfit',
    'brut kar/zarar': 'grossProfit',
    'esas faaliyet kari (zarari)': 'operatingIncome',
    'esas faaliyet kari': 'operatingIncome',
    'esas faaliyet kar/zarar': 'operatingIncome',
    'faaliyet kari (zarari)': 'operatingIncome',
    'surdurulen faaliyetler vergi oncesi kari (zarari)': 'pretaxIncome',
    'vergi oncesi kar/zarar': 'pretaxIncome',
    'donem kari (zarari)': 'netIncome',
    'donem net kari (zarari)': 'netIncome',
    'net donem kari': 'netIncome',
    'net donem kari (zarari)': 'netIncome',
    'ana ortaklik paylari': 'netIncomeParent',
    'ana ortakliga ait net donem kari': 'netIncomeParent',
    'favok': 'ebitda',
    'toplam varliklar': 'totalAssets',
    'varliklar toplami': 'totalAssets',
    'donen varliklar': 'currentAssets',
    'nakit ve nakit benzerleri': 'cash',
    'nakit ve nakit benzerler': 'cash',
    'kisa vadeli yukumlulukler': 'currentLiabilities',
    'kisa vadeli borclar': 'currentLiabilities',
    'uzun vadeli yukumlulukler': 'longTermDebt',
    'uzun vadeli borclar': 'longTermDebt',
    'toplam yukumlulukler': 'totalLiabilities',
    'yukumlulukler toplami': 'totalLiabilities',
    'toplam ozkaynaklar': 'totalEquity',
    'ozkaynaklar toplami': 'totalEquity',
    // v31.43: İş Yatırım's XI_29 sheet labels it plainly "Özkaynaklar" (code 2N), so
    // equity never mapped and ROE / debt-to-equity showed N/A on real statements.
    'ozkaynaklar': 'totalEquity',
    'ana ortakliga ait ozkaynaklar': 'parentEquity',
    'odenmis sermaye': 'paidCapital',
    'stoklar': 'inventories',
    'ticari alacaklar': 'tradeReceivables',
    'ticari borclar': 'tradePayables',
    'finansal borclar': 'financialDebts',
    'maddi duran varliklar': 'ppe',
  };

  for (const row of rows) {
    const desc = row.itemDescTr || row.itemDesc || '';
    const key = normalizeTR(desc.trim());
    let mkey = null;
    if (MAP[key]) mkey = MAP[key];
    else {
      if ((key.includes('hasilat') || key.includes('satis gelir')) && !key.includes('diger') && !key.includes('maliyet') && !key.includes('satilan')) mkey = out.metrics.revenue ? null : 'revenue';
      else if (key.includes('brut kar') && !key.includes('diger')) mkey = out.metrics.grossProfit ? null : 'grossProfit';
      else if ((key.includes('donem kari') || key.includes('net donem') || key.includes('net kar')) && !key.includes('diger') && !key.includes('kontrol') && !key.includes('kapsamli') && !key.includes('faaliyet')) mkey = out.metrics.netIncome ? null : 'netIncome';
      else if (key.includes('toplam varlik') || key === 'varliklar toplami' || key.includes('aktif toplami')) mkey = out.metrics.totalAssets ? null : 'totalAssets';
      else if (key.includes('donen varlik') && !key.includes('duran')) mkey = out.metrics.currentAssets ? null : 'currentAssets';
      else if (key.includes('nakit ve nakit')) mkey = out.metrics.cash ? null : 'cash';
      else if (key.includes('kisa vadeli') && (key.includes('yukumluluk') || key.includes('borc'))) mkey = out.metrics.currentLiabilities ? null : 'currentLiabilities';
      else if (key.includes('toplam ozkaynak') || key === 'ozkaynaklar toplami') mkey = out.metrics.totalEquity ? null : 'totalEquity';
      else if (key.includes('toplam yukumluluk') || key === 'yukumlulukler toplami' || key.includes('pasif toplami')) mkey = out.metrics.totalLiabilities ? null : 'totalLiabilities';
      else if (key.includes('odenmis sermaye')) mkey = out.metrics.paidCapital ? null : 'paidCapital';
      else if (key === 'esas faaliyet kari' || key.includes('esas faaliyet kar') || key === 'faaliyet kari (zarari)') mkey = out.metrics.operatingIncome ? null : 'operatingIncome';
    }
    if (!mkey) continue;

    const vals = {};
    for (let i = 1; i <= 4; i++) {
      const v = row['itemValue' + i];
      const label = periodLabels[i - 1] || `P${i}`;
      if (v != null && v !== '' && v !== 0) {
        vals[label] = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0;
      }
    }
    if (Object.keys(vals).length === 0) {
      for (let i = 1; i <= 4; i++) {
        for (const k of ['value' + i, 'Value' + i, 'val' + i]) {
          if (row[k] != null && row[k] !== '') {
            const label = periodLabels[i - 1] || `P${i}`;
            vals[label] = typeof row[k] === 'number' ? row[k] : parseFloat(String(row[k]).replace(/\./g, '').replace(',', '.')) || 0;
            break;
          }
        }
      }
    }
    if (Object.keys(vals).length === 0) {
      for (const k of Object.keys(row)) {
        if (/^\d{4}[/-]\d{1,2}$/.test(k) && row[k] != null && row[k] !== '') {
          vals[k] = typeof row[k] === 'number' ? row[k] : parseFloat(String(row[k]).replace(/\./g, '').replace(',', '.')) || 0;
        }
      }
    }
    if (Object.keys(vals).length > 0) out.metrics[mkey] = vals;
  }

  // v31.43: the same sheet has no "Toplam Yükümlülükler" row — short- and long-term
  // liabilities are listed separately. Measured on THYAO 2026/6: 566.8B + 774.8B =
  // 1,341.6B, exactly totalAssets − equity. Derive it so the debt ratios exist.
  if (!out.metrics.totalLiabilities && out.metrics.currentLiabilities && out.metrics.longTermDebt) {
    const derived = {};
    for (const label of Object.keys(out.metrics.currentLiabilities)) {
      const shortTerm = out.metrics.currentLiabilities[label];
      const longTerm = out.metrics.longTermDebt[label];
      if (Number.isFinite(shortTerm) && Number.isFinite(longTerm)) derived[label] = shortTerm + longTerm;
    }
    if (Object.keys(derived).length) {
      out.metrics.totalLiabilities = derived;
      out.derivedTotalLiabilities = true;   // kisa + uzun vadeli toplami
    }
  }

  const curr = periodLabels[0] || Object.keys(out.metrics.revenue || {})[0];
  // v31.44: index 1 is the SAME period one year earlier (see buildPeriodPlan),
  // not the previous quarter. The old plan compared a 6-month cumulative against
  // a 3-month one, so "Ciro Buyume" was structurally ~+100% for every company
  // (measured on THYAO: +126.8%, an artifact, not growth).
  const prev = periodLabels[1] || Object.keys(out.metrics.revenue || {})[1];
  const lastFY = periodPlan?.lastFY || periodLabels[2];
  const isFullYear = !!periodPlan?.isFullYear;

  if (curr) {
    const get = (k) => out.metrics[k]?.[curr] || 0;
    const getPrev = (k) => prev && (out.metrics[k]?.[prev] || 0);

    // Trailing twelve months = last full year - same period last year + this
    // period. Cumulative statements make this exact; without it ROE on a H1
    // sheet reads as half a year of profit over a full balance sheet (THYAO:
    // 1.8% instead of 13.1%).
    const ttm = (k) => {
      const cur = get(k);
      if (isFullYear) return cur;
      const fy = lastFY ? out.metrics[k]?.[lastFY] : undefined;
      const sly = getPrev(k);
      if (!Number.isFinite(fy) || !Number.isFinite(sly) || !Number.isFinite(cur)) return null;
      if (fy === 0 || sly === 0) return null;
      return fy - sly + cur;
    };
    const ttmNetIncome = ttm('netIncome');
    const ttmRevenue = ttm('revenue');
    const roeTtm = ttmNetIncome != null && get('totalEquity') > 0 ? ttmNetIncome / get('totalEquity') * 100 : null;
    const roaTtm = ttmNetIncome != null && get('totalAssets') > 0 ? ttmNetIncome / get('totalAssets') * 100 : null;

    out.ratios = {
      grossMargin: get('revenue') > 0 ? get('grossProfit') / get('revenue') * 100 : null,
      netMargin: get('revenue') > 0 ? get('netIncome') / get('revenue') * 100 : null,
      operatingMargin: get('revenue') > 0 ? get('operatingIncome') / get('revenue') * 100 : null,
      // roe/roa are annualised (TTM) where the data allows; the raw
      // period-over-equity figures stay available for auditing.
      roe: roeTtm != null ? roeTtm : (get('totalEquity') > 0 ? get('netIncome') / get('totalEquity') * 100 : null),
      roa: roaTtm != null ? roaTtm : (get('totalAssets') > 0 ? get('netIncome') / get('totalAssets') * 100 : null),
      roePeriod: get('totalEquity') > 0 ? get('netIncome') / get('totalEquity') * 100 : null,
      roeIsTtm: roeTtm != null,
      currentRatio: get('currentLiabilities') > 0 ? get('currentAssets') / get('currentLiabilities') : null,
      debtToEquity: get('totalEquity') > 0 ? get('totalLiabilities') / get('totalEquity') : null,
      debtToAssets: get('totalAssets') > 0 ? get('totalLiabilities') / get('totalAssets') : null,
      revenueGrowth: getPrev('revenue') > 0 ? (get('revenue') - getPrev('revenue')) / getPrev('revenue') * 100 : null,
      netIncomeGrowth: getPrev('netIncome') !== 0 ? (get('netIncome') - getPrev('netIncome')) / Math.abs(getPrev('netIncome')) * 100 : null,
    };
    out.ttm = { netIncome: ttmNetIncome, revenue: ttmRevenue, comparedTo: prev || null };
    out.latest = {
      period: curr,
      revenue: get('revenue'),
      grossProfit: get('grossProfit'),
      operatingIncome: get('operatingIncome'),
      netIncome: get('netIncome'),
      totalAssets: get('totalAssets'),
      totalEquity: get('totalEquity'),
      totalLiabilities: get('totalLiabilities'),
      currentAssets: get('currentAssets'),
      currentLiabilities: get('currentLiabilities'),
      cash: get('cash'),
      paidCapital: get('paidCapital'),
    };
  }
  return out;
}

/**
 * v31.44: which four statement periods to request.
 *
 * The old plan asked for four CONSECUTIVE quarters (2026/6, 2026/3, 2025/12,
 * 2025/9). Is Yatirim reports CUMULATIVE figures, so "previous period" was a
 * 3-month cumulative next to a 6-month one: growth was ~+100% by construction
 * and there was no way to annualise profit.
 *
 * The new plan keeps the same four slots but gives them meaning:
 *   [0] current      [1] same period one year earlier (YoY comparison)
 *   [2] last full year   [3] the full year before it   (trailing 12m)
 *
 * When the newest statement IS a full year (Jan-Apr, before Q1 lands), the
 * trailing window is already complete, so the slots become four year-ends.
 *
 * @returns {{periods: Array<{year:number, period:number}>, current: string,
 *            prevYearSame: string, lastFY: string, isFullYear: boolean}}
 */
export function buildPeriodPlan(baseYear, basePeriod) {
  const label = (y, p) => `${y}/${p}`;
  const isFullYear = basePeriod === 12;
  const periods = isFullYear
    ? [{ year: baseYear, period: 12 }, { year: baseYear - 1, period: 12 },
       { year: baseYear - 2, period: 12 }, { year: baseYear - 3, period: 12 }]
    : [{ year: baseYear, period: basePeriod }, { year: baseYear - 1, period: basePeriod },
       { year: baseYear - 1, period: 12 }, { year: baseYear - 2, period: 12 }];
  return {
    periods,
    current: label(periods[0].year, periods[0].period),
    prevYearSame: label(periods[1].year, periods[1].period),
    lastFY: label(periods[2].year, periods[2].period),
    isFullYear,
  };
}

export async function fetchIsYatirimFinancials(symbol) {
  const cached = getCached(symbol);
  if (cached) { console.log(`IsYatirim: ${symbol} from cache`); return cached; }

  const now = new Date();
  const yr = now.getFullYear();
  const m = now.getMonth() + 1;
  let baseYear, basePeriod;
  if (m >= 11) { baseYear = yr; basePeriod = 9; }
  else if (m >= 8) { baseYear = yr; basePeriod = 6; }
  else if (m >= 5) { baseYear = yr; basePeriod = 3; }
  else { baseYear = yr - 1; basePeriod = 12; }

  const plan = buildPeriodPlan(baseYear, basePeriod);
  const periods = plan.periods;

  const groups = ['XI_29', 'UFRS_K', 'UFRS'];
  for (const grp of groups) {
    const url = `${BASE_URL}/MaliTablo?companyCode=${symbol}&exchange=TRY&financialGroup=${grp}` +
      `&year1=${periods[0].year}&period1=${periods[0].period}` +
      `&year2=${periods[1].year}&period2=${periods[1].period}` +
      `&year3=${periods[2].year}&period3=${periods[2].period}` +
      `&year4=${periods[3].year}&period4=${periods[3].period}`;

    try {
      const resp = await fetchWithProxy(url);
      if (!resp) continue;
      let json;
      try { json = JSON.parse(resp); } catch { continue; }
      if (!json || !json.value || !Array.isArray(json.value) || json.value.length === 0) continue;

      const labels = periods.map(p => `${p.year}/${p.period}`);
      const parsed = parseFinancialData(json.value, symbol, labels, plan);
      if (parsed && parsed.ratios && Object.keys(parsed.metrics).length >= 3) {
        parsed.financialGroup = grp;
        saveCache(symbol, parsed);
        console.log(`✅ IsYatirim: ${symbol} loaded via ${grp}`);
        return parsed;
      }
    } catch (e) {
      console.warn(`IsYatirim fetch error ${symbol}/${grp}:`, e.message);
    }
  }
  console.warn(`IsYatirim: no data for ${symbol}`);
  return null;
}

export function scoreIsYatirimFundamentals(fin) {
  if (!fin || !fin.ratios) return null;
  const r = fin.ratios;
  const L = fin.latest || {};
  let score = 5;
  const points = [];

  if (r.roe != null) {
    if (r.roe > 20) { score += 1.5; points.push('Yuksek ROE (' + r.roe.toFixed(1) + '%)'); }
    else if (r.roe > 10) { score += 0.5; points.push('Iyi ROE'); }
    else if (r.roe < 5 && r.roe >= 0) { score -= 1; points.push('Dusuk ROE'); }
    else if (r.roe < 0) { score -= 2; points.push('Negatif ROE'); }
  }
  if (r.revenueGrowth != null) {
    if (r.revenueGrowth > 20) { score += 1.5; points.push('Guclu Ciro Buyumesi'); }
    else if (r.revenueGrowth > 5) { score += 0.5; points.push('Pozitif Ciro Buyumesi'); }
    else if (r.revenueGrowth < -10) { score -= 1.5; points.push('Ciddi Ciro Dususu'); }
  }
  if (r.netMargin != null) {
    if (r.netMargin > 15) { score += 1; points.push('Yuksek Karlilik'); }
    else if (r.netMargin < 2 && r.netMargin >= 0) { score -= 0.5; points.push('Dusuk Marj'); }
    else if (r.netMargin < 0) { score -= 1.5; points.push('Net Zarar'); }
  }
  if (r.currentRatio != null) {
    if (r.currentRatio > 1.5) { score += 1; points.push('Guclu Likidite'); }
    else if (r.currentRatio < 1) { score -= 1.5; points.push('Likidite Riski'); }
  }
  if (r.debtToEquity != null) {
    if (r.debtToEquity < 0.5) { score += 1; points.push('Dusuk Borcluluk'); }
    else if (r.debtToEquity > 2) { score -= 1.5; points.push('Yuksek Kaldirac'); }
  }

  // DuPont
  let dupont = null;
  if (L.revenue > 0 && L.totalAssets > 0 && L.totalEquity > 0 && L.netIncome != null) {
    const netMargin = L.netIncome / L.revenue;
    const assetTurnover = L.revenue / L.totalAssets;
    const equityMultiplier = L.totalAssets / L.totalEquity;
    dupont = {
      netMargin, assetTurnover, equityMultiplier,
      syntheticROE: netMargin * assetTurnover * equityMultiplier * 100,
    };
  }

  // Altman Z-Score
  let altmanZScore = null, altmanZone = null;
  if (L.totalAssets > 0 && L.totalEquity > 0) {
    const workingCap = (L.currentAssets || 0) - (L.currentLiabilities || 0);
    const retainedEarn = L.totalEquity - (L.paidCapital || 0);
    const ebit = L.operatingIncome || L.netIncome || 0;
    const totalLiab = L.totalLiabilities || (L.totalAssets - L.totalEquity);
    const x1 = workingCap / L.totalAssets;
    const x2 = retainedEarn / L.totalAssets;
    const x3 = ebit / L.totalAssets;
    const x4 = totalLiab > 0 ? L.totalEquity / totalLiab : 2;
    altmanZScore = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4;
    if (altmanZScore > 2.6) altmanZone = 'GUVENLI';
    else if (altmanZScore > 1.1) altmanZone = 'GRI BOLGE';
    else altmanZone = 'TEHLIKELI';
    if (altmanZScore > 3) { score += 0.5; points.push('Altman Z guvenli'); }
    else if (altmanZScore < 1.1) { score -= 1; points.push('Altman Z tehlikeli'); }
  }

  // Piotroski F-Score
  let piotroski = 0;
  const piotroskiDetails = [];
  if (L.netIncome > 0) { piotroski++; piotroskiDetails.push('Pozitif net kar'); }
  if (r.roa != null && r.roa > 0) { piotroski++; piotroskiDetails.push('Pozitif ROA'); }
  if (L.netIncome > 0 && L.operatingIncome > 0) { piotroski++; piotroskiDetails.push('Pozitif nakit akisi'); }
  if (L.operatingIncome > L.netIncome) { piotroski++; piotroskiDetails.push('Kaliteli kazanc'); }
  if (r.debtToAssets != null && r.debtToAssets < 0.5) { piotroski++; piotroskiDetails.push('Dusuk kaldirac'); }
  if (r.currentRatio != null && r.currentRatio > 1) { piotroski++; piotroskiDetails.push('Pozitif likidite'); }
  if (L.paidCapital > 0) { piotroski++; piotroskiDetails.push('Sermaye artirimi yok'); }
  if (r.grossMargin != null && r.grossMargin > 0) { piotroski++; piotroskiDetails.push('Pozitif brut marj'); }
  if (dupont && dupont.assetTurnover > 0.3) { piotroski++; piotroskiDetails.push('Iyi varlik devir hizi'); }

  if (piotroski >= 7) { score += 0.5; points.push('Piotroski guclu (' + piotroski + '/9)'); }
  else if (piotroski <= 3) { score -= 0.5; points.push('Piotroski zayif (' + piotroski + '/9)'); }

  return {
    score: Math.max(0, Math.min(10, score)),
    points,
    ratios: r,
    latest: fin.latest,
    dupont,
    altmanZScore,
    altmanZone,
    piotroski,
    piotroskiDetails,
  };
}
