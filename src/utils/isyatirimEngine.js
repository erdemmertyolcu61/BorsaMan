// isyatirimEngine.js — Is Yatirim bilanco (financial statements) fetch + scoring
// Ports MaliTablo (financial tables) from isyatirim.com.tr, with multi-proxy fallback,
// localStorage cache, DuPont decomposition, Altman Z-Score, Piotroski F-Score.

const BASE_URL = 'https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx';
const CACHE_KEY = 'bist_isyatirim_cache_v3';
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

async function fetchWithProxy(url) {
  // 1. Try vite proxy
  try {
    const u = new URL(url);
    const viteUrl = '/api/isyatirim' + u.pathname.replace('/_layouts/15/IsYatirim.Website/Common/Data.aspx', '') + u.search;
    const r = await fetch(viteUrl, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    if (r.ok) {
      const text = await r.text();
      if (text && text.length > 100 && (text.includes('"value"') || text.includes('"itemCode"'))) return text;
    }
  } catch {}

  // 2. Public CORS proxies
  const proxies = [
    'https://api.allorigins.win/get?url=' + encodeURIComponent(url),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    'https://corsproxy.io/?' + encodeURIComponent(url),
    'https://thingproxy.freeboard.io/fetch/' + url,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || text.length < 100) continue;
      if (p.includes('allorigins.win/get')) {
        try { const j = JSON.parse(text); if (j.contents) return j.contents; } catch {}
      }
      if (text.includes('"value"') || text.includes('"itemCode"')) return text;
    } catch {}
  }

  // 3. Direct fetch (rare success due to CORS)
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://www.isyatirim.com.tr/',
          Origin: 'https://www.isyatirim.com.tr',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
        },
      });
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 50 && (text.includes('"value"') || text.includes('"itemCode"')) && !text.includes('<!DOCTYPE')) return text;
      }
    } catch {}
    if (i === 0) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function parseFinancialData(rows, symbol, periodLabels) {
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

  const curr = periodLabels[0] || Object.keys(out.metrics.revenue || {})[0];
  const prev = periodLabels[1] || Object.keys(out.metrics.revenue || {})[1];

  if (curr) {
    const get = (k) => out.metrics[k]?.[curr] || 0;
    const getPrev = (k) => prev && (out.metrics[k]?.[prev] || 0);

    out.ratios = {
      grossMargin: get('revenue') > 0 ? get('grossProfit') / get('revenue') * 100 : null,
      netMargin: get('revenue') > 0 ? get('netIncome') / get('revenue') * 100 : null,
      operatingMargin: get('revenue') > 0 ? get('operatingIncome') / get('revenue') * 100 : null,
      roe: get('totalEquity') > 0 ? get('netIncome') / get('totalEquity') * 100 : null,
      roa: get('totalAssets') > 0 ? get('netIncome') / get('totalAssets') * 100 : null,
      currentRatio: get('currentLiabilities') > 0 ? get('currentAssets') / get('currentLiabilities') : null,
      debtToEquity: get('totalEquity') > 0 ? get('totalLiabilities') / get('totalEquity') : null,
      debtToAssets: get('totalAssets') > 0 ? get('totalLiabilities') / get('totalAssets') : null,
      revenueGrowth: getPrev('revenue') > 0 ? (get('revenue') - getPrev('revenue')) / getPrev('revenue') * 100 : null,
      netIncomeGrowth: getPrev('netIncome') !== 0 ? (get('netIncome') - getPrev('netIncome')) / Math.abs(getPrev('netIncome')) * 100 : null,
    };
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

  const periods = [];
  let y = baseYear, p = basePeriod;
  for (let i = 0; i < 4; i++) {
    periods.push({ year: y, period: p });
    p -= 3;
    if (p <= 0) { p = 12; y--; }
  }

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
      const parsed = parseFinancialData(json.value, symbol, labels);
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
