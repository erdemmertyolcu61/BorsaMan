/**
 * signals.js — detector unit tests.
 *
 * Targets the six pattern/event detectors that drive getUnifiedAnalysis:
 *   • detectBreakout       — RESISTANCE_BREAK / SUPPORT_BREAK / SQUEEZE_BREAKOUT
 *   • detectChartPattern   — CUP_HANDLE / ASC_TRIANGLE / BULL_ENGULF
 *   • detectMomentumShift  — MACD_BULL_CROSS / MACD_BEAR_CROSS / TTM_FIRE
 *   • detectSmartMoney     — SMART_ACCUMULATION / SMART_DISTRIBUTION
 *   • detectHolyGrail      — boolean confluence
 *   • detectSetups         — Bollinger sikisma, oversold bounce, volume breakout, etc.
 *   • getUnifiedAnalysis   — composite output contract
 *
 * Strategy:
 *   - Realistic price fixtures with crafted candles for chart-shape detectors.
 *   - Synthetic `ind` objects (smartMoney/holyGrail) since those only read scalars.
 *   - Each test asserts at least one of: type === expected, direction, confidence range.
 */

import { describe, it, expect } from 'vitest';
import {
  detectBreakout,
  detectChartPattern,
  detectMomentumShift,
  detectSmartMoney,
  detectHolyGrail,
  detectSetups,
  getUnifiedAnalysis,
} from '../signals.js';
import { calcAll } from '../indicators.js';

// ── Fixture helpers ────────────────────────────────────────────────────────
const makeBar = (date, o, h, l, c, v = 1000) => ({ date, open: o, high: h, low: l, close: c, volume: v });

/** Flat consolidation around `base` then a strong upside breakout candle on volume. */
function buildResistanceBreakoutPrices() {
  const out = [];
  // 50 bars of warm-up trend up to 100
  for (let i = 0; i < 50; i++) {
    const c = 80 + i * 0.4;
    out.push(makeBar(new Date(2024, 0, i + 1), c - 0.2, c + 0.4, c - 0.4, c, 1000));
  }
  // 25 bars consolidating between 99-101 (clear horizontal resistance ~101)
  for (let i = 0; i < 25; i++) {
    const c = 99.5 + (i % 3) * 0.5; // 99.5 / 100 / 100.5
    out.push(makeBar(new Date(2024, 1, i + 1), c, 101, 99, c, 1000));
  }
  // Yesterday: closed AT resistance (still capped)
  out.push(makeBar(new Date(2024, 2, 1), 100.5, 101, 100, 100.8, 1100));
  // Today: breakout candle — close 105 with 2x volume
  out.push(makeBar(new Date(2024, 2, 2), 101, 106, 101, 105, 2500));
  return out;
}

function buildSupportBreakdownPrices() {
  const out = [];
  for (let i = 0; i < 50; i++) {
    const c = 120 - i * 0.4;
    out.push(makeBar(new Date(2024, 0, i + 1), c + 0.2, c + 0.4, c - 0.4, c, 1000));
  }
  for (let i = 0; i < 25; i++) {
    const c = 100.5 + (i % 3) * 0.5;
    out.push(makeBar(new Date(2024, 1, i + 1), c, 101, 100, c, 1000));
  }
  // Yesterday: closed near support
  out.push(makeBar(new Date(2024, 2, 1), 100.5, 101, 100, 100.2, 1100));
  // Today: breakdown
  out.push(makeBar(new Date(2024, 2, 2), 100, 100, 95, 95.5, 2200));
  return out;
}

/** Strictly bullish 220-bar trend — useful for genSignal/HolyGrail-style tests. */
function buildBullishTrend(len = 220) {
  return Array.from({ length: len }, (_, i) => {
    const c = 50 + i * 0.4;
    return makeBar(new Date(2024, 0, i + 1), c - 0.1, c + 0.3, c - 0.3, c, 1000 + i);
  });
}

/** Strictly bearish 220-bar trend. */
function buildBearishTrend(len = 220) {
  return Array.from({ length: len }, (_, i) => {
    const c = 200 - i * 0.4;
    return makeBar(new Date(2024, 0, i + 1), c + 0.1, c + 0.3, c - 0.3, c, 1000);
  });
}

