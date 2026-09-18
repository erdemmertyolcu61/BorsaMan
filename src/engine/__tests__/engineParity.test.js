import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { initEngine, engineReady, engineStats } from '../engineCore.js';
import { ENGINE_SOURCE_HASH } from '../bistEngineWasm.js';
import { engineSourceHash } from '../../../scripts/engine-hash.mjs';
import { calcAll, calcAllJs } from '../../utils/indicators.js';
import { genSignal, genSignalJs, setSignalReliabilityHints, clearSignalReliabilityHints } from '../../utils/signals.js';
import { buildCalibrationModel, setSignalCalibration, clearSignalCalibration } from '../../utils/signalCalibration.js';
import fixture from './fixtures/realBars.json';

// Deep equality with Object.is on primitives (NaN === NaN, -0 !== +0) and the
// same key ORDER — the Rust path must hand back the JS engine's exact objects.
function firstDiff(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  const show = (x) => (typeof x === 'string' ? JSON.stringify(x) : String(x));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${show(a)} vs ${show(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join('|') !== kb.join('|')) return `${path} keys: [${ka}] vs [${kb}]`;
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

// Deterministic synthetic bars, prices rounded to 2 decimals like BIST (so
// toFixed ties and equal highs/lows actually occur).
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function makeBars(n, seed, kind) {
  const r = lcg(seed);
  let p = 20 + r() * 80;
  const t0 = Date.UTC(2026, 0, 2);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const drift = kind === 'up' ? 0.004 : kind === 'down' ? -0.004 : 0;
    const vol = kind === 'wild' ? 0.09 : 0.025;
    let o = p * (1 + (r() - 0.5) * vol * 0.5);
    let c = Math.max(0.5, p * (1 + drift + (r() - 0.5) * vol));
    if (kind === 'flat' && i % 3 === 0) c = o;
    let h = Math.max(o, c) * (1 + r() * 0.015);
    let l = Math.min(o, c) * (1 - r() * 0.015);
    if (kind === 'flat' && i % 7 === 0) { h = o; l = o; c = o; }
    if (kind === 'wild' && i % 11 === 0) o = c * 1.08;
    let v = Math.round(1e4 + r() * 1e6);
    if (kind === 'thin' && i % 4 === 0) v = 0;
    bars.push({
      date: new Date(t0 + i * 86400000).toISOString().slice(0, 10),
      open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: v,
    });
    p = c;
  }
  return bars;
}

const LENGTHS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 14, 15, 16, 19, 20, 21, 22, 25, 26, 27, 29, 30, 31, 40, 50, 52, 53, 60, 100, 200, 201, 252, 300];
const KINDS = ['up', 'down', 'flat', 'wild', 'thin'];
const SYNTH = KINDS.flatMap((kind, k) => LENGTHS.map((n) => ({ name: `${kind}/${n}`, bars: makeBars(n, 1000 + k * 97 + n, kind) })));

const REAL = Object.entries(fixture).flatMap(([sym, rows]) => {
  const bars = rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
  // 252-bar windows (what the live scan feeds genSignal) at 8 different end days
  return [0, 7, 19, 33, 41, 55, 64, 78].map((off) => ({ name: `${sym}@-${off}`, bars: bars.slice(bars.length - 252 - off, bars.length - off) }));
});

const OPTS = [
  undefined,
  {},
  { sectorStrength: 85 },
  { sectorStrength: 72 },
  { sectorStrength: 25 },
  { sectorStrength: 0 },
  { sectorStrength: 52.3456 },
  { htfContext: { trend: 'bull', weeklyTrend: 'bull', adx: 31, rsi: 72, ma200Above: true, weeklyRsi: 75 } },
  { htfContext: { trend: 'bear', weeklyTrend: 'bear', adx: 12, rsi: 25, ma200Above: false, weeklyRsi: 22 } },
  { htfContext: { trend: 'bear', adx: 40 } },
  { htfContext: { trend: 'bull', weeklyTrend: 'neutral' } },
  { kapSentiment: { score: 5, headline: 'Yeni iş ilişkisi — "sözleşme"' } },
  { kapSentiment: { score: -4 } },
  { kapSentiment: { score: null } },
  { kapSentiment: {} },
  { kapSentiment: { score: 0 } },
  { htfContext: { trend: 'bull', adx: 28, rsi: 45 }, sectorStrength: 90, kapSentiment: { score: 2, headline: '' } },
];

function compareSignal(bars, opts) {
  const indJ = calcAllJs(bars);
  const indW = calcAll(bars);
  const sigJ = genSignalJs(indJ, bars, opts);
  const sigW = genSignal(indW, bars, opts);
  return firstDiff(sigJ, sigW);
}

beforeAll(async () => {
  expect(await initEngine()).toBe(true);
  // wallStreet's data-quality check reads the clock; pin it for both paths
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
  clearSignalCalibration();
  clearSignalReliabilityHints();
});

