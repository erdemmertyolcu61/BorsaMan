import { describe, it, expect } from 'vitest';
import {
  analyzeDetailedFinancials, getFundamentalGrade, analyzeComprehensiveFinancials,
} from '../fundamentalEngine.js';

describe('analyzeDetailedFinancials', () => {
  it('returns null on null/undefined input', () => {
    expect(analyzeDetailedFinancials(null)).toBeNull();
  });

  it('computes margins / ROE / ROA from a full Yahoo-style payload', () => {
    const r = analyzeDetailedFinancials({
      revenue: 1000, grossProfit: 450, operatingIncome: 200, netIncome: 150,
      equity: 500, totalAssets: 1500, totalDebt: 300,
      currentAssets: 400, currentLiabilities: 200,
    });
    expect(r.grossMargin).toBeCloseTo(45, 6);
    expect(r.opMargin).toBeCloseTo(20, 6);
    expect(r.netMargin).toBeCloseTo(15, 6);
    expect(r.roe).toBeCloseTo(30, 6);
    expect(r.roa).toBeCloseTo(10, 6);
    expect(r.debtToEquity).toBeCloseTo(0.6, 6);
    expect(r.currentRatio).toBeCloseTo(2, 6);
    expect(r.score).toBeGreaterThan(6);
  });

  it('flags critical debt and operating losses in reasons', () => {
    const r = analyzeDetailedFinancials({
      revenue: 100, operatingIncome: -10, netIncome: -15,
      equity: 10, totalDebt: 100,
    });
    expect(r.score).toBeLessThan(5);
    expect(r.reasons.join(' ')).toMatch(/Op\. zarar|Kritik borc|Net zarar/);
  });

  it('detects improving profit trend over 3 quarters', () => {
    const r = analyzeDetailedFinancials({
      revenue: 100, netIncome: 10, equity: 50,
      quarterlyNet: [5, 8, 12],
    });
    expect(r.profitTrend).toBe('IMPROVING');
  });

  it('detects declining profit trend', () => {
    const r = analyzeDetailedFinancials({
      revenue: 100, netIncome: 10, equity: 50,
      quarterlyNet: [20, 12, 5],
    });
    expect(r.profitTrend).toBe('DECLINING');
  });

  it('accepts Turkish KAP-style aliases (hasilat, brutKar, ozkaynak)', () => {
    const r = analyzeDetailedFinancials({
      hasilat: 1000, brutKar: 300, netKar: 100, ozkaynak: 400,
    });
    expect(r.grossMargin).toBeCloseTo(30, 6);
    expect(r.netMargin).toBeCloseTo(10, 6);
    expect(r.roe).toBeCloseTo(25, 6);
  });
});

describe('getFundamentalGrade', () => {
  it('maps score boundaries to the expected letter grade', () => {
    expect(getFundamentalGrade(9).label).toBe('A+');
    expect(getFundamentalGrade(8).label).toBe('A');
    expect(getFundamentalGrade(7).label).toBe('B+');
    expect(getFundamentalGrade(6).label).toBe('B');
    expect(getFundamentalGrade(4.5).label).toBe('C');
    expect(getFundamentalGrade(2).label).toBe('D');
  });
  it('returns neutral dash for non-finite input', () => {
    expect(getFundamentalGrade(null).label).toBe('-');
    expect(getFundamentalGrade(NaN).label).toBe('-');
  });
});

describe('analyzeComprehensiveFinancials', () => {
  it('returns null when both sources are empty', () => {
    expect(analyzeComprehensiveFinancials({}, {})).toBeNull();
  });
  it('marks source correctly based on inputs', () => {
    expect(analyzeComprehensiveFinancials({ marketCap: 1e9 }, {}).source).toBe('Yahoo');
    expect(analyzeComprehensiveFinancials({}, { roe: 15 }).source).toBe('KAP');
    expect(analyzeComprehensiveFinancials({ marketCap: 1 }, { roe: 1 }).source).toBe('Yahoo+KAP');
  });
  it('attaches a grade with label + color', () => {
    const r = analyzeComprehensiveFinancials(
      { pe: 10, roe: 22, profitMargin: 18 },
      {},
    );
    expect(r.grade).toHaveProperty('label');
    expect(r.grade).toHaveProperty('color');
    expect(typeof r.score).toBe('number');
  });
});