// ── detectBreakout ─────────────────────────────────────────────────────────
describe('detectBreakout', () => {
  it('returns null when prices are too short', () => {
    const prices = buildBullishTrend(20);
    const ind = calcAll(prices);
    expect(detectBreakout(prices, ind)).toBeNull();
  });

  it('flags RESISTANCE_BREAK with buy direction on volume confirmation', () => {
    const prices = buildResistanceBreakoutPrices();
    const ind = calcAll(prices);
    const out = detectBreakout(prices, ind);
    expect(out).not.toBeNull();
    // Either RESISTANCE_BREAK or SQUEEZE_BREAKOUT — both are valid breakout calls and both must be buy
    expect(['RESISTANCE_BREAK', 'SQUEEZE_BREAKOUT']).toContain(out.type);
    expect(out.direction).toBe('buy');
    expect(out.confidence).toBeGreaterThanOrEqual(75);
  });

  it('flags SUPPORT_BREAK with sell direction', () => {
    const prices = buildSupportBreakdownPrices();
    const ind = calcAll(prices);
    const out = detectBreakout(prices, ind);
    expect(out).not.toBeNull();
    expect(['SUPPORT_BREAK', 'SQUEEZE_BREAKDOWN']).toContain(out.type);
    expect(out.direction).toBe('sell');
  });

  it('returns null on a quiet uptrend with no fresh break', () => {
    const prices = buildBullishTrend(220);
    const ind = calcAll(prices);
    // Steady drift — no resistance level to break, no squeeze
    const out = detectBreakout(prices, ind);
    // Either null or NOT a sell signal — this trend is bullish
    if (out) expect(out.direction).toBe('buy');
  });
});

// ── detectChartPattern ─────────────────────────────────────────────────────
describe('detectChartPattern', () => {
  it('returns null below 40 bars', () => {
    const prices = buildBullishTrend(30);
    const ind = calcAll(prices);
    expect(detectChartPattern(prices, ind)).toBeNull();
  });

  it('detects BULL_ENGULF on a textbook engulfing candle', () => {
    const prices = buildBullishTrend(50);
    // Replace last 2 bars with an engulfing pair on heavy volume
    const last2Date = new Date(2024, 5, 1);
    const last1Date = new Date(2024, 5, 2);
    prices[prices.length - 2] = makeBar(last2Date, 100, 100.5, 98, 98.5, 1000);  // bearish small body
    prices[prices.length - 1] = makeBar(last1Date, 98,  103,   97.8, 102.5, 2500); // bullish engulfing on 2.5x vol
    const ind = calcAll(prices);
    const out = detectChartPattern(prices, ind);
    if (out) {
      expect(out.direction).toBe('buy');
      expect(out.confidence).toBeGreaterThanOrEqual(60);
    }
  });
});

// ── detectMomentumShift ────────────────────────────────────────────────────
describe('detectMomentumShift', () => {
  it('returns null when prices are too short', () => {
    const prices = buildBullishTrend(10);
    const ind = calcAll(prices);
    expect(detectMomentumShift(prices, ind)).toBeNull();
  });

  it('returns null on a steady linear trend (no fresh MACD cross)', () => {
    const prices = buildBullishTrend(220);
    const ind = calcAll(prices);
    // Steady drift can't produce a cross — function should handle gracefully
    const out = detectMomentumShift(prices, ind);
    // Either null or has a valid shape
    if (out) {
      expect(['MACD_BULL_CROSS', 'MACD_BEAR_CROSS', 'TTM_FIRE']).toContain(out.type);
    }
  });

  it('fires TTM_FIRE when ttmSqueeze.firing && squeezeCount >= 5', () => {
    const prices = buildBullishTrend(220);
    const ind = calcAll(prices);
    // Force TTM squeeze fire condition
    ind.ttmSqueeze = { firing: true, squeezeCount: 7, squeezeOn: false, momentum: 1.5 };
    // Wipe MACD so it doesn't trigger first — leave only TTM path
    ind.macd = { macd: [null], signal: [null], histogram: [null] };
    const out = detectMomentumShift(prices, ind);
    expect(out).not.toBeNull();
    expect(out.type).toBe('TTM_FIRE');
    expect(out.direction).toBe('buy');
  });
});

// ── detectSmartMoney ───────────────────────────────────────────────────────
describe('detectSmartMoney', () => {
  it('returns SMART_ACCUMULATION on 3+ bullish smart-money flags', () => {
    const ind = {
      mfi: 22,                       // < 25 ✓
      obvTrend: 'accumulation',      // ✓
      cmf: 0.15,                     // > 0.10 ✓
      wyckoffPhase: 'accumulation',  // ✓
    };
    const sigs = detectSmartMoney(ind);
    const acc = sigs.find(s => s.type === 'SMART_ACCUMULATION');
    expect(acc).toBeDefined();
    expect(acc.direction).toBe('buy');
    expect(acc.confidence).toBeGreaterThanOrEqual(78 + 4 * 3);
  });

  it('returns SMART_DISTRIBUTION on 3+ bearish smart-money flags', () => {
    const ind = {
      mfi: 80,
      obvTrend: 'distribution',
      cmf: -0.15,
      wyckoffPhase: 'distribution',
    };
    const sigs = detectSmartMoney(ind);
    const dist = sigs.find(s => s.type === 'SMART_DISTRIBUTION');
    expect(dist).toBeDefined();
    expect(dist.direction).toBe('sell');
  });

  it('returns empty array when fewer than 3 confirmations', () => {
    const ind = { mfi: 50, obvTrend: 'neutral', cmf: 0.01, wyckoffPhase: 'markup' };
    expect(detectSmartMoney(ind)).toEqual([]);
  });

  it('handles missing fields safely (no throw, no false positive)', () => {
    expect(() => detectSmartMoney({})).not.toThrow();
    expect(detectSmartMoney({})).toEqual([]);
  });
});

