// IntradayEngine.js v2 — BIST professional intraday analysis
// VWAP (session-anchored) + ORB + Relative Strength + 15m Momentum + Volume Rate + Structure Levels
// Zero external deps.

const BIST_TZ_OFFSET_MIN = 180; // BIST is UTC+3
const VWAP_BAND_MULT = [1, 2]; // 1σ / 2σ bands

// BIST open/close in TR minutes from midnight
const BIST_OPEN_MIN = 570;  // 09:30
const BIST_CLOSE_MIN = 990; // 16:30
const BIST_TRADING_MIN = BIST_CLOSE_MIN - BIST_OPEN_MIN; // 420 min

// BIST phases (local TR time, minutes from midnight)
const PHASES = [
  { code: 'PRE',       label: 'Pre-Market',       from:   0, to: 570,   edge: 'none',   suppress: true  },
  { code: 'OPEN',      label: 'Acilis Seansi',    from: 570, to: 600,   edge: 'high',   suppress: false }, // 09:30-10:00
  { code: 'MORNING',   label: 'Sabah Trendi',     from: 600, to: 750,   edge: 'normal', suppress: false }, // 10:00-12:30
  { code: 'LUNCH',     label: 'Ogle Molasi',      from: 750, to: 870,   edge: 'low',    suppress: true  }, // 12:30-14:30
  { code: 'AFTERNOON', label: 'Ogle Trendi',      from: 870, to: 960,   edge: 'normal', suppress: false }, // 14:30-16:00
  { code: 'CLOSE',     label: 'Kapanis Saati',    from: 960, to: 990,   edge: 'high',   suppress: false }, // 16:00-16:30
  { code: 'POST',      label: 'Piyasa Sonrasi',   from: 990, to: 1440,  edge: 'none',   suppress: true  },
];

function _trMinutes(date = new Date()) {
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMin + BIST_TZ_OFFSET_MIN) % 1440;
}

export function getSessionPhase(date = new Date()) {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) {
    return { code: 'WEEKEND', label: 'Piyasa Kapali', edge: 'none', suppress: true, minute: _trMinutes(date) };
  }
  const m = _trMinutes(date);
  const p = PHASES.find(x => m >= x.from && m < x.to) || PHASES[0];
  return { ...p, minute: m };
}

export function isMarketOpen(date = new Date()) {
  const p = getSessionPhase(date);
  return ['OPEN', 'MORNING', 'LUNCH', 'AFTERNOON', 'CLOSE'].includes(p.code);
}

// ══════════════════════════════════════════════════════════════════════════════
// SESSION-ANCHORED VWAP + STDEV BANDS
// ══════════════════════════════════════════════════════════════════════════════

// bars: [{ date|timestamp, high, low, close, volume }] — intraday (1m/5m/15m)
// Anchors at start of each trading day. Returns aligned arrays (same length as bars).
export function computeVWAP(bars, { bands = VWAP_BAND_MULT } = {}) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const vwap = new Array(n).fill(null);
  const upper = bands.map(() => new Array(n).fill(null));
  const lower = bands.map(() => new Array(n).fill(null));
  if (n === 0) return { vwap, upper, lower, bands };

  let dayKey = null;
  let cumPV = 0, cumV = 0, cumP2V = 0;

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (!b) continue;
    const ts = b.date ? new Date(b.date) : (b.timestamp ? new Date(b.timestamp) : null);
    if (!ts || isNaN(ts)) continue;
    const key = ts.toISOString().slice(0, 10);
    if (key !== dayKey) { dayKey = key; cumPV = 0; cumV = 0; cumP2V = 0; }

    const tp = (b.high + b.low + b.close) / 3;
    const v = Math.max(0, b.volume || 0);
    cumPV += tp * v;
    cumV += v;
    cumP2V += tp * tp * v;

    if (cumV <= 0) continue;
    const v_ = cumPV / cumV;
    vwap[i] = v_;
    const variance = Math.max(0, cumP2V / cumV - v_ * v_);
    const sd = Math.sqrt(variance);
    for (let k = 0; k < bands.length; k++) {
      upper[k][i] = v_ + bands[k] * sd;
      lower[k][i] = v_ - bands[k] * sd;
    }
  }
  return { vwap, upper, lower, bands };
}

