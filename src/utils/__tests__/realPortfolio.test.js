import { describe, it, expect } from 'vitest';
import {
  normalizePositions, positionMetrics, summarizeGroup, allocationPct,
  sortedByReturnPct, biggestWinner, biggestLoser, checkAlerts, portfolioTotals,
} from '../realPortfolio.js';

const pos = (o) => ({ ticker: 'X', market: 'BIST', quantity: 10, avgCost: 100, currency: 'TRY', currentPrice: 110, ...o });

describe('normalizePositions', () => {
  it('accepts the Python portfolio.json shape (snake_case avg_cost)', () => {
    const out = normalizePositions({
      positions: [{ ticker: 'nvda', market: 'US', quantity: 0.6931, avg_cost: 202, currency: 'USD' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ticker: 'NVDA', market: 'US', avgCost: 202, currency: 'USD' });
    expect(out[0].currentPrice).toBeNull();
  });

  it('accepts a bare array and defaults market to BIST', () => {
    const out = normalizePositions([{ ticker: 'KCHOL', quantity: 16, avgCost: 204 }]);
    expect(out[0].market).toBe('BIST');
  });

  it('drops entries without a ticker and is null-safe', () => {
    expect(normalizePositions(null)).toEqual([]);
    expect(normalizePositions({ positions: [{ quantity: 5 }] })).toEqual([]);
  });
});

describe('positionMetrics', () => {
  it('computes value / cost / return / return%', () => {
    const m = positionMetrics(pos({ quantity: 10, avgCost: 100, currentPrice: 110 }));
    expect(m.value).toBe(1100);
    expect(m.cost).toBe(1000);
    expect(m.ret).toBe(100);
    expect(m.retPct).toBeCloseTo(10, 6);
  });

  it('treats a missing price as unpriced (no fabricated value)', () => {
    const m = positionMetrics(pos({ currentPrice: null }));
    expect(m.hasPrice).toBe(false);
    expect(m.value).toBe(0);
    expect(m.ret).toBe(0);
    expect(m.retPct).toBe(0);
  });

  it('zero cost basis does not divide by zero', () => {
    expect(positionMetrics(pos({ avgCost: 0 })).retPct).toBe(0);
  });
});

describe('summarizeGroup', () => {
  it('excludes unpriced positions from totals but reports them', () => {
    const group = [
      pos({ ticker: 'A', quantity: 10, avgCost: 100, currentPrice: 120 }), // +200
      pos({ ticker: 'B', quantity: 5, avgCost: 200, currentPrice: null }),  // unpriced
    ];
    const s = summarizeGroup(group);
    expect(s.totalValue).toBe(1200);
    expect(s.totalCost).toBe(1000);
    expect(s.totalReturn).toBe(200);
    expect(s.totalReturnPct).toBeCloseTo(20, 6);
    expect(s.missingTickers).toEqual(['B']);
    expect(s.count).toBe(2);
  });

  it('empty group → zeros, no NaN', () => {
    const s = summarizeGroup([]);
    expect(s.totalValue).toBe(0);
    expect(s.totalReturnPct).toBe(0);
  });
});

describe('allocation + ranking', () => {
  const group = [
    pos({ ticker: 'A', quantity: 10, avgCost: 100, currentPrice: 150 }), // val 1500, +50%
    pos({ ticker: 'B', quantity: 10, avgCost: 100, currentPrice: 50 }),  // val 500,  -50%
  ];

  it('allocationPct weights by value within the group', () => {
    expect(allocationPct(group[0], group)).toBeCloseTo(75, 6);
    expect(allocationPct(group[1], group)).toBeCloseTo(25, 6);
  });

  it('unpriced position has 0 allocation', () => {
    expect(allocationPct(pos({ currentPrice: null }), group)).toBe(0);
  });

  it('sorts by return% and finds winner / loser', () => {
    expect(sortedByReturnPct(group).map(p => p.ticker)).toEqual(['A', 'B']);
    expect(biggestWinner(group).ticker).toBe('A');
    expect(biggestLoser(group).ticker).toBe('B');
  });

  it('winner/loser on an empty list → null', () => {
    expect(biggestWinner([])).toBeNull();
    expect(biggestLoser([])).toBeNull();
  });
});

describe('checkAlerts', () => {
  it('fires loss and gain alerts on the default thresholds', () => {
    const list = [
      pos({ ticker: 'LOSS', avgCost: 100, currentPrice: 85 }),  // -15% <= -10
      pos({ ticker: 'GAIN', avgCost: 100, currentPrice: 130 }), // +30% >= 20
      pos({ ticker: 'CALM', avgCost: 100, currentPrice: 103 }), // +3% → none
    ];
    const a = checkAlerts(list);
    expect(a.map(x => x.ticker).sort()).toEqual(['GAIN', 'LOSS']);
    expect(a.find(x => x.ticker === 'LOSS').kind).toBe('loss');
    expect(a.find(x => x.ticker === 'GAIN').kind).toBe('gain');
  });

  it('honors per-ticker overrides and skips unpriced', () => {
    const list = [pos({ ticker: 'NVDA', avgCost: 100, currentPrice: 88 })]; // -12%
    expect(checkAlerts(list, { perTicker: { NVDA: { loss: -20 } } })).toEqual([]);
    expect(checkAlerts([pos({ currentPrice: null, avgCost: 100 })])).toEqual([]);
  });
});

describe('portfolioTotals (multi-currency)', () => {
  const positions = [
    pos({ ticker: 'NVDA', market: 'US', currency: 'USD', quantity: 1, avgCost: 200, currentPrice: 250 }),
    pos({ ticker: 'KCHOL', market: 'BIST', currency: 'TRY', quantity: 10, avgCost: 200, currentPrice: 220 }),
  ];

  it('converts the US leg with USD/TRY into a combined TRY total', () => {
    const t = portfolioTotals(positions, 40);
    // US: value 250*40=10000, cost 200*40=8000 ; BIST: value 2200, cost 2000
    expect(t.totalValueTRY).toBeCloseTo(12200, 6);
    expect(t.totalCostTRY).toBeCloseTo(10000, 6);
    expect(t.totalReturnTRY).toBeCloseTo(2200, 6);
    expect(t.totalReturnPct).toBeCloseTo(22, 6);
    expect(t.usConversionMissing).toBe(false);
  });

  it('flags missing FX rate and excludes the US leg rather than faking it', () => {
    const t = portfolioTotals(positions, null);
    expect(t.usConversionMissing).toBe(true);
    expect(t.totalValueTRY).toBeCloseTo(2200, 6); // BIST only
  });

  it('keeps per-group summaries separate', () => {
    const t = portfolioTotals(positions, 40);
    expect(t.us.totalValue).toBeCloseTo(250, 6);   // in USD
    expect(t.bist.totalValue).toBeCloseTo(2200, 6); // in TRY
  });
});
