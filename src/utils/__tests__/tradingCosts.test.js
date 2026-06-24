import { describe, it, expect } from 'vitest';
import {
  TOTAL_COST_PCT,
  liquiditySlippagePct,
  applyEntryCost,
  applyExitCost,
} from '../tradingCosts.js';

describe('tradingCosts', () => {
  it('exposes a sane default round-trip cost', () => {
    expect(TOTAL_COST_PCT).toBeGreaterThan(0);
    expect(TOTAL_COST_PCT).toBeLessThan(0.02);
  });

  it('resolves slippage by liquidity tier (string or object)', () => {
    expect(liquiditySlippagePct('HIGH')).toBeLessThan(liquiditySlippagePct('VERY_LOW'));
    expect(liquiditySlippagePct({ tier: 'MEDIUM' })).toBe(liquiditySlippagePct('MEDIUM'));
    expect(liquiditySlippagePct(null)).toBeGreaterThan(0); // default
    expect(liquiditySlippagePct('NONSENSE')).toBe(liquiditySlippagePct(null));
  });

  it('entry cost makes a buyer pay up and a seller receive down', () => {
    expect(applyEntryCost(100, 'buy', 0.002)).toBeCloseTo(100.2, 6);
    expect(applyEntryCost(100, 'sell', 0.002)).toBeCloseTo(99.8, 6);
  });

  it('exit cost makes a long sell down and a short buy up', () => {
    expect(applyExitCost(100, 'buy', 0.002)).toBeCloseTo(99.8, 6);
    expect(applyExitCost(100, 'sell', 0.002)).toBeCloseTo(100.2, 6);
  });

  it('round trip on a long position is always a net drag at flat price', () => {
    const entry = applyEntryCost(100, 'buy', TOTAL_COST_PCT / 2);
    const exit = applyExitCost(100, 'buy', TOTAL_COST_PCT / 2);
    expect(exit).toBeLessThan(entry); // selling flat still loses the spread
  });

  it('guards against invalid prices', () => {
    expect(applyEntryCost(null, 'buy')).toBeNull();
    expect(applyExitCost(undefined, 'buy')).toBeUndefined();
    expect(applyEntryCost(NaN, 'buy')).toBeNaN();
  });
});
