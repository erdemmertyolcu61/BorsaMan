import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import NodeCache from 'node-cache';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const WS_PORT = process.env.WS_PORT || 3002;

// ── Middleware ──
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json());

// ── Cache (5 min TTL for market data) ──
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ── Rate Limiter ──
const rateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60,
  blockDuration: 10,
});

const rateLimiterMiddleware = async (req, res, next) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    await rateLimiter.consume(clientIP);
    next();
  } catch {
    res.status(429).json({ error: 'Too many requests. Please wait.' });
  }
};

app.use('/api/', rateLimiterMiddleware);

// ── Yahoo Finance Fetcher ──
async function fetchYahooFinance(symbol, range = '6mo', interval = '1d') {
  const cacheKey = `yahoo:${symbol}:${range}:${interval}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const rangeMap = {
    '5d': { period1: 7, period2: 'd' },
    '1mo': { period1: 35, period2: 'd' },
    '3mo': { period1: 100, period2: 'd' },
    '6mo': { period1: 200, period2: 'd' },
    '1y': { period1: 370, period2: 'd' },
    '2y': { period1: 740, period2: 'd' },
    '5y': { period1: 1850, period2: 'd' },
  };

  const { period1, period2 } = rangeMap[range] || rangeMap['6mo'];
  const endDate = Math.floor(Date.now() / 1000);
  const startDate = endDate - (period1 * 24 * 60 * 60);

  const queryParams = new URLSearchParams({
    period1: startDate.toString(),
    period2: endDate.toString(),
    interval: interval === '1d' ? '1d' : interval,
    events: 'history',
    symbol: `${symbol}.IS`,
  });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?${queryParams}`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });

    const { chart } = response.data;
    if (!chart || !chart.result || chart.result.length === 0) {
      throw new Error('No data received from Yahoo');
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
      source: 'Yahoo Finance (Proxy)',
      cachedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    console.error(`[Yahoo] Error fetching ${symbol}:`, error.message);
    throw error;
  }
}

