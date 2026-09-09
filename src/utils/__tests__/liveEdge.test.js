import { describe, it, expect } from 'vitest';
import { computeLiveEdge, getLiveEdgeStat, MIN_SAMPLE, signalsToLiveEdgeTrades } from '../liveEdge.js';

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

describe('signalsToLiveEdgeTrades (v31.16)', () => {
  const sig = (o) => ({ cls: 'buy', status: 'closed', score: 80, regime: 'BULL', perf: { d5: 2 }, ...o });

  it('is defensive against non-array / empty', () => {
    expect(signalsToLiveEdgeTrades(null)).toEqual([]);
    expect(signalsToLiveEdgeTrades([])).toEqual([]);
  });

  it('includes only settled BUY signals with a realized return', () => {
    const out = signalsToLiveEdgeTrades([
      sig({ symbol: 'A' }),                                   // ok
      sig({ symbol: 'B', cls: 'sell' }),                     // sell → excluded
      sig({ symbol: 'C', status: 'active', perf: {} }),      // not settled → excluded
      sig({ symbol: 'D', status: 'active', perf: { d5: 3 } }), // 5d-settled → included
      sig({ symbol: 'E', perf: {}, currentReturn: null }),   // no return → excluded
    ]);
    expect(out).toHaveLength(2);
  });

  it('prefers d5, maps to pnlPct, and carries regime', () => {
    const [x] = signalsToLiveEdgeTrades([sig({ perf: { d1: 1, d3: 1.5, d5: 2.4 }, regime: 'NEUTRAL' })]);
    expect(x.pnlPct).toBe(2.4);
    expect(x.regime).toBe('NEUTRAL');
  });

  it('derives convictionTier from score when unrecorded, else keeps it', () => {
    expect(signalsToLiveEdgeTrades([sig({ score: 80 })])[0].convictionTier).toBe('sniper');
    expect(signalsToLiveEdgeTrades([sig({ score: 68 })])[0].convictionTier).toBe('flagged');
    expect(signalsToLiveEdgeTrades([sig({ score: 50 })])[0].convictionTier).toBe('early');
    expect(signalsToLiveEdgeTrades([sig({ score: 50, convictionTier: 'sniper' })])[0].convictionTier).toBe('sniper');
  });

  it('feeds computeLiveEdge → a full cell becomes reliable', () => {
    const signals = Array.from({ length: MIN_SAMPLE }, (_, i) =>
      sig({ symbol: `S${i}`, score: 80, regime: 'BULL', perf: { d5: 1 + (i % 2) } }));
    const edge = computeLiveEdge(signalsToLiveEdgeTrades(signals), { limit: 200 });
    const stat = getLiveEdgeStat(edge, 'sniper', 'BULL');
    expect(stat).not.toBeNull();
    expect(stat.n).toBe(MIN_SAMPLE);
    expect(stat.winRate).toBe(100); // all positive d5
  });
});

describe('signalsToLiveEdgeTrades — v31.35: same return source as calibration', () => {
  const sig = (over = {}) => ({
    cls: 'buy', status: 'closed', score: 78, regime: 'BULL',
    timestamp: '2026-08-20T09:00:00Z', ...over,
  });

  it('prefers planReturn — the metric the app actually instructs', () => {
    // v31.28-B moved calibration onto the plan return. This reader kept using the
    // raw latch, so the two learning paths were optimising different numbers.
    const [t] = signalsToLiveEdgeTrades([sig({ planReturn: 6.4, perf: { d5: -2.1 } })]);
    expect(t.pnlPct).toBe(6.4);
  });

  it('prefers the close-derived checkpoint over the live latch', () => {
    // perf.dN is one-shot and only runs while the app is open: with the app shut
    // for a week all four latches take the SAME late price (v31.22/v31.23).
    const [t] = signalsToLiveEdgeTrades([sig({ perfDaily: { d5: 3.3 }, perf: { d5: 11.9 } })]);
    expect(t.pnlPct).toBe(3.3);
  });

  it('still falls back to the live latch when nothing better exists', () => {
    const [t] = signalsToLiveEdgeTrades([sig({ perf: { d5: 2.5 } })]);
    expect(t.pnlPct).toBe(2.5);
  });

  it('counts a signal as settled on planReturn alone', () => {
    // A bar-reconstructed plan return is settled evidence even when the live
    // latches never fired because the app was closed.
    const out = signalsToLiveEdgeTrades([sig({ status: 'active', planReturn: -4.2 })]);
    expect(out).toHaveLength(1);
    expect(out[0].pnlPct).toBe(-4.2);
  });

  it('leaves a genuinely unsettled signal out', () => {
    expect(signalsToLiveEdgeTrades([sig({ status: 'active' })])).toHaveLength(0);
  });
});