// Position of last close relative to VWAP bands.
export function vwapStretch(bars, vwapResult) {
  if (!vwapResult || !bars || !bars.length) return { zone: 'unknown', distance: 0 };
  const i = bars.length - 1;
  const px = bars[i]?.close;
  const v = vwapResult.vwap[i];
  if (!Number.isFinite(px) || !Number.isFinite(v)) return { zone: 'unknown', distance: 0 };
  const u1 = vwapResult.upper[0]?.[i], u2 = vwapResult.upper[1]?.[i];
  const l1 = vwapResult.lower[0]?.[i], l2 = vwapResult.lower[1]?.[i];
  const distPct = ((px - v) / v) * 100;

  let zone = 'at';
  if (px >= u2) zone = 'above_2s';
  else if (px >= u1) zone = 'above_1s';
  else if (px > v) zone = 'above';
  else if (px <= l2) zone = 'below_2s';
  else if (px <= l1) zone = 'below_1s';
  else if (px < v) zone = 'below';

  return { zone, distance: Number(distPct.toFixed(2)), price: px, vwap: Number(v.toFixed(3)) };
}

// ══════════════════════════════════════════════════════════════════════════════
// OPENING RANGE BREAKOUT (ORB)
// ══════════════════════════════════════════════════════════════════════════════

