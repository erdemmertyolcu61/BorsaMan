// MomentumScanner.js — Pre-Breakout / Top Gainer scanner.
// Pairs fresh Bullish FVGs with RVOL spikes to flag watchlist candidates.
// Zero deps. Designed to run in a background interval (no UI).

import SMCEngine from './SMC_Logic_Engine.js';

const DEFAULTS = {
  fvgLookback: 5,        // fresh FVG must appear in last N bars
  rvolWindow: 20,        // volume MA window
  rvolMult: 2.5,         // RVOL threshold
  minBars: 30,
  minPrice: 1,           // skip penny floats
  concurrency: 4,
};

function _avg(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i] || 0;
  return s / n;
}

// Score a single symbol's bars. Returns candidate object or null.
export function scoreSymbol(symbol, bars, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!Array.isArray(bars) || bars.length < cfg.minBars) return null;

  const last = bars[bars.length - 1];
  if (!last || last.close < cfg.minPrice) return null;

  // RVOL
  const vols = bars.map(b => b.volume || 0);
  const volMA = _avg(vols, cfg.rvolWindow);
  if (!volMA || volMA <= 0) return null;
  const rvol = (last.volume || 0) / volMA;
  if (rvol < cfg.rvolMult) return null;

  // FVG scan (reuse engine method, avoid re-instantiating state)
  const engine = new SMCEngine();
  const fvgs = engine.findFVG(bars);
  const lastIdx = bars.length - 1;
  const fresh = fvgs.filter(g =>
    g.type === 'bullish_fvg' && g.active && (lastIdx - g.index) <= cfg.fvgLookback
  );
  if (!fresh.length) return null;

  const topFvg = fresh[0]; // most recent (findFVG returns reversed)
  const gapMid = (topFvg.gapHigh + topFvg.gapLow) / 2;
  const distancePct = ((last.close - gapMid) / gapMid) * 100;

  // Simple momentum score (0-100) — boosts for higher RVOL + fresher gap + close above gap
  const freshness = 1 - ((lastIdx - topFvg.index) / cfg.fvgLookback); // 1 = newest
  const rvolScore = Math.min(1, (rvol - cfg.rvolMult) / cfg.rvolMult + 0.5);
  const aboveGap = last.close >= topFvg.gapHigh ? 1 : 0.5;
  const score = Math.round((freshness * 0.35 + rvolScore * 0.45 + aboveGap * 0.20) * 100);

  return {
    symbol: String(symbol || '').toUpperCase(),
    rvol: Number(rvol.toFixed(2)),
    volMA: Math.round(volMA),
    lastVolume: last.volume || 0,
    lastClose: Number(last.close.toFixed(2)),
    fvg: {
      index: topFvg.index,
      barsAgo: lastIdx - topFvg.index,
      gapLow: Number(topFvg.gapLow.toFixed(3)),
      gapHigh: Number(topFvg.gapHigh.toFixed(3)),
      gapMid: Number(gapMid.toFixed(3)),
      sizePct: Number(((topFvg.gapHigh - topFvg.gapLow) / gapMid * 100).toFixed(2)),
    },
    distancePct: Number(distancePct.toFixed(2)),
    score,
    ts: Date.now(),
  };
}

// Bulk scan: takes { SYMBOL: bars[] }. Returns sorted candidates (desc score).
export function scanUniverse(priceMap, opts = {}) {
  const out = [];
  if (!priceMap || typeof priceMap !== 'object') return out;
  for (const [sym, bars] of Object.entries(priceMap)) {
    try {
      const c = scoreSymbol(sym, bars, opts);
      if (c) out.push(c);
    } catch {}
  }
  out.sort((a, b) => b.score - a.score || b.rvol - a.rvol);
  return out;
}

// Async streaming scan with concurrency limit — fetcher(symbol) → Promise<bars>
export async function scanAsync(symbols, fetcher, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const queue = [...(symbols || [])];
  const results = [];

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) return;
      try {
        const bars = await fetcher(sym);
        const c = scoreSymbol(sym, bars, cfg);
        if (c) results.push(c);
      } catch {}
    }
  }

  const workers = Array.from({ length: Math.max(1, cfg.concurrency) }, () => worker());
  await Promise.all(workers);
  results.sort((a, b) => b.score - a.score || b.rvol - a.rvol);
  return results;
}

// Format for JARVIS / AlertLog consumption
export function formatCandidates(candidates, topN = 10) {
  const list = (candidates || []).slice(0, topN);
  return {
    generatedAt: new Date().toISOString(),
    count: list.length,
    candidates: list.map(c => ({
      symbol: c.symbol,
      score: c.score,
      rvol: c.rvol,
      lastClose: c.lastClose,
      gap: `${c.fvg.gapLow} — ${c.fvg.gapHigh}`,
      gapSizePct: c.fvg.sizePct,
      barsAgo: c.fvg.barsAgo,
      trigger: c.lastClose >= c.fvg.gapHigh ? 'ABOVE_GAP' : 'IN_GAP',
    })),
    ragContext: list.length
      ? `PRE-BREAKOUT ADAYLARI (${list.length}):\n` +
        list.map((c, i) => `${i + 1}. ${c.symbol} — skor ${c.score}, RVOL ${c.rvol}x, FVG ${c.fvg.gapLow}-${c.fvg.gapHigh} (${c.fvg.barsAgo} bar once), son ${c.lastClose}`).join('\n')
      : 'PRE-BREAKOUT ADAYLARI: sinyal yok.',
  };
}

export default {
  scoreSymbol,
  scanUniverse,
  scanAsync,
  formatCandidates,
};
