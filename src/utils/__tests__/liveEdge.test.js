import { describe, it, expect } from 'vitest';
import { computeLiveEdge, getLiveEdgeStat, MIN_SAMPLE } from '../liveEdge.js';

// Trade factory — mirrors the localStorage closed-trade shape (camelCase),
// plus snake_case variants where the DB path differs.
const t = (o) => ({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 1, closed_at: Date.now(), ...o });

describe('computeLiveEdge', () => {
  it('returns empty structure for no trades', () => {
    const e = computeLiveEdge([]);
    expect(e.sampleSize).toBe(0);
    expect(e.overall.n).toBe(0);
    expect(e.cells).toEqual([]);
    expect(e.overall.reliable).toBe(false);
  });

  it('is defensive against null / garbage entries', () => {
    const e = computeLiveEdge([null, undefined, t({ pnl_pct: 2 })]);
    expect(e.sampleSize).toBe(1);
    expect(e.overall.n).toBe(1);
  });

  it('computes win rate and expectancy for a single bucket', () => {
    const trades = [
      t({ pnl_pct: 3 }), t({ pnl_pct: 2 }), t({ pnl_pct: -1 }), t({ pnl_pct: -2 }),
    ];
    const e = computeLiveEdge(trades);
    expect(e.overall.n).toBe(4);
    expect(e.overall.wins).toBe(2);
    expect(e.overall.losses).toBe(2);
    expect(e.overall.winRate).toBe(50);
    expect(e.overall.avgWinPct).toBe(2.5);
    expect(e.overall.avgLossPct).toBe(-1.5);
    // 0.5*2.5 + 0.5*(-1.5) = 0.5
    expect(e.overall.expectancy).toBe(0.5);
    // grossWin=5, grossLoss=3 → PF 1.67
    expect(e.overall.profitFactor).toBe(1.67);
  });

  it('treats a zero pnl as a loss (>0 is the win threshold)', () => {
    const e = computeLiveEdge([t({ pnl_pct: 0 }), t({ pnl_pct: 1 })]);
    expect(e.overall.wins).toBe(1);
    expect(e.overall.losses).toBe(1);
  });

  it('segments by convictionTier × regime into cells', () => {
    const trades = [
      t({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 2 }),
      t({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 1 }),
      t({ convictionTier: 'early', entryRegime: 'BEAR', pnl_pct: -3 }),
    ];
    const e = computeLiveEdge(trades);
    const sBull = e.cells.find(c => c.tier === 'sniper' && c.regime === 'BULL');
    const eBear = e.cells.find(c => c.tier === 'early' && c.regime === 'BEAR');
    expect(sBull.n).toBe(2);
    expect(sBull.winRate).toBe(100);
    expect(eBear.n).toBe(1);
    expect(eBear.winRate).toBe(0);
    // only the two populated cells appear
    expect(e.cells.length).toBe(2);
  });

  it('rolls up byTier and byRegime independently', () => {
    const trades = [
      t({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 2 }),
      t({ convictionTier: 'sniper', entryRegime: 'NEUTRAL', pnl_pct: -1 }),
      t({ convictionTier: 'flagged', entryRegime: 'BULL', pnl_pct: 1 }),
    ];
    const e = computeLiveEdge(trades);
    expect(e.byTier.sniper.n).toBe(2);
    expect(e.byTier.flagged.n).toBe(1);
    expect(e.byRegime.BULL.n).toBe(2);
    expect(e.byRegime.NEUTRAL.n).toBe(1);
    expect(e.byRegime.BEAR.n).toBe(0);
  });

  it('reads snake_case DB fields (conviction_tier / entry_regime / pnlPct)', () => {
    const trades = [
      { conviction_tier: 'sniper', entry_regime: 'BULL', pnlPct: 2, closed_at: 2 },
      { conviction_tier: 'sniper', entry_regime: 'BULL', pnlPct: 4, closed_at: 1 },
    ];
    const e = computeLiveEdge(trades);
    const cell = e.cells.find(c => c.tier === 'sniper' && c.regime === 'BULL');
    expect(cell.n).toBe(2);
    expect(cell.winRate).toBe(100);
  });

  it('defaults missing tier to early and missing regime to NEUTRAL', () => {
    const e = computeLiveEdge([{ pnl_pct: 1, closed_at: 1 }]);
    expect(e.byTier.early.n).toBe(1);
    expect(e.byRegime.NEUTRAL.n).toBe(1);
  });

  it('honors the recency limit — keeps only the newest N by closed_at', () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      t({ pnl_pct: i < 10 ? -5 : 5, closed_at: i })); // newest (high closed_at) are winners
    const e = computeLiveEdge(trades, { limit: 5 });
    expect(e.sampleSize).toBe(5);
    expect(e.overall.winRate).toBe(100); // only the 5 newest (winners) survive
  });

  it('flags reliability at MIN_SAMPLE', () => {
    const few = computeLiveEdge(Array.from({ length: MIN_SAMPLE - 1 }, () => t({ pnl_pct: 1 })));
    expect(few.overall.reliable).toBe(false);
    const enough = computeLiveEdge(Array.from({ length: MIN_SAMPLE }, () => t({ pnl_pct: 1 })));
    expect(enough.overall.reliable).toBe(true);
  });
});

describe('getLiveEdgeStat', () => {
  it('returns null when the bucket is too small to trust', () => {
    const e = computeLiveEdge([t({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 2 })]);
    expect(getLiveEdgeStat(e, 'sniper', 'BULL')).toBeNull();
  });

  it('returns the bucket once it has enough samples', () => {
    const trades = Array.from({ length: MIN_SAMPLE }, () =>
      t({ convictionTier: 'sniper', entryRegime: 'BULL', pnl_pct: 2 }));
    const e = computeLiveEdge(trades);
    const stat = getLiveEdgeStat(e, 'sniper', 'BULL');
    expect(stat).not.toBeNull();
    expect(stat.winRate).toBe(100);
    expect(stat.reliable).toBe(true);
  });

  it('returns null for an empty edge or unknown combo', () => {
    expect(getLiveEdgeStat(computeLiveEdge([]), 'sniper', 'BULL')).toBeNull();
    const e = computeLiveEdge(Array.from({ length: MIN_SAMPLE }, () =>
      t({ convictionTier: 'sniper', entryRegime: 'BULL' })));
    expect(getLiveEdgeStat(e, 'early', 'BEAR')).toBeNull();
  });
});
