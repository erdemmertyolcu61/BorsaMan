import { describe, it, expect } from 'vitest';
import {
  TOTAL_COST_PCT,
  liquiditySlippagePct,
  applyEntryCost,
  applyExitCost,
  netRR,
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

  describe('netRR', () => {
    it('is always below the frictionless gross RR', () => {
      // gross: entry 100, stop 97, target 106 → RR = 2.0
      const net = netRR(100, 97, 106);
      expect(net).not.toBeNull();
      expect(net).toBeLessThan(2.0);
      expect(net).toBeGreaterThan(1.5); // typical degradation ~0.1-0.3 at BIST widths
    });

    it('degrades thin edges below the 1.0 bar', () => {
      // gross RR ≈ 1.05 with a tight 2% stop / 2.1% target
      const net = netRR(100, 98, 102.1);
      expect(net).toBeLessThan(1.0);
    });

    it('widens per-leg cost for illiquid tiers', () => {
      const liquid = netRR(100, 97, 106, 'HIGH');
      const illiquid = netRR(100, 97, 106, 'VERY_LOW');
      expect(illiquid).toBeLessThan(liquid);
    });

    it('returns null on invalid geometry', () => {
      expect(netRR(0, 97, 106)).toBeNull();
      expect(netRR(100, 101, 106)).toBeNull();  // stop above entry (long) → risk<=0
      expect(netRR(100, NaN, 106)).toBeNull();
      expect(netRR(null, 97, 106)).toBeNull();
    });
  });
});
