import { describe, it, expect } from 'vitest';
import { isOverboughtMomentumRule, filterRulesForRegime, scoreNewSignal } from '../ML_BacktestEngine.js';

describe('v29 ML Regime Gate', () => {
  const overboughtRule = { setup_name: 'RSI_OVERBOUGHT>70 + MFI_HIGH>65', expectancy: 2.0, conditions: JSON.stringify([{ type: 'signal', signalKey: 'RSI_OVERBOUGHT' }]) };
  const mfiHighRule    = { setup_name: 'MFI_HIGH>75 + CMF_POSITIVE>0.1', expectancy: 1.5 };
  const accumRule      = { setup_name: 'OBV_ACC + CMF_POSITIVE>0.1', expectancy: 1.2 };
  const goldenRule     = { setup_name: 'SIG_GOLDEN_CROSS + SIG_ABOVE_MA200', expectancy: 1.0 };

  describe('isOverboughtMomentumRule', () => {
    it('flags RSI_OVERBOUGHT rules', () => {
      expect(isOverboughtMomentumRule(overboughtRule)).toBe(true);
    });
    it('flags MFI_HIGH rules', () => {
      expect(isOverboughtMomentumRule(mfiHighRule)).toBe(true);
    });
    it('does not flag accumulation rules', () => {
      expect(isOverboughtMomentumRule(accumRule)).toBe(false);
      expect(isOverboughtMomentumRule(goldenRule)).toBe(false);
    });
    it('is defensive against missing setup_name', () => {
      expect(isOverboughtMomentumRule({})).toBe(false);
      expect(isOverboughtMomentumRule({ setupName: 'MFI_HIGH>75' })).toBe(true);
    });
  });

  describe('filterRulesForRegime', () => {
    const allRules = [overboughtRule, mfiHighRule, accumRule, goldenRule];

    it('keeps ALL rules in a confirmed uptrend (ADX>25 + supertrend UP + weekly bull)', () => {
      const out = filterRulesForRegime(allRules, { adx: 30, supertrendTrend: 'UP', weeklyTrend: 'bull' });
      expect(out.rules).toHaveLength(4);
      expect(out.gated).toBe(false);
      expect(out.suppressed).toBe(0);
    });

    it('suppresses overbought-momentum rules in a sideways regime', () => {
      const out = filterRulesForRegime(allRules, { adx: 15, supertrendTrend: 'UP', weeklyTrend: 'neutral' });
      expect(out.rules).toHaveLength(2); // only accum + golden survive
      expect(out.rules.map(r => r.setup_name)).toEqual(
        expect.arrayContaining([accumRule.setup_name, goldenRule.setup_name])
      );
      expect(out.gated).toBe(true);
      expect(out.suppressed).toBe(2);
    });

    it('suppresses when supertrend is DOWN even if ADX strong', () => {
      const out = filterRulesForRegime(allRules, { adx: 40, supertrendTrend: 'DOWN', weeklyTrend: 'bull' });
      expect(out.gated).toBe(true);
      expect(out.suppressed).toBe(2);
    });

    it('suppresses when weekly trend is only weak_bull (strict bull required)', () => {
      const out = filterRulesForRegime(allRules, { adx: 30, supertrendTrend: 'UP', weeklyTrend: 'weak_bull' });
      expect(out.gated).toBe(true);
    });

    it('is conservative when regime data is missing', () => {
      const out = filterRulesForRegime(allRules, {});
      expect(out.gated).toBe(true);
      expect(out.suppressed).toBe(2);
    });

    it('handles empty rule sets gracefully', () => {
      expect(filterRulesForRegime([], { adx: 30 }).rules).toHaveLength(0);
      expect(filterRulesForRegime(null, {}).rules).toEqual([]);
    });
  });

  describe('end-to-end: overbought pick in chop gets no ML boost from momentum rules', () => {
    // A pick that fires RSI_OVERBOUGHT in a sideways regime should NOT be boosted
    // by the overbought-momentum rule once the regime gate removes it.
    const overboughtPick = {
      firedSignals: ['RSI_OVERBOUGHT'],
      adx: 15, supertrend: { trend: 'UP' }, weeklyTrend: 'neutral',
    };

    it('boost is zero after gating in chop', () => {
      const { rules: gated } = filterRulesForRegime([overboughtRule], {
        adx: overboughtPick.adx,
        supertrendTrend: overboughtPick.supertrend.trend,
        weeklyTrend: overboughtPick.weeklyTrend,
      });
      const result = scoreNewSignal(overboughtPick, gated);
      expect(result.ruleCount).toBe(0);
      expect(result.confidenceBoost).toBe(0);
    });

    it('boost applies in a confirmed uptrend', () => {
      const { rules: ungated } = filterRulesForRegime([overboughtRule], {
        adx: 30, supertrendTrend: 'UP', weeklyTrend: 'bull',
      });
      const result = scoreNewSignal(overboughtPick, ungated);
      expect(result.ruleCount).toBe(1);
      expect(result.confidenceBoost).toBeGreaterThan(0);
    });
  });
});
