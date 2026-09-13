import { describe, it, expect } from 'vitest';
import {
  DATA_LAYER_POLICY, isForeignFlowScoringEnabled, isKapCatalystScoringEnabled, isKapRiskGuardEnabled,
  isKapBuybackBoostEnabled,
} from '../dataLayerPolicy.js';

describe('dataLayerPolicy — user decision 2026-09-12: show + measure, then enable', () => {
  it('keeps foreign flow and KAP events out of scoring until measured', () => {
    // Flipping either of these must be a deliberate, measured decision — the
    // foreign-flow rules behind the first flag have never been measured at all.
    expect(isForeignFlowScoringEnabled()).toBe(false);
    expect(isKapCatalystScoringEnabled()).toBe(false);
  });

  it('keeps the protective trading-measure filter on', () => {
    expect(isKapRiskGuardEnabled()).toBe(true);
  });

  it('enables only the measured buyback boost (user decision 2026-09-13)', () => {
    // 24-month event study: buyback is the one KAP event that beat the market in
    // both halves. The general KAP flag above stays off — new-business deals were
    // measured as priced in.
    expect(isKapBuybackBoostEnabled()).toBe(true);
    expect(DATA_LAYER_POLICY.buybackBoostDecidedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('cannot be flipped at runtime', () => {
    expect(Object.isFrozen(DATA_LAYER_POLICY)).toBe(true);
    expect(() => { 'use strict'; DATA_LAYER_POLICY.foreignFlowScoring = true; }).toThrow();
    expect(() => { 'use strict'; DATA_LAYER_POLICY.kapBuybackBoost = false; }).toThrow();
    expect(isForeignFlowScoringEnabled()).toBe(false);
    expect(isKapBuybackBoostEnabled()).toBe(true);
    expect(DATA_LAYER_POLICY.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
