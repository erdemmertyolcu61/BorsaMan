// ============================================================
// SECTOR RELATIVE STRENGTH (RS) ENGINE
// Groups stocks by sector, calculates sector-level strength
// vs BIST100 index, and provides rotation signals
// ============================================================

import { SECTORS } from './constants.js';

// Reverse map: sector → stock list
export function getSectorStocks() {
  const map = {};
  for (const [sym, sec] of Object.entries(SECTORS)) {
    if (!map[sec]) map[sec] = [];
    map[sec].push(sym);
  }
  return map;
}

// Calculate relative strength of a stock/sector vs benchmark
// Returns RS score (0-100 scale, 50 = neutral)
export function calcRelativeStrength(prices, benchPrices, lookback = 20) {
  if (!prices || !benchPrices || prices.length < lookback || benchPrices.length < lookback) return 50;

  const pLen = prices.length;
  const bLen = benchPrices.length;

  const stockReturn = (prices[pLen - 1].close - prices[pLen - lookback].close) / prices[pLen - lookback].close;
  const benchReturn = (benchPrices[bLen - 1].close - benchPrices[bLen - lookback].close) / benchPrices[bLen - lookback].close;

  // RS ratio
  const rsRatio = benchReturn !== 0 ? stockReturn / Math.abs(benchReturn) : stockReturn > 0 ? 1.5 : 0.5;

  // Normalize to 0-100 scale
  // rsRatio > 1 means outperforming, < 1 means underperforming
  const rs = Math.min(100, Math.max(0, 50 + (rsRatio - 1) * 50));
  return Math.round(rs);
}

// Calculate sector aggregate metrics from individual stock scan results
export function calcSectorMetrics(scanResults) {
  const sectorMap = getSectorStocks();
  const sectors = {};

  for (const [sector, stocks] of Object.entries(sectorMap)) {
    const matches = scanResults.filter(r => stocks.includes(r.symbol));
    if (matches.length === 0) continue;

    const buyCount = matches.filter(r => r.cls === 'buy').length;
    const sellCount = matches.filter(r => r.cls === 'sell').length;
    const avgScore = matches.reduce((s, r) => s + (r.score || 0), 0) / matches.length;
    const avgRSI = matches.reduce((s, r) => s + (r.rsi || 50), 0) / matches.length;
    const accumCount = matches.filter(r => r.obvTrend === 'accumulation').length;
    const avgChange = matches.reduce((s, r) => s + (r.change || 0), 0) / matches.length;
    const totalVolume = matches.reduce((s, r) => s + (r.volume || 0), 0);
    const avgMFI = matches.reduce((s, r) => s + (r.mfi || 50), 0) / matches.length;
    const avgADX = matches.reduce((s, r) => s + (r.adx || 15), 0) / matches.length;

    // Composite strength score (0-100)
    let strength = 50;
    strength += (buyCount / matches.length - 0.3) * 30; // Buy ratio contribution
    strength += avgScore * 3; // Signal score contribution
    strength += (accumCount / matches.length) * 15; // Accumulation contribution
    strength += avgChange * 2; // Price momentum
    if (avgMFI < 30) strength += 5; // Oversold sector = potential bounce
    if (avgMFI > 70) strength -= 5; // Overbought risk
    if (avgADX > 25) strength += 3; // Trending sector
    strength = Math.min(100, Math.max(0, Math.round(strength)));

    // Rotation signal
    let rotation;
    if (strength >= 70 && buyCount > sellCount * 2) rotation = 'GUCLU GIRIS';
    else if (strength >= 60 && buyCount > sellCount) rotation = 'GIRIS';
    else if (strength <= 30 && sellCount > buyCount) rotation = 'CIKIS';
    else if (strength <= 40) rotation = 'ZAYIF';
    else rotation = 'NOTR';

    sectors[sector] = {
      sector,
      stocks: stocks.length,
      scanned: matches.length,
      buyCount,
      sellCount,
      holdCount: matches.length - buyCount - sellCount,
      buyPct: Math.round(buyCount / matches.length * 100),
      avgScore: +avgScore.toFixed(2),
      avgRSI: Math.round(avgRSI),
      avgMFI: Math.round(avgMFI),
      avgADX: Math.round(avgADX),
      accumPct: Math.round(accumCount / matches.length * 100),
      avgChange: +avgChange.toFixed(2),
      strength,
      rotation,
      topPick: matches.sort((a, b) => (b.score || 0) - (a.score || 0))[0]?.symbol || null,
    };
  }

  return sectors;
}

// Get top/bottom sectors for heatmap
export function rankSectors(sectorMetrics) {
  const list = Object.values(sectorMetrics);
  list.sort((a, b) => b.strength - a.strength);
  return list;
}

// Get sector for a symbol
export function getSector(symbol) {
  return SECTORS[symbol] || 'Diger';
}

// Calculate sector RS vs index for a specific stock
// sectorData = array of {symbol, prices} for all stocks in sector
// indexPrices = BIST100 prices
export function calcSectorRS(sectorData, indexPrices, lookback = 20) {
  if (!sectorData || sectorData.length === 0 || !indexPrices) return 50;

  // Average sector return
  let totalReturn = 0, count = 0;
  for (const stock of sectorData) {
    if (!stock.prices || stock.prices.length < lookback) continue;
    const len = stock.prices.length;
    const ret = (stock.prices[len - 1].close - stock.prices[len - lookback].close) / stock.prices[len - lookback].close;
    totalReturn += ret;
    count++;
  }
  if (count === 0) return 50;

  const avgSectorReturn = totalReturn / count;
  const bLen = indexPrices.length;
  if (bLen < lookback) return 50;
  const benchReturn = (indexPrices[bLen - 1].close - indexPrices[bLen - lookback].close) / indexPrices[bLen - lookback].close;

  const rsRatio = benchReturn !== 0 ? avgSectorReturn / Math.abs(benchReturn) : avgSectorReturn > 0 ? 1.5 : 0.5;
  return Math.min(100, Math.max(0, Math.round(50 + (rsRatio - 1) * 50)));
}
