// ═══════════════════════════════════════════════════════════════
// BIST Terminal — Self-Hosted CORS Proxy (Vercel Serverless)
// ═══════════════════════════════════════════════════════════════
// Deploy: repo kokunde `npm run deploy:proxy` (proxy/ ICINDEN deploy eder; --cwd kok vercel.json'u okur)
// Usage: /api/proxy?url=https://query1.finance.yahoo.com/...
//        /api/proxy?source=yahoo&path=/v8/finance/chart/THYAO.IS&range=1mo&interval=1d
//        /api/proxy?source=bigpara&symbol=THYAO
//        /api/proxy?source=isyatirim&symbol=THYAO&startdate=01-01-2024&enddate=15-04-2026
//        /api/proxy?source=foreks&symbol=THYAO&last=252&period=1440
//        /api/proxy?source=kap_disclosures&days=3               (v31.38 KAP bildirim akisi)
//        /api/proxy?source=kap_disclosures&days=60&oid=<32 hex> (v31.38 tek sirket)
//        /api/proxy?source=isy_foreign                          (v31.38 hisse bazli yabanci orani)
//        /api/proxy?source=tcmb_evds&series=TP.MKNETHAR.M7&startdate=dd-mm-yyyy&enddate=dd-mm-yyyy&evds_key=...
//
// Features:
// - Domain whitelist for security
// - 2-minute edge cache (stale-while-revalidate 10min)
// - 10-second upstream timeout with AbortController
// - Specialized shorthand routes for common data sources
// - Referer/UA spoofing for each data source
// ═══════════════════════════════════════════════════════════════

const ALLOWED_DOMAINS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'web-paragaranti-pubsub.foreks.com',
  'finans.truncgil.com',
  'bigpara.hurriyet.com.tr',
  'www.bigpara.com.tr',
  'www.isyatirim.com.tr',
  'www.tcmb.gov.tr',
  'evds2.tcmb.gov.tr',
  // v31.38: EVDS moved to evds3 — evds2 /service/evds now 302s to the SPA.
  'evds3.tcmb.gov.tr',
  'nfs.faireconomy.media',
  'api.genelpara.com',
  'www.kap.org.tr',
  'biquote.io',
  'fc.yahoo.com',
  // v31.22: RSS news feeds. Without these the proxy returned 403 for every news
  // request, which (together with the HTML guard in fetchEngine) is why the
  // news-driven selection layer never received a single item.
  'www.borsaningundemi.com',
  'www.bigpara.com',
  'www.mynet.com',
  'www.bloomberght.com',
  'www.dunya.com',
  'www.sabah.com.tr',
];

const ALLOWED_SOURCES = new Set([
  'yahoo', 'yahoo_fund', 'bigpara', 'bigpara_list', 'bigpara_yabanci',
  'isyatirim', 'isyatirim_fin', 'isyatirim_yabanci', 'foreks', 'tcmb_evds', 'news', 'default',
  // v31.38: server-side POST routes (see handleKapDisclosures / handleIsyForeign)
  'kap_disclosures', 'isy_foreign',
]);

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4173',
  'capacitor://localhost',
  'http://localhost',
];

function getCorsOrigin(req) {
  const origin = req.headers.origin;
  // No origin header = Electron renderer or server-to-server (allow)
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Allow any Vercel deployment of this project
  if (/^https:\/\/bist[\w-]*\.vercel\.app$/.test(origin)) return origin;
  return false; // blocked
}

// Source-specific headers for better success rate
const SOURCE_HEADERS = {
  // v31.22: RSS feeds must NOT inherit the JSON/AJAX headers below — the bigpara
  // branch in particular would send Accept: application/json for an XML feed.
  news: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'tr-TR,tr;q=0.9',
  },
  yahoo: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  bigpara: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://bigpara.hurriyet.com.tr/',
    'Accept': 'application/json',
    // BigPara API'si bu header olmadan 401 doner (AJAX-only endpoint gate).
    'X-Requested-With': 'XMLHttpRequest',
  },
  isyatirim: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.isyatirim.com.tr/',
    'Accept': 'application/json',
  },
  foreks: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.paragaranti.com/',
    'Accept': 'application/json',
  },
  default: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
  },
};

