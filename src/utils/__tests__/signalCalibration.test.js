import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCalibrationModel,
  calibrateScore,
  applyCalibrationToScore,
  setSignalCalibration,
  clearSignalCalibration,
} from '../signalCalibration.js';

function mkSignal({ cls = 'buy', source = 'advisor', grade = 'B', score = 70, outcome = 'WIN', d5 = 5 } = {}) {
  return {
    id: Math.random().toString(36),
    cls,
    source,
    setupGrade: grade,
    score100: score,
    status: 'closed',
    outcome,
    perf: { d5 },
  };
}

describe('signalCalibration', () => {
  beforeEach(() => clearSignalCalibration());

  it('returns multiplier=1 when history is empty', () => {
    const model = buildCalibrationModel([]);
    expect(model.sampleCount).toBe(0);
    const r = calibrateScore(75, { cls: 'buy' }, model);
    expect(r.applied).toBe(false);
    expect(r.multiplier).toBe(1);
  });

  it('returns multiplier=1 when below MIN_SAMPLES', () => {
    const sigs = Array.from({ length: 5 }, () => mkSignal());
    const model = buildCalibrationModel(sigs);
    const r = calibrateScore(75, { cls: 'buy' }, model);
    expect(r.applied).toBe(false);
  });

  it('boosts score when matching bucket has strong winRate + expectancy', () => {
    // 10 strong buys at q3 score, all winners
    const sigs = Array.from({ length: 12 }, (_, i) =>
      mkSignal({ cls: 'buy', score: 70, outcome: 'TARGET_HIT', d5: 7 + (i % 3) })
    );
    const model = buildCalibrationModel(sigs);
    const r = calibrateScore(70, { cls: 'buy' }, model);
    expect(r.applied).toBe(true);
    expect(r.multiplier).toBeGreaterThan(1.05);
    expect(r.breakdown.length).toBeGreaterThan(0);
  });

  it('demotes score when matching bucket has poor winRate + losses', () => {
    const sigs = Array.from({ length: 12 }, () =>
      mkSignal({ cls: 'buy', score: 70, outcome: 'STOP_HIT', d5: -4 })
    );
    const model = buildCalibrationModel(sigs);
    const r = calibrateScore(70, { cls: 'buy' }, model);
    expect(r.applied).toBe(true);
    expect(r.multiplier).toBeLessThan(0.95);
  });

  it('clamps multiplier to [0.55, 1.30]', () => {
    // Perfectly catastrophic: 30 stops in a row
    const sigs = Array.from({ length: 30 }, () =>
      mkSignal({ cls: 'buy', score: 80, outcome: 'STOP_HIT', d5: -8 })
    );
    const model = buildCalibrationModel(sigs);
    const r = calibrateScore(80, { cls: 'buy' }, model);
    expect(r.multiplier).toBeGreaterThanOrEqual(0.55);
    expect(r.multiplier).toBeLessThanOrEqual(1.30);
  });

  it('applyCalibrationToScore pulls score toward 50 when multiplier < 1', () => {
    const sigs = Array.from({ length: 15 }, () =>
      mkSignal({ cls: 'buy', score: 80, outcome: 'STOP_HIT', d5: -5 })
    );
    setSignalCalibration(buildCalibrationModel(sigs));
    const out = applyCalibrationToScore(80, { cls: 'buy' });
    expect(out.score100).toBeLessThan(80);
    expect(out.score100).toBeGreaterThan(50);
    expect(out.calibration.applied).toBe(true);
  });

  it('applyCalibrationToScore pushes score away from 50 when multiplier > 1', () => {
    const sigs = Array.from({ length: 15 }, () =>
      mkSignal({ cls: 'buy', score: 70, outcome: 'TARGET_HIT', d5: 8 })
    );
    setSignalCalibration(buildCalibrationModel(sigs));
    const out = applyCalibrationToScore(70, { cls: 'buy' });
    expect(out.score100).toBeGreaterThan(70);
    expect(out.score100).toBeLessThanOrEqual(100);
  });

  it('uses module-level singleton when model arg omitted', () => {
    const sigs = Array.from({ length: 12 }, () =>
      mkSignal({ cls: 'buy', score: 70, outcome: 'TARGET_HIT', d5: 6 })
    );
    setSignalCalibration(buildCalibrationModel(sigs));
    const r = calibrateScore(70, { cls: 'buy' });
    expect(r.applied).toBe(true);
  });

  it('weights specific buckets higher than overall', () => {
    // overall is mediocre; cls:buy q4 is excellent → cls bucket should dominate
    const lossPool = Array.from({ length: 20 }, () => mkSignal({ cls: 'sell', score: 30, outcome: 'STOP_HIT', d5: -4 }));
    const winPool = Array.from({ length: 12 }, () => mkSignal({ cls: 'buy', score: 80, outcome: 'TARGET_HIT', d5: 9 }));
    const model = buildCalibrationModel([...lossPool, ...winPool]);
    const r = calibrateScore(80, { cls: 'buy' }, model);
    expect(r.multiplier).toBeGreaterThan(1.0);
  });

  it('grade hint contributes when bucket has enough samples', () => {
    const sigs = Array.from({ length: 12 }, () =>
      mkSignal({ cls: 'buy', grade: 'A', score: 70, outcome: 'TARGET_HIT', d5: 6 })
    );
    const model = buildCalibrationModel(sigs);
    const r = calibrateScore(70, { cls: 'buy', grade: 'A' }, model);
    expect(r.breakdown.some(b => b.label === 'grade:A')).toBe(true);
  });

  it('ignores active (non-closed) signals', () => {
    const closed = Array.from({ length: 10 }, () => mkSignal({ outcome: 'STOP_HIT', d5: -5 }));
    const active = Array.from({ length: 50 }, () => ({ ...mkSignal(), status: 'active', outcome: null }));
    const model = buildCalibrationModel([...closed, ...active]);
    expect(model.sampleCount).toBe(10);
  });
});
