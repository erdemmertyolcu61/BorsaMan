// ── RUST / WASM HESAP MOTORU KOPRUSU (v31.42) ─────────────────────────────
//
// calcAll'in tamami ve genSignal'in saf cekirdegi engine-rs/ (Rust) icinde
// yazili ve WebAssembly'e derlenmis halde calisir. Bu modul:
//   - wasm'i TEMBEL yukler (base64 gomulu JS parcasi → Electron file://, PWA,
//     Capacitor ve Node/Vitest'te ayni sekilde calisir, ayri .wasm istegi yok),
//   - fiyat barlarini wasm bellegine yazar, sonucu JS motorunun dondurdugu
//     nesnenin AYNISINA (anahtar sirasi dahil) cevirir,
//   - uygunsuz girdide ya da herhangi bir hatada null doner → cagiran eski JS
//     motoruna duser. Sonuclar bit duzeyinde ayni oldugu icin fark edilmez.
//
// Eslik kaniti: src/engine/__tests__/engineParity.test.js (her `npm test`)
// ve scripts/engine-parity.mjs (130 gercek seri x 5 yil, 19.739 pencere).
// Kapatmak: localStorage.bist_engine = 'js'  (yeniden yuklemede JS motoru).

const NULL_HI = 0x7ff4dead; // js.rs NULL_BITS = 0x7FF4DEAD_BEEF0001
const NULL_LO = 0xbeef0001;
const ABI_VERSION = 1;

let ex = null;
let initPromise = null;
let disabled = false;
let lastPrices = null;
let lastFp = null;
const stats = { calc: 0, signal: 0, fallbacks: 0, error: null };
// ind objects this engine built → the bars they came from + their top-level
// fields. The Rust genSignal scores from `prices`, genSignalJs from the `ind` it
// is handed, so the Rust path is only safe for exactly calcAll(prices), unedited.
// Reassigned or added top-level fields are caught; in-place edits inside nested
// arrays/objects are not — edit a copy, or call genSignalJs, if you need that.
const built = new WeakMap();
const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function base64ToBytes(b64) {
  const NodeBuffer = globalThis.Buffer; // Node / Vitest fast path
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function forcedJs() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('bist_engine') === 'js';
  } catch {
    return false;
  }
}

/** Loads the wasm engine once. Resolves true when it is ready. */
export function initEngine() {
  if (initPromise) return initPromise;
  if (typeof WebAssembly === 'undefined' || !te || !td || forcedJs()) {
    initPromise = Promise.resolve(false);
    return initPromise;
  }
  initPromise = import('./bistEngineWasm.js')
    .then(async (m) => {
      const { instance } = await WebAssembly.instantiate(base64ToBytes(m.ENGINE_WASM_BASE64), {});
      if (instance.exports.eng_abi_version() !== ABI_VERSION) throw new Error('wasm ABI mismatch');
      ex = instance.exports;
      return true;
    })
    .catch((err) => {
      disabled = true;
      stats.error = String(err?.message || err);
      console.warn('[engine] Rust/WASM motoru yuklenemedi, JS motoru kullaniliyor:', stats.error);
      return false;
    });
  return initPromise;
}

export function engineReady() {
  return ex !== null && !disabled;
}

/** Counters for tests and the diagnostics line. */
export function engineStats() {
  return { ready: engineReady(), ...stats };
}

function fail(err) {
  stats.fallbacks++;
  if (!stats.error) {
    stats.error = String(err?.message || err);
    console.warn('[engine] Rust/WASM cagrisi basarisiz, bu oturum JS motoruyla devam ediyor:', stats.error);
  }
  disabled = true;
}

/** The wasm path accepts plain numeric bars only; anything else stays on JS. */
function barsEligible(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return false;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p === null || typeof p !== 'object') return false;
    if (typeof p.open !== 'number' || typeof p.high !== 'number' || typeof p.low !== 'number'
      || typeof p.close !== 'number' || typeof p.volume !== 'number') return false;
  }
  return true;
}

function fingerprint(prices) {
  const a = prices[0];
  const z = prices[prices.length - 1];
  return [prices.length, a.open, a.close, z.open, z.high, z.low, z.close, z.volume];
}

function sameFp(fp, prices) {
  if (!fp) return false;
  const now = fingerprint(prices);
  for (let i = 0; i < now.length; i++) if (!Object.is(now[i], fp[i])) return false;
  return true;
}

function loadBars(prices) {
  const n = prices.length;
  const ptr = ex.eng_input_f64(n * 5);
  const f = new Float64Array(ex.memory.buffer, ptr, n * 5);
  for (let i = 0, k = 0; i < n; i++, k += 5) {
    const p = prices[i];
    f[k] = p.open;
    f[k + 1] = p.high;
    f[k + 2] = p.low;
    f[k + 3] = p.close;
    f[k + 4] = p.volume;
  }
  const rc = ex.eng_calc(n);
  if (rc !== 0) throw new Error(`eng_calc ${rc}`);
  lastPrices = prices;
  lastFp = fingerprint(prices);
}

