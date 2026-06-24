import { describe, it, expect, beforeEach } from 'vitest';
import {
  tradingDayKey,
  recordSnapshot,
  outcomeFromPrice,
  evaluateJournal,
  journalStats,
  JOURNAL_STORAGE_KEY,
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

  it('evaluateJournal does not touch un-matured (< 1 day) snapshots', () => {
    const t = Date.now();
    const days = recordSnapshot([], mkDetail([mkPick({ symbol: 'AAA' })]), t);
    const { changed } = evaluateJournal(days, { AAA: 120 }, t + DAY * 0.5);
    expect(changed).toBe(false);
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
