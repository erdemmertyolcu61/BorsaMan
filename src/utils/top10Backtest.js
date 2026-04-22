import { getDatabase, saveDatabase } from './database.js';
import { fetchData } from './fetchEngine.js';
import { calcAll } from './indicators.js';

const STRATEGY_NAME = 'top10_momentum';

export async function runTop10Backtest(symbols, options = {}) {
  const {
    minVolume = 1000000,
    maxPositions = 10,
    holdingDays = 1,
    stopLoss = -5,
    targetProfit = 10
  } = options;

  const db = getDatabase();
  const results = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchData(symbol, '3mo', '1d');
      if (!data || !data.prices || data.prices.length < 30) continue;

      const trades = simulateTrades(data.prices, {
        holdingDays,
        stopLoss,
        targetProfit
      });

      for (const trade of trades) {
        results.push({
          symbol,
          ...trade,
          indicators: JSON.stringify(trade.indicators)
        });
      }
    } catch (e) {
      console.warn(`[Backtest] ${symbol} failed:`, e.message);
    }
  }

  if (db && results.length > 0) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO backtest_results
      (date, strategy, symbol, entry_price, exit_price, roi_pct, holding_days, stop_hit, target_hit, indicators)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const today = new Date().toISOString().split('T')[0];
    for (const r of results) {
      stmt.run([
        today, STRATEGY_NAME, r.symbol, r.entryPrice, r.exitPrice,
        r.roiPct, r.holdingDays, r.stopHit ? 1 : 0, r.targetHit ? 1 : 0, r.indicators
      ]);
    }
    stmt.free();
    saveDatabase();
  }

  return aggregateResults(results);
}

function simulateTrades(prices, options) {
  const { holdingDays, stopLoss, targetProfit } = options;
  const trades = [];

  for (let i = 30; i < prices.length - holdingDays; i++) {
    const entry = prices[i];
    const exitIdx = Math.min(i + holdingDays, prices.length - 1);
    const exit = prices[exitIdx];

    const roiPct = ((exit.close - entry.close) / entry.close) * 100;

    const stopHit = roiPct <= stopLoss;
    const targetHit = roiPct >= targetProfit;

    const ind = calcAll(prices.slice(0, i + 1));
    const rsi = ind.rsi?.[ind.rsi.length - 1] || null;
    const macd = ind.macd?.[ind.macd.length - 1] || null;
    const volumeRatio = entry.volume / (ind.sma?.find(s => s.period === 20)?.values?.slice(-1)[0] || entry.volume);

    trades.push({
      entryDate: entry.date,
      exitDate: exit.date,
      entryPrice: entry.close,
      exitPrice: exit.close,
      roiPct,
      holdingDays,
      stopHit,
      targetHit,
      indicators: { rsi, macd, volumeRatio }
    });
  }

  return trades;
}

function aggregateResults(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgRoi: 0,
      maxDrawdown: 0,
      bestTrade: 0,
      worstTrade: 0,
      trades: []
    };
  }

  const wins = trades.filter(t => t.roiPct > 0);
  const losses = trades.filter(t => t.roiPct < 0);
  const rois = trades.map(t => t.roiPct);

  let equity = 10000;
  const equityCurve = [equity];
  let maxEquity = equity;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity *= (1 + trade.roiPct / 100);
    equityCurve.push(equity);
    maxEquity = Math.max(maxEquity, equity);
    const drawdown = ((maxEquity - equity) / maxEquity) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return {
    totalTrades: trades.length,
    winRate: ((wins.length / trades.length) * 100).toFixed(1),
    avgRoi: (rois.reduce((a, b) => a + b, 0) / rois.length).toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(2),
    bestTrade: Math.max(...rois).toFixed(2),
    worstTrade: Math.min(...rois).toFixed(2),
    profitFactor: Math.abs(wins.reduce((a, t) => a + t.roiPct, 0) / losses.reduce((a, t) => a + t.roiPct, 0) || 0).toFixed(2),
    trades: trades.slice(-100)
  };
}

export async function getBacktestHistory(days = 30) {
  const db = getDatabase();
  if (!db) return [];

  try {
    const results = db.exec(`
      SELECT date, strategy, COUNT(*) as count,
             AVG(roi_pct) as avg_roi,
             SUM(CASE WHEN roi_pct > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN roi_pct < 0 THEN 1 ELSE 0 END) as losses
      FROM backtest_results
      WHERE date >= date('now', '-${days} days')
      GROUP BY date, strategy
      ORDER BY date DESC
    `);

    if (!results.length) return [];

    return results[0].values.map(v => ({
      date: v[0],
      strategy: v[1],
      count: v[2],
      avgRoi: v[3]?.toFixed(2) || 0,
      wins: v[4],
      losses: v[5]
    }));
  } catch (e) {
    console.error('[Backtest] History query failed:', e);
    return [];
  }
}

export async function runIntradayTop10Strategy(symbols, threshold = 2) {
  const results = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchData(symbol, '5d', '1h');
      if (!data || !data.prices || data.prices.length < 20) continue;

      const latest = data.prices[data.prices.length - 1];
      const prev = data.prices[data.prices.length - 2];

      if (!latest || !prev) continue;

      const hourChange = ((latest.close - prev.close) / prev.close) * 100;

      if (hourChange >= threshold) {
        const ind = calcAll(data.prices);
        const rsi = ind.rsi?.[ind.rsi.length - 1] || null;
        const mfi = ind.mfi?.[ind.mfi.length - 1] || null;
        const volumeRatio = latest.volume / (ind.sma?.find(s => s.period === 20)?.values?.slice(-1)[0] || latest.volume);

        results.push({
          symbol,
          entryPrice: latest.close,
          expectedDirection: 'long',
          hourChange: hourChange.toFixed(2),
          rsi: rsi?.toFixed(1),
          mfi: mfi?.toFixed(1),
          volumeRatio: volumeRatio.toFixed(2),
          confidence: calculateConfidence({ rsi, mfi, volumeRatio, hourChange })
        });
      }
    } catch (e) {
      console.warn(`[Intraday] ${symbol} failed:`, e.message);
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

function calculateConfidence({ rsi, mfi, volumeRatio, hourChange }) {
  let score = 0;

  if (rsi && rsi < 50) score += 20;
  if (rsi && rsi < 30) score += 10;

  if (mfi && mfi < 40) score += 20;
  if (mfi && mfi < 30) score += 10;

  if (volumeRatio && volumeRatio > 1.5) score += 25;
  if (volumeRatio && volumeRatio > 2) score += 15;

  if (hourChange > 2 && hourChange < 5) score += 15;

  return Math.min(score, 100);
}