function revive(_k, v) {
  if (v === '__NaN__') return NaN;
  if (v === '__Inf__') return Infinity;
  if (v === '__-Inf__') return -Infinity;
  return v;
}

function readOut() {
  const ptr = ex.eng_out_ptr();
  const len = ex.eng_out_len();
  const text = td.decode(new Uint8Array(ex.memory.buffer, ptr, len));
  return text.startsWith('{"__special"') ? JSON.parse(text, revive) : JSON.parse(text);
}

function writeBytes(text) {
  const bytes = te.encode(text);
  const ptr = ex.eng_input_bytes(bytes.length);
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function series(id) {
  const len = ex.eng_series_len(id);
  const out = new Array(len);
  if (len === 0) return out;
  const ptr = ex.eng_series_ptr(id);
  const f = new Float64Array(ex.memory.buffer, ptr, len);
  const u = new Uint32Array(ex.memory.buffer, ptr, len * 2);
  for (let i = 0; i < len; i++) {
    out[i] = u[2 * i + 1] === NULL_HI && u[2 * i] === NULL_LO ? null : f[i];
  }
  return out;
}

/** Same object calcAll builds, same key order. */
function assembleInd(prices, j) {
  const n = prices.length;
  const closes = prices.map((p) => p.close);
  const ma20 = series(0), ma50 = series(1), ma100 = series(2), ma200 = series(3);
  const rsi = series(4);
  const stochRSI = { k: series(5), d: series(6) };
  const macd = { macd: series(7), signal: series(8), histogram: series(9) };
  const bollinger = { upper: series(10), middle: series(11), lower: series(12) };
  const obv = series(13);
  const adl = series(14);
  const result = {
    closes, ma20, ma50, ma100, ma200,
    lastMA20: ma20[n - 1], lastMA50: ma50[n - 1], lastMA100: ma100[n - 1], lastMA200: ma200[n - 1],
    rsi, lastRSI: rsi[n - 1],
    stochRSI, lastStochK: stochRSI.k[n - 1], lastStochD: stochRSI.d[n - 1],
    macd, lastMACD: macd.macd[n - 1], lastMACDSig: macd.signal[n - 1], lastMACDHist: macd.histogram[n - 1],
    bollinger, lastBU: bollinger.upper[n - 1], lastBM: bollinger.middle[n - 1], lastBL: bollinger.lower[n - 1],
    sr: j.sr, mfi: j.mfi, obv, obvTrend: j.obvTrend, adl, adlTrend: j.adlTrend, vwap: j.vwap,
    lastVol: prices[n - 1].volume, volRatio: j.volRatio, lastClose: closes[n - 1], change: j.change, changePct: j.changePct,
    cmf: j.cmf,
    adx: j.adx, plusDI: j.plusDI, minusDI: j.minusDI,
    ttmSqueeze: j.ttmSqueeze, chandelier: j.chandelier, candlePatterns: j.candlePatterns,
    atr: j.atr,
  };
  result.wyckoffPhase = j.wyckoffPhase;
  result.obvDivergence = j.obvDivergence;
  result.rsiDivergence = j.rsiDivergence;
  result.wyckoffSpring = j.wyckoffSpring;
  result.volumeClimax = j.volumeClimax;
  result.diConvergence = j.diConvergence;
  const ic = j.ichimoku;
  result.ichimoku = {
    tenkan: series(15), kijun: series(16), senkouA: series(17), senkouB: series(18), chikou: series(19),
    lastTenkan: ic.lastTenkan, lastKijun: ic.lastKijun, lastSenkouA: ic.lastSenkouA, lastSenkouB: ic.lastSenkouB,
    tkCross: ic.tkCross, kumoBreakout: ic.kumoBreakout, kumoTwist: ic.kumoTwist, cloudPosition: ic.cloudPosition,
    kumoTop: ic.kumoTop, kumoBottom: ic.kumoBottom,
  };
  const williamsR = series(20);
  result.williamsR = williamsR;
  result.lastWilliamsR = williamsR[n - 1];
  result.trix = j.trix.full
    ? { trix: series(21), signal: series(22), lastTRIX: j.trix.lastTRIX, lastSignal: j.trix.lastSignal, crossover: j.trix.crossover }
    : { trix: [], signal: [], lastTRIX: null, lastSignal: null };
  result.supertrend = j.supertrend.full
    ? { supertrend: series(23), direction: series(24), trend: j.supertrend.trend, value: j.supertrend.value, flip: j.supertrend.flip }
    : { trend: null, value: null, direction: null };
  result.volumeProfile = j.volumeProfile;
  const roc10 = series(25);
  const roc20 = series(26);
  result.roc10 = roc10;
  result.roc20 = roc20;
  result.lastROC10 = roc10[n - 1];
  result.lastROC20 = roc20[n - 1];
  result.gapPct = j.gapPct;
  result.gapUp = j.gapUp;
  result.gapDown = j.gapDown;
  result.momentum1h = j.momentum1h;
  result.momentum4h = j.momentum4h;
  result.momentumIntraday = j.momentumIntraday;
  result.volumeSurge = j.volumeSurge;
  result.relStrength = j.relStrength;
  result.orBreakout = j.orBreakout;
  result.orBreakdown = j.orBreakdown;
  result.dayHighLowRange = j.dayHighLowRange;
  result.openToCurrentPct = j.openToCurrentPct;
  result.momentumScore = j.momentumScore;
  result.momentumSlope = j.momentumSlope;
  result.momentumTrend = j.momentumTrend;
  result.forwardMomentum = j.forwardMomentum;
  return result;
}

function register(ind, prices) {
  const keys = Object.keys(ind);
  built.set(ind, { prices, fp: lastFp, keys, vals: keys.map((k) => ind[k]) });
}

/** True when `ind` is this engine's calcAll(prices) result, unedited. */
function untouchedFor(ind, prices) {
  const rec = ind !== null && typeof ind === 'object' ? built.get(ind) : undefined;
  if (!rec || rec.prices !== prices || !sameFp(rec.fp, prices)) return false;
  const keys = Object.keys(ind);
  if (keys.length !== rec.keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== rec.keys[i] || !Object.is(ind[keys[i]], rec.vals[i])) return false;
  }
  return true;
}

