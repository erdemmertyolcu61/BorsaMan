// ── LIVE EDGE — paper-trade truth, segmented by conviction tier × regime (v29.5)
//
// This is the honesty layer. Backtests say "sniper in YUKSELIS should win"; this
// module says what the forward paper-trades ACTUALLY did in the last N closes,
// bucketed the same way the advisor buckets its picks (convictionTier × regime).
// Pure + testable: feeds off closedTrades only, no I/O, no mutation.
//
// A bucket is only "reliable" once it has MIN_SAMPLE closes — below that we still
// report the numbers but flag reliable=false so the UI can grey it out and the
// scorer (if ever wired) can ignore it. Small samples lie.

export const MIN_SAMPLE = 8;

const TIER_ORDER = ['sniper', 'flagged', 'early'];
const REGIME_ORDER = ['BULL', 'NEUTRAL', 'BEAR'];

function normTier(t) {
  const v = String(t || '').toLowerCase();
  if (v === 'sniper' || v === 'flagged' || v === 'early') return v;
  return 'early'; // default bucket for legacy trades without a conviction tag
}

function normRegime(r) {
  const v = String(r || '').toUpperCase();
  if (v === 'BULL' || v === 'BEAR' || v === 'NEUTRAL') return v;
  return 'NEUTRAL';
}

// Reduce a flat list of closed trades into one edge bucket.
function reduceBucket(trades) {
  const n = trades.length;
  if (!n) {
    return { n: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0,
      expectancy: 0, profitFactor: 0, totalPnlPct: 0, reliable: false };
  }
  const wins = trades.filter(t => (t.pnl_pct ?? t.pnlPct ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl_pct ?? t.pnlPct ?? 0) <= 0);
  const pctOf = (t) => t.pnl_pct ?? t.pnlPct ?? 0;
  const winRate = (wins.length / n) * 100;
  const avgWinPct = wins.length ? wins.reduce((a, t) => a + pctOf(t), 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((a, t) => a + pctOf(t), 0) / losses.length : 0;
  const expectancy = (winRate / 100) * avgWinPct + (1 - winRate / 100) * avgLossPct;
  const grossWin = wins.reduce((a, t) => a + pctOf(t), 0);
  const grossLoss = losses.reduce((a, t) => a + Math.abs(pctOf(t)), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (wins.length ? Infinity : 0);
  const totalPnlPct = trades.reduce((a, t) => a + pctOf(t), 0);
  return {
    n, wins: wins.length, losses: losses.length,
    winRate: Math.round(winRate * 10) / 10,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    profitFactor: isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : Infinity,
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    reliable: n >= MIN_SAMPLE,
  };
}

/**
 * Segment closed paper-trades into conviction-tier × regime buckets.
 *
 * @param {Array} closedTrades - PaperTradeEngine closed trades (SQLite or localStorage shape)
 * @param {Object} [opts]
 * @param {number} [opts.limit] - only consider the most recent N closes (recency window)
 * @returns {{
 *   overall: object,
 *   byTier: Record<string, object>,
 *   byRegime: Record<string, object>,
 *   cells: Array<{ tier, regime, ...bucket }>,
 *   sampleSize: number,
 * }}
 */
export function computeLiveEdge(closedTrades = [], opts = {}) {
  let closed = Array.isArray(closedTrades) ? closedTrades.filter(Boolean) : [];
  // Recency window — most-recent first. Closed lists arrive newest-first from the
  // engine, but sort defensively on closed_at so a mixed order can't skew it.
  if (opts.limit && closed.length > opts.limit) {
    closed = [...closed]
      .sort((a, b) => (b.closed_at || b.closedAt || 0) - (a.closed_at || a.closedAt || 0))
      .slice(0, opts.limit);
  }

  const tierOf = (t) => normTier(t.convictionTier ?? t.conviction_tier);
  const regimeOf = (t) => normRegime(t.entryRegime ?? t.entry_regime ?? t.regime);

  const byTier = {};
  for (const tier of TIER_ORDER) byTier[tier] = reduceBucket(closed.filter(t => tierOf(t) === tier));

  const byRegime = {};
  for (const regime of REGIME_ORDER) byRegime[regime] = reduceBucket(closed.filter(t => regimeOf(t) === regime));

  const cells = [];
  for (const tier of TIER_ORDER) {
    for (const regime of REGIME_ORDER) {
      const bucket = reduceBucket(closed.filter(t => tierOf(t) === tier && regimeOf(t) === regime));
      if (bucket.n > 0) cells.push({ tier, regime, ...bucket });
    }
  }

  return {
    overall: reduceBucket(closed),
    byTier,
    byRegime,
    cells,
    sampleSize: closed.length,
  };
}

/**
 * Look up the live edge for a specific tier × regime combination.
 * Returns null when the bucket has too few samples to trust.
 *
 * @param {object} edge - output of computeLiveEdge
 * @param {string} tier - 'sniper' | 'flagged' | 'early'
 * @param {string} regime - 'BULL' | 'NEUTRAL' | 'BEAR'
 * @returns {object|null} the bucket if reliable, else null
 */
export function getLiveEdgeStat(edge, tier, regime) {
  if (!edge?.cells?.length) return null;
  const t = normTier(tier), r = normRegime(regime);
  const cell = edge.cells.find(c => c.tier === t && c.regime === r);
  if (!cell || !cell.reliable) return null;
  return cell;
}
