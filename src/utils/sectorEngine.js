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

// ── SECTOR TILT NORMALIZATION (v31.20) — pure, testable ───────────────────
// BUG (measured): useAIAdvisor's enhancePick fed a RAW sector score into
//   sectorComponent = (50 + sectorScore * 8) * 0.10
// while that formula is designed for a small tilt in the -3..+3 range (giving a
// ~2.6-7.4 component, i.e. the intended ~10% weight). The map was filled with
// `avgScore` (~40-60) — and both `avgScore` and `strength` are 0-100-style
// centered-at-50 scales — so the component came out at 37-53: roughly 7x its
// design weight, dominating the composite. Real scan evidence: GOZDE (score 46,
// cls='neutral') scored confidence 97/grade A on a sector component of 42, ranking
// ABOVE SOKM (score 62.6, a genuine buy) which got 5. Confidence stopped measuring
// setup quality and started measuring "is my sector in the map".
//
// This converts any centered-at-50 sector metric into the intended small tilt.
// Works for avgScore (~40-60) and strength (0-100) alike; unknown → 0 (neutral).
export const SECTOR_TILT_CLAMP = 3;

export function normalizeSectorTilt(rawSectorScore) {
  if (rawSectorScore == null || !Number.isFinite(rawSectorScore)) return 0;
  const tilt = (rawSectorScore - 50) / 3.5;   // 50 = neutral centre
  return Math.max(-SECTOR_TILT_CLAMP, Math.min(SECTOR_TILT_CLAMP, +tilt.toFixed(2)));
}
