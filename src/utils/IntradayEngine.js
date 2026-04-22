// IntradayEngine.js — BIST 1m/5m/15m session-aware engine.
// VWAP (session-anchored) + stdev bands + phase detection + low-edge signal suppression.
// Zero deps.

const BIST_TZ_OFFSET_MIN = 180;       // BIST is UTC+3
const VWAP_BAND_MULT = [1, 2];        // 1σ / 2σ bands

// BIST phases (local TR time, minutes from midnight)
const PHASES = [
  { code: 'PRE',       label: 'Pre-Market',       from:   0, to: 595,  edge: 'none',   suppress: true  }, // <09:55
  { code: 'OPEN',      label: 'Opening Rush',     from: 595, to: 630,  edge: 'high',   suppress: false }, // 09:55-10:30
  { code: 'MORNING',   label: 'Morning Trend',    from: 630, to: 750,  edge: 'normal', suppress: false }, // 10:30-12:30
  { code: 'LUNCH',     label: 'Afternoon Lull',   from: 750, to: 870,  edge: 'low',    suppress: true  }, // 12:30-14:30
  { code: 'AFTERNOON', label: 'Afternoon Trend',  from: 870, to: 1020, edge: 'normal', suppress: false }, // 14:30-17:00
  { code: 'CLOSE',     label: 'Closing Rush',     from: 1020, to: 1095, edge: 'high',  suppress: false }, // 17:00-18:15
  { code: 'POST',      label: 'Post-Market',      from: 1095, to: 1440, edge: 'none',  suppress: true  },
];

function _trMinutes(date = new Date()) {
  // Convert any local time to Istanbul minutes-of-day
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMin + BIST_TZ_OFFSET_MIN) % 1440;
}

export function getSessionPhase(date = new Date()) {
  const dow = date.getUTCDay(); // 0=Sun, 6=Sat (TZ-safe enough — BIST weekend matches)
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

// ── Session-anchored VWAP with stdev bands ───────────────────────────
// bars: [{ date|timestamp, high, low, close, volume }] — intraday (1m/5m/15m)
// Anchors at start of each trading day. Returns aligned arrays (same length as bars).
export function computeVWAP(bars, { bands = VWAP_BAND_MULT } = {}) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const vwap = new Array(n).fill(null);
  const upper = bands.map(() => new Array(n).fill(null));
  const lower = bands.map(() => new Array(n).fill(null));
  if (n === 0) return { vwap, upper, lower, bands };

  let dayKey = null;
  let cumPV = 0, cumV = 0, cumP2V = 0; // for variance

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
// Returns: 'above_2s' | 'above_1s' | 'above' | 'at' | 'below' | 'below_1s' | 'below_2s'
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

// ── Intraday signal filter ───────────────────────────────────────────
// Suppresses low-edge signals during LUNCH / PRE / POST / WEEKEND.
// Also downgrades signals when price is stretched >2σ from VWAP (mean-reversion risk).
//
// signal: { action: 'buy'|'sell'|'hold', score: 0-10, ... }
// ctx:    { bars, vwap }  (vwap = computeVWAP output)
export function filterIntradaySignal(signal, ctx = {}, when = new Date()) {
  if (!signal) return { ...signal, allowed: false, reason: 'empty' };
  const phase = getSessionPhase(when);
  const action = String(signal.action || signal.signal || '').toLowerCase();
  const score = Number(signal.score ?? signal.confidence ?? 5);

  // Phase-based suppression of low-edge signals (keep high-conviction >=7.5)
  if (phase.suppress && score < 7.5) {
    return {
      ...signal,
      allowed: false,
      downgrade: true,
      phase: phase.code,
      reason: `${phase.label} — dusuk edge sinyali bastirildi`,
    };
  }

  // VWAP stretch: fade signals chasing >2σ moves
  if (ctx.bars && ctx.vwap) {
    const s = vwapStretch(ctx.bars, ctx.vwap);
    if (action.includes('buy') && s.zone === 'above_2s') {
      return {
        ...signal,
        allowed: false,
        phase: phase.code,
        reason: `Fiyat VWAP+2σ ustu (${s.distance}%) — alim kovalama riski`,
      };
    }
    if (action.includes('sell') && s.zone === 'below_2s') {
      return {
        ...signal,
        allowed: false,
        phase: phase.code,
        reason: `Fiyat VWAP-2σ alti (${s.distance}%) — geç satis riski`,
      };
    }
  }

  return {
    ...signal,
    allowed: true,
    phase: phase.code,
    phaseLabel: phase.label,
    reason: `${phase.label} (edge: ${phase.edge})`,
  };
}

// ── Full intraday snapshot for a symbol ──────────────────────────────
export function analyzeIntraday({ bars, signal, when = new Date() }) {
  const phase = getSessionPhase(when);
  const vwap = computeVWAP(bars || []);
  const stretch = vwapStretch(bars || [], vwap);
  const filtered = signal ? filterIntradaySignal(signal, { bars, vwap }, when) : null;
  return { phase, vwap, stretch, signal: filtered, ts: Date.now() };
}

export default {
  getSessionPhase,
  isMarketOpen,
  computeVWAP,
  vwapStretch,
  filterIntradaySignal,
  analyzeIntraday,
  PHASES,
};
