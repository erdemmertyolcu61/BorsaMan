// ═══════════════════════════════════════════════════════════════
// BIST Terminal — Self-Hosted CORS Proxy (Vercel Serverless)
// ═══════════════════════════════════════════════════════════════
// Deploy: cd proxy && vercel --prod
// Usage: /api/proxy?url=https://query1.finance.yahoo.com/...
//        /api/proxy?source=yahoo&path=/v8/finance/chart/THYAO.IS&range=1mo&interval=1d
//        /api/proxy?source=bigpara&symbol=THYAO
//        /api/proxy?source=isyatirim&symbol=THYAO&startdate=01-01-2024&enddate=15-04-2026
//        /api/proxy?source=foreks&symbol=THYAO&last=252&period=1440
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
  'www.isyatirim.com.tr',
  'www.tcmb.gov.tr',
  'evds2.tcmb.gov.tr',
  'nfs.faireconomy.media',
  'api.genelpara.com',
  'www.kap.org.tr',
];

const ALLOWED_SOURCES = new Set([
  'yahoo', 'yahoo_fund', 'bigpara', 'bigpara_list',
  'isyatirim', 'isyatirim_fin', 'isyatirim_yabanci', 'foreks', 'tcmb_evds', 'default',
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
  yahoo: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  bigpara: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://bigpara.hurriyet.com.tr/',
    'Accept': 'application/json',
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
      // EVDS requires API key
      const series = query.series || 'bie_ypgircik';
      const start = query.startdate || '01-01-2024';
      const end = query.enddate || formatDateISY(new Date());
      const keyStr = query.evds_key ? `&key=${query.evds_key}` : '';
      return `https://evds2.tcmb.gov.tr/service/evds/series=${series}&startDate=${start}&endDate=${end}&type=json${keyStr}`;
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
  return SOURCE_HEADERS[source] || SOURCE_HEADERS.default;
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
      if (parsed.hostname.includes('yahoo')) sourceType = 'yahoo';
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
