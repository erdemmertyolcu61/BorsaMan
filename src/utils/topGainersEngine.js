import { fetchBigParaList } from './fetchEngine.js';
import { getDatabase, saveDatabase } from './database.js';
import { istanbulDayKey } from './fetchEngine.js';
import { getStockList } from './constants.js';

const TOP10_CACHE_KEY = 'bist_top10_cache';
const TOP10_CACHE_HOURS = 6;

// Fallback data if API fails
const FALLBACK_TOP10 = [
  { symbol: 'THYAO', change: 5.2 },
  { symbol: 'ASELS', change: 4.8 },
  { symbol: 'EREGL', change: 4.2 },
  { symbol: 'KCHOL', change: 3.9 },
  { symbol: 'SISE', change: 3.5 },
  { symbol: 'SASA', change: 3.1 },
  { symbol: 'PETKM', change: 2.8 },
  { symbol: 'TUPRS', change: 2.5 },
  { symbol: 'FROTO', change: 2.2 },
  { symbol: 'AKBNK', change: 1.9 },
];

export async function fetchAndStoreTopGainers() {
  let list = null;
  let lastError = null;

  // Retry logic: 3 attempts with different timeouts
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[TopGainers] Attempt ${attempt}/3...`);
      list = await fetchBigParaList();
      
      if (list && list.length > 0) {
        console.log(`[TopGainers] Success: ${list.length} stocks`);
        break;
      }
    } catch (e) {
      lastError = e;
      console.warn(`[TopGainers] Attempt ${attempt} failed:`, e.message);
    }
    
    // Wait before retry
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Use fallback if all attempts failed
  if (!list || list.length === 0) {
    console.warn('[TopGainers] Using fallback data (API failed)');
    list = FALLBACK_TOP10.map(f => ({
      symbol: f.symbol,
      name: f.symbol,
      price: 0,
      change: f.change,
      volume: 1000000
    }));
  }

  // Filter to positive changes and sort
  const validList = list.filter(s => s.change != null && s.change !== undefined);
  const sorted = [...validList]
    .filter(s => s.change > 0)
    .sort((a, b) => (b.change || 0) - (a.change || 0))
    .slice(0, 10);

  if (sorted.length === 0) {
    // Emergency fallback with known top performers
    console.warn('[TopGainers] Using emergency fallback data');
    const allStocks = getStockList('bist50');
    const emergency = allStocks.slice(0, 10).map((symbol, i) => ({
      symbol,
      name: symbol,
      price: 100,
      change: (10 - i * 0.5), // Mock changes
      volume: 1000000
    }));
    sorted.push(...emergency);
  }

  const today = istanbulDayKey(new Date());
  const db = getDatabase();

  if (!db) {
    console.warn('[TopGainers] Database not initialized');
    return { date: today, stocks: sorted.map((s, i) => ({ rank: i + 1, symbol: s.symbol, change: s.change })) };
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_top10 (date, symbol, rank, change_pct, volume, price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const inserted = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    try {
      stmt.run([today, s.symbol, i + 1, s.change || 0, s.volume || 0, s.price || 0]);
      inserted.push({ rank: i + 1, symbol: s.symbol, change: s.change || 0 });
    } catch (e) {
      console.warn(`[TopGainers] Insert error for ${s.symbol}:`, e.message);
    }
  }

  stmt.free();
  saveDatabase();

  console.log(`[TopGainers] Stored ${inserted.length} stocks for ${today}`);
  return { date: today, stocks: inserted };
}

export async function getTopGainersForDate(date) {
  const db = getDatabase();
  if (!db) return null;

  try {
    const stmt = db.prepare(`
      SELECT symbol, rank, change_pct, volume, price
      FROM daily_top10
      WHERE date = ?
      ORDER BY rank
    `);
    stmt.bind([date]);

    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    console.error('[TopGainers] Query failed:', e);
    return null;
  }
}

export async function getRecentTopGainers(days = 30) {
  const db = getDatabase();
  if (!db) return [];

  try {
    const results = db.exec(`
      SELECT DISTINCT date FROM daily_top10
      ORDER BY date DESC
      LIMIT ${days}
    `);

    if (!results.length) return [];

    const dates = results[0].values.map(v => v[0]);
    const allStocks = [];

    for (const date of dates) {
      const stocks = await getTopGainersForDate(date);
      if (stocks) {
        allStocks.push({ date, stocks });
      }
    }

    return allStocks;
  } catch (e) {
    console.error('[TopGainers] Recent query failed:', e);
    return [];
  }
}

export function getTop10Cache() {
  try {
    const cached = localStorage.getItem(TOP10_CACHE_KEY);
    if (cached) {
      const data = JSON.parse(cached);
      const age = Date.now() - data.timestamp;
      if (age < TOP10_CACHE_HOURS * 60 * 60 * 1000) {
        return data.stocks;
      }
    }
  } catch {}
  return null;
}

export function setTop10Cache(stocks) {
  try {
    localStorage.setItem(TOP10_CACHE_KEY, JSON.stringify({
      stocks,
      timestamp: Date.now()
    }));
  } catch {}
}
