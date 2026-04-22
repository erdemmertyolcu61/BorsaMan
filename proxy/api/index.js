import axios from 'axios';

const CACHE = new Map();
const CACHE_TTL = 300000; // 5 minutes

function getCached(key) {
  const item = CACHE.get(key);
  if (item && Date.now() - item.ts < CACHE_TTL) {
    return item.data;
  }
  CACHE.delete(key);
  return null;
}

function setCache(key, data) {
  CACHE.set(key, { data, ts: Date.now() });
}

async function fetchYahooFinance(symbol, range = '6mo', interval = '1d') {
  const cacheKey = `yahoo:${symbol}:${range}:${interval}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const rangeMap = {
    '5d': 7, '1mo': 35, '3mo': 100, '6mo': 200, '1y': 370, '2y': 740, '5y': 1850,
  };

  const period1 = Math.floor(Date.now() / 1000) - (rangeMap[range] || 200) * 86400;
  const period2 = Math.floor(Date.now() / 1000);

  const queryParams = new URLSearchParams({
    period1: period1.toString(),
    period2: period2.toString(),
    interval: interval === '1d' ? '1d' : interval,
    events: 'history',
    symbol: `${symbol}.IS`,
  });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?${queryParams}`;

  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    timeout: 15000,
  });

  const { chart } = response.data;
  if (!chart?.result?.[0]) {
    throw new Error('No data from Yahoo');
  }

  const result = chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose || quote.close;

  const prices = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    timestamp: ts,
    open: quote.open?.[i] ?? adjClose?.[i],
    high: quote.high?.[i],
    low: quote.low?.[i],
    close: adjClose?.[i],
    volume: quote.volume?.[i] || 0,
  })).filter(p => p.close != null);

  const data = {
    symbol: symbol.toUpperCase(),
    prices,
    source: 'Yahoo Finance (Vercel)',
    cachedAt: new Date().toISOString(),
  };

  setCache(cacheKey, data);
  return data;
}

async function fetchIsYatirim(symbol) {
  const cacheKey = `isyatirim:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);

  const formatDate = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };

  const params = new URLSearchParams({
    hisse: symbol,
    startdate: formatDate(startDate),
    enddate: formatDate(endDate),
  });

  const response = await axios.get(
    `https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?${params}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.isyatirim.com.tr/',
      },
      timeout: 15000,
    }
  );

  const values = response.data?.value || [];
  const prices = values.map(v => ({
    date: v.HGDG_TARIH?.split('-').reverse().join('-'),
    open: parseFloat(v.HGDG_AOF) || parseFloat(v.HGDG_KAPANIS),
    high: parseFloat(v.HGDG_MAX),
    low: parseFloat(v.HGDG_MIN),
    close: parseFloat(v.HGDG_KAPANIS),
    volume: Math.round(parseFloat(v.HGDG_HACIM) / parseFloat(v.HGDG_KAPANIS)) || 0,
  })).filter(p => p.close > 0);

  const data = {
    symbol: symbol.toUpperCase(),
    prices,
    source: 'İş Yatırım (Vercel)',
    cachedAt: new Date().toISOString(),
  };

  setCache(cacheKey, data);
  return data;
}

async function fetchBigParaQuote(symbol) {
  const cacheKey = `bigpara:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const response = await axios.get(
    `https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/${symbol}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://bigpara.hurriyet.com.tr/',
      },
      timeout: 10000,
    }
  );

  const h = response.data?.data?.hisseYuzeysel;
  if (!h) throw new Error('No data from BigPara');

  const data = {
    symbol: symbol.toUpperCase(),
    price: parseFloat(h.kapanis),
    open: parseFloat(h.acilis),
    high: parseFloat(h.yuksek),
    low: parseFloat(h.dusuk),
    volume: parseFloat(h.hacimlot),
    change: parseFloat(h.yuzdedegisim),
    prevClose: parseFloat(h.dunkukapanis),
    timestamp: Date.now(),
    source: 'BigPara (Vercel)',
  };

  setCache(cacheKey, data);
  return data;
}

async function fetchBISTList() {
  const cacheKey = 'bist:list';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const response = await axios.get(
    'https://bigpara.hurriyet.com.tr/api/v1/hisse/list',
    {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 15000,
    }
  );

  const stocks = response.data?.data?.map(h => ({
    symbol: h.kod,
    name: h.ad,
    price: parseFloat(h.kapanis) || 0,
    change: parseFloat(h.yuzdeDegisim) || 0,
    volume: parseFloat(h.hacimLot) || 0,
  })) || [];

  setCache(cacheKey, stocks);
  return stocks;
}

export default async function handler(req, res) {
  const { type, symbol, symbols, range, interval } = req.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let data;

    switch (type) {
      case 'yahoo':
        if (!symbol) throw new Error('symbol required');
        data = await fetchYahooFinance(symbol, range || '6mo', interval || '1d');
        break;

      case 'isyatirim':
        if (!symbol) throw new Error('symbol required');
        data = await fetchIsYatirim(symbol);
        break;

      case 'bigpara':
        if (!symbol) throw new Error('symbol required');
        data = await fetchBigParaQuote(symbol);
        break;

      case 'bistlist':
        data = await fetchBISTList();
        break;

      case 'batch':
        if (!symbols) throw new Error('symbols required');
        const symbolList = symbols.split(',').slice(0, 50);
        const results = await Promise.allSettled(
          symbolList.map(s => fetchBigParaQuote(s.trim().toUpperCase()))
        );
        data = {
          quotes: results.filter(r => r.status === 'fulfilled').map(r => r.value),
          timestamp: Date.now(),
        };
        break;

      default:
        throw new Error('Invalid type. Use: yahoo, isyatirim, bigpara, bistlist, batch');
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('[Vercel API] Error:', error.message);
    return res.status(500).json({
      error: error.message,
      source: 'vercel-api',
      timestamp: new Date().toISOString(),
    });
  }
}