// ── İş Yatırım Fetcher ──
async function fetchIsYatirim(symbol) {
  const cacheKey = `isyatirim:${symbol}`;
  const cached = cache.get(cacheKey);
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

  try {
    const response = await axios.get(
      `https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?${params}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/plain, */*',
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
      source: 'İş Yatırım (Proxy)',
      cachedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, data, 1800); // 30 min cache
    return data;
  } catch (error) {
    console.error(`[İş Yatırım] Error fetching ${symbol}:`, error.message);
    throw error;
  }
}

// ── BigPara Real-time Quote ──
async function fetchBigParaQuote(symbol) {
  const cacheKey = `bigpara:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(
      `https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://bigpara.hurriyet.com.tr/',
        },
        timeout: 10000,
      }
    );

    const h = response.data?.data?.hisseYuzeysel;
    if (!h) throw new Error('No data');

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
      source: 'BigPara (Proxy)',
    };

    cache.set(cacheKey, data, 30); // 30 sec cache for live data
    return data;
  } catch (error) {
    console.error(`[BigPara] Error fetching ${symbol}:`, error.message);
    throw error;
  }
}

// ── BIST Stock List ──
async function fetchBISTList() {
  const cacheKey = 'bist:list';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(
      'https://bigpara.hurriyet.com.tr/api/v1/hisse/list',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        },
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

    cache.set(cacheKey, stocks, 300); // 5 min cache
    return stocks;
  } catch (error) {
    console.error('[BIST List] Error:', error.message);
    throw error;
  }
}

// ── API Routes ──

// Generic proxy endpoint
app.get('/api/proxy', async (req, res) => {
  const { url, type } = req.query;

  if (!url && !type) {
    return res.status(400).json({ error: 'Missing url or type parameter' });
  }

  try {
    let data;

    if (type === 'yahoo' && req.query.symbol) {
      data = await fetchYahooFinance(req.query.symbol, req.query.range || '6mo', req.query.interval || '1d');
    } else if (type === 'isyatirim' && req.query.symbol) {
      data = await fetchIsYatirim(req.query.symbol);
    } else if (type === 'bigpara' && req.query.symbol) {
      data = await fetchBigParaQuote(req.query.symbol);
    } else if (type === 'bistlist') {
      data = await fetchBISTList();
    } else if (url) {
      const response = await axios.get(decodeURIComponent(url), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        timeout: 15000,
      });
      data = response.data;
    } else {
      return res.status(400).json({ error: 'Invalid request' });
    }

    res.json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch data',
      message: error.message,
      source: 'proxy-server',
    });
  }
});

// Yahoo Finance specific endpoint
app.get('/api/yahoo/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range = '6mo', interval = '1d' } = req.query;
    const data = await fetchYahooFinance(symbol, range, interval);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// İş Yatırım endpoint
app.get('/api/isyatirim/:symbol', async (req, res) => {
  try {
    const data = await fetchIsYatirim(req.params.symbol);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// BigPara quote endpoint
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const data = await fetchBigParaQuote(req.params.symbol);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// BIST list endpoint
app.get('/api/bist/list', async (req, res) => {
  try {
    const data = await fetchBISTList();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Batch quotes for WebSocket subscriptions
app.post('/api/quotes/batch', express.json(), async (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array required' });
  }

  try {
    const results = await Promise.allSettled(
      symbols.slice(0, 50).map(s => fetchBigParaQuote(s.toUpperCase()))
    );

    const quotes = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    res.json({ quotes, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cacheSize: cache.keys().length,
    timestamp: new Date().toISOString(),
  });
});

// ── WebSocket Server (Live Data) ──
const server = createServer(app);
const wss = new WebSocketServer({ server: new WebSocketServer({ noServer: true }) });

// Integrate WebSocket with HTTP server
const wsServer = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Active subscriptions
const subscriptions = new Map(); // ws -> Set of symbols

wsServer.on('connection', (ws) => {
  console.log('[WS] Client connected');
  subscriptions.set(ws, new Set());

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.type === 'subscribe') {
        const symbols = Array.isArray(msg.symbols) ? msg.symbols : [msg.symbols];
        symbols.forEach(s => subscriptions.get(ws)?.add(s.toUpperCase()));
        ws.send(JSON.stringify({ type: 'subscribed', symbols: [...subscriptions.get(ws)] }));
      }

      if (msg.type === 'unsubscribe') {
        const symbols = Array.isArray(msg.symbols) ? msg.symbols : [msg.symbols];
        symbols.forEach(s => subscriptions.get(ws)?.delete(s.toUpperCase()));
        ws.send(JSON.stringify({ type: 'unsubscribed', symbols: [...subscriptions.get(ws)] }));
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (e) {
      console.error('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('[WS] Error:', error.message);
    subscriptions.delete(ws);
  });
});

// Broadcast live quotes to subscribers
async function broadcastQuotes() {
  const allSymbols = new Set();
  subscriptions.forEach(symbols => symbols.forEach(s => allSymbols.add(s)));

  if (allSymbols.size === 0) return;

  try {
    const results = await Promise.allSettled(
      [...allSymbols].slice(0, 50).map(s => fetchBigParaQuote(s))
    );

    const quotes = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (quotes.length > 0) {
      const message = JSON.stringify({
        type: 'quotes',
        data: quotes,
        timestamp: Date.now(),
      });

      subscriptions.forEach((symbols, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          const relevantQuotes = quotes.filter(q => symbols.has(q.symbol));
          if (relevantQuotes.length > 0) {
            ws.send(JSON.stringify({
              type: 'quotes',
              data: relevantQuotes,
              timestamp: Date.now(),
            }));
          }
        }
      });
    }
  } catch (error) {
    console.error('[WS] Broadcast error:', error.message);
  }
}

// Broadcast BIST index updates
async function broadcastIndexUpdates() {
  const indices = ['XU100', 'XU030', 'XU050'];

  try {
    const results = await Promise.allSettled(
      indices.map(idx => fetchYahooFinance(idx.replace('XU', ''), '5d', '1d'))
    );

    const updates = results
      .filter(r => r.status === 'fulfilled')
      .map((r, i) => ({
        symbol: indices[i],
        ...r.value,
      }));

    if (updates.length > 0) {
      const message = JSON.stringify({
        type: 'indices',
        data: updates,
        timestamp: Date.now(),
      });

      subscriptions.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      });
    }
  } catch (error) {
    console.error('[WS] Index broadcast error:', error.message);
  }
}

// Start broadcasting intervals
setInterval(broadcastQuotes, 5000); // Every 5 seconds
setInterval(broadcastIndexUpdates, 30000); // Every 30 seconds

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           BIST AI Trading Terminal - Proxy Server         ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP API:     http://localhost:${PORT}                      ║
║  WebSocket:    ws://localhost:${PORT}/ws                     ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                              ║
║  GET  /api/yahoo/:symbol     - Yahoo Finance OHLCV        ║
║  GET  /api/isyatirim/:symbol - İş Yatırım Historical     ║
║  GET  /api/quote/:symbol     - BigPara Live Quote         ║
║  GET  /api/bist/list         - BIST Stock List            ║
║  POST /api/quotes/batch      - Batch Quotes               ║
║  GET  /api/proxy             - Generic Proxy              ║
║  GET  /api/health            - Health Check              ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
