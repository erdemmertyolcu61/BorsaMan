// Full-scale parity + speed check for the Rust/WASM engine (v31.42).
//
// Every cached real series in .replay-cache/ (Yahoo bars, up to 5 years), 252-bar
// windows (what the live scan feeds calcAll/genSignal) stepping through the
// history, JS engine vs Rust engine on the same window, option shapes rotating.
// Any difference in any field — numbers compared with Object.is — is a failure.
//
//   node scripts/engine-parity.mjs [step=5]
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const load = (p) => import(pathToFileURL(join(ROOT, 'src', p)).href);
const { initEngine, engineStats } = await load('engine/engineCore.js');
const { calcAll, calcAllJs } = await load('utils/indicators.js');
const { genSignal, genSignalJs } = await load('utils/signals.js');

if (!(await initEngine())) {
  console.error('engine failed to load:', engineStats().error);
  process.exit(1);
}
// wallStreet's data-quality age reads the clock: pin it so both paths see one instant
const NOW = Date.now();
Date.now = () => NOW;

function firstDiff(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: ${String(a)} vs ${String(b)}`;
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
  if (ka.join('|') !== kb.join('|')) return `${path} keys differ`;
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const OPTS = [
  {},
  { sectorStrength: 0 },
  { sectorStrength: 84.25 },
  { htfContext: { trend: 'bull', weeklyTrend: 'bull', adx: 29, rsi: 64, ma200Above: true, weeklyRsi: 71 } },
  { htfContext: { trend: 'bear', weeklyTrend: 'bear', adx: 33, rsi: 28, ma200Above: false, weeklyRsi: 27 } },
  { kapSentiment: { score: 3, headline: 'Pay geri alımı' } },
];

const step = Math.max(1, Number(process.argv[2]) || 5);
const files = readdirSync(join(ROOT, '.replay-cache')).filter((f) => f.endsWith('.json'));
let windows = 0;
let mismatches = 0;
const samples = [];
const t = { calcJs: 0, calcW: 0, sigJs: 0, sigW: 0 };
const isNum = (x) => typeof x === 'number';

for (const f of files) {
  const bars = JSON.parse(readFileSync(join(ROOT, '.replay-cache', f), 'utf8'))
    .filter((b) => b && isNum(b.open) && isNum(b.high) && isNum(b.low) && isNum(b.close) && isNum(b.volume));
  for (let end = Math.min(252, bars.length); end <= bars.length; end += step) {
    const w = bars.slice(Math.max(0, end - 252), end);
    const opts = OPTS[windows % OPTS.length];
    let t0 = performance.now();
    const indJ = calcAllJs(w);
    t.calcJs += performance.now() - t0;
    t0 = performance.now();
    const sJ = genSignalJs(indJ, w, opts);
    t.sigJs += performance.now() - t0;
    t0 = performance.now();
    const indW = calcAll(w);
    t.calcW += performance.now() - t0;
    t0 = performance.now();
    const sW = genSignal(indW, w, opts);
    t.sigW += performance.now() - t0;
    const d = firstDiff(sJ, sW);
    if (d) {
      mismatches++;
      if (samples.length < 12) samples.push(`${f} end=${end}: ${d}`);
    }
    windows++;
  }
}

const s = engineStats();
const per = (ms) => `${(ms / windows).toFixed(3)} ms`;
console.log(`series ${files.length} · windows ${windows} · mismatches ${mismatches} · engine calc ${s.calc} signal ${s.signal} fallbacks ${s.fallbacks}`);
console.log(`calcAll   JS ${per(t.calcJs)} · Rust/WASM ${per(t.calcW)} (incl. JS object assembly)`);
console.log(`genSignal JS ${per(t.sigJs)} · Rust/WASM ${per(t.sigW)} (incl. calibration + Wall Street layer in JS)`);
for (const x of samples) console.log('  ' + x);
process.exit(mismatches === 0 && s.fallbacks === 0 && s.signal === windows ? 0 : 1);
