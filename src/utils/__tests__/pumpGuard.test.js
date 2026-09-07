import { describe, it, expect } from 'vitest';
import { calcContinuationProbability, isUnsafeForTomorrow } from '../pumpGuard.js';

// A "strong" pumped name: catalyst + accumulation + healthy internals. Built to
// clear the high continuation bars so the threshold tests are about the GATE,
// not about whether the fixture happens to score well.
const strong = (over = {}) => ({
  todayPumpReal: 10, cumulativePump: 10,
  newsCategories: ['insider_buy'], newsScore: 6,
  obvTrend: 'accumulation', cmf: 0.25,
  wyckoffPhase: 'Markup', wyckoffSpring: true,
  ttmSqueeze: { squeezeRelease: true }, mfi: 55, rsi: 60,
  supertrend: { trend: 'UP' }, ichimoku: { cloudPosition: 'above' },
  sectorStrength: 3, ...over,
});

// A weak pump: no catalyst, distribution, overbought.
const weak = (over = {}) => ({
  todayPumpReal: 10, cumulativePump: 10,
  newsCategories: [], obvTrend: 'distribution', cmf: -0.1,
  wyckoffPhase: 'Distribution', mfi: 85, rsi: 84,
  supertrend: { trend: 'DOWN' }, sectorStrength: -2, ...over,
});

describe('pumpGuard.calcContinuationProbability', () => {
  it('only applies above the 7% pump zone — below that it has nothing to say', () => {
    expect(calcContinuationProbability({ todayPumpReal: 6.9 })).toBeNull();
    expect(calcContinuationProbability({ todayPumpReal: 7 })).not.toBeNull();
    expect(calcContinuationProbability(null)).toBeNull();
  });

  it('is clamped to [5, 55] — no indicator stack earns more than 55%', () => {
    expect(calcContinuationProbability(strong())).toBeLessThanOrEqual(55);
    expect(calcContinuationProbability(weak())).toBeGreaterThanOrEqual(5);
  });

  it('separates a catalyst-backed pump from a bare FOMO pump', () => {
    expect(calcContinuationProbability(strong()))
      .toBeGreaterThan(calcContinuationProbability(weak()));
  });

  it('penalises a second consecutive limit-up (cumulative >= 22%)', () => {
    // Deliberately NOT the `strong` fixture: it saturates the 55 clamp, which
    // would hide the penalty. A mid-strength name keeps the effect visible.
    const mid = (cp) => ({
      todayPumpReal: 10, cumulativePump: cp,
      newsCategories: [], obvTrend: 'accumulation', cmf: 0.06,
      mfi: 62, rsi: 70, supertrend: { trend: 'UP' },
    });
    expect(calcContinuationProbability(mid(24)))
      .toBeLessThan(calcContinuationProbability(mid(10)));
  });

  it('reads todayPumpReal or recentPump, whichever is higher', () => {
    // todayPumpReal is the BigPara-derived ground truth; recentPump is the bar
    // fallback. Either alone must be enough to enter the pump zone.
    expect(calcContinuationProbability({ todayPumpReal: 0, recentPump: 9 })).not.toBeNull();
    expect(calcContinuationProbability({ todayPumpReal: 9, recentPump: 0 })).not.toBeNull();
  });
});

describe('pumpGuard.isUnsafeForTomorrow — absolute rejections', () => {
  it('rejects extreme RSI (>90) no matter how good everything else is', () => {
    expect(isUnsafeForTomorrow(strong({ rsi: 91 }))).toBe(true);
    expect(isUnsafeForTomorrow(strong({ rsi: 90 }))).toBe(false);
  });

  it('rejects extreme MFI (>92) regardless of catalyst', () => {
    expect(isUnsafeForTomorrow(strong({ mfi: 93 }))).toBe(true);
    expect(isUnsafeForTomorrow(strong({ mfi: 92 }))).toBe(false);
  });
});