describe('Rust/WASM engine — bit-for-bit parity with the JS engine', () => {
  it('ships a wasm built from the current Rust sources', () => {
    // vitest runs from the project root (jsdom rewrites import.meta.url, so no URL here)
    const crate = join(process.cwd(), 'engine-rs');
    // If this fails: run `npm run build:engine` and commit src/engine/bistEngineWasm.js.
    expect(ENGINE_SOURCE_HASH).toBe(engineSourceHash(crate));
  });

  it('calcAll matches on synthetic edge cases (1-300 bars, doji, zero range, zero volume, gaps)', () => {
    const before = engineStats().calc;
    for (const s of SYNTH) {
      const d = firstDiff(calcAllJs(s.bars), calcAll(s.bars));
      expect(d, s.name).toBeNull();
    }
    expect(engineReady()).toBe(true);
    expect(engineStats().calc - before).toBe(SYNTH.length);
  });

  it('calcAll matches on real BIST bars', () => {
    for (const s of REAL) expect(firstDiff(calcAllJs(s.bars), calcAll(s.bars)), s.name).toBeNull();
  });

  it('genSignal matches for every option shape the app passes', () => {
    const before = engineStats().signal;
    let runs = 0;
    for (const s of [...REAL, ...SYNTH.filter((_, i) => i % 3 === 0)]) {
      for (const o of OPTS) {
        expect(compareSignal(s.bars, o), `${s.name} ${JSON.stringify(o)}`).toBeNull();
        runs++;
      }
    }
    expect(engineStats().signal - before).toBe(runs);
    expect(engineStats().fallbacks).toBe(0);
  });

  it('genSignal matches with a learned calibration model and reliability hints', () => {
    const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'CHOPPY', 'QUIET', 'NORMAL'];
    const closed = Array.from({ length: 160 }, (_, i) => ({
      status: 'closed',
      outcome: i % 3 === 0 ? 'STOP_HIT' : 'TARGET_HIT',
      cls: i % 4 === 0 ? 'sell' : 'buy',
      source: 'advisor',
      score100: 20 + (i * 37) % 70,
      regime: regimes[i % regimes.length],
      planReturn: ((i * 53) % 17) - 7.5,
    }));
    setSignalCalibration(buildCalibrationModel(closed));
    setSignalReliabilityHints({
      buy: { winRate: 0.31, sampleSize: 22 },
      sell: { winRate: 0.7, sampleSize: 25 },
      hold: { winRate: 0.66, sampleSize: 30 },
      bySignalType: {
        MACD_HIST_POS: { winRate: 0.71, sampleSize: 40 },
        OBV_ACC: { winRate: 0.28, sampleSize: 12 },
        ABOVE_MA20: { winRate: 0.55, sampleSize: 9 },
        SUPERTREND_UP: { winRate: 0.62, sampleSize: 33 },
      },
    });
    try {
      for (const s of [...REAL, ...SYNTH.filter((_, i) => i % 4 === 0)]) {
        for (const o of [undefined, OPTS[7], OPTS[8], OPTS[16]]) {
          expect(compareSignal(s.bars, o), `${s.name} ${JSON.stringify(o)}`).toBeNull();
        }
      }
    } finally {
      clearSignalCalibration();
      clearSignalReliabilityHints();
    }
  });

  it('leaves inputs it does not model to the JS engine, with the same result', () => {
    const bars = makeBars(80, 7, 'up');
    const odd = bars.map((b, i) => (i === 40 ? { ...b, close: String(b.close) } : b));
    const f0 = engineStats().fallbacks;
    expect(firstDiff(calcAllJs(odd), calcAll(odd))).toBeNull();
    const ind = calcAllJs(bars);
    expect(firstDiff(genSignalJs(ind, bars, { sectorStrength: '85' }), genSignal(ind, bars, { sectorStrength: '85' }))).toBeNull();
    expect(firstDiff(genSignalJs(ind, bars, { htfContext: { adx: '30' } }), genSignal(ind, bars, { htfContext: { adx: '30' } }))).toBeNull();
    // ineligible input is not an engine failure
    expect(engineStats().fallbacks).toBe(f0);
    expect(engineReady()).toBe(true);
  });

  it('uses the JS engine when ind is not the untouched calcAll(prices) result', () => {
    // genSignal's Rust path scores from `prices`; genSignalJs reads the `ind` it is
    // handed. They only agree when ind === calcAll(prices) and nobody edited it.
    const a = makeBars(260, 11, 'up');
    const b = makeBars(260, 12, 'down');
    const indA = calcAll(a);
    expect(firstDiff(genSignalJs(indA, b), genSignal(indA, b)), 'ind built from other bars').toBeNull();
    const indB = calcAll(b);
    indB.lastRSI = 85; // tests and callers edit ind like this (signals.detectors.test.js)
    indB.sr = [{ type: 'support', price: indB.lastClose * 0.99 }];
    expect(firstDiff(genSignalJs(indB, b), genSignal(indB, b)), 'ind edited after calcAll').toBeNull();
    const indC = calcAll(b);
    indC.extraField = 1;
    expect(firstDiff(genSignalJs(indC, b), genSignal(indC, b)), 'key added after calcAll').toBeNull();
  });

  it('throws exactly where the JS engine throws', () => {
    expect(() => calcAllJs([])).toThrow();
    expect(() => calcAll([])).toThrow();
    const bars = makeBars(30, 3, 'up');
    expect(() => genSignal(calcAll(bars), bars, null)).toThrow();
  });
});