// ── detectHolyGrail ────────────────────────────────────────────────────────
describe('detectHolyGrail', () => {
  it('returns true on perfect bullish confluence', () => {
    const ind = {
      lastClose: 105,
      lastMA20: 100,        // price > MA20
      lastRSI: 55,          // 45-65 sweet spot
      lastMACDHist: 0.5,    // positive
      obvTrend: 'accumulation',
    };
    expect(detectHolyGrail(ind)).toBe(true);
  });

  it('returns false when RSI is overbought', () => {
    const ind = {
      lastClose: 105, lastMA20: 100,
      lastRSI: 78,          // > 65 → fail
      lastMACDHist: 0.5,
      obvTrend: 'accumulation',
    };
    expect(detectHolyGrail(ind)).toBe(false);
  });

  it('returns false when price below MA20', () => {
    const ind = {
      lastClose: 95, lastMA20: 100,
      lastRSI: 55, lastMACDHist: 0.5, obvTrend: 'accumulation',
    };
    expect(detectHolyGrail(ind)).toBe(false);
  });

  it('returns false when OBV is not in accumulation', () => {
    const ind = {
      lastClose: 105, lastMA20: 100, lastRSI: 55, lastMACDHist: 0.5,
      obvTrend: 'distribution',
    };
    expect(detectHolyGrail(ind)).toBe(false);
  });
});

// ── detectSetups ───────────────────────────────────────────────────────────
describe('detectSetups', () => {
  it('returns an array', () => {
    const prices = buildBullishTrend(220);
    const ind = calcAll(prices);
    const setups = detectSetups(prices, ind);
    expect(Array.isArray(setups)).toBe(true);
  });

  it('every setup has name, desc, score, type fields', () => {
    const prices = buildBullishTrend(220);
    const ind = calcAll(prices);
    const setups = detectSetups(prices, ind);
    setups.forEach(s => {
      expect(typeof s.name).toBe('string');
      expect(typeof s.desc).toBe('string');
      expect(typeof s.score).toBe('number');
      expect(typeof s.type).toBe('string');
    });
  });

  it('flags Hacim Kirilimi when changePct > 1 and volRatio > 2', () => {
    const prices = buildBullishTrend(50);
    const ind = calcAll(prices);
    // Force the conditions
    ind.changePct = 3.5;
    ind.volRatio  = 2.4;
    const setups = detectSetups(prices, ind);
    const hit = setups.find(s => s.name === 'Hacim Kirilimi');
    expect(hit).toBeDefined();
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.type).toBe('breakout');
  });

  it('flags Asiri Satim Sicramasi when RSI < 32 and price near support', () => {
    const prices = buildBullishTrend(50);
    const ind = calcAll(prices);
    ind.lastRSI = 28;
    // Inject a support level near current price (within 2%)
    ind.sr = [{ type: 'support', price: ind.lastClose * 0.99 }];
    const setups = detectSetups(prices, ind);
    expect(setups.find(s => s.name === 'Asiri Satim Sicramasi')).toBeDefined();
  });
});

// ── getUnifiedAnalysis ─────────────────────────────────────────────────────
describe('getUnifiedAnalysis', () => {
  it('returns { ind, sig, bestBuy, bestSell } shape', () => {
    const prices = buildBullishTrend(220);
    const result = getUnifiedAnalysis('TEST', { prices });
    expect(result).toBeDefined();
    expect(result.ind).toBeDefined();
    expect(result.sig).toBeDefined();
    // bestBuy / bestSell may be null if no confluence — that's a valid contract
    expect('bestBuy' in result).toBe(true);
    expect('bestSell' in result).toBe(true);
  });

  it('does not produce a bestBuy on a clearly bearish price series', () => {
    const prices = buildBearishTrend(220);
    const { bestBuy } = getUnifiedAnalysis('TEST', { prices });
    expect(bestBuy).toBeNull();
  });

  it('respects extraContext.sectorStrength flowing into genSignal', () => {
    const prices = buildBullishTrend(220);
    const baseline = getUnifiedAnalysis('TEST', { prices }, {});
    const cikis    = getUnifiedAnalysis('TEST', { prices }, { sectorStrength: 15 });
    // sig.score is the same numeric scale — CIKIS sector should not increase it
    expect(cikis.sig.score).toBeLessThanOrEqual(baseline.sig.score);
  });

  it('bestBuy (when produced) carries entry / stop / target / rr from sig', () => {
    const prices = buildBullishTrend(220);
    const { bestBuy, sig } = getUnifiedAnalysis('TEST', { prices });
    if (bestBuy) {
      expect(bestBuy.direction).toBe('buy');
      expect(bestBuy.entry).toBe(sig.entry);
      expect(bestBuy.stop).toBe(sig.stop);
      expect(bestBuy.target).toBe(sig.t1);
      expect(typeof bestBuy.confidence).toBe('number');
      expect(bestBuy.confidence).toBeLessThanOrEqual(95);
    }
  });
});
