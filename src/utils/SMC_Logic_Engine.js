// SMC_Logic_Engine.js — Smart Money Concepts engine for BIST high-frequency use.
// Zero deps. Pure logic. High-volatility tolerant.

const PIVOT_LOOKBACK = 3;
const MIN_BOS_VOLUME_MULT = 1.3;   // BOS candle volume >= 1.3x avg(20) → anti-fakeout
const OB_MAX_LOOKBACK = 12;        // max bars backward to find the contrarian OB
const OB_ZONE_EXPAND = 0.0015;     // 15 bps buffer around OB range
const SWEEP_EXTREME_PCT = 99;      // percentile threshold for liquidity sweep detection
const FVG_MIN_GAP_PCT = 0.0008;    // min gap size vs mid-price (8 bps) to filter noise
const FVG_MAX_TRACK = 40;          // cap active FVGs tracked

function _last(arr, n = 1) { return arr && arr.length >= n ? arr[arr.length - n] : null; }

function _avg(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function _pivots(bars, lb = PIVOT_LOOKBACK) {
  const highs = [], lows = [];
  for (let i = lb; i < bars.length - lb; i++) {
    const h = bars[i].high, l = bars[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (bars[j].high >= h) isHigh = false;
      if (bars[j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: h });
    if (isLow) lows.push({ i, price: l });
  }
  return { highs, lows };
}

export default class SMCEngine {
  constructor() {
    this._state = {
      bos: null,
      orderBlocks: [],
      lastSignal: null,
      lastPrice: null,
      ts: 0,
    };
  }

  // Return snapshot of current state (cheap).
  getState() { return this._state; }

  _fallback() { return this._state; }

  // ── Break of Structure ─────────────────────────────────────────────
  // Returns { direction: 'bull'|'bear', index, pivotPrice, breakPrice, volOK } or null
  findBOS(data) {
    if (!data || !Array.isArray(data) || data.length < 10) return null;
    const { highs, lows } = _pivots(data);
    if (!highs.length && !lows.length) return null;

    const lastIdx = data.length - 1;
    const closes = data.map(b => b.close);
    const vols = data.map(b => b.volume || 0);
    const avgVol20 = _avg(vols, Math.min(20, vols.length)) || 0;
    const lastVol = _last(vols) || 0;
    const volOK = avgVol20 === 0 || lastVol >= avgVol20 * MIN_BOS_VOLUME_MULT;

    // Latest pivots before current bar
    const priorHigh = [...highs].reverse().find(p => p.i < lastIdx);
    const priorLow  = [...lows].reverse().find(p => p.i < lastIdx);
    const price = closes[lastIdx];

    if (priorHigh && price > priorHigh.price) {
      return { direction: 'bull', index: lastIdx, pivotIndex: priorHigh.i, pivotPrice: priorHigh.price, breakPrice: price, volOK };
    }
    if (priorLow && price < priorLow.price) {
      return { direction: 'bear', index: lastIdx, pivotIndex: priorLow.i, pivotPrice: priorLow.price, breakPrice: price, volOK };
    }
    return null;
  }

  // ── Order Block (last contrarian candle before the BOS) ────────────
  // Bull BOS → last bearish (down) candle before break
  // Bear BOS → last bullish (up) candle before break
  identifyOB(data, bosIndex) {
    if (!data || typeof bosIndex !== 'number') return null;
    const bos = this._state.bos || this.findBOS(data);
    if (!bos) return null;
    const wantBearCandle = bos.direction === 'bull';
    const start = Math.max(bos.pivotIndex ?? bosIndex, 0);
    const from = Math.max(0, start - OB_MAX_LOOKBACK);

    for (let i = start; i >= from; i--) {
      const b = data[i];
      if (!b) continue;
      const isBear = b.close < b.open;
      const isBull = b.close > b.open;
      if ((wantBearCandle && isBear) || (!wantBearCandle && isBull)) {
        const low = b.low, high = b.high;
        const buf = (high - low) * OB_ZONE_EXPAND;
        return {
          type: bos.direction === 'bull' ? 'bullish_ob' : 'bearish_ob',
          index: i,
          zoneLow: low - buf,
          zoneHigh: high + buf,
          open: b.open, close: b.close,
          volume: b.volume || 0,
          ts: b.date || b.timestamp || null,
          active: true,
        };
      }
    }
    return null;
  }

  // ── Liquidity Sweep detection ──────────────────────────────────────
  // Needs recent MFI array + OBV array + recent bars for extreme detection.
  // Returns { sweep: 'bull'|'bear'|null, reason }
  checkLiquidity(mfi, obv, bars) {
    if (!Array.isArray(mfi) || !Array.isArray(obv) || mfi.length < 5 || obv.length < 5) return { sweep: null, reason: 'insufficient' };
    const lastMfi = _last(mfi), prevMfi = _last(mfi, 2);
    const lastObv = _last(obv), prevObv = _last(obv, 2);

    // Price extreme check
    let priceExtremeHigh = false, priceExtremeLow = false;
    if (Array.isArray(bars) && bars.length >= 20) {
      const window = bars.slice(-20);
      const highs = window.map(b => b.high).sort((a, b) => a - b);
      const lows = window.map(b => b.low).sort((a, b) => a - b);
      const hiQ = highs[Math.floor(highs.length * (SWEEP_EXTREME_PCT / 100)) - 1];
      const loQ = lows[Math.floor(lows.length * ((100 - SWEEP_EXTREME_PCT) / 100))];
      const lastBar = _last(bars);
      priceExtremeHigh = lastBar.high >= hiQ;
      priceExtremeLow  = lastBar.low  <= loQ;
    }

    // Bullish sweep: price makes a low extreme but MFI rises + OBV rises (stop-hunt then absorb)
    if (priceExtremeLow && lastMfi > prevMfi && lastObv > prevObv) {
      return { sweep: 'bull', reason: 'lowSweep+MFI/OBV diverjans' };
    }
    // Bearish sweep: price makes a high extreme but MFI falls + OBV falls
    if (priceExtremeHigh && lastMfi < prevMfi && lastObv < prevObv) {
      return { sweep: 'bear', reason: 'highSweep+MFI/OBV diverjans' };
    }
    return { sweep: null, reason: 'noSweep' };
  }

  // ── Fair Value Gap detection (O(n)) ────────────────────────────────
  // Bullish FVG: bars[i+2].low > bars[i].high  → gap = (bars[i].high, bars[i+2].low)
  // Bearish FVG: bars[i+2].high < bars[i].low  → gap = (bars[i+2].high, bars[i].low)
  // Mitigation: any subsequent bar whose range overlaps the gap zone fills/partials it.
  findFVG(bars) {
    if (!Array.isArray(bars) || bars.length < 3) return [];
    const n = bars.length;
    const gaps = [];

    for (let i = 0; i < n - 2; i++) {
      const a = bars[i], c = bars[i + 2];
      if (!a || !c) continue;
      const mid = (a.high + a.low) / 2 || 1;

      // Bullish FVG
      if (c.low > a.high) {
        const gapLow = a.high, gapHigh = c.low;
        if ((gapHigh - gapLow) / mid < FVG_MIN_GAP_PCT) continue;
        gaps.push({ type: 'bullish_fvg', index: i + 1, gapLow, gapHigh, createdAt: bars[i + 1]?.date || bars[i + 1]?.timestamp || null, active: true, mitigatedAt: null, mitigation: 0 });
      }
      // Bearish FVG
      else if (c.high < a.low) {
        const gapLow = c.high, gapHigh = a.low;
        if ((gapHigh - gapLow) / mid < FVG_MIN_GAP_PCT) continue;
        gaps.push({ type: 'bearish_fvg', index: i + 1, gapLow, gapHigh, createdAt: bars[i + 1]?.date || bars[i + 1]?.timestamp || null, active: true, mitigatedAt: null, mitigation: 0 });
      }
    }

    // Single O(n) mitigation pass — walk forward from each gap's next bar.
    // Use cursor reuse: sort by index (already sorted), pointer advances only forward.
    for (const g of gaps) {
      for (let j = g.index + 2; j < n; j++) {
        const b = bars[j];
        if (!b) continue;
        // Overlap?
        const lo = Math.max(b.low, g.gapLow);
        const hi = Math.min(b.high, g.gapHigh);
        if (hi <= lo) continue;
        const overlap = hi - lo;
        const size = g.gapHigh - g.gapLow;
        g.mitigation = Math.min(1, (g.mitigation || 0) + overlap / size);
        if (
          (g.type === 'bullish_fvg' && b.low <= g.gapLow) ||
          (g.type === 'bearish_fvg' && b.high >= g.gapHigh) ||
          g.mitigation >= 0.98
        ) {
          g.active = false;
          g.mitigatedAt = b.date || b.timestamp || j;
          break;
        }
      }
    }

    // Return only active, most recent first, capped.
    return gaps.filter(g => g.active).slice(-FVG_MAX_TRACK).reverse();
  }

  // ── Signal validation against active OB zones ──────────────────────
  validateSignal(indicatorSignal, currentPrice, activeOBs) {
    if (indicatorSignal == null || !Number.isFinite(currentPrice)) return this._fallback().lastSignal || { label: 'Neutral', confidence: 0 };
    const obs = Array.isArray(activeOBs) ? activeOBs.filter(o => o && o.active !== false) : [];
    const sig = String(indicatorSignal).toLowerCase();
    const isBuy = sig.includes('buy') || sig === 'al' || sig.includes('bull');
    const isSell = sig.includes('sell') || sig === 'sat' || sig.includes('bear');

    let inBull = null, inBear = null;
    for (const o of obs) {
      if (currentPrice >= o.zoneLow && currentPrice <= o.zoneHigh) {
        if (o.type === 'bullish_ob') inBull = o;
        else if (o.type === 'bearish_ob') inBear = o;
      }
    }

    if (isBuy && inBull)  return { label: 'High Confidence', confidence: 90, reason: 'Buy + Bullish OB teyit', ob: inBull };
    if (isBuy && inBear)  return { label: 'High Risk',       confidence: 25, reason: 'Buy ama Bearish OB icinde — tuzak riski', ob: inBear };
    if (isSell && inBear) return { label: 'High Confidence', confidence: 90, reason: 'Sell + Bearish OB teyit', ob: inBear };
    if (isSell && inBull) return { label: 'High Risk',       confidence: 25, reason: 'Sell ama Bullish OB icinde — yanlis satim', ob: inBull };
    if (isBuy || isSell)  return { label: 'Neutral',         confidence: 55, reason: 'OB zone teyidi yok' };
    return { label: 'Neutral', confidence: 50, reason: 'Belirsiz sinyal' };
  }

  // ── Convenience: run full pass and update internal state ───────────
  // Accepts { bars, mfi, obv, indicatorSignal }. Returns full analysis snapshot.
  analyze({ bars, mfi, obv, indicatorSignal } = {}) {
    if (!bars || !Array.isArray(bars) || bars.length < 10) return this._fallback();

    const bos = this.findBOS(bars);
    let obs = this._state.orderBlocks || [];
    if (bos) {
      const fresh = this.identifyOB(bars, bos.index);
      if (fresh) {
        // keep only recent, still-active OBs (cap 8)
        obs = [fresh, ...obs.filter(o => o && o.ts !== fresh.ts)].slice(0, 8);
      }
    }

    // Invalidate OBs broken through in the wrong direction
    const lastBar = _last(bars);
    if (lastBar) {
      obs = obs.map(o => {
        if (!o.active) return o;
        if (o.type === 'bullish_ob' && lastBar.close < o.zoneLow) return { ...o, active: false, invalidated: 'broke-below' };
        if (o.type === 'bearish_ob' && lastBar.close > o.zoneHigh) return { ...o, active: false, invalidated: 'broke-above' };
        return o;
      });
    }

    const liquidity = this.checkLiquidity(mfi || [], obv || [], bars);
    const fvgs = this.findFVG(bars);
    const price = lastBar ? lastBar.close : null;
    const validation = this.validateSignal(indicatorSignal, price, obs);

    const snapshot = {
      bos,
      orderBlocks: obs,
      fvgs,
      liquidity,
      lastSignal: validation,
      lastPrice: price,
      ts: Date.now(),
    };
    this._state = snapshot;
    return snapshot;
  }

  reset() {
    this._state = { bos: null, orderBlocks: [], fvgs: [], lastSignal: null, lastPrice: null, ts: 0 };
  }
}