describe('pumpGuard.isUnsafeForTomorrow — the pump zone bar rises with the pump', () => {
  // 7-8% needs 38%, 8-9.5% needs 45%, 9.5%+ needs 50%. A name that passes at a
  // small pump can fail at a big one on identical internals - that is the point.
  it('lets a strong, catalyst-backed limit-up through', () => {
    expect(isUnsafeForTomorrow(strong({ todayPumpReal: 10 }))).toBe(false);
  });

  it('rejects a weak pump at every level of the zone', () => {
    for (const tp of [7, 8, 10, 13]) {
      expect(isUnsafeForTomorrow(weak({ todayPumpReal: tp, cumulativePump: tp })),
        `tp=${tp} reddedilmeli`).toBe(true);
    }
  });

  it('a mid-strength name can pass at 7% and fail at 10% — the bar moved, not the stock', () => {
    // Tuned to land between the 38 and 50 thresholds.
    const mid = (tp) => ({
      todayPumpReal: tp, cumulativePump: tp,
      newsCategories: [], newsScore: 0,
      obvTrend: 'accumulation', cmf: 0.06, mfi: 62, rsi: 70,
      supertrend: { trend: 'UP' }, sectorStrength: 0,
    });
    const p = calcContinuationProbability(mid(7));
    expect(p).toBeGreaterThanOrEqual(38);
    expect(p).toBeLessThan(50);
    expect(isUnsafeForTomorrow(mid(7))).toBe(false);
    expect(isUnsafeForTomorrow(mid(10))).toBe(true);
  });
});

describe('pumpGuard.isUnsafeForTomorrow — the 5-7% mean-reversion trap', () => {
  // Shipped after the user reported that yesterday's +5-7% picks closed red.
  // This band demands BOTH a catalyst AND >= 4 technical confirmations.
  const midPump = (over = {}) => ({
    todayPumpReal: 6, cumulativePump: 6,
    newsCategories: ['contract'],
    obvTrend: 'accumulation', cmf: 0.1, volRatio: 1.5,
    wyckoffSpring: true, ttmSqueeze: { squeezeRelease: true }, adx: 30,
    rsi: 60, mfi: 55, ...over,
  });

  it('accepts catalyst + 4 or more technical confirmations', () => {
    expect(isUnsafeForTomorrow(midPump())).toBe(false);
  });

  it('rejects when the catalyst is missing, however strong the technicals', () => {
    expect(isUnsafeForTomorrow(midPump({ newsCategories: [] }))).toBe(true);
  });

  it('rejects a catalyst with thin technical backing', () => {
    expect(isUnsafeForTomorrow(midPump({
      obvTrend: 'neutral', cmf: 0, volRatio: 1, wyckoffSpring: false,
      ttmSqueeze: null, adx: 15,
    }))).toBe(true);
  });

  it('leaves the quiet zone (<5%) alone', () => {
    expect(isUnsafeForTomorrow({ todayPumpReal: 3, cumulativePump: 3, rsi: 55, mfi: 50 })).toBe(false);
  });
});

describe('pumpGuard.isUnsafeForTomorrow — cumulative exhaustion', () => {
  it('cumulative >= 22% demands a 55% continuation probability', () => {
    // Below 7% today, so only the cumulative rule can fire.
    const tired = (over = {}) => ({
      todayPumpReal: 2, cumulativePump: 24,
      newsCategories: ['insider_buy'], obvTrend: 'accumulation',
      cmf: 0.25, wyckoffPhase: 'Markup', mfi: 55, rsi: 60, ...over,
    });
    // rp < 7 -> calcContinuationProbability returns null -> rejected.
    expect(isUnsafeForTomorrow(tired())).toBe(true);
  });

  it('cumulative 18-22% passes only with a catalyst', () => {
    const base = { todayPumpReal: 2, cumulativePump: 19, rsi: 60, mfi: 55 };
    expect(isUnsafeForTomorrow({ ...base, newsCategories: ['buyback'] })).toBe(false);
    expect(isUnsafeForTomorrow({ ...base, newsCategories: [] })).toBe(true);
    expect(isUnsafeForTomorrow({ ...base, newsCategories: ['sector_bull'] })).toBe(true);
  });

  it('is defensive against a bare object with no fields', () => {
    expect(isUnsafeForTomorrow({})).toBe(false);
  });
});
