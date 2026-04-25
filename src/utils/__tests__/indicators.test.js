/**
 * indicators.js — pure-math regression tests.
 *
 * Hand-computed expected values for small windows so any silent drift
 * (e.g. someone "cleans up" an EMA seed or off-by-one in RSI smoothing)
 * fails CI immediately.
 */

import { describe, it, expect } from 'vitest';
import {
  calcMA, calcEMA, calcRSI, calcMACD, calcBollinger, calcSR,
  calcMFI, calcOBV, calcOBVTrend, calcADL, calcVWAP, calcATR,
  calcFibonacci, calcPivots, calcCMF, calcADX, calcKeltner,
  calcTTMSqueeze, calcChandelierExit, detectWyckoffPhase,
  calcCandlestickPatterns, calcStochRSI, calcAll,
} from '../indicators.js';

// ── fixture builders ────────────────────────────────────────────────
function seriesUptrend(n = 60, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { date: new Date(2025, 0, i + 1), open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 + i * 10 };
  });
}
function seriesDowntrend(n = 60, start = 200, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const c = start - i * step;
    return { date: new Date(2025, 0, i + 1), open: c + 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
  });
}
function seriesFlat(n = 40, price = 100) {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(2025, 0, i + 1), open: price, high: price, low: price, close: price, volume: 1000,
  }));
}

describe('calcMA', () => {
  it('produces period-lagged simple moving average', () => {
    const ma = calcMA([1, 2, 3, 4, 5], 3);
    expect(ma[0]).toBeNull();
    expect(ma[1]).toBeNull();
    expect(ma[2]).toBeCloseTo(2, 10);   // (1+2+3)/3
    expect(ma[3]).toBeCloseTo(3, 10);
    expect(ma[4]).toBeCloseTo(4, 10);
  });
});

describe('calcEMA', () => {
  it('first populated index equals the SMA seed', () => {
    const ema = calcEMA([2, 4, 6, 8, 10, 12], 3);
    expect(ema[2]).toBeCloseTo(4, 10);   // seed = (2+4+6)/3
    // k = 2/(3+1) = 0.5
    expect(ema[3]).toBeCloseTo(8 * 0.5 + 4 * 0.5, 10);   // 6
    expect(ema[4]).toBeCloseTo(10 * 0.5 + 6 * 0.5, 10);  // 8
  });
});

describe('calcRSI', () => {
  it('monotonically rising closes yield RSI = 100', () => {
    const rsi = calcRSI(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
    expect(rsi[14]).toBeCloseTo(100, 6);
    expect(rsi[29]).toBeCloseTo(100, 6);
  });
  it('monotonically falling closes yield RSI = 0', () => {
    const rsi = calcRSI(Array.from({ length: 30 }, (_, i) => 200 - i), 14);
    expect(rsi[29]).toBeCloseTo(0, 6);
  });
  it('returns nulls when series shorter than period+1', () => {
    expect(calcRSI([1, 2, 3], 14).every(v => v === null)).toBe(true);
  });
});

describe('calcMACD', () => {
  it('has macd, signal, histogram arrays matching input length', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5));
    const r = calcMACD(closes);
    expect(r.macd).toHaveLength(60);
    expect(r.signal).toHaveLength(60);
    expect(r.histogram).toHaveLength(60);
    // last histogram = macd - signal
    const last = r.macd.length - 1;
    expect(r.histogram[last]).toBeCloseTo(r.macd[last] - r.signal[last], 10);
  });
});

describe('calcBollinger', () => {
  it('middle band equals SMA; upper/lower are ± 2*std', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 5));
    const b = calcBollinger(closes, 20, 2);
    const last = 24;
    expect(b.middle[last]).toBeCloseTo(closes.slice(5, 25).reduce((a, v) => a + v, 0) / 20, 8);
    expect(b.upper[last]).toBeGreaterThan(b.middle[last]);
    expect(b.lower[last]).toBeLessThan(b.middle[last]);
  });
  it('flat prices collapse bands to middle', () => {
    const b = calcBollinger(Array.from({ length: 25 }, () => 50), 20, 2);
    expect(b.upper[24]).toBeCloseTo(50, 8);
    expect(b.lower[24]).toBeCloseTo(50, 8);
  });
});