// bars: 5m or 15m intraday bars
// orbMinutes: formation window after BIST open (default 30 min)
// Returns: { high, low, midpoint, formed, breakoutUp, breakoutDown, nearBreakout, range }
export function computeORB(bars, orbMinutes = 30) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { high: null, low: null, formed: false, breakoutUp: false, breakoutDown: false };
  }

  // Filter today's ORB window (BIST_OPEN_MIN .. BIST_OPEN_MIN + orbMinutes)
  const orbEnd = BIST_OPEN_MIN + orbMinutes;
  const lastBar = bars[bars.length - 1];
  if (!lastBar?.date) return { high: null, low: null, formed: false, breakoutUp: false, breakoutDown: false };

  // Use the day of the last bar as "today"
  const lastDay = new Date(lastBar.date).toISOString().slice(0, 10);

  const orbBars = bars.filter(b => {
    if (!b?.date) return false;
    const ts = new Date(b.date);
    const day = ts.toISOString().slice(0, 10);
    if (day !== lastDay) return false;
    const m = _trMinutes(ts);
    return m >= BIST_OPEN_MIN && m < orbEnd;
  });

  if (orbBars.length < 2) {
    return { high: null, low: null, formed: false, breakoutUp: false, breakoutDown: false };
  }

  const high = Math.max(...orbBars.map(b => b.high));
  const low = Math.min(...orbBars.map(b => b.low));
  const lastClose = lastBar.close;

  return {
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    midpoint: Number(((high + low) / 2).toFixed(2)),
    formed: true,
    breakoutUp: lastClose > high * 1.001,
    breakoutDown: lastClose < low * 0.999,
    nearBreakoutUp: lastClose <= high && lastClose > high * 0.995,
    nearBreakoutDown: lastClose >= low && lastClose < low * 1.005,
    range: Number((high - low).toFixed(2)),
    rangePct: Number(((high - low) / low * 100).toFixed(2)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// RELATIVE STRENGTH vs MARKET
// ══════════════════════════════════════════════════════════════════════════════

// Returns today's stock % change vs market % change
// rs > 1.1 = stock leads market (bullish); rs < 0.9 = stock lags (bearish)
export function computeRS(stockBars, marketBars) {
  const stockChange = _todayChangePct(stockBars);
  const marketChange = _todayChangePct(marketBars);

  if (!Number.isFinite(stockChange) || !Number.isFinite(marketChange)) {
    return { rs: 1, leading: false, lagging: false, stockChange: 0, marketChange: 0 };
  }

  // RS: how much the stock outperforms/underperforms vs market direction
  let rs = 1;
  const absMarket = Math.abs(marketChange);
  if (absMarket > 0.2) {
    rs = stockChange / absMarket * (marketChange > 0 ? 1 : -1);
  } else {
    // Near-flat market: RS = normalized stock move
    rs = 1 + stockChange / 4;
  }

  const outperformance = stockChange - marketChange; // positive = beating market

  return {
    rs: Number(rs.toFixed(2)),
    stockChange: Number(stockChange.toFixed(2)),
    marketChange: Number(marketChange.toFixed(2)),
    outperformance: Number(outperformance.toFixed(2)),
    leading: outperformance > 0.5,      // outperforming by 0.5%+
    lagging: outperformance < -0.5,     // underperforming by 0.5%+
    strongLeader: outperformance > 1.5, // very strong relative strength
  };
}

// Today's open-to-current % change for intraday bars
function _todayChangePct(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return 0;
  const lastBar = bars[bars.length - 1];
  if (!lastBar?.date) return 0;

  const lastDay = new Date(lastBar.date).toISOString().slice(0, 10);
  let todayOpen = null;
  for (const b of bars) {
    const d = b.date ? new Date(b.date).toISOString().slice(0, 10) : '';
    if (d === lastDay && b.open > 0) { todayOpen = b.open; break; }
  }

  if (!todayOpen || todayOpen <= 0) return 0;
  return ((lastBar.close - todayOpen) / todayOpen) * 100;
}

// ══════════════════════════════════════════════════════════════════════════════
// INTRADAY MOMENTUM SCORE (0-100) using 15m bars
// ══════════════════════════════════════════════════════════════════════════════

export function intradayMomentumScore(bars15m, vwapResult) {
  if (!Array.isArray(bars15m) || bars15m.length < 5) {
    return { score: 50, rsi: null, macdBull: false, macdAccel: false, vwapZone: 'unknown', trend: 'neutral' };
  }

  const closes = bars15m.map(b => b.close).filter(v => Number.isFinite(v));
  if (closes.length < 5) return { score: 50, rsi: null, macdBull: false, macdAccel: false, vwapZone: 'unknown', trend: 'neutral' };

  const rsi = _miniRSI(closes, Math.min(14, closes.length - 1));
  const macdData = _miniMACD(closes);
  const macdBull = macdData.histCurrent > 0;
  const macdAccel = macdData.histCurrent > macdData.histPrev;

  // VWAP zone from intraday bars
  const stretch = (vwapResult && vwapResult.vwap) ? vwapStretch(bars15m, vwapResult) : { zone: 'unknown', distance: 0 };
  const vwapZone = stretch.zone;

  // Today's intraday trend (first bar of today vs last)
  const lastBar = bars15m[bars15m.length - 1];
  const lastDay = lastBar?.date ? new Date(lastBar.date).toISOString().slice(0, 10) : '';
  let todayOpen = null;
  for (const b of bars15m) {
    const d = b.date ? new Date(b.date).toISOString().slice(0, 10) : '';
    if (d === lastDay) { todayOpen = b.open; break; }
  }
  const trend = todayOpen ? (lastBar.close > todayOpen ? 'up' : lastBar.close < todayOpen * 0.998 ? 'down' : 'flat') : 'neutral';

  // Score assembly
  let score = 50;

  // RSI contribution
  if (rsi != null) {
    if (rsi > 60 && rsi <= 75) score += 12;       // hot bull zone
    else if (rsi > 50 && rsi <= 60) score += 6;
    else if (rsi <= 50 && rsi >= 40) score -= 4;
    else if (rsi < 40 && rsi >= 25) score -= 10;  // bear zone
    else if (rsi < 25) score -= 5;                // oversold — might bounce
    else if (rsi > 75) score += 5;               // overbought but still hot
  }

  // MACD contribution
  if (macdBull && macdAccel) score += 12;         // rising positive histogram
  else if (macdBull && !macdAccel) score += 5;    // positive but slowing
  else if (!macdBull && macdAccel) score -= 3;    // negative but improving
  else score -= 10;                               // negative and worsening

  // VWAP zone contribution
  if (vwapZone === 'above_1s') score += 10;       // momentum zone
  else if (vwapZone === 'above') score += 6;      // above VWAP — bullish
  else if (vwapZone === 'above_2s') score += 3;   // extended, careful
  else if (vwapZone === 'below') score -= 6;      // below VWAP — bearish
  else if (vwapZone === 'below_1s') score -= 12;  // oversold zone (might bounce)
  else if (vwapZone === 'below_2s') score -= 6;   // very oversold — bounce risk

  // Trend contribution
  if (trend === 'up') score += 10;
  else if (trend === 'down') score -= 10;

  // Volume acceleration in last bar
  if (bars15m.length >= 3) {
    const vols = bars15m.slice(-3).map(b => b.volume || 0);
    const avgVol = (vols[0] + vols[1]) / 2;
    if (avgVol > 0 && vols[2] > avgVol * 2) score += 6;     // volume spike
    else if (avgVol > 0 && vols[2] > avgVol * 1.5) score += 3;
    else if (avgVol > 0 && vols[2] < avgVol * 0.4) score -= 3;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
    macdBull,
    macdAccel,
    vwapZone,
    trend,
    vwapDistance: Number(stretch.distance.toFixed(2)),
  };
}

// Mini RSI using Wilder smoothing (last period+1 bars)
function _miniRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (gains + losses < 1e-10) return 50;
  const rs = gains / (losses || 1e-10);
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

// Mini MACD (simplified EMA-based — good enough for intraday momentum direction)
function _miniMACD(closes) {
  if (!closes || closes.length < 6) return { histCurrent: 0, histPrev: 0 };

  const _ema = (src, p) => {
    if (!src || src.length === 0) return 0;
    const k = 2 / (p + 1);
    let e = src[0];
    for (let i = 1; i < src.length; i++) e = src[i] * k + e * (1 - k);
    return e;
  };

  const fast = Math.min(12, Math.floor(closes.length * 0.4));
  const slow = Math.min(26, closes.length - 1);

  const macd1 = _ema(closes.slice(-fast), fast) - _ema(closes.slice(-slow), slow);
  const macd2 = closes.length > 2
    ? _ema(closes.slice(-fast - 1, -1), fast) - _ema(closes.slice(-slow - 1, -1), slow)
    : macd1;

  const sigLine = (macd1 * 2 + macd2) / 3;
  const sigLinePrev = (macd1 + macd2 * 2) / 3;

  return {
    histCurrent: macd1 - sigLine,
    histPrev: macd2 - sigLinePrev,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// VOLUME RATE — how fast is today's vol accumulating vs daily average?
// ══════════════════════════════════════════════════════════════════════════════

export function volumeRate(bars15m, avgDailyVol) {
  if (!Array.isArray(bars15m) || bars15m.length === 0) {
    return { rate: 1, todayVol: 0, projection: 0, onPace: false, elapsedPct: 0 };
  }

  const lastBar = bars15m[bars15m.length - 1];
  if (!lastBar?.date) return { rate: 1, todayVol: 0, projection: 0, onPace: false, elapsedPct: 0 };

  const lastDay = new Date(lastBar.date).toISOString().slice(0, 10);
  const todayBars = bars15m.filter(b => {
    const d = b.date ? new Date(b.date).toISOString().slice(0, 10) : '';
    return d === lastDay;
  });

  if (todayBars.length === 0) return { rate: 1, todayVol: 0, projection: 0, onPace: false, elapsedPct: 0 };

  const todayVol = todayBars.reduce((s, b) => s + (b.volume || 0), 0);

  const firstMin = _trMinutes(new Date(todayBars[0].date));
  const lastMin = _trMinutes(new Date(lastBar.date));
  const elapsedMin = Math.max(15, lastMin - Math.max(firstMin, BIST_OPEN_MIN) + 15);
  const elapsedFraction = Math.min(1, elapsedMin / BIST_TRADING_MIN);

  const projected = elapsedFraction > 0.01 ? todayVol / elapsedFraction : todayVol;
  const rate = (avgDailyVol && avgDailyVol > 1000) ? projected / avgDailyVol : 1;

  return {
    rate: Number(rate.toFixed(2)),
    todayVol,
    projection: Math.round(projected),
    elapsedPct: Math.round(elapsedFraction * 100),
    onPace: rate > 1.3,   // 30%+ above average
    surge: rate > 2.5,    // volume surge
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// INTRADAY STRUCTURE LEVELS (stop/target from 15m structure)
// ══════════════════════════════════════════════════════════════════════════════

export function calcIntradayStructureLevels(bars15m, vwapResult, orbResult, side = 'buy') {
  if (!bars15m || bars15m.length < 3) return { stop: null, target: null, rr: 0 };

  const lastClose = bars15m[bars15m.length - 1]?.close;
  if (!lastClose || lastClose <= 0) return { stop: null, target: null, rr: 0 };

  const recentN = Math.min(8, bars15m.length); // last ~2 hours of 15m bars
  const recent = bars15m.slice(-recentN);

  const vwapLast = vwapResult?.vwap?.[bars15m.length - 1];
  const vwap1sH = vwapResult?.upper?.[0]?.[bars15m.length - 1];
  const vwap1sL = vwapResult?.lower?.[0]?.[bars15m.length - 1];
  const vwap2sH = vwapResult?.upper?.[1]?.[bars15m.length - 1];
  const atr15 = _calcATR15(recent);

  let stop, target;

  if (side === 'buy') {
    // ── Stop candidates ─────────────────────────────────────
    const stops = [];

    // 1. Recent structure low (last 6 15m bars = 90 min), just below
    const structLow = Math.min(...recent.map(b => b.low));
    if (structLow > 0 && structLow < lastClose) stops.push(structLow * 0.997);

    // 2. VWAP - 1σ (if valid and gives a tighter stop)
    if (vwap1sL && Number.isFinite(vwap1sL) && vwap1sL < lastClose) {
      stops.push(vwap1sL * 0.999);
    }

    // 3. ORB low (if formed)
    if (orbResult?.formed && orbResult.low > 0 && orbResult.low < lastClose) {
      stops.push(orbResult.low * 0.997);
    }

    // 4. ATR-based fallback (1× ATR below entry)
    if (atr15 > 0) stops.push(lastClose - atr15 * 1.0);

    // Pick the highest valid stop (closest to price, still below)
    const validStops = stops.filter(s => s < lastClose * 0.999 && s > lastClose * 0.90);
    stop = validStops.length > 0 ? Math.max(...validStops) : lastClose * 0.978;

    // Hard ceiling: never closer than 0.5%
    if (stop > lastClose * 0.995) stop = lastClose * 0.988;

    // ── Target candidates ────────────────────────────────────
    const targets = [];

    // 1. ORB high (very reliable if above current price)
    if (orbResult?.formed && orbResult.high > lastClose * 1.003) {
      targets.push({ p: orbResult.high, w: 4 });
    }

    // 2. VWAP + 1σ — primary momentum target
    if (vwap1sH && Number.isFinite(vwap1sH) && vwap1sH > lastClose * 1.003) {
      targets.push({ p: vwap1sH, w: 5 });
    }

    // 3. Recent structure high (resistance, just below)
    const structHigh = Math.max(...recent.map(b => b.high));
    if (structHigh > lastClose * 1.003) targets.push({ p: structHigh * 0.995, w: 3 });

    // 4. VWAP + 2σ (extended target, valid for strong momentum)
    if (vwap2sH && Number.isFinite(vwap2sH) && vwap2sH > lastClose * 1.005) {
      targets.push({ p: vwap2sH, w: 2 });
    }

    // 5. ATR-based target (1.5× ATR above entry)
    if (atr15 > 0) targets.push({ p: lastClose + 1.5 * atr15, w: 1 });

    // Weighted average of valid targets (min 0.4%, max 8%)
    const validTargets = targets.filter(t => t.p > lastClose * 1.004 && t.p < lastClose * 1.08);
    if (validTargets.length > 0) {
      const totalW = validTargets.reduce((s, t) => s + t.w, 0);
      target = validTargets.reduce((s, t) => s + t.p * t.w, 0) / totalW;
    } else {
      target = lastClose * 1.015;
    }
  }

  const risk = lastClose - (stop || lastClose * 0.978);
  const reward = (target || lastClose * 1.015) - lastClose;
  const rr = risk > 0 ? reward / risk : 0;

  return {
    stop: stop ? Number(stop.toFixed(2)) : null,
    target: target ? Number(target.toFixed(2)) : null,
    rr: Number(rr.toFixed(2)),
    vwap: vwapLast ? Number(vwapLast.toFixed(2)) : null,
    vwap1sHigh: vwap1sH ? Number(vwap1sH.toFixed(2)) : null,
    vwap1sLow: vwap1sL ? Number(vwap1sL.toFixed(2)) : null,
    vwap2sHigh: vwap2sH ? Number(vwap2sH.toFixed(2)) : null,
    atr15m: atr15 ? Number(atr15.toFixed(3)) : null,
  };
}

function _calcATR15(bars) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length === 0) return 0;
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// INTRADAY SIGNAL FILTER (phase + VWAP stretch)
// ══════════════════════════════════════════════════════════════════════════════

export function filterIntradaySignal(signal, ctx = {}, when = new Date()) {
  if (!signal) return { ...signal, allowed: false, reason: 'empty' };
  const phase = getSessionPhase(when);
  const action = String(signal.action || signal.signal || '').toLowerCase();
  const score = Number(signal.score ?? signal.confidence ?? 5);

  if (phase.suppress && score < 7.5) {
    return {
      ...signal,
      allowed: false,
      downgrade: true,
      phase: phase.code,
      reason: `${phase.label} — dusuk edge sinyali bastirildi`,
    };
  }

  if (ctx.bars && ctx.vwap) {
    const s = vwapStretch(ctx.bars, ctx.vwap);
    if (action.includes('buy') && s.zone === 'above_2s') {
      return { ...signal, allowed: false, phase: phase.code, reason: `VWAP+2s uzeri (${s.distance}%) — alim kovalama riski` };
    }
    if (action.includes('sell') && s.zone === 'below_2s') {
      return { ...signal, allowed: false, phase: phase.code, reason: `VWAP-2s alti (${s.distance}%) — gec satis riski` };
    }
  }

  return { ...signal, allowed: true, phase: phase.code, phaseLabel: phase.label, reason: `${phase.label} (edge: ${phase.edge})` };
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL INTRADAY SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════════

export function analyzeIntraday({ bars, signal, when = new Date() }) {
  const phase = getSessionPhase(when);
  const vwap = computeVWAP(bars || []);
  const stretch = vwapStretch(bars || [], vwap);
  const orb = computeORB(bars || []);
  const momentum = intradayMomentumScore(bars || [], vwap);
  const filtered = signal ? filterIntradaySignal(signal, { bars, vwap }, when) : null;
  return { phase, vwap, stretch, orb, momentum, signal: filtered, ts: Date.now() };
}

// ══════════════════════════════════════════════════════════════════════════════
// PLAY TYPE CLASSIFIER
// ══════════════════════════════════════════════════════════════════════════════

// Classify which intraday play type this stock fits best
// Returns: 'momentum' | 'vwap_reclaim' | 'orb_breakout' | 'dip_bounce' | 'squeeze' | 'none'
export function classifyIntradayPlay(intradayData, dailyData) {
  const { vwapZone, trend, rsi: rsi15m, macdBull, macdAccel } = intradayData?.momentum || {};
  const { breakoutUp, formed: orbFormed } = intradayData?.orb || {};
  const { leading } = intradayData?.rs || {};

  // 1. Momentum: above VWAP, accelerating, leading market
  if ((vwapZone === 'above_1s' || vwapZone === 'above_2s') && macdBull && macdAccel && leading) {
    return 'momentum';
  }

  // 2. ORB Breakout: just broke above ORB high with volume
  if (orbFormed && breakoutUp && vwapZone !== 'below') {
    return 'orb_breakout';
  }

  // 3. VWAP Reclaim: was below VWAP, now at/near VWAP from below
  if ((vwapZone === 'at' || vwapZone === 'above') && trend === 'up' && rsi15m && rsi15m < 60) {
    return 'vwap_reclaim';
  }

  // 4. Dip Bounce: below VWAP-1s but daily indicators bullish (OBV accumulation etc.)
  if ((vwapZone === 'below_1s' || vwapZone === 'below_2s') && dailyData?.obvTrend === 'accumulation') {
    return 'dip_bounce';
  }

  // 5. Squeeze: TTM squeeze releasing with momentum
  if (dailyData?.ttmSqueeze?.firing && dailyData?.ttmSqueeze?.momentum > 0) {
    return 'squeeze';
  }

  return 'none';
}

export const PLAY_TYPE_META = {
  momentum:    { label: 'Momentum Takip', icon: 'M', color: 'var(--cyan)',   desc: 'VWAP ustunde, piyasayi geciyor. Trend yonu ile gir.' },
  orb_breakout:{ label: 'ORB Kiriliyor',  icon: 'O', color: 'var(--yellow)', desc: 'Acilis araligi kirdiktan sonra devam hamlesi bekleniyor.' },
  vwap_reclaim:{ label: 'VWAP Toparlanma',icon: 'V', color: 'var(--green)',  desc: 'VWAP yi geri kazaniyordu, yukari devam potansiyeli.' },
  dip_bounce:  { label: 'Dip Alis',       icon: 'D', color: 'var(--purple)', desc: 'Asiri satimdan donus. Kurumsal birikim desteginde.' },
  squeeze:     { label: 'Squeeze Patliyor',icon:'S',  color: 'var(--orange)', desc: 'Bollinger sikismasi bitti, sert hareket basliyor.' },
  none:        { label: 'Standart',        icon: '-', color: 'var(--t3)',     desc: '' },
};

export default {
  getSessionPhase,
  isMarketOpen,
  computeVWAP,
  vwapStretch,
  computeORB,
  computeRS,
  intradayMomentumScore,
  volumeRate,
  calcIntradayStructureLevels,
  filterIntradaySignal,
  analyzeIntraday,
  classifyIntradayPlay,
  PLAY_TYPE_META,
  PHASES,
};
