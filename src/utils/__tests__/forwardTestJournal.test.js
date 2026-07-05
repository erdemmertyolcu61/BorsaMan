import { describe, it, expect, beforeEach } from 'vitest';
import {
  tradingDayKey,
  recordSnapshot,
  outcomeFromPrice,
  evaluateJournal,
  journalStats,
  predMetrics,
  netRealized,
  exportJournalJSON,
  JOURNAL_STORAGE_KEY,
  ROUND_TRIP_COST_PP,
} from '../forwardTestJournal.js';

const DAY = 1000 * 60 * 60 * 24;

function mkDetail(picks, extra = {}) {
  return { topPicks: picks, scanMode: 'intraday', ...extra };
}

function mkPick(o = {}) {
  return {
    symbol: 'THYAO', cls: 'buy', price: 100, target: 110, stop: 97,
    score: 70, grade: 'A', tier: 'STRONG', confidence: 80, rr: 2, sector: 'Ulastirma',
    ...o,
  };
}

describe('forwardTestJournal', () => {
  beforeEach(() => { try { localStorage.clear(); } catch {} });

  it('tradingDayKey returns a YYYY-MM-DD string', () => {
    expect(tradingDayKey(Date.UTC(2026, 5, 24, 12, 0, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recordSnapshot only stores buy picks and caps at MAX_PICKS_PER_DAY', () => {
    const picks = [
      mkPick({ symbol: 'AAA' }),
      mkPick({ symbol: 'BBB', cls: 'sell' }), // excluded
      ...Array.from({ length: 12 }, (_, i) => mkPick({ symbol: 'C' + i })),
    ];
    const days = recordSnapshot([], mkDetail(picks), Date.now());
    expect(days).toHaveLength(1);
    expect(days[0].predictions.every(p => p.cls === 'buy')).toBe(true);
    expect(days[0].predictions.length).toBeLessThanOrEqual(8);
    expect(days[0].predictions.some(p => p.symbol === 'BBB')).toBe(false);
  });

  it('recordSnapshot keeps one record per trading day (overwrites same day)', () => {
    const t = Date.now();
    let days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA' })]), t);
    days = recordSnapshot(days, mkDetail([mkPick({ symbol: 'BBB' })]), t + 1000);
    expect(days).toHaveLength(1);
    expect(days[0].predictions[0].symbol).toBe('BBB'); // latest scan wins
  });

  it('recordSnapshot freezes a day once predictions have matured', () => {
    const t = Date.now();
    let days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA' })]), t);
    days[0].predictions[0].evaluatedAt = t + DAY; // simulate maturation
    const after = recordSnapshot(days, mkDetail([mkPick({ symbol: 'BBB' })]), t + 2000);
    expect(after[0].predictions[0].symbol).toBe('AAA'); // not overwritten
  });

  it('recordSnapshot ignores scans with no buy picks', () => {
    const days = recordSnapshot([], mkDetail([mkPick({ cls: 'sell' })]), Date.now());
    expect(days).toHaveLength(0);
  });

  it('outcomeFromPrice classifies target/stop/win/loss', () => {
    // outcomeFromPrice operates on a stored prediction (entryPrice), not a raw pick.
    const p = { entryPrice: 100, target: 110, stop: 97 };
    expect(outcomeFromPrice(p, 110).outcome).toBe('TARGET_HIT');
    expect(outcomeFromPrice(p, 96).outcome).toBe('STOP_HIT');
    expect(outcomeFromPrice(p, 106).outcome).toBe('WIN');   // +6% but below target
    expect(outcomeFromPrice({ ...p, stop: 90 }, 96).outcome).toBe('LOSS'); // -4%, above stop
    expect(outcomeFromPrice(p, 100).outcome).toBe('OPEN');
  });

  it('evaluateJournal does not mature outcomes on day-0 (extremes only)', () => {
    const t = Date.now();
    const days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA' })]), t);
    const r = evaluateJournal(days, { AAA: 120 }, t + DAY * 0.5);
    const pred = r.days[0].predictions[0];
    // v2: running extremes update from day 0 …
    expect(pred.runningHigh).toBe(120);
    // … but outcome fields stay untouched until day 1
    expect(pred.perf.d1).toBeNull();
    expect(pred.outcome).toBeNull();
    expect(pred.directionalHit).toBeNull();
    expect(pred.evaluatedAt).toBeNull();
  });

  it('evaluateJournal locks directionalHit and fills perf by age', () => {
    const t = Date.now();
    const days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA', price: 100 })]), t);
    const r = evaluateJournal(days, { AAA: 105 }, t + DAY * 1.2);
    const pred = r.days[0].predictions[0];
    expect(r.changed).toBe(true);
    expect(pred.directionalHit).toBe(true);
    expect(pred.perf.d1).toBeCloseTo(5, 5);
    expect(pred.perf.d3).toBeNull(); // not aged enough yet
    expect(pred.evaluatedAt).toBeTruthy();
  });

  it('journalStats computes next-day directional accuracy and expectancy', () => {
    const t = Date.now() - DAY * 6;
    let days = recordSnapshot([], mkDetail([
      mkPick({ symbol: 'WIN1', price: 100, grade: 'A' }),
      mkPick({ symbol: 'LOSE1', price: 100, grade: 'B' }),
    ]), t);
    // WIN1 up to 108, LOSE1 down to 95 — mature past D5
    ({ days } = evaluateJournal(days, { WIN1: 108, LOSE1: 95 }, t + DAY * 6));
    const s = journalStats(days);
    expect(s.evaluated).toBe(2);
    expect(s.directionalAccuracy).toBe(50);
    expect(s.expectancy).toBeCloseTo((8 + -5) / 2, 5);
    expect(s.byGrade.A.accuracy).toBe(100);
    expect(s.byGrade.B.accuracy).toBe(0);
    expect(s.sampleConfidence).toBe('insufficient');
  });

  it('journalStats breaks accuracy down by market regime', () => {
    const t = Date.now() - DAY * 6;
    let days = recordSnapshot([], mkDetail(
      [mkPick({ symbol: 'BULLWIN', price: 100 })],
      { marketContext: { bias: 'bullish' } },
    ), t);
    ({ days } = evaluateJournal(days, { BULLWIN: 107 }, t + DAY * 6));
    const s = journalStats(days);
    expect(s.byRegime.bullish).toBeDefined();
    expect(s.byRegime.bullish.accuracy).toBe(100);
    expect(s.byRegime.bullish.total).toBe(1);
  });

  it('persists to the expected storage key', () => {
    recordSnapshot([], mkDetail([mkPick()]), Date.now());
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBeTruthy();
  });
});

describe('forwardTestJournal v2', () => {
  beforeEach(() => { try { localStorage.clear(); } catch {} });

  it('outcomeFromPrice catches a stop touch between evaluations via running extremes', () => {
    // Current price is back above the stop, but runningLow touched it.
    const p = { entryPrice: 100, target: 110, stop: 97, runningLow: 96.5, runningHigh: 101 };
    expect(outcomeFromPrice(p, 99).outcome).toBe('STOP_HIT');
  });

  it('outcomeFromPrice is pessimistic when both stop and target were touched', () => {
    const p = { entryPrice: 100, target: 110, stop: 97, runningLow: 96, runningHigh: 111 };
    expect(outcomeFromPrice(p, 100).outcome).toBe('STOP_HIT');
  });

  it('tracks MFE/MAE and stop-then-recover across evaluations', () => {
    const t = Date.now();
    let days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA', price: 100, stop: 97 })]), t);
    // Day 0: dips near stop
    ({ days } = evaluateJournal(days, { AAA: 98 }, t + DAY * 0.4));
    // Day 1.2: breaches stop → STOP_HIT
    ({ days } = evaluateJournal(days, { AAA: 96.5 }, t + DAY * 1.2));
    let pred = days[0].predictions[0];
    expect(pred.outcome).toBe('STOP_HIT');
    // Day 3: price recovers to +3% — outcome must NOT be rewritten
    ({ days } = evaluateJournal(days, { AAA: 103 }, t + DAY * 3));
    pred = days[0].predictions[0];
    expect(pred.outcome).toBe('STOP_HIT');
    const m = predMetrics(pred);
    expect(m.stoppedThenRecovered).toBe(true);
    expect(m.maePct).toBeCloseTo(-3.5, 5);
    expect(m.mfePct).toBeCloseTo(3, 5);
  });

  it('netRealized subtracts the round-trip cost from the gross return', () => {
    const pred = { perf: { d1: 2, d3: null, d5: null } };
    expect(netRealized(pred)).toBeCloseTo(2 - ROUND_TRIP_COST_PP, 8);
    expect(netRealized({ perf: { d1: null, d3: null, d5: null } })).toBeNull();
  });

  it('journalStats tolerates v1 records (no extremes, no regime/dayOfWeek fields)', () => {
    const v1Day = {
      date: '2026-06-01', timestamp: Date.now() - DAY * 10, scanMode: 'intraday',
      marketBias: 'bullish', regime: null, avgRSI: 55,
      predictions: [{
        symbol: 'OLD', sector: '', cls: 'buy', entryPrice: 100, target: 110, stop: 97,
        rr: 2, score: 70, grade: 'A', tier: 'STRONG', confidence: 80, firedSignals: ['OBV_ACC'],
        perf: { d1: 3, d3: 4, d5: 6 }, outcome: 'WIN', directionalHit: true,
        evaluatedAt: Date.now() - DAY * 4, lastPrice: 106,
      }],
    };
    const s = journalStats([v1Day]);
    expect(s.evaluated).toBe(1);
    expect(s.netExpectancy).toBeCloseTo(6 - ROUND_TRIP_COST_PP, 8);
    expect(s.bySignalType.OBV_ACC.total).toBe(1);
    expect(s.rolling20.samples).toBe(1);
    expect(s.stopQuality.stopHitRate).toBe(0);
    expect(s.byDayOfWeek).toBeDefined();
  });

  it('journalStats aggregates stopQuality with per-regime slices', () => {
    const t = Date.now() - DAY * 6;
    let days = recordSnapshot([], mkDetail(
      [mkPick({ symbol: 'STOPME', price: 100, stop: 97 }), mkPick({ symbol: 'WINNER', price: 100, target: 120 })],
      { marketContext: { regime: { regime: 'BULL' } } },
    ), t);
    ({ days } = evaluateJournal(days, { STOPME: 96, WINNER: 106 }, t + DAY * 6));
    const s = journalStats(days);
    expect(s.stopQuality.stopHits).toBe(1);
    expect(s.stopQuality.stopHitRate).toBe(50);
    expect(s.stopQuality.byRegime.BULL.samples).toBe(2);
    expect(s.byRegime.BULL.total).toBe(2);
  });

  it('exportJournalJSON produces parseable v2 payload', () => {
    const days = recordSnapshot([], mkDetail([mkPick()]), Date.now());
    const parsed = JSON.parse(exportJournalJSON(days));
    expect(parsed.version).toBe(2);
    expect(parsed.days).toHaveLength(1);
    expect(parsed.stats).toBeDefined();
  });

  it('recordSnapshot captures v2 fields (claudeGrade, scanHour, dayOfWeek, positionSizeMult)', () => {
    const t = Date.UTC(2026, 6, 2, 14, 25, 0); // Thu 17:25 Istanbul
    const days = recordSnapshot([], mkDetail(
      [mkPick({ claudeGrade: 'A', atrPct: 2.1, _positionSizeMult: 0.8 })],
      { marketContext: { regime: 'RANGE' } },
    ), t);
    expect(days[0].regime).toBe('RANGE');
    expect(days[0].scanHour).toBe(17);
    expect(days[0].dayOfWeek).toBe(4);
    const p = days[0].predictions[0];
    expect(p.claudeGrade).toBe('A');
    expect(p.atrPct).toBe(2.1);
    expect(p.positionSizeMult).toBe(0.8);
  });
});
