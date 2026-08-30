import { describe, it, expect } from 'vitest';
import {
  applyConvictionSizing, convictionTierOf,
  TIER_MULT, NEUTRAL_EXTRA_MULT, MAX_MULT,
} from '../positionSizing.js';

describe('positionSizing.convictionTierOf', () => {
  it('uses the stamped tier when present', () => {
    expect(convictionTierOf({ convictionTier: 'sniper', score: 10 })).toBe('sniper');
  });

  it('derives from score with the SAME thresholds as stampSegKeys (75 / 65)', () => {
    expect(convictionTierOf({ score: 75 })).toBe('sniper');
    expect(convictionTierOf({ score: 74 })).toBe('flagged');
    expect(convictionTierOf({ score: 65 })).toBe('flagged');
    expect(convictionTierOf({ score: 64 })).toBe('early');
    expect(convictionTierOf({})).toBe('early');       // no score → most cautious
  });

  it('classifies sells separately', () => {
    expect(convictionTierOf({ cls: 'sell', score: 20 })).toBe('sell');
  });
});

describe('positionSizing.applyConvictionSizing', () => {
  it('scales by conviction tier in BULL — a sniper is twice an early pick', () => {
    const sniper = applyConvictionSizing(1, { convictionTier: 'sniper', _regime: 'BULL' });
    const flagged = applyConvictionSizing(1, { convictionTier: 'flagged', _regime: 'BULL' });
    const early = applyConvictionSizing(1, { convictionTier: 'early', _regime: 'BULL' });
    expect(sniper).toBe(TIER_MULT.sniper);
    expect(flagged).toBe(TIER_MULT.flagged);
    expect(early).toBe(TIER_MULT.early);
    expect(sniper).toBe(early * 2);
  });

  it('halves NEUTRAL buys on top of the tier multiplier', () => {
    // The arithmetic this exists for: NEUTRAL is -1.98% net per trade, so the
    // same setup opens smaller there than in BULL.
    const bull = applyConvictionSizing(1, { convictionTier: 'sniper', _regime: 'BULL' });
    const neutral = applyConvictionSizing(1, { convictionTier: 'sniper', _regime: 'NEUTRAL' });
    expect(neutral).toBeCloseTo(bull * NEUTRAL_EXTRA_MULT, 6);
  });

  it('returns 0 for watch-only picks — visible, never opened', () => {
    expect(applyConvictionSizing(1, { convictionTier: 'sniper', _regime: 'BEAR', _watchOnly: true })).toBe(0);
    // and the flag wins even over a large incoming multiplier
    expect(applyConvictionSizing(1.4, { convictionTier: 'sniper', _watchOnly: true })).toBe(0);
  });

  it('exempts sells from the NEUTRAL penalty', () => {
    // The -1.98% figure is a measurement of BUY expectancy; penalising sells with
    // it would be applying a number to something it never measured.
    expect(applyConvictionSizing(1, { cls: 'sell', _regime: 'NEUTRAL' })).toBe(TIER_MULT.sell);
  });

  it('compounds with the multiplier already in the chain', () => {
    // regimeEngine.riskMult (RANGE = 0.8) x governor arrives as `current`.
    const out = applyConvictionSizing(0.8, { convictionTier: 'flagged', _regime: 'NEUTRAL' });
    expect(out).toBeCloseTo(0.8 * 0.75 * 0.5, 3);
  });

  it('accepts a regime fallback when the pick has none', () => {
    const withFallback = applyConvictionSizing(1, { convictionTier: 'sniper' }, 'NEUTRAL');
    expect(withFallback).toBeCloseTo(NEUTRAL_EXTRA_MULT, 6);
    // a stamped regime on the pick takes precedence over the fallback
    const stamped = applyConvictionSizing(1, { convictionTier: 'sniper', _regime: 'BULL' }, 'NEUTRAL');
    expect(stamped).toBe(1);
  });

  it('treats an invalid incoming multiplier as 1 rather than propagating it', () => {
    for (const bad of [undefined, null, NaN, -2, 0]) {
      expect(applyConvictionSizing(bad, { convictionTier: 'sniper', _regime: 'BULL' })).toBe(1);
    }
  });

  it('clamps the result to the allowed range', () => {
    expect(applyConvictionSizing(99, { convictionTier: 'sniper', _regime: 'BULL' })).toBe(MAX_MULT);
    expect(applyConvictionSizing(1, {})).toBeGreaterThanOrEqual(0);
  });

  it('is defensive against a missing pick', () => {
    expect(applyConvictionSizing(1, undefined)).toBe(TIER_MULT.early);
  });
});