// --- Yahoo Auto-Crumb System for Proxy ---
let cachedYahooCookie = null;
let cachedYahooCrumb = null;
let crumbExpiry = 0;

async function getYahooAuth() {
  if (cachedYahooCookie && cachedYahooCrumb && Date.now() < crumbExpiry) {
    return { cookie: cachedYahooCookie, crumb: cachedYahooCrumb };
  }
  try {
    const res = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const cookieHeader = res.headers.get('set-cookie');
    if (!cookieHeader) return null;
    cachedYahooCookie = cookieHeader.split(';')[0];

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cachedYahooCookie
      }
    });
    cachedYahooCrumb = await crumbRes.text();
    crumbExpiry = Date.now() + 1000 * 60 * 45; // 45 mins
    return { cookie: cachedYahooCookie, crumb: cachedYahooCrumb };
  } catch (e) {
    return null;
  }
}


// Build URL from shorthand source parameter
function buildSourceUrl(query) {
  const { source, symbol, path } = query;

  switch (source) {
    case 'yahoo': {
      const range = query.range || '1mo';
      const interval = query.interval || '1d';
      const ver = query.ver || 'v8';
      if (path) return `https://query1.finance.yahoo.com${path}`;
      return `https://query1.finance.yahoo.com/${ver}/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false`;
    }
    case 'yahoo_fund': {
      const modules = query.modules || 'defaultKeyStatistics,financialData,summaryDetail';
      return `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}.IS?modules=${modules}`;
    }
    case 'bigpara':
      return `https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/${symbol}`;
    case 'bigpara_list':
      return 'https://bigpara.hurriyet.com.tr/api/v1/hisse/list';
    case 'bigpara_yabanci':
      return 'https://bigpara.hurriyet.com.tr/api/v1/borsa/yapikredi/yabancioranlari';
    case 'isyatirim': {
      const startdate = query.startdate || '01-01-2024';
      const enddate = query.enddate || formatDateISY(new Date());
      return `https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?hisse=${symbol}&startdate=${startdate}&enddate=${enddate}`;
    }
    case 'isyatirim_fin':
      return `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo?companyCode=${symbol}&exchange=TRY&financialGroup=XI_29&year1=2024&period1=12&year2=2023&period2=12&year3=2022&period3=12&year4=&period4=`;
    case 'isyatirim_yabanci': {
      // Yabancı Oran endpoint. Expected format: ?date=24.06.2026 or similar, or scrape HTML page.
      // We will proxy the HTML page and let client parse it if necessary, or just use BigPara yabancı
      return `https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/yabanci-oranlari.aspx`;
    }
    case 'tcmb_evds': {
      // v31.38: EVDS3. The old evds2 /service/evds URL now 302s to the SPA, and
      // since 2024-04-05 the key must travel in a `key` HEADER (added in the
      // handler), never in the URL. TP.MKNETHAR.M7 = weekly net equity
      // purchases by non-residents (mn USD), data group bie_mknethar.
      const series = /^[A-Za-z0-9._-]{3,60}$/.test(query.series || '') ? query.series : 'TP.MKNETHAR.M7';
      const start = /^\d{2}-\d{2}-\d{4}$/.test(query.startdate || '') ? query.startdate : '01-01-2024';
      const end = /^\d{2}-\d{2}-\d{4}$/.test(query.enddate || '') ? query.enddate : formatDateISY(new Date());
      return `https://evds3.tcmb.gov.tr/igmevdsms-dis/series=${series}&startDate=${start}&endDate=${end}&type=json`;
    }
    case 'foreks': {
      const last = query.last || '252';
      const period = query.period || '1440';
      return `https://web-paragaranti-pubsub.foreks.com/web-services/historical-data?userName=undefined&name=${symbol}&exchange=BIST&market=N&group=E&last=${last}&period=${period}&intraPeriod=null&isLast=false`;
    }
    default:
      return null;
  }
}