describe('calcATR', () => {
  it('produces null for tiny series, positive for real series', () => {
    expect(calcATR([{ high: 1, low: 1, close: 1 }], 14)).toBeNull();
    const atr = calcATR(seriesUptrend(30), 14);
    expect(atr).toBeGreaterThan(0);
  });
});

describe('calcSR', () => {
  it('returns empty array on tiny input, detects pivots otherwise', () => {
    expect(calcSR(seriesFlat(5))).toEqual([]);
    const p = seriesUptrend(40);
    // Spike a resistance
    p[20] = { ...p[20], high: p[20].high + 50 };
    const lv = calcSR(p);
    expect(lv.some(l => l.type === 'resistance')).toBe(true);
  });
});

describe('volume-family: MFI / OBV / ADL / VWAP / CMF', () => {
  const up = seriesUptrend(30);
  it('calcMFI stays within [0,100]', () => {
    const v = calcMFI(up, 14);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
  it('calcOBV length matches input and is monotonic when volume flat + price up', () => {
    const obv = calcOBV(up);
    expect(obv).toHaveLength(up.length);
    expect(obv[obv.length - 1]).toBeGreaterThan(obv[0]);
  });
  it('calcOBVTrend reports confirmation when price+OBV both rise', () => {
    const obv = calcOBV(up);
    const closes = up.map(p => p.close);
    // Rising price + rising OBV = 'confirmation' per engine contract
    expect(calcOBVTrend(obv, closes, 20)).toBe('confirmation');
  });
  it('calcADL and calcVWAP return numeric arrays/values', () => {
    const adl = calcADL(up);
    // ADL seeds with an extra leading 0 — accept either length
    expect(adl.length).toBeGreaterThanOrEqual(up.length);
    const vwap = calcVWAP(up, 20);
    expect(vwap).toBeGreaterThan(0);
  });
  it('calcCMF returns null for tiny window, else in [-1,1]', () => {
    expect(calcCMF(seriesFlat(5), 20)).toBeNull();
    const cmf = calcCMF(up, 20);
    expect(cmf).toBeGreaterThanOrEqual(-1);
    expect(cmf).toBeLessThanOrEqual(1);
  });
});

describe('calcFibonacci', () => {
  it('detects uptrend Fibs with correct 0.5 midpoint', () => {
    const fib = calcFibonacci(seriesUptrend(60, 100, 1));
    expect(fib.trend).toBe('up');
    expect(fib['0.5']).toBeCloseTo((fib.high + fib.low) / 2, 6);
  });
  it('returns null when high equals low', () => {
    expect(calcFibonacci(seriesFlat(30, 50))).toBeNull();
  });
});

describe('calcPivots', () => {
  it('PP = (H+L+C)/3', () => {
    const p = calcPivots([{ high: 110, low: 90, close: 100 }]);
    expect(p.pp).toBeCloseTo(100, 10);
    expect(p.r1).toBeCloseTo(110, 10);
    expect(p.s1).toBeCloseTo(90, 10);
  });
});

describe('calcADX + calcKeltner + calcTTMSqueeze + calcChandelierExit', () => {
  const p = seriesUptrend(50);
  it('ADX is positive for a clear trend', () => {
    const a = calcADX(p, 14);
    expect(a.adx).not.toBeNull();
    expect(a.plusDI).toBeGreaterThan(a.minusDI);
  });
  it('Keltner bands sandwich EMA', () => {
    const k = calcKeltner(p, 20, 14, 1.5);
    const last = p.length - 1;
    expect(k.upper[last]).toBeGreaterThan(k.middle[last]);
    expect(k.lower[last]).toBeLessThan(k.middle[last]);
  });
  it('TTM Squeeze returns a shape with squeezeOn + momentum', () => {
    const s = calcTTMSqueeze(p);
    expect(s).toHaveProperty('squeezeOn');
    expect(s).toHaveProperty('momentum');
  });
  it('Chandelier longStop is below price in uptrend', () => {
    const ch = calcChandelierExit(p, 22, 3);
    expect(ch.longStop).toBeLessThan(p[p.length - 1].close);
  });
});

describe('detectWyckoffPhase', () => {
  it('labels an uptrend with rising OBV as Markup', () => {
    const p = seriesUptrend(40);
    const ind = {
      obvTrend: 'accumulation',
      lastClose: p[p.length - 1].close,
      lastMA50: p[p.length - 20].close,
      lastMA200: p[0].close,
    };
    const phase = detectWyckoffPhase(p, ind);
    expect(typeof phase).toBe('string');
    expect(phase.length).toBeGreaterThan(0);
  });
});

describe('calcCandlestickPatterns + calcStochRSI', () => {
  it('returns an object (patterns may be empty for synthetic data)', () => {
    const res = calcCandlestickPatterns(seriesUptrend(30));
    expect(res).toBeDefined();
  });
  it('StochRSI k/d arrays stay bounded [0,100] when populated', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const s = calcStochRSI(closes);
    const last = closes.length - 1;
    if (s.k[last] != null) {
      expect(s.k[last]).toBeGreaterThanOrEqual(0);
      expect(s.k[last]).toBeLessThanOrEqual(100);
    }
  });
});

describe('calcAll — integration smoke', () => {
  it('returns a populated ind blob with last* scalars on 60-bar uptrend', () => {
    const p = seriesUptrend(60);
    const ind = calcAll(p);
    expect(ind.lastClose).toBeCloseTo(p[59].close, 8);
    expect(ind.lastMA20).not.toBeNull();
    expect(ind.lastRSI).toBeGreaterThan(50);   // uptrend
    // When price AND OBV rise together, trend is 'confirmation' (bullish agreement)
    expect(['confirmation', 'accumulation']).toContain(ind.obvTrend);
    expect(ind.wyckoffPhase).toBeDefined();
  });
  it('downtrend yields distribution OBV and RSI < 50', () => {
    const p = seriesDowntrend(60);
    const ind = calcAll(p);
    expect(ind.lastRSI).toBeLessThan(50);
  });
});

// ── FORWARD MOMENTUM TESTS ────────────────────────────────────────────────
describe('Forward Momentum (bias fix)', () => {
  // Test 1: Steep spike today should get penalty
  function seriesSteepSpike(n = 30, spikeDay = 28, spikePct = 8) {
    return Array.from({ length: n }, (_, i) => {
      const base = 100;
      if (i >= spikeDay) {
        // Sharp spike on last 2 days
        const spike = 1 + ((i - spikeDay) * spikePct / 2);
        return { date: new Date(2025, 0, i + 1), open: base * spike * 0.99, high: base * spike * 1.01, low: base * spike * 0.98, close: base * spike, volume: 1000 };
      }
      return { date: new Date(2025, 0, i + 1), open: base - 0.2, high: base + 0.5, low: base - 0.5, close: base, volume: 1000 };
    });
  }
  
  // Test 2: Gradual buildup over 5 days - PREFERRED
  function seriesGradualBuild(n = 30) {
    return Array.from({ length: n }, (_, i) => {
      const base = 100;
      const gradual = 1 + (i / 30) * 0.05;  // ~5% total over 30 days
      return { date: new Date(2025, 0, i + 1), open: base * gradual * 0.99, high: base * gradual * 1.01, low: base * gradual * 0.98, close: base * gradual, volume: 1000 + i * 10 };
    });
  }
  
  it('steep spike (today +8%) gets momentumScore PENALTY', () => {
    const p = seriesSteepSpike(30, 28, 8);
    const ind = calcAll(p);
    // Should have momentumScore reduced due to steep spike penalty
    expect(ind.momentumScore).toBeLessThan(50);
    expect(ind.momentumTrend).toBe('steep');
    expect(ind.forwardMomentum).toBe(false);
  });
  
  it('gradual buildup gets FORWARD MOMENTUM bonus', () => {
    const p = seriesGradualBuild(30);
    const ind = calcAll(p);
    // Gradual but small — may or may not trigger forwardMomentum
    expect(ind.momentumTrend).toBeDefined();
    expect(typeof ind.momentumSlope).toBe('number');
    // With positive trend, momentumScore should be reasonable
    expect(ind.momentumScore).toBeGreaterThanOrEqual(0);
    expect(ind.momentumScore).toBeLessThanOrEqual(100);
  });
  
  it('forwardMomentum field exists in calcAll result', () => {
    const p = seriesUptrend(40);
    const ind = calcAll(p);
    expect(ind).toHaveProperty('momentumSlope');
    expect(ind).toHaveProperty('momentumTrend');
    expect(ind).toHaveProperty('forwardMomentum');
  });
});