/** calcAll through the wasm engine, or null (caller falls back to JS). */
export function engineCalcAll(prices) {
  if (!engineReady() || !barsEligible(prices)) return null;
  try {
    loadBars(prices);
    const ind = assembleInd(prices, readOut());
    register(ind, prices);
    stats.calc++;
    return ind;
  } catch (err) {
    fail(err);
    return null;
  }
}

const finiteOr = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * genSignal's options as JSON the engine reads, or null when a value has a
 * type whose JS behaviour the engine does not model (then JS handles it).
 * Omitted keys mean `undefined`; values that are no-ops in JS are omitted too.
 */
function encodeOpts(opts) {
  if (opts === null) return null; // JS destructuring throws — let JS throw
  if (opts === undefined || (typeof opts !== 'object' && typeof opts !== 'function')) return '{}';
  const out = {};
  const { kapSentiment, htfContext, sectorStrength } = opts;
  if (kapSentiment) {
    const k = {};
    const s = kapSentiment.score;
    if (s === null) k.score = null;
    else if (s !== undefined) {
      if (!finiteOr(s)) return null;
      k.score = s;
    }
    const h = kapSentiment.headline;
    if (typeof h === 'string') k.headline = h;
    else if (h != null && h !== false && h !== 0) return null;
    out.kapSentiment = k;
  }
  if (htfContext) {
    const h = {};
    if (typeof htfContext.trend === 'string') h.trend = htfContext.trend;
    if (typeof htfContext.weeklyTrend === 'string') h.weeklyTrend = htfContext.weeklyTrend;
    const adx = htfContext.adx;
    if (adx) {
      if (!finiteOr(adx)) return null;
      h.adx = adx;
    }
    for (const key of ['rsi', 'weeklyRsi']) {
      const v = htfContext[key];
      if (v == null || (typeof v === 'number' && Number.isNaN(v))) continue;
      if (!finiteOr(v)) return null;
      h[key] = v;
    }
    if (htfContext.ma200Above === true || htfContext.ma200Above === false) h.ma200Above = htfContext.ma200Above;
    out.htfContext = h;
  }
  if (sectorStrength != null && !(typeof sectorStrength === 'number' && Number.isNaN(sectorStrength))) {
    if (!finiteOr(sectorStrength)) return null;
    out.sectorStrength = sectorStrength;
  }
  return JSON.stringify(out);
}

/**
 * genSignal phase 1 (scoring). Returns { score100, cls, regime } or null.
 * `ind` must be this engine's untouched calcAll(prices) — anything else is left
 * to genSignalJs. Reuses the bars already in wasm when `prices` is the array
 * calcAll just saw.
 */
export function engineSignalBegin(prices, opts, ind) {
  if (!engineReady() || !barsEligible(prices) || !untouchedFor(ind, prices)) return null;
  const optsJson = encodeOpts(opts);
  if (optsJson === null) return null;
  try {
    if (prices !== lastPrices || !sameFp(lastFp, prices)) loadBars(prices);
    const len = writeBytes(optsJson);
    const rc = ex.eng_signal_begin(len);
    if (rc !== 0) throw new Error(`eng_signal_begin ${rc}`);
    return readOut();
  } catch (err) {
    fail(err);
    return null;
  }
}

/**
 * genSignal phase 2 with the score after JS calibration. `reasonText` is the
 * ML KALIBRASYON reason (or null), `reasonC` 1 = bullish / 2 = bearish.
 */
export function engineSignalFinish(score100, reasonText, reasonC) {
  if (!engineReady()) return null;
  try {
    const len = reasonText ? writeBytes(reasonText) : 0;
    const rc = ex.eng_signal_finish(score100, len, reasonText ? reasonC : 0);
    if (rc !== 0) throw new Error(`eng_signal_finish ${rc}`);
    const out = readOut();
    stats.signal++;
    return out;
  } catch (err) {
    fail(err);
    return null;
  }
}