function formatDateISY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

function getHeaders(source) {
  // Return a COPY. The Yahoo branch below injects a Cookie into this object; with
  // a shared reference that cookie was written onto the module-level
  // SOURCE_HEADERS.yahoo and then re-sent on every later request handled by the
  // same warm serverless instance — including after the crumb rotated (55 min),
  // so a stale cookie/crumb pair kept going out. Serverless instances are reused,
  // so per-request mutation of module state is a cross-request leak.
  return { ...(SOURCE_HEADERS[source] || SOURCE_HEADERS.default) };
}

// ── v31.38: SERVER-SIDE POST ROUTES ────────────────────────────────────────
// Both upstreams answer only a JSON POST, which a browser cannot send to them
// cross-origin. The proxy makes the call and returns a SLIM payload: raw KAP is
// ~990 bytes per disclosure and a scan pulls a week of them.

const KAP_LIST_URL = 'https://www.kap.org.tr/tr/api/disclosure/list/main';
const ISY_SCREENER_URL = 'https://www.isyatirim.com.tr/tr-tr/analiz/_Layouts/15/IsYatirim.Website/StockInfo/CompanyInfoAjax.aspx/getScreenerDataNEW';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const DAY_MS = 24 * 60 * 60 * 1000;

// İş Yatırım screener criteria ids (measured 2026-09-12, 603 rows):
//   40 foreign ratio %, 44 / 45 foreign ratio 1-week / 1-month change,
//   8 market cap (mn TL), 22 / 23 relative return 1-week / 1-month %.
const ISY_FIELDS = [
  ['40', 'foreignRatio'], ['44', 'foreignChg1w'], ['45', 'foreignChg1m'],
  ['8', 'mcapMnTL'], ['22', 'rel1w'], ['23', 'rel1m'],
];

function istanbulDate(ms) {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function trimText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s || s === '-') return null;
  return s.length > max ? s.slice(0, max) : s;
}

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

function sendUpstreamError(res, err) {
  const timeout = err && err.name === 'AbortError';
  return res.status(timeout ? 504 : 500).json({ ok: false, error: timeout ? 'upstream_timeout' : 'fetch_failed' });
}

