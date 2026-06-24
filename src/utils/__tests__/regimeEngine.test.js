import { describe, it, expect } from 'vitest';
import { classifyRegime, REGIMES } from '../regimeEngine.js';

describe('regimeEngine.classifyRegime', () => {
  it('labels a broad strong tape as BULL', () => {
    const r = classifyRegime({ pctBull: 0.62, avgRSI: 60, scanned: 600 });
    expect(r.regime).toBe(REGIMES.BULL);
    expect(r.riskMult).toBe(1.0);
    expect(r.confidence).toBeGreaterThan(20);
  });

  it('labels broad weakness as BEAR with reduced risk', () => {
    const r = classifyRegime({ pctBull: 0.12, avgRSI: 38, scanned: 600 });
    expect(r.regime).toBe(REGIMES.BEAR);
    expect(r.riskMult).toBeLessThan(0.5);
  });

  it('labels an indecisive tape as RANGE', () => {
    const r = classifyRegime({ pctBull: 0.38, avgRSI: 50, scanned: 600 });
    expect(r.regime).toBe(REGIMES.RANGE);
  });

  it('flags macro stress (high VIX) without strong internals as VOLATILE', () => {
    const r = classifyRegime({ pctBull: 0.40, avgRSI: 49, scanned: 600, macro: { vix: 34 } });
    expect(r.regime).toBe(REGIMES.VOLATILE);
    expect(r.riskMult).toBeLessThan(0.8);
  });

  it('a sharp lira move also triggers VOLATILE', () => {
    const r = classifyRegime({ pctBull: 0.42, avgRSI: 50, scanned: 600, macro: { usdtryChangePct: -2.3 } });
    expect(r.regime).toBe(REGIMES.VOLATILE);
  });

  it('strong internals override macro stress (real bull, not whipsaw)', () => {
    const r = classifyRegime({ pctBull: 0.65, avgRSI: 62, scanned: 600, macro: { vix: 30 } });
    expect(r.regime).toBe(REGIMES.BULL);
  });

  it('caps confidence when the scan sample is thin', () => {
    const r = classifyRegime({ pctBull: 0.7, avgRSI: 65, scanned: 10 });
    expect(r.confidence).toBeLessThanOrEqual(35);
  });

  it('is defensive against missing/garbage input', () => {
    const r = classifyRegime();
    expect(Object.values(REGIMES)).toContain(r.regime);
    expect(r.confidence).toBeGreaterThanOrEqual(5);
    const r2 = classifyRegime({ pctBull: 'x', avgRSI: null });
    expect(Object.values(REGIMES)).toContain(r2.regime);
  });
});
