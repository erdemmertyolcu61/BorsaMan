import { describe, it, expect } from 'vitest';
import { buildTradePlan, PLAN_CONST } from '../tradePlan.js';

const buy = { entry: 100, stop: 96, t1: 108, t2: 112, t3: 118, atr: 2, rr: 2, holdText: '3-8 gün', cls: 'buy' };

describe('buildTradePlan', () => {
  it('returns null without a valid entry/stop', () => {
    expect(buildTradePlan({})).toBeNull();
    expect(buildTradePlan({ entry: 0, stop: 5 })).toBeNull();
    expect(buildTradePlan({ entry: 100 })).toBeNull();
  });

  it('builds a 40/30/30 scale-in with pullback below and breakout above entry (buy)', () => {
    const p = buildTradePlan(buy);
    expect(p.entrySteps.map(s => s.fraction)).toEqual([40, 30, 30]);
    expect(p.entrySteps[0].at).toBe(100);
    expect(p.pullback).toBe(99);   // entry - 0.5*ATR
    expect(p.breakout).toBe(101);  // entry + 0.5*ATR
  });

  it('stages profit taking at T1/T2/T3 with 40/30/30 fractions', () => {
    const p = buildTradePlan(buy);
    expect(p.exitSteps.map(s => s.at)).toEqual([108, 112, 118]);
    expect(p.exitSteps.map(s => s.fraction)).toEqual([40, 30, 30]);
    expect(p.exitSteps[0].note).toMatch(/\+8%/); // (108-100)/100
  });

  it('trailing exit when T3 is absent', () => {
    const p = buildTradePlan({ ...buy, t3: undefined });
    expect(p.exitSteps.at(-1).at).toBeNull();
    expect(p.exitSteps.at(-1).note).toMatch(/trailing/i);
  });

  it('encodes breakeven and lock triggers from the shared constants', () => {
    const p = buildTradePlan(buy);
    expect(p.beTrigger).toBe(round(100 * (1 + PLAN_CONST.BREAKEVEN_PCT / 100)));   // 103
    expect(p.lockTrigger).toBe(round(100 * (1 + PLAN_CONST.TRAIL_ACTIVE_PCT / 100))); // 105
    expect(p.stopSteps[1].at).toBe(100); // move stop to entry (breakeven)
    expect(p.riskPct).toBe(-4);          // (96-100)/100
  });

  it('mirrors correctly for a sell: pullback above, breakout below, risk still negative', () => {
    const p = buildTradePlan({ entry: 100, stop: 104, t1: 92, atr: 2, cls: 'sell' });
    expect(p.isBuy).toBe(false);
    expect(p.pullback).toBe(101);   // entry + 0.5*ATR (adverse = up for a short)
    expect(p.breakout).toBe(99);    // entry - 0.5*ATR (favorable breakdown)
    expect(p.riskPct).toBe(-4);     // stop above entry → direction-adjusted loss
    expect(p.exitSteps[0].note).toMatch(/\+8%/); // (92 below 100) = +8% for a short
  });

  it('carries the hold horizon and rr through', () => {
    const p = buildTradePlan(buy);
    expect(p.holdHorizon).toBe('3-8 gün');
    expect(p.rr).toBe(2);
  });
});

function round(v) { return Math.round(v * 100) / 100; }
