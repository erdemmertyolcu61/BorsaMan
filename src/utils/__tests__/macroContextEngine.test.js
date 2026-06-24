// macroContextEngine.test.js — Pure-function tests for regime classification
import { describe, it, expect } from 'vitest';
import {
  buildMacroPromptLine,
  classifyRegime,
  __test__,
} from '../macroContextEngine.js';

const { computeRegime, parseYahooSeries } = __test__;

describe('computeRegime — risk-off / panic combinations', () => {
  it('panic: USDTRY +6% 5g, VIX 32, BIST/USD -6% → regime panic + scoreAdjust <= -12', () => {
    const ctx = computeRegime({
      usdtry: { value: 40, change5d: 6, change20d: 8, vol20d: 35 },
      vix:    { value: 32, change5d: 8, classification: 'panic' },
      tcmb:   { rate: 42.5, nextMeeting: '2099-01-01' },
      bistUsd:{ value: 250, change20d: -6 },
    });
    expect(ctx.regime).toBe('panic');
    expect(ctx.scoreAdjust).toBeLessThanOrEqual(-12);
    expect(ctx.scoreAdjust).toBeGreaterThanOrEqual(-15); // clamped
    expect(ctx.badge).toContain('PANIC');
    expect(ctx.reasons.length).toBeGreaterThan(0);
  });

  it('risk_off: USDTRY +4% + VIX 27 → regime risk_off, adjust between -6 and -12', () => {
    const ctx = computeRegime({
      usdtry: { value: 39, change5d: 4, change20d: 3, vol20d: 22 },
      vix:    { value: 27, change5d: 5, classification: 'elevated' },
      tcmb:   { rate: 42.5, nextMeeting: '2099-01-01' },
      bistUsd:{ value: 260, change20d: -2 },
    });
    expect(ctx.regime).toBe('risk_off');
    expect(ctx.scoreAdjust).toBeLessThanOrEqual(-6);
    expect(ctx.scoreAdjust).toBeGreaterThan(-12);
  });

  it('risk_on: USDTRY -3% + VIX 12 + BIST/USD +6% → regime risk_on, adjust >= 4', () => {
    const ctx = computeRegime({
      usdtry: { value: 37, change5d: -3, change20d: -5, vol20d: 18 },
      vix:    { value: 12, change5d: -10, classification: 'complacent' },
      tcmb:   { rate: 42.5, nextMeeting: '2099-01-01' },
      bistUsd:{ value: 275, change20d: 6 },
    });
    expect(ctx.regime).toBe('risk_on');
    expect(ctx.scoreAdjust).toBeGreaterThanOrEqual(4);
    expect(ctx.badge).toContain('RISK-ON');
  });

  it('neutral: all sources null → adjust 0, regime neutral', () => {
    const ctx = computeRegime({ usdtry: null, vix: null, tcmb: null, bistUsd: null });
    expect(ctx.regime).toBe('neutral');
    expect(ctx.scoreAdjust).toBe(0);
  });

  it('TCMB toplantı 2 gün sonra → -3 ek ceza tetiklenir', () => {
    const tomorrow2 = new Date(Date.now() + 2 * 86400000).toISOString();
    const baseline = computeRegime({
      usdtry: { value: 38, change5d: 0, change20d: 0, vol20d: 15 },
      vix:    { value: 18, classification: 'normal' },
      tcmb:   { rate: 42.5, nextMeeting: '2099-01-01' },
      bistUsd:{ value: 270, change20d: 0 },
    });
    const withMeeting = computeRegime({
      usdtry: { value: 38, change5d: 0, change20d: 0, vol20d: 15 },
      vix:    { value: 18, classification: 'normal' },
      tcmb:   { rate: 42.5, nextMeeting: tomorrow2 },
      bistUsd:{ value: 270, change20d: 0 },
    });
    expect(withMeeting.scoreAdjust).toBe(baseline.scoreAdjust - 3);
    expect(withMeeting.reasons.some(r => /PPK/.test(r))).toBe(true);
  });
});

describe('parseYahooSeries', () => {
  it('returns null for malformed JSON', () => {
    expect(parseYahooSeries('not json')).toBeNull();
    expect(parseYahooSeries('{}')).toBeNull();
    expect(parseYahooSeries(JSON.stringify({ chart: { result: [] } }))).toBeNull();
  });

  it('parses valid Yahoo chart payload (10 bars)', () => {
    const ts = Array.from({ length: 10 }, (_, i) => 1700000000 + i * 86400);
    const closes = Array.from({ length: 10 }, (_, i) => 38 + i * 0.1);
    const payload = JSON.stringify({
      chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: closes }] } }] },
    });
    const out = parseYahooSeries(payload);
    expect(out).not.toBeNull();
    expect(out.length).toBe(10);
    expect(out[0].close).toBeCloseTo(38);
    expect(out[9].close).toBeCloseTo(38.9);
  });

  it('skips null/zero closes', () => {
    const ts = [1, 2, 3, 4, 5, 6, 7, 8];
    const closes = [10, null, 0, 11, 12, null, 13, 14];
    const payload = JSON.stringify({
      chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: closes }] } }] },
    });
    const out = parseYahooSeries(payload);
    expect(out.length).toBe(5);
  });
});

describe('buildMacroPromptLine', () => {
  it('returns empty string for null context', () => {
    expect(buildMacroPromptLine(null)).toBe('');
    expect(buildMacroPromptLine(undefined)).toBe('');
  });

  it('handles partial fields gracefully', () => {
    const line = buildMacroPromptLine({
      regime: 'neutral',
      usdtry: { value: 38.42, change5d: 1.2 },
      // vix / tcmb / bistUsd missing
    });
    expect(line).toContain('MAKRO:');
    expect(line).toContain('USDTRY 38.42');
    expect(line).toContain('Rejim: NEUTRAL');
  });

  it('full context produces all segments', () => {
    const tomorrow3 = new Date(Date.now() + 3 * 86400000).toISOString();
    const line = buildMacroPromptLine({
      regime: 'risk_off',
      usdtry: { value: 39.1, change5d: 3.5 },
      vix:    { value: 26.8 },
      tcmb:   { rate: 42.5, nextMeeting: tomorrow3 },
      bistUsd:{ change20d: -4.2 },
    });
    expect(line).toContain('USDTRY 39.10');
    expect(line).toContain('VIX 26.8');
    expect(line).toContain('TCMB 42.5%');
    expect(line).toContain('BIST/USD');
    expect(line).toContain('RISK_OFF');
  });
});

describe('classifyRegime', () => {
  it('returns regime string from context', () => {
    expect(classifyRegime({ regime: 'panic' })).toBe('panic');
    expect(classifyRegime({})).toBe('neutral');
    expect(classifyRegime(null)).toBe('neutral');
  });
});
