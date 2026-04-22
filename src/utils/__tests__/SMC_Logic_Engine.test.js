/**
 * SMC_Logic_Engine — regression tests.
 *
 * These tests lock in the critical BOS / OB / FVG contracts.
 * If any of these silently break, backtests and the JARVIS confluence
 * layer will produce invalid signals, so fail LOUDLY at CI time.
 */

import { describe, it, expect } from 'vitest';
import SMCEngine from '../SMC_Logic_Engine.js';

// ─── fixture builders ───────────────────────────────────────────────────────
function bar(i, o, h, l, c, v = 1000) {
  return { date: new Date(2025, 0, i + 1).toISOString(), open: o, high: h, low: l, close: c, volume: v };
}

// A monotonic uptrend that breaks a clear prior swing high on high volume.
function bullBOSFixture() {
  // 20 bars of slow climb + pullback + explosive break
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(i, 100 + i, 101 + i, 99 + i, 100 + i, 1000));
  // pullback creates a clean pivot high at bar index 9 (high=110)
  for (let i = 10; i < 15; i++) bars.push(bar(i, 108, 109, 105, 106, 900));
  // break-out bar with 2x avg volume, closes ABOVE prior swing high 110
  bars.push(bar(15, 107, 118, 107, 116, 3000));
  return bars;
}

function bearBOSFixture() {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(i, 110 - i, 111 - i, 109 - i, 110 - i, 1000));
  for (let i = 10; i < 15; i++) bars.push(bar(i, 102, 104, 101, 103, 900));
  bars.push(bar(15, 103, 104, 92, 94, 3000));
  return bars;
}

// 3-bar pattern with a clear bullish FVG: bar[2].low > bar[0].high.
// Follow-up bars intentionally stay above bar[0].high but below bar[1].high
// so no SECOND FVG forms between bar[1] and bar[3].
// Follow-up bars trade ABOVE gapHigh so mitigation overlap stays ~0,
// while bar[1]/bar[3] relationship does not spawn a second FVG.
function fvgFixture() {
  return [
    bar(0, 100, 101, 99, 100),    // high=101
    bar(1, 102, 106, 101, 103),
    bar(2, 106, 108, 105, 107),   // low(105) > bar[0].high(101) ⇒ bullish FVG 101→105
    bar(3, 106, 108, 106, 107),   // low=106 > gapHigh=105 ⇒ zero overlap, doesn't mitigate. low=106 ≤ bar[1].high=106 ⇒ no new FVG.
    bar(4, 107, 109, 107, 108),   // low=107 > gapHigh=105 ⇒ no mitigation. low=107 ≤ bar[2].high=108 ⇒ no new FVG.
  ];
}

// ─── tests ──────────────────────────────────────────────────────────────────
describe('SMCEngine.findBOS', () => {
  it('detects a bullish BOS when price breaks a prior swing high on elevated volume', () => {
    const engine = new SMCEngine();
    const bos = engine.findBOS(bullBOSFixture());
    expect(bos).not.toBeNull();
    expect(bos.direction).toBe('bull');
    expect(bos.breakPrice).toBeGreaterThan(bos.pivotPrice);
    expect(bos.volOK).toBe(true);
  });

  it('detects a bearish BOS when price breaks a prior swing low', () => {
    const engine = new SMCEngine();
    const bos = engine.findBOS(bearBOSFixture());
    expect(bos).not.toBeNull();
    expect(bos.direction).toBe('bear');
    expect(bos.breakPrice).toBeLessThan(bos.pivotPrice);
  });

  it('returns null on insufficient data (prevents silent fake signals)', () => {
    const engine = new SMCEngine();
    expect(engine.findBOS([])).toBeNull();
    expect(engine.findBOS([bar(0, 10, 11, 9, 10)])).toBeNull();
    expect(engine.findBOS(null)).toBeNull();
  });
});

describe('SMCEngine.findFVG', () => {
  it('detects an active bullish fair-value-gap with correct zone bounds', () => {
    const engine = new SMCEngine();
    const fvgs = engine.findFVG(fvgFixture());
    expect(fvgs.length).toBeGreaterThan(0);
    const bull = fvgs.find(f => f.type === 'bullish_fvg');
    expect(bull).toBeDefined();
    expect(bull.gapLow).toBeCloseTo(101, 2);   // bar[0].high
    expect(bull.gapHigh).toBeCloseTo(105, 2);  // bar[2].low
    expect(bull.active).toBe(true);
  });

  it('marks an FVG mitigated when a later bar fully fills the gap', () => {
    const engine = new SMCEngine();
    // FVG at bars 0-2 (zone 101..105), then bar 3 pierces below gapLow → mitigated
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 102, 105, 101, 103),
      bar(2, 106, 108, 105, 107),
      bar(3, 106, 107, 100, 101), // full fill — low 100 < gapLow 101
      bar(4, 101, 103, 100, 102),
    ];
    const fvgs = engine.findFVG(bars);
    // Active list should NOT contain the mitigated bullish FVG
    const activeBull = fvgs.find(f => f.type === 'bullish_fvg');
    expect(activeBull).toBeUndefined();
  });
});
