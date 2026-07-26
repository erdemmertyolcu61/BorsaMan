import { describe, it, expect } from 'vitest';
import { computeSectorMacroAdjust } from '../thematicMacro.js';

const riskOff = { vix: { classification: 'panic', value: 34 }, sp500: { change5d: -4 }, tcmb: { rate: 50 } };
const riskOn = { vix: { classification: 'complacent', value: 12 }, sp500: { change5d: 3 }, tcmb: { rate: 50 } };
const calm = { vix: { classification: 'normal', value: 18 }, sp500: { change5d: 0.2 }, tcmb: { rate: 50 } };

describe('computeSectorMacroAdjust', () => {
  it('is defensive against missing input', () => {
    expect(computeSectorMacroAdjust(null, 'Banka')).toEqual({ delta: 0, reasons: [] });
    expect(computeSectorMacroAdjust(riskOff, null)).toEqual({ delta: 0, reasons: [] });
    expect(computeSectorMacroAdjust({}, 'Banka').delta).toBe(0);
  });

  it('penalizes cyclical sectors in risk-off', () => {
    const r = computeSectorMacroAdjust(riskOff, 'Holding');
    expect(r.delta).toBeLessThan(0);
    expect(r.reasons.join(' ')).toMatch(/döngüsel|Risk-off/i);
  });

  it('keeps defensive sectors resilient (positive) in risk-off', () => {
    const r = computeSectorMacroAdjust(riskOff, 'Telekom');
    expect(r.delta).toBeGreaterThan(0);
    expect(r.reasons.join(' ')).toMatch(/defansif|dayanıklı/i);
  });

  it('favors cyclicals in risk-on', () => {
    expect(computeSectorMacroAdjust(riskOn, 'Holding').delta).toBeGreaterThan(0);
  });

  it('applies high-rate pressure to rate-sensitive sectors and lift to banks', () => {
    // Use a calm risk backdrop so only the rate axis moves the number.
    expect(computeSectorMacroAdjust(calm, 'GYO').delta).toBeLessThan(0);
    expect(computeSectorMacroAdjust(calm, 'Insaat').delta).toBeLessThan(0);
    expect(computeSectorMacroAdjust(calm, 'Banka').delta).toBeGreaterThan(0);
  });

  it('does not apply rate pressure when rates are low', () => {
    const lowRate = { ...calm, tcmb: { rate: 20 } };
    expect(computeSectorMacroAdjust(lowRate, 'GYO').delta).toBe(0);
  });

  it('returns zero for an unmapped / neutral-beta sector in calm markets', () => {
    expect(computeSectorMacroAdjust(calm, 'Savunma').delta).toBe(0);
    expect(computeSectorMacroAdjust(calm, 'UnknownSector').delta).toBe(0);
  });

  it('clamps the combined adjustment to +/-6', () => {
    // GYO: risk-off cyclical-ish (beta 0.3) + heavy rate pressure → strongest negative
    const r = computeSectorMacroAdjust(riskOff, 'GYO');
    expect(r.delta).toBeGreaterThanOrEqual(-6);
    const bank = computeSectorMacroAdjust(riskOn, 'Banka');
    expect(bank.delta).toBeLessThanOrEqual(6);
  });
});
