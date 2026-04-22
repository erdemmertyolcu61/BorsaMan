/**
 * signals.js — regression tests.
 *
 * Locks in the contracts for two critical functions:
 *   • calcPosition — the ONLY function that determines lot size + max loss.
 *     Any silent change here directly touches user capital.
 *   • genSignal returns a stable shape { signal, cls, score, ... } so that
 *     consumers (UI, signal tracker, live guard) don't crash on NaN/undef.
 */

import { describe, it, expect } from 'vitest';
import { calcPosition, genSignal } from '../signals.js';
import { calcAll } from '../indicators.js';

describe('calcPosition', () => {
  it('sizes lot based on risk percentage, never exceeding account cash', () => {
    const r = calcPosition(10000, 2, 100, 95); // 2% of 10k = 200 TL risk, 5 TL per share → 40 shares
    expect(r.shares).toBe(40);
    expect(r.cost).toBe(4000);
    expect(r.maxLoss).toBeCloseTo(200, 2);
    expect(r.riskPct).toBe(2);
    expect(r.costPct).toBeCloseTo(40, 2);
  });

  it('caps shares by available budget when risk allows more than cash can buy', () => {
    // 50% risk on 1000 TL with 0.10 TL stop distance → would want 5000 shares
    // but entry is 100 TL, so budget only allows 10 shares
    const r = calcPosition(1000, 50, 100, 99.9);
    expect(r.shares).toBe(10);
    expect(r.cost).toBe(1000);
  });

  it('returns zero-risk payload when stop == entry (undefined R/R)', () => {
    const r = calcPosition(10000, 2, 50, 50);
    expect(r.shares).toBe(0);
    expect(r.cost).toBe(0);
    expect(r.maxLoss).toBe(0);
  });
});

describe('genSignal output contract', () => {
  // Build realistic bullish/bearish OHLCV series so calcAll populates
  // every array genSignal depends on (ma20, ma50, macd.macd[], etc).
  const bullishPrices = Array.from({ length: 220 }, (_, i) => {
    const c = 50 + i * 0.4;
    return { date: new Date(2024, 0, i + 1), open: c - 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 + i };
  });
  const bearishPrices = Array.from({ length: 220 }, (_, i) => {
    const c = 200 - i * 0.4;
    return { date: new Date(2024, 0, i + 1), open: c + 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 };
  });

  it('returns a stable shape with signal, cls, and a numeric score', () => {
    const ind = calcAll(bullishPrices);
    const sig = genSignal(ind, bullishPrices);
    expect(sig).toBeDefined();
    expect(typeof sig.signal).toBe('string');
    expect(['buy', 'sell', 'hold', 'neutral']).toContain(sig.cls);
    expect(Number.isFinite(sig.score)).toBe(true);
    // Signal label is one of the 5 canonical buckets, optionally suffixed
    // with a qualifier like " (Edge yetersiz)".
    expect(/^(GUCLU AL|AL|TUT|SAT|GUCLU SAT)( .+)?$/.test(sig.signal)).toBe(true);
  });

  it('is not a bullish BUY on a deeply bearish setup', () => {
    const ind = calcAll(bearishPrices);
    const sig = genSignal(ind, bearishPrices);
    expect(sig.cls).not.toBe('buy');
  });
});
