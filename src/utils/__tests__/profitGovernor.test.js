import { describe, it, expect } from 'vitest';
import { computeGovernor, adaptiveStopMult } from '../profitGovernor.js';

const DAY = 1000 * 60 * 60 * 24;

// Build a synthetic journal: `outcomes` is an array of gross d1 returns (%),
// most-recent-first. Each becomes one evaluated prediction.
function mkJournal(outcomes, { regime = 'RANGE', dayOfWeek = 2 } = {}) {
  const now = Date.now();
  return outcomes.map((ret, i) => ({
    date: `2026-06-${String(30 - (i % 28)).padStart(2, '0')}`,
    timestamp: now - DAY * (i + 2),
    scanMode: 'intraday',
    marketBias: regime,
    regime,
    avgRSI: 50,
    dayOfWeek,
    scanHour: 17,
    predictions: [{
      symbol: 'SYM' + i, sector: '', cls: 'buy', entryPrice: 100,
      target: 110, stop: 95, rr: 2, score: 60, grade: 'B', tier: 'GOOD',
      confidence: 60, firedSignals: [],
      perf: { d1: ret, d3: null, d5: null },
      outcome: ret > 0 ? 'WIN' : 'LOSS',
      directionalHit: ret > 0,
      evaluatedAt: now - DAY * (i + 1),
      lastPrice: 100 + ret,
    }],
  }));
}

describe('profitGovernor', () => {
  it('young journal → NORMAL pass-through with insufficient-sample reasons', () => {
    const g = computeGovernor(mkJournal([2, -1, 3]), 'RANGE');
    expect(g.mode).toBe('NORMAL');
    expect(g.scoreCutoffDelta).toBe(0);
    expect(g.maxPicksMult).toBe(1);
    expect(g.positionMult).toBe(1);
    expect(g.reasons.some(r => r.includes('yetersiz orneklem'))).toBe(true);
  });

  it('empty journal → NORMAL', () => {
    const g = computeGovernor([], 'BULL');
    expect(g.mode).toBe('NORMAL');
  });

  it('regime accuracy < 45% with n>=20 → CAUTION (+5 cutoff, half picks)', () => {
    // 8 winners / 12 losers = 40% accuracy in RANGE, but positive net expectancy
    // (winners +9 dwarf losers -0.5) so the kill-switch stays quiet.
    const rets = [
      ...Array(8).fill(9),
      ...Array(12).fill(-0.5),
    ];
    const g = computeGovernor(mkJournal(rets, { regime: 'RANGE' }), 'RANGE');
    expect(g.mode).toBe('CAUTION');
    expect(g.scoreCutoffDelta).toBe(5);
    expect(g.maxPicksMult).toBe(0.5);
  });

  it('regime accuracy < 38% with n>=30 → DEFENSE (+10 cutoff)', () => {
    const rets = [
      ...Array(10).fill(15),   // 10 winners, huge — net expectancy stays positive
      ...Array(20).fill(-0.4), // 20 small losers → accuracy 33%
    ];
    const g = computeGovernor(mkJournal(rets, { regime: 'BEAR' }), 'BEAR');
    expect(g.mode).toBe('DEFENSE');
    expect(g.scoreCutoffDelta).toBe(10);
  });

  it('other-regime history does not throttle the current regime', () => {
    const rets = [...Array(8).fill(1), ...Array(12).fill(-2)];
    const g = computeGovernor(mkJournal(rets, { regime: 'BEAR' }), 'BULL');
    // BULL bucket empty → regime rule silent (kill-switch may still fire, so
    // just assert the regime reason is absent)
    expect(g.reasons.some(r => r.startsWith('BULL rejiminde'))).toBe(false);
  });

  it('rolling-20 negative net expectancy → CAUTION with half position', () => {
    // Alternating small: 10 × +0.2, 10 × -0.6 → gross avg -0.2, net < 0
    // Accuracy = 50% → regime rule silent.
    const rets = [];
    for (let i = 0; i < 10; i++) rets.push(0.2, -0.6);
    const g = computeGovernor(mkJournal(rets), 'RANGE');
    expect(g.mode).toBe('CAUTION');
    expect(g.positionMult).toBe(0.5);
    expect(g.reasons.some(r => r.includes('net beklenti'))).toBe(true);
  });

  it('rolling-20 below -1% → DEFENSE with quarter position', () => {
    const rets = [];
    for (let i = 0; i < 10; i++) rets.push(0.5, -3.5); // avg -1.5 gross
    const g = computeGovernor(mkJournal(rets), 'RANGE');
    expect(g.mode).toBe('DEFENSE');
    expect(g.positionMult).toBe(0.25);
    expect(g.maxPicksMult).toBe(0.5);
  });

  it('recovery hysteresis: fresh positive streak after a losing window stays CAUTION', () => {
    // 3 recent wins (streak < 5) after 20 losers → rolling-20 (which includes
    // losers) may already be… construct: 3 × +1 then 20 × -2.
    const rets = [1, 1, 1, ...Array(20).fill(-2)];
    const g = computeGovernor(mkJournal(rets), 'RANGE');
    expect(['CAUTION', 'DEFENSE']).toContain(g.mode);
    expect(g.positionMult).toBeLessThanOrEqual(0.5);
  });

  it('calendar rule: weak weekday (n>=15, acc<42%) adds +5 cutoff', () => {
    // Monday (dow=1) picks: 5 winners +8 / 10 losers -0.3 → 33% accuracy,
    // net expectancy positive → only the calendar rule should fire.
    const rets = [...Array(5).fill(8), ...Array(10).fill(-0.3)];
    const g = computeGovernor(
      mkJournal(rets, { regime: 'BULL', dayOfWeek: 1 }),
      'RANGE', // different regime → regime rule silent (n=0 in RANGE)
      { tomorrowDow: 1 },
    );
    expect(g.scoreCutoffDelta).toBeGreaterThanOrEqual(5);
    expect(g.reasons.some(r => r.includes('gun-1'))).toBe(true);
  });

  it('healthy journal with enough samples → NORMAL full throttle', () => {
    // 14 winners +3 / 6 losers -1 → 70% accuracy, strong positive net
    const rets = [...Array(14).fill(3), ...Array(6).fill(-1)];
    const g = computeGovernor(mkJournal(rets, { regime: 'BULL' }), 'BULL');
    expect(g.mode).toBe('NORMAL');
    expect(g.positionMult).toBe(1);
    expect(g.scoreCutoffDelta).toBe(0);
  });
});

