import { describe, it, expect } from 'vitest';
import {
  bigMoveBaseRate, computeTopGainerPotential, topGainerConfidenceAdjust,
  BIG_MOVE_PCT, PROB_CAP, TOP_GAINER_CONF_CAP,
} from '../topGainerPotential.js';

/** Build daily bars where `bigDays` sessions gain +8% and the rest drift +0.1%. */
function bars(n, bigDays = 0) {
  const out = [{ close: 100 }];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1].close;
    out.push({ close: i <= bigDays ? prev * 1.08 : prev * 1.001 });
  }
  return out;
}

describe('bigMoveBaseRate', () => {
  it('counts the share of sessions clearing the threshold', () => {
    const r = bigMoveBaseRate(bars(101, 10));
    expect(r.days).toBe(100);
    expect(r.hits).toBe(10);
    expect(r.rate).toBeCloseTo(0.1);
  });

  it('returns zero for a stock that never makes a big move', () => {
    expect(bigMoveBaseRate(bars(101, 0)).rate).toBe(0);
  });

  it('honours the lookback window', () => {
    // 10 big days at the START, then 200 quiet ones — a 50-day window sees none.
    const b = bars(211, 10);
    expect(bigMoveBaseRate(b, { lookback: 50 }).hits).toBe(0);
    expect(bigMoveBaseRate(b, { lookback: 250 }).hits).toBe(10);
  });

  it('is defensive about bad input', () => {
    expect(bigMoveBaseRate(null)).toEqual({ rate: 0, hits: 0, days: 0 });
    expect(bigMoveBaseRate([{ close: 100 }])).toEqual({ rate: 0, hits: 0, days: 0 });
    expect(bigMoveBaseRate([{ close: 0 }, { close: 5 }]).days).toBe(0); // prev<=0 skipped
    expect(bigMoveBaseRate([{ close: 100 }, { close: NaN }]).days).toBe(0);
  });

  it('uses the documented BIST threshold by default', () => {
    expect(BIG_MOVE_PCT).toBe(6);
  });
});

describe('computeTopGainerPotential', () => {
  const history = bars(251, 20);          // ~8% of sessions are big movers
  const coiled = {
    atrPct: 4, volRatio: 1.8, obvTrend: 'accumulation', cmf: 0.12, rsi: 55, mfi: 50,
    ttmSqueeze: { squeezeOn: true, squeezeRelease: false }, recentPump: 1,
    cumulativePump: 2, todayPumpReal: 0.5, newsCategories: [], avgVolumeTL: 50_000_000,
  };

  it('rates a coiled accumulating mover well above a dead one', () => {
    const good = computeTopGainerPotential(coiled, history);
    const dead = computeTopGainerPotential(
      { ...coiled, atrPct: 2, volRatio: 0.5, obvTrend: 'distribution', cmf: -0.2, ttmSqueeze: {} },
      bars(251, 0));
    expect(good.score).toBeGreaterThan(dead.score);
    expect(good.drivers.length).toBeGreaterThan(0);
  });

  it('hard-gates a stock whose daily range cannot produce a big move', () => {
    const out = computeTopGainerPotential({ ...coiled, atrPct: 1.0 }, history);
    expect(out.score).toBe(0);
    expect(out.eligible).toBe(false);
    expect(out.blockers.join()).toMatch(/ATR/);
  });

  it('penalises a name that already hit the ceiling today', () => {
    const fresh = computeTopGainerPotential(coiled, history);
    const spent = computeTopGainerPotential({ ...coiled, todayPumpReal: 9.8, recentPump: 9.8 }, history);
    expect(spent.score).toBeLessThan(fresh.score);
    expect(spent.blockers.join()).toMatch(/tavan/i);
  });

  it('rewards a news catalyst', () => {
    const withNews = computeTopGainerPotential({ ...coiled, newsCategories: ['insider_buy'] }, history);
    const without = computeTopGainerPotential(coiled, history);
    expect(withNews.score).toBeGreaterThan(without.score);
  });

  it('never claims more than the honest cap', () => {
    const everything = computeTopGainerPotential({
      ...coiled, ttmSqueeze: { squeezeRelease: true }, wyckoffSpring: true,
      newsCategories: ['insider_buy', 'contract'], volRatio: 2.5, cmf: 0.4,
    }, bars(251, 120));                       // absurdly explosive history
    expect(everything.probPct).toBeLessThanOrEqual(PROB_CAP * 100);
    expect(everything.score).toBeLessThanOrEqual(100);
  });

  it('falls back to a range-implied prior when history is too thin to trust', () => {
    const thin = computeTopGainerPotential(coiled, bars(11, 5));   // 10 days only
    expect(thin.sampleDays).toBe(10);
    expect(thin.score).toBeGreaterThan(0);       // still scored, via the prior
    expect(thin.baseRatePct).toBeGreaterThan(0); // raw base rate still reported
  });

  it('reports the empirical base rate separately from the estimate', () => {
    const out = computeTopGainerPotential(coiled, history);
    expect(out.sampleDays).toBe(250);
    expect(out.baseRatePct).toBeCloseTo(8, 0);
  });

  it('is defensive about missing input', () => {
    expect(computeTopGainerPotential(null, history).score).toBe(0);
    expect(computeTopGainerPotential(coiled, null).score).toBeGreaterThanOrEqual(0);
    expect(computeTopGainerPotential({}, []).score).toBeGreaterThanOrEqual(0);
  });
});

describe('topGainerConfidenceAdjust', () => {
  it('is bounded in both directions', () => {
    expect(topGainerConfidenceAdjust({ score: 100 })).toBeLessThanOrEqual(TOP_GAINER_CONF_CAP);
    expect(topGainerConfidenceAdjust({ score: 0 })).toBeGreaterThanOrEqual(-TOP_GAINER_CONF_CAP / 2);
  });

  it('is neutral at the eligibility floor', () => {
    expect(topGainerConfidenceAdjust({ score: 35 })).toBe(0);
  });

  it('does not apply to sell picks or bad input', () => {
    expect(topGainerConfidenceAdjust({ score: 100 }, true)).toBe(0);
    expect(topGainerConfidenceAdjust(null)).toBe(0);
    expect(topGainerConfidenceAdjust({})).toBe(0);
  });
});
