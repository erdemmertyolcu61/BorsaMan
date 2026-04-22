import { WebSocketServer } from 'ws';
import axios from 'axios';

const WS_PORT = process.env.WS_PORT || 8080;
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL) || 5000;

const wss = new WebSocketServer({ port: WS_PORT });

const subscriptions = new Map();
const quoteCache = new Map();

console.log(`[WS Server] Starting on port ${WS_PORT}`);
console.log(`[WS Server] Update interval: ${UPDATE_INTERVAL}ms`);

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(7);
  console.log(`[WS] Client ${clientId} connected`);
  subscriptions.set(ws, { id: clientId, symbols: new Set() });

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      const sub = subscriptions.get(ws);

      switch (msg.type) {
        case 'subscribe':
          const symbols = Array.isArray(msg.symbols) ? msg.symbols : [msg.symbols];
          symbols.forEach(s => {
            sub.symbols.add(s.toUpperCase());
            console.log(`[WS] ${clientId} subscribed to ${s}`);
          });
          ws.send(JSON.stringify({
            type: 'subscribed',
            symbols: [...sub.symbols],
            timestamp: Date.now()
          }));
          break;

        case 'unsubscribe':
          const toRemove = Array.isArray(msg.symbols) ? msg.symbols : [msg.symbols];
          toRemove.forEach(s => {
            sub.symbols.delete(s.toUpperCase());
            console.log(`[WS] ${clientId} unsubscribed from ${s}`);
          });
          ws.send(JSON.stringify({
            type: 'unsubscribed',
            symbols: [...sub.symbols],
            timestamp: Date.now()
          }));
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        case 'list':
          ws.send(JSON.stringify({
            type: 'symbol_list',
            symbols: [...sub.symbols],
            quote_count: quoteCache.size,
            timestamp: Date.now()
          }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (e) {
      console.error(`[WS] ${clientId} invalid message:`, e.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
    console.log(`[WS] Client ${clientId} disconnected`);
  });

  ws.on('error', (error) => {
    console.error(`[WS] ${clientId} error:`, error.message);
    subscriptions.delete(ws);
  });

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to BIST WebSocket Server',
    clientId,
    timestamp: Date.now()
  }));
});

async function fetchQuote(symbol) {
  const cacheKey = `quote:${symbol}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 15000) {
    return cached.data;
  }

  try {
    const response = await axios.get(
      `https://bigpara.hurriyet.com.tr/api/v1/borsa/hisseyuzeysel/${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        },
        timeout: 8000,
      }
    );

    const h = response.data?.data?.hisseYuzeysel;
    if (!h) return null;

    const quote = {
      symbol: symbol.toUpperCase(),
      price: parseFloat(h.kapanis),
      open: parseFloat(h.acilis),
      high: parseFloat(h.yuksek),
      low: parseFloat(h.dusuk),
      volume: parseFloat(h.hacimlot),
      change: parseFloat(h.yuzdedegisim),
      prevClose: parseFloat(h.dunkukapanis),
      timestamp: Date.now(),
    };

    quoteCache.set(cacheKey, { data: quote, ts: Date.now() });
    return quote;
  } catch (error) {
    return cached?.data || null;
  }
}

async function fetchYahooChart(symbol) {
  const cacheKey = `yahoo:${symbol}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60000) {
    return cached.data;
  }

  try {
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - (5 * 86400);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?period1=${startDate}&period2=${endDate}&interval=1d&events=history`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) return null;

    const quote = result.indicators?.quote?.[0];
    const timestamps = result.timestamp;

    if (!timestamps || !quote) return null;

    const lastIdx = timestamps.length - 1;
    const data = {
      symbol: symbol.toUpperCase(),
      lastClose: quote.close?.[lastIdx],
      open: quote.open?.[lastIdx],
      high: quote.high?.[lastIdx],
      low: quote.low?.[lastIdx],
      volume: quote.volume?.[lastIdx],
      timestamp: timestamps[lastIdx] * 1000,
    };

    quoteCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch (error) {
    return cached?.data || null;
  }
}

async function updateAndBroadcast() {
  const allSymbols = new Set();
  subscriptions.forEach(sub => sub.symbols.forEach(s => allSymbols.add(s)));

  if (allSymbols.size === 0) return;

  const symbols = [...allSymbols];
  const results = await Promise.allSettled(
    symbols.map(async (s) => {
      const quote = await fetchQuote(s);
      if (!quote) {
        const chart = await fetchYahooChart(s);
        return chart;
      }
      return quote;
    })
  );

  const updates = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (updates.length === 0) return;

  const broadcastMessage = JSON.stringify({
    type: 'quotes',
    data: updates,
    count: updates.length,
    timestamp: Date.now(),
  });

  let broadcastCount = 0;
  subscriptions.forEach((sub, ws) => {
    if (ws.readyState === 1) {
      const relevantUpdates = updates.filter(q => sub.symbols.has(q.symbol));
      if (relevantUpdates.length > 0) {
        ws.send(JSON.stringify({
          type: 'quotes',
          data: relevantUpdates,
          count: relevantUpdates.length,
          timestamp: Date.now(),
        }));
        broadcastCount++;
      }
    }
  });

  if (broadcastCount > 0) {
    console.log(`[WS] Broadcast ${updates.length} quotes to ${broadcastCount} clients`);
  }
}

setInterval(updateAndBroadcast, UPDATE_INTERVAL);

console.log(`
╔═══════════════════════════════════════════════════════╗
║       BIST AI Trading Terminal - WebSocket Server     ║
╠═══════════════════════════════════════════════════════╣
║  WebSocket:  ws://localhost:${WS_PORT}                     ║
║  Update:    Every ${UPDATE_INTERVAL}ms                          ║
╠═══════════════════════════════════════════════════════╣
║  Commands:                                              ║
║  { type: "subscribe", symbols: ["THYAO","ASELS"] }     ║
║  { type: "unsubscribe", symbols: ["THYAO"] }           ║
║  { type: "ping" }                                      ║
║  { type: "list" }                                      ║
╚═══════════════════════════════════════════════════════╝
`);

process.on('SIGINT', () => {
  console.log('[WS Server] Shutting down...');
  wss.close();
  process.exit(0);
});