async function handleKapDisclosures(req, res) {
  const oid = typeof req.query.oid === 'string' && /^[0-9a-f]{32}$/i.test(req.query.oid)
    ? req.query.oid.toLowerCase() : null;
  const maxDays = oid ? 180 : 14;
  const parsed = parseInt(req.query.days, 10);
  const days = Number.isFinite(parsed) ? Math.min(maxDays, Math.max(1, parsed)) : 3;
  const now = Date.now();
  const body = {
    fromDate: istanbulDate(now - days * DAY_MS),
    toDate: istanbulDate(now),
    disclosureTypes: null,
    memberTypes: ['IGS'],
    mkkMemberOid: oid,
  };
  try {
    const { status, text } = await postJson(KAP_LIST_URL, body, {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'tr',
      'Origin': 'https://www.kap.org.tr',
      'Referer': 'https://www.kap.org.tr/tr/bildirim-sorgu',
    }, 9000);
    if (status !== 200) return res.status(502).json({ ok: false, error: 'upstream_status', status });
    let raw;
    try { raw = JSON.parse(text); } catch { return res.status(502).json({ ok: false, error: 'upstream_not_json' }); }
    if (!Array.isArray(raw)) return res.status(502).json({ ok: false, error: 'upstream_shape' });

    const items = [];
    for (const row of raw) {
      const b = row && row.disclosureBasic;
      if (!b || !Number.isFinite(Number(b.disclosureIndex))) continue;
      const company = trimText(b.companyTitle, 80);
      const summary = trimText(b.summary, 280);
      if (/^KAP TEST/i.test(company || '') || /^test bildirimi$/i.test(summary || '')) continue;
      const code = trimText(b.stockCode, 40);
      const item = {
        i: Number(b.disclosureIndex),
        c: code,
        r: trimText(b.relatedStocks, 400),
        t: trimText(b.title, 160),
        s: summary,
        k: b.disclosureClass || null,
        d: b.publishDate || null,
        m: company,
      };
      // OID only where it identifies a listed company (lets the client learn code → OID).
      if (code && typeof b.mkkMemberOid === 'string') item.o = b.mkkMemberOid;
      items.push(item);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', oid ? 's-maxage=1800, stale-while-revalidate=3600' : 's-maxage=300, stale-while-revalidate=900');
    res.setHeader('X-Proxy-Source', 'kap_disclosures');
    return res.status(200).json({
      ok: true, source: 'kap', fromDate: body.fromDate, toDate: body.toDate,
      fetchedAt: now, count: items.length, items,
    });
  } catch (err) {
    return sendUpstreamError(res, err);
  }
}

async function handleIsyForeign(req, res) {
  const body = {
    sektor: '', endeks: '', takip: '', oneri: '', lang: '1055',
    criterias: [
      ['40', '0', '100', 'False'],
      ['44', '-100000', '100000', 'False'],
      ['45', '-100000', '100000', 'False'],
      ['8', '0', '100000000', 'False'],
      ['22', '-100000', '100000', 'False'],
      ['23', '-100000', '100000', 'False'],
    ],
  };
  const now = Date.now();
  try {
    const { status, text } = await postJson(ISY_SCREENER_URL, body, {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.isyatirim.com.tr',
      'Referer': 'https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/gelismis-hisse-arama.aspx',
    }, 9000);
    if (status !== 200) return res.status(502).json({ ok: false, error: 'upstream_status', status });
    let list;
    try {
      const outer = JSON.parse(text);
      list = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
    } catch {
      return res.status(502).json({ ok: false, error: 'upstream_not_json' });
    }
    if (!Array.isArray(list)) return res.status(502).json({ ok: false, error: 'upstream_shape' });

    const num = (v) => {
      const n = parseFloat(String(v).replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    const rows = [];
    for (const it of list) {
      const symbol = String((it && it.Hisse) || '').split(' - ')[0].trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{2,5}$/.test(symbol)) continue;
      rows.push([symbol, ...ISY_FIELDS.map(([id]) => num(it[id]))]);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    res.setHeader('X-Proxy-Source', 'isy_foreign');
    return res.status(200).json({
      ok: true, source: 'isyatirim', fetchedAt: now,
      fields: ['symbol', ...ISY_FIELDS.map(([, name]) => name)],
      count: rows.length, rows,
    });
  } catch (err) {
    return sendUpstreamError(res, err);
  }
}

export default async function handler(req, res) {
  // CORS — restrict to known origins; Electron has no origin header (allowed)
  const allowedOrigin = getCorsOrigin(req);
  if (allowedOrigin === false) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validate source parameter
  const rawSource = req.query.source || 'default';
  if (!ALLOWED_SOURCES.has(rawSource)) {
    return res.status(400).json({ error: 'Invalid source parameter' });
  }

  // Validate + sanitize symbol (alphanumeric, dots, max 20 chars)
  if (req.query.symbol) {
    if (!/^[A-Za-z0-9.]{1,20}$/.test(req.query.symbol)) {
      return res.status(400).json({ error: 'Invalid symbol parameter' });
    }
  }

  // v31.38: POST-only upstreams — the proxy makes the call itself.
  if (rawSource === 'kap_disclosures') return handleKapDisclosures(req, res);
  if (rawSource === 'isy_foreign') return handleIsyForeign(req, res);

  let targetUrl = req.query.url;
  let sourceType = rawSource;

  // Build URL from shorthand if no direct URL provided
  if (!targetUrl && req.query.source) {
    targetUrl = buildSourceUrl(req.query);
    if (!targetUrl) {
      return res.status(400).json({ error: 'Invalid source or missing parameters' });
    }
  }

  if (!targetUrl) {
    return res.status(400).json({
      error: 'url parameter required, or use source= shorthand',
      usage: {
        direct: '/api/proxy?url=https://...',
        yahoo: '/api/proxy?source=yahoo&symbol=THYAO&range=1mo&interval=1d',
        bigpara: '/api/proxy?source=bigpara&symbol=THYAO',
        bigpara_list: '/api/proxy?source=bigpara_list',
        isyatirim: '/api/proxy?source=isyatirim&symbol=THYAO',
        isyatirim_fin: '/api/proxy?source=isyatirim_fin&symbol=THYAO',
        foreks: '/api/proxy?source=foreks&symbol=THYAO&last=252&period=1440',
        yahoo_fund: '/api/proxy?source=yahoo_fund&symbol=THYAO',
        kap_disclosures: '/api/proxy?source=kap_disclosures&days=3',
        isy_foreign: '/api/proxy?source=isy_foreign',
      },
    });
  }

  // Domain whitelist check
  try {
    const parsed = new URL(targetUrl);
    if (!ALLOWED_DOMAINS.some(d => parsed.hostname.includes(d))) {
      return res.status(403).json({ error: 'Domain not allowed: ' + parsed.hostname });
    }
    // Auto-detect source type from URL if not specified
    if (sourceType === 'default') {
      // v31.22: RSS check comes FIRST — www.bigpara.com/rss/... would otherwise
      // be classified as the bigpara JSON API and get the wrong headers.
      const path = parsed.pathname.toLowerCase() + parsed.search.toLowerCase();
      if (path.includes('/rss') || path.endsWith('.xml') || path.includes('rss?')) sourceType = 'news';
      else if (parsed.hostname.includes('yahoo')) sourceType = 'yahoo';
      else if (parsed.hostname.includes('bigpara')) sourceType = 'bigpara';
      else if (parsed.hostname.includes('isyatirim')) sourceType = 'isyatirim';
      else if (parsed.hostname.includes('foreks')) sourceType = 'foreks';
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const fetchHeaders = getHeaders(sourceType);

    // v31.38: EVDS key goes in a header (TCMB rule since 2024-04-05). Client value
    // first, then an optional EVDS_API_KEY env var on the deployment.
    if (sourceType === 'tcmb_evds') {
      const key = (typeof req.query.evds_key === 'string' && req.query.evds_key.trim()) || process.env.EVDS_API_KEY || '';
      if (key) fetchHeaders.key = key;
    }

    // Auto-inject Yahoo Crumb if target is Yahoo v8 or requires it
    if (sourceType === 'yahoo' && targetUrl.includes('/v8/')) {
      const auth = await getYahooAuth();
      if (auth && auth.cookie) {
        fetchHeaders['Cookie'] = auth.cookie;
        // The client might have sent its own crumb in URL. We should override it or append ours if missing.
        // It's safer to always use the server's crumb because it matches the server's cookie.
        if (targetUrl.includes('crumb=')) {
          targetUrl = targetUrl.replace(/crumb=[^&]+/, 'crumb=' + auth.crumb);
        } else {
          const sep = targetUrl.includes('?') ? '&' : '?';
          targetUrl += sep + 'crumb=' + auth.crumb;
        }
      }
    }

    const response = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || 'application/json';
    const text = await response.text();

    // Edge cache: 2 minutes fresh, serve stale for up to 10 minutes while revalidating
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.setHeader('X-Proxy-Source', sourceType);
    res.setHeader('X-Proxy-Target', targetUrl.substring(0, 100));

    return res.status(response.status).send(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'upstream_timeout', source: sourceType });
    }
    return res.status(500).json({ error: 'fetch_failed', source: sourceType });
  }
}
