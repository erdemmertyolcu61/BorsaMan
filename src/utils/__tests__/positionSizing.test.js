import { describe, it, expect } from 'vitest';
import {
  applyConvictionSizing, convictionTierOf,
  TIER_MULT, NEUTRAL_EXTRA_MULT, MAX_MULT,
  suggestPosition, sizeMultOf, setTradingCapital, getTradingCapital, DEFAULT_CAPITAL,
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

// ── v31.47: lot onerisi ────────────────────────────────────────────────────

describe('positionSizing.suggestPosition (v31.47)', () => {
  it('risks 2% of capital at the stop — same rule as the paper engine', () => {
    // 100k, entry 100, stop 95 (5%) → 2,000 TL risk / 5% = 40,000 TL → capped at 33%.
    const s = suggestPosition({ capital: 100_000, entry: 100, stop: 95, mult: 1 });
    expect(s.ok).toBe(true);
    expect(s.lots).toBe(330);
    expect(s.capped).toBe(true);
    expect(s.riskTl).toBe(330 * 5);
    // A wide stop is NOT capped and sizes down with the distance.
    const wide = suggestPosition({ capital: 100_000, entry: 100, stop: 90, mult: 1 });
    expect(wide.lots).toBe(200);
    expect(wide.capped).toBe(false);
    expect(wide.riskTl).toBe(2000);
  });

  it('scales with the conviction multiplier and refuses watch-only picks', () => {
    expect(suggestPosition({ capital: 100_000, entry: 100, stop: 90, mult: 0.5 }).lots).toBe(100);
    expect(suggestPosition({ capital: 100_000, entry: 100, stop: 90, mult: 0 }).reason).toBe('watch_only');
    expect(sizeMultOf({ _watchOnly: true, _positionSizeMult: 1 })).toBe(0);
    expect(sizeMultOf({ _positionSizeMult: 0.4 })).toBe(0.4);
    expect(sizeMultOf({ convictionTier: 'early', _regime: 'BULL' })).toBe(0.5);
  });

  it('needs a stop below the entry and a meaningful size', () => {
    expect(suggestPosition({ entry: 100, stop: 0 }).reason).toBe('no_stop');
    expect(suggestPosition({ entry: 100, stop: 101 }).reason).toBe('no_stop');
    expect(suggestPosition({ capital: 5_000, entry: 100, stop: 90 }).reason).toBe('too_small');
    expect(suggestPosition({ entry: 100, stop: 90 }).capital).toBe(DEFAULT_CAPITAL);
  });

  it('stores the trading capital, accepting Turkish thousands separators', () => {
    expect(setTradingCapital('250.000')).toBe(250000);
    expect(getTradingCapital()).toBe(250000);
    expect(setTradingCapital('')).toBeNull();
    expect(getTradingCapital()).toBeNull();
  });
});
