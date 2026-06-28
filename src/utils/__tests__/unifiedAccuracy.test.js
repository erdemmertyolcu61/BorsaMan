import { describe, it, expect } from 'vitest';
import { computeUnifiedStats } from '../unifiedAccuracy.js';

describe('computeUnifiedStats', () => {
  it('returns zero stats on empty inputs', () => {
    const stats = computeUnifiedStats({});
    expect(stats.overall.total).toBe(0);
    expect(stats.overall.winRate).toBe(0);
    expect(stats.calibration).toEqual([]);
    expect(stats.byRegime).toEqual({});
  });

  it('computes journal-only stats correctly', () => {
    const journalDays = [{
      date: '2026-06-25',
      marketBias: 'BULL',
      regime: 'BULL',
      predictions: [
        { symbol: 'THYAO', evaluatedAt: 1, directionalHit: true, perf: { d1: 2, d3: 3, d5: 4 }, grade: 'A', tier: 'STRONG', confidence: 78, firedSignals: ['RSI_OVERSOLD', 'OBV_ACC'] },
        { symbol: 'GARAN', evaluatedAt: 1, directionalHit: false, perf: { d1: -1, d3: -2, d5: -3 }, grade: 'B', tier: 'GOOD', confidence: 62, firedSignals: ['MACD_BULL_CROSS'] },
      ],
    }];

    const stats = computeUnifiedStats({ journalDays });
    expect(stats.overall.total).toBe(2);
    expect(stats.overall.wins).toBe(1);
    expect(stats.overall.winRate).toBe(50);
    expect(stats.overall.avgReturn).toBeCloseTo(0.5);
    expect(stats.byRegime.BULL.total).toBe(2);
    expect(stats.byGrade.A.total).toBe(1);
    expect(stats.byGrade.A.winRate).toBe(100);
    expect(stats.byGrade.B.winRate).toBe(0);
    expect(stats.bySignalType.RSI_OVERSOLD.total).toBe(1);
    expect(stats.bySignalType.RSI_OVERSOLD.winRate).toBe(100);
    expect(stats.bySignalType.MACD_BULL_CROSS.winRate).toBe(0);
    expect(stats.bySources.journal.total).toBe(2);
  });

  it('deduplicates overlapping journal and tracker entries', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'THYAO', evaluatedAt: 1, directionalHit: true, perf: { d1: 2 }, grade: 'A', confidence: 80 },
      ],
    }];

    const signals = [{
      symbol: 'THYAO',
      timestamp: new Date('2026-06-25T14:00:00'),
      status: 'closed',
      outcome: 'WIN',
      perf: { d1: 2.5 },
      grade: 'A',
      confidence: 80,
    }];

    const stats = computeUnifiedStats({ journalDays, signals });
    expect(stats.overall.total).toBe(1);
    expect(stats.bySources.journal.total).toBe(1);
    expect(stats.bySources.tracker).toBeUndefined();
  });

  it('includes non-overlapping tracker signals', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'THYAO', evaluatedAt: 1, directionalHit: true, perf: { d1: 2 } },
      ],
    }];

    const signals = [{
      symbol: 'GARAN',
      timestamp: new Date('2026-06-25T10:00:00'),
      status: 'closed',
      outcome: 'TARGET_HIT',
      perf: { d5: 5 },
      grade: 'B',
      regime: 'BULL',
      firedSignals: ['TTM_FIRE'],
    }];

    const stats = computeUnifiedStats({ journalDays, signals });
    expect(stats.overall.total).toBe(2);
    expect(stats.bySources.journal.total).toBe(1);
    expect(stats.bySources.tracker.total).toBe(1);
    expect(stats.bySignalType.TTM_FIRE.total).toBe(1);
  });

  it('computes confidence calibration buckets', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'A1', evaluatedAt: 1, directionalHit: true, perf: { d1: 1 }, confidence: 72 },
        { symbol: 'A2', evaluatedAt: 1, directionalHit: true, perf: { d1: 2 }, confidence: 75 },
        { symbol: 'A3', evaluatedAt: 1, directionalHit: false, perf: { d1: -1 }, confidence: 55 },
      ],
    }];

    const stats = computeUnifiedStats({ journalDays });
    expect(stats.calibration.length).toBeGreaterThan(0);

    const b70 = stats.calibration.find(c => c.bucket === '70-80');
    expect(b70).toBeDefined();
    expect(b70.count).toBe(2);
    expect(b70.actual).toBe(100);

    const b50 = stats.calibration.find(c => c.bucket === '50-60');
    expect(b50).toBeDefined();
    expect(b50.count).toBe(1);
    expect(b50.actual).toBe(0);
  });

  it('handles missing firedSignals and regime gracefully', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'X', evaluatedAt: 1, directionalHit: true, perf: { d1: 1 } },
      ],
    }];

    const stats = computeUnifiedStats({ journalDays });
    expect(stats.overall.total).toBe(1);
    expect(stats.byRegime['—'].total).toBe(1);
    expect(Object.keys(stats.bySignalType)).toHaveLength(0);
  });

  it('integrates paper trade data', () => {
    const paperTrades = [
      { symbol: 'EREGL', pnl_pct: 3.5, closed_at: new Date('2026-06-26T16:00:00').getTime(), regime: 'RANGE' },
      { symbol: 'SISE', pnl_pct: -2.1, closed_at: new Date('2026-06-26T16:00:00').getTime() },
    ];

    const stats = computeUnifiedStats({ paperTrades });
    expect(stats.overall.total).toBe(2);
    expect(stats.overall.wins).toBe(1);
    expect(stats.bySources.paper.total).toBe(2);
    expect(stats.byRegime.RANGE.total).toBe(1);
  });

  it('produces correct bySources breakdown with all 3 sources', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'A', evaluatedAt: 1, directionalHit: true, perf: { d1: 2 } },
      ],
    }];
    const signals = [{
      symbol: 'B', timestamp: new Date('2026-06-26T10:00:00'),
      status: 'closed', outcome: 'LOSS', perf: { d1: -3 },
    }];
    const paperTrades = [
      { symbol: 'C', pnl_pct: 1.5, closed_at: new Date('2026-06-27T16:00:00').getTime() },
    ];

    const stats = computeUnifiedStats({ journalDays, signals, paperTrades });
    expect(stats.overall.total).toBe(3);
    expect(stats.bySources.journal.total).toBe(1);
    expect(stats.bySources.tracker.total).toBe(1);
    expect(stats.bySources.paper.total).toBe(1);
    expect(stats.bySources.journal.winRate).toBe(100);
    expect(stats.bySources.tracker.winRate).toBe(0);
    expect(stats.bySources.paper.winRate).toBe(100);
  });

  it('skips unevaluated journal predictions', () => {
    const journalDays = [{
      date: '2026-06-25',
      predictions: [
        { symbol: 'A', evaluatedAt: null, directionalHit: null, perf: {} },
        { symbol: 'B', evaluatedAt: 1, directionalHit: true, perf: { d1: 1 } },
      ],
    }];

    const stats = computeUnifiedStats({ journalDays });
    expect(stats.overall.total).toBe(1);
  });
});