describe('adaptiveStopMult', () => {
  it('returns regime defaults below the sample floor', () => {
    expect(adaptiveStopMult(null, 'BULL').mult).toBe(1.8);
    expect(adaptiveStopMult({ stopHits: 5 }, 'VOLATILE').mult).toBe(2.2);
    expect(adaptiveStopMult({ stopHits: 5 }, 'BEAR').mult).toBe(1.6);
    expect(adaptiveStopMult({ stopHits: 5 }, 'BULL').adapted).toBe(false);
  });

  it('widens when stopped-then-recovered rate exceeds 40%', () => {
    const sq = { stopHits: 40, stoppedThenRecoveredRate: 55, avgWinnerMAE: 2 };
    const r = adaptiveStopMult(sq, 'BULL');
    expect(r.mult).toBeCloseTo(2.0, 5);
    expect(r.adapted).toBe(true);
  });

  it('tightens when winners never use the stop room', () => {
    const sq = { stopHits: 40, stoppedThenRecoveredRate: 10, avgWinnerMAE: 0.3 };
    const r = adaptiveStopMult(sq, 'BULL');
    expect(r.mult).toBeCloseTo(1.6, 5);
  });

  it('uses the per-regime slice when available', () => {
    const sq = {
      stopHits: 100, stoppedThenRecoveredRate: 10, avgWinnerMAE: 2,
      byRegime: { BEAR: { stopHits: 35, stoppedThenRecoveredRate: 60, avgWinnerMAE: 2 } },
    };
    const r = adaptiveStopMult(sq, 'BEAR');
    expect(r.mult).toBeCloseTo(1.8, 5); // 1.6 base + 0.2 widen
  });

  it('respects hard bounds 1.4-2.6', () => {
    const wide = adaptiveStopMult({ stopHits: 50, stoppedThenRecoveredRate: 90 }, 'VOLATILE');
    expect(wide.mult).toBeLessThanOrEqual(2.6);
    const tight = adaptiveStopMult({ stopHits: 50, stoppedThenRecoveredRate: 0, avgWinnerMAE: 0.1 }, 'BEAR');
    expect(tight.mult).toBeGreaterThanOrEqual(1.4);
  });
});
