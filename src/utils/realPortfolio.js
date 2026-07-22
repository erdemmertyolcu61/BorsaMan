// ── GERÇEK PORTFÖY (US + BIST) — pure, testable ───────────────────────────
// Ported from the standalone Python tracker (models.py / calculations.py /
// alerts.py). The terminal's existing "Portföy" tab is a VIRTUAL paper account;
// this module models REAL, manually-maintained positions across two markets and
// two currencies, so a combined total needs a USD/TRY rate.
//
// Positions never ship in the repo — they live in localStorage (personal data).
//
// Position shape (accepts snake_case from the Python portfolio.json too):
//   { ticker, market: 'US'|'BIST', quantity, avgCost|avg_cost, currency, currentPrice }

export const DEFAULT_LOSS_ALERT_PCT = -10;
export const DEFAULT_GAIN_ALERT_PCT = 20;

/** Normalize raw JSON (python portfolio.json or UI edits) into our shape. */
export function normalizePositions(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.positions || []);
  return list
    .filter(p => p && p.ticker)
    .map(p => ({
      ticker: String(p.ticker).toUpperCase().trim(),
      market: p.market === 'US' ? 'US' : 'BIST',
      quantity: Number(p.quantity) || 0,
      avgCost: Number(p.avgCost ?? p.avg_cost) || 0,
      currency: p.currency || (p.market === 'US' ? 'USD' : 'TRY'),
      currentPrice: Number.isFinite(Number(p.currentPrice)) ? Number(p.currentPrice) : null,
    }));
}

export function hasPrice(p) {
  return p && Number.isFinite(p.currentPrice) && p.currentPrice > 0;
}

/** Per-position value / cost / return, in the position's OWN currency. */
export function positionMetrics(p) {
  const priced = hasPrice(p);
  const value = priced ? p.quantity * p.currentPrice : 0;
  const cost = p.quantity * p.avgCost;
  const ret = priced ? value - cost : 0;
  const retPct = cost === 0 || !priced ? 0 : (ret / cost) * 100;
  return { hasPrice: priced, value, cost, ret, retPct };
}

/**
 * Group (US or BIST) totals. Unpriced positions are EXCLUDED from the totals
 * but reported in missingTickers — mirrors the Python summarize_group.
 */
export function summarizeGroup(positions = []) {
  const priced = positions.filter(hasPrice);
  const totalValue = priced.reduce((s, p) => s + positionMetrics(p).value, 0);
  const totalCost = priced.reduce((s, p) => s + positionMetrics(p).cost, 0);
  const totalReturn = totalValue - totalCost;
  return {
    totalValue,
    totalCost,
    totalReturn,
    totalReturnPct: totalCost === 0 ? 0 : (totalReturn / totalCost) * 100,
    missingTickers: positions.filter(p => !hasPrice(p)).map(p => p.ticker),
    count: positions.length,
  };
}

/** Weight of a position inside its own group (%). */
export function allocationPct(position, group = []) {
  const total = group.filter(hasPrice).reduce((s, p) => s + positionMetrics(p).value, 0);
  if (total === 0 || !hasPrice(position)) return 0;
  return (positionMetrics(position).value / total) * 100;
}

/** Priced positions sorted by return % (unpriced dropped). */
export function sortedByReturnPct(positions = [], descending = true) {
  return positions
    .filter(hasPrice)
    .slice()
    .sort((a, b) => {
      const d = positionMetrics(b).retPct - positionMetrics(a).retPct;
      return descending ? d : -d;
    });
}

export function biggestWinner(positions = []) {
  return sortedByReturnPct(positions, true)[0] || null;
}

export function biggestLoser(positions = []) {
  return sortedByReturnPct(positions, false)[0] || null;
}

/**
 * Threshold alerts (ported from alerts.py). `perTicker` allows per-symbol
 * overrides: { NVDA: { loss: -15, gain: 30 } }.
 */
export function checkAlerts(positions = [], opts = {}) {
  const lossDefault = Number.isFinite(opts.lossPct) ? opts.lossPct : DEFAULT_LOSS_ALERT_PCT;
  const gainDefault = Number.isFinite(opts.gainPct) ? opts.gainPct : DEFAULT_GAIN_ALERT_PCT;
  const perTicker = opts.perTicker || {};
  const alerts = [];
  for (const p of positions) {
    if (!hasPrice(p)) continue;
    const o = perTicker[p.ticker] || {};
    const lossLimit = Number.isFinite(o.loss) ? o.loss : lossDefault;
    const gainLimit = Number.isFinite(o.gain) ? o.gain : gainDefault;
    const pct = positionMetrics(p).retPct;
    if (pct <= lossLimit) {
      alerts.push({ ticker: p.ticker, kind: 'loss', pct, message: `${p.ticker} %${pct.toFixed(1)} — zarar eşiği (${lossLimit}%) aşıldı` });
    } else if (pct >= gainLimit) {
      alerts.push({ ticker: p.ticker, kind: 'gain', pct, message: `${p.ticker} %${pct.toFixed(1)} — kâr eşiği (${gainLimit}%) aşıldı` });
    }
  }
  return alerts;
}

/**
 * Combined portfolio in TRY. US positions are converted with usdTry.
 * Returns null-safe zeros when the rate is missing (US side then excluded).
 */
export function portfolioTotals(positions = [], usdTry = null) {
  const us = positions.filter(p => p.market === 'US');
  const bist = positions.filter(p => p.market === 'BIST');
  const usSum = summarizeGroup(us);
  const bistSum = summarizeGroup(bist);
  const rate = Number.isFinite(usdTry) && usdTry > 0 ? usdTry : null;

  const usValueTRY = rate ? usSum.totalValue * rate : 0;
  const usCostTRY = rate ? usSum.totalCost * rate : 0;
  const totalValueTRY = bistSum.totalValue + usValueTRY;
  const totalCostTRY = bistSum.totalCost + usCostTRY;
  const totalReturnTRY = totalValueTRY - totalCostTRY;

  return {
    us: usSum,
    bist: bistSum,
    usdTry: rate,
    totalValueTRY,
    totalCostTRY,
    totalReturnTRY,
    totalReturnPct: totalCostTRY === 0 ? 0 : (totalReturnTRY / totalCostTRY) * 100,
    // true when the USD leg could not be converted (rate missing) but US positions exist
    usConversionMissing: !rate && us.length > 0,
  };
}
