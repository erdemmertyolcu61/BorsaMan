import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchBigParaQuote, fetchBiquoteLatest } from '../utils/fetchEngine.js';

// ============================================================
// TIERED ADAPTIVE LIVE-PRICE ENGINE (v11)
// ------------------------------------------------------------
// BIST has no public WebSocket — we simulate WS-grade freshness
// with three polling tiers and intelligent escalation:
//   - FAST   (5s): symbols within 1.5% of stop/target ("burst")
//   - NORMAL (15s): open positions
//   - SLOW   (45s): watchlist & non-positioned symbols
// Plus:
//   - Page Visibility API: pauses all polling when tab hidden
//   - Batch quote fetch: fetchBiquoteLatest if available
//   - Re-arm: a symbol that escalated to FAST drops back to NORMAL
//     once the gap re-widens, capping the load on free CORS proxies.
// ============================================================

const TIER_FAST_MS = 5_000;
const TIER_NORMAL_MS = 15_000;
const TIER_SLOW_MS = 45_000;
const BURST_PROXIMITY_PCT = 1.5; // escalate to FAST when within 1.5% of stop/target

const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 55;
const MARKET_CLOSE_HOUR = 18;
const MARKET_CLOSE_MIN = 10;
const TRAIL_BREAKEVEN_PCT = 3;
const TRAIL_ACTIVE_PCT = 5;
const TRAIL_LOCK_FRACTION = 0.5;

function isWithinMarketHours(d = new Date()) {
  const day = d.getDay();
  if (day < 1 || day > 5) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  const open = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
  const close = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
  return t >= open && t <= close;
}

function isTabVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function pushDesktopAlert({ title, message, urgency = 'normal', symbol }) {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.notifications?.alert) {
      window.electronAPI.notifications.alert({
        id: `risk-${symbol}-${Date.now()}`,
        type: urgency === 'critical' ? 'critical' : 'warning',
        title, message, urgency, silent: false,
      });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
  } catch {}
}

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }

/**
 * Compute the polling tier for a single symbol.
 * Burst (FAST) when fiyat stop'a veya hedefe %1.5'tan yakin.
 * NORMAL for any open position. SLOW otherwise.
 */
function classifyTier(symbol, lastPrice, position) {
  if (position && lastPrice) {
    const stop = position.stopLoss, target = position.target;
    const distStop = stop ? Math.abs(lastPrice - stop) / lastPrice * 100 : Infinity;
    const distTarget = target ? Math.abs(lastPrice - target) / lastPrice * 100 : Infinity;
    if (Math.min(distStop, distTarget) <= BURST_PROXIMITY_PCT) return 'fast';
    return 'normal';
  }
  return 'slow';
}

export function useLivePrices(portfolio, updatePortfolio, watchlist, alertLog) {
  const [livePrices, setLivePrices] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isPolling, setIsPolling] = useState(false);
  const [tierStats, setTierStats] = useState({ fast: 0, normal: 0, slow: 0 });

  const firedAlarmsRef = useRef(new Set());
  const portfolioRef = useRef(portfolio);
  const watchlistRef = useRef(watchlist);
  const updatePortfolioRef = useRef(updatePortfolio);
  const alertLogRef = useRef(alertLog);
  const livePricesRef = useRef(livePrices);
  useEffect(() => { portfolioRef.current = portfolio; }, [portfolio]);
  useEffect(() => { watchlistRef.current = watchlist; }, [watchlist]);
  useEffect(() => { updatePortfolioRef.current = updatePortfolio; }, [updatePortfolio]);
  useEffect(() => { alertLogRef.current = alertLog; }, [alertLog]);
  useEffect(() => { livePricesRef.current = livePrices; }, [livePrices]);

  const updateLivePrice = useCallback((symbol, quote) => {
    const now = Date.now();
    setLivePrices(prev => {
      const prior = prev[symbol];
      const price = typeof quote === 'number' ? quote : quote?.price;
      if (price == null || !Number.isFinite(price)) return prev;
      return {
        ...prev,
        [symbol]: {
          price,
          open: quote?.open ?? prior?.open,
          high: quote?.high ?? prior?.high,
          low: quote?.low ?? prior?.low,
          volume: quote?.volume ?? prior?.volume,
          change: quote?.change ?? (prior?.price ? ((price - prior.price) / prior.price) * 100 : 0),
          prevClose: quote?.prevClose ?? prior?.prevClose,
          timestamp: now,
        },
      };
    });
    setLastUpdate(new Date(now));
  }, []);

  // ── Build tier-bucketed symbol lists ─────────────────────────
  const buildTieredSymbols = useCallback(() => {
    const fast = [], normal = [], slow = [];
    const pf = portfolioRef.current;
    const wl = watchlistRef.current;
    const lp = livePricesRef.current;

    if (pf?.positions) {
      for (const p of pf.positions) {
        if (p.status !== 'open' || !p.symbol) continue;
        const sym = p.symbol.replace('.IS', '').toUpperCase();
        const lastPrice = lp[sym]?.price ?? p.entryPrice ?? p.avgPrice;
        const tier = classifyTier(sym, lastPrice, p);
        if (tier === 'fast') fast.push(sym);
        else normal.push(sym);
      }
    }
    if (Array.isArray(wl)) {
      for (const w of wl) {
        const s = typeof w === 'string' ? w : w?.symbol;
        if (!s) continue;
        const sym = s.replace('.IS', '').toUpperCase();
        if (fast.includes(sym) || normal.includes(sym)) continue;
        slow.push(sym);
      }
    }
    return {
      fast: uniq(fast),
      normal: uniq(normal),
      slow: uniq(slow),
    };
  }, []);

  // ── Risk checks (stop/target/trailing) ───────────────────────
  const runRiskChecks = useCallback((symbol, price) => {
    const portfolio = portfolioRef.current;
    const updatePortfolio = updatePortfolioRef.current;
    const alertLog = alertLogRef.current;
    if (!updatePortfolio || !portfolio?.positions) return;
    const pos = portfolio.positions.find(p => p.status === 'open' && p.symbol === symbol);
    if (!pos) return;

    const entry = pos.entryPrice ?? pos.avgPrice ?? pos.price;
    if (!entry) return;
    const gainPct = ((price - entry) / entry) * 100;

    if (pos.stopLoss && price <= pos.stopLoss) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id
            ? { ...p, status: 'closed', closePrice: price, closeReason: 'stop-loss', closedAt: new Date().toISOString() }
            : p
        ),
      });
      alertLog?.addAlert?.({ type: 'error', source: 'live_guard', symbol,
        message: `STOP — ${symbol} ${price.toFixed(2)} TL (stop ${pos.stopLoss.toFixed(2)})` });
      pushDesktopAlert({
        title: `🚨 STOP TETIKLENDI — ${symbol}`,
        message: `${symbol} fiyati ${price.toFixed(2)} TL'ye dustu. Stop ${pos.stopLoss.toFixed(2)} TL otomatik kapatildi.`,
        urgency: 'critical', symbol });
      return;
    }

    if (pos.target && price >= pos.target) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id
            ? { ...p, status: 'closed', closePrice: price, closeReason: 'target', closedAt: new Date().toISOString() }
            : p
        ),
      });
      alertLog?.addAlert?.({ type: 'success', source: 'live_guard', symbol,
        message: `HEDEF — ${symbol} ${price.toFixed(2)} TL` });
      pushDesktopAlert({
        title: `🎯 HEDEF ULASILDI — ${symbol}`,
        message: `${symbol} fiyati ${price.toFixed(2)} TL (hedef ${pos.target.toFixed(2)}). Pozisyon karla kapatildi.`,
        urgency: 'critical', symbol });
      return;
    }

    if (pos.stopLoss && price > pos.stopLoss) {
      const proximity = ((price - pos.stopLoss) / price) * 100;
      if (proximity <= 2) {
        const warnKey = `near-stop|${pos.id}`;
        if (!firedAlarmsRef.current.has(warnKey)) {
          firedAlarmsRef.current.add(warnKey);
          setTimeout(() => firedAlarmsRef.current.delete(warnKey), 15 * 60 * 1000);
          alertLog?.addAlert?.({ type: 'warn', source: 'live_guard', symbol,
            message: `STOP YAKIN — ${symbol} ${price.toFixed(2)} TL, stop ${pos.stopLoss.toFixed(2)} (%${proximity.toFixed(1)} uzakta)` });
          pushDesktopAlert({
            title: `⚠️ STOP YAKINDA — ${symbol}`,
            message: `${symbol} stop seviyesine %${proximity.toFixed(1)} uzakta. Fiyat ${price.toFixed(2)}.`,
            urgency: 'normal', symbol });
        }
      }
    }

    let newStop = pos.stopLoss;
    if (gainPct >= TRAIL_ACTIVE_PCT) {
      const lockedStop = entry + ((price - entry) * TRAIL_LOCK_FRACTION);
      if (lockedStop > (newStop ?? -Infinity)) newStop = lockedStop;
    } else if (gainPct >= TRAIL_BREAKEVEN_PCT) {
      if (entry > (newStop ?? -Infinity)) newStop = entry;
    }

    if (newStop && Math.abs((newStop - (pos.stopLoss ?? 0))) > 1e-4 && newStop > (pos.stopLoss ?? -Infinity)) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id ? { ...p, stopLoss: newStop, trailingActive: true } : p
        ),
      });
      alertLog?.addAlert?.({ type: 'info', source: 'live_guard', symbol,
        message: `Trailing stop ${symbol} → ${newStop.toFixed(2)} TL (kar %${gainPct.toFixed(1)})` });
    }
  }, []);

  const runWatchlistAlarms = useCallback((symbol, price) => {
    const watchlist = watchlistRef.current;
    const alertLog = alertLogRef.current;
    if (!Array.isArray(watchlist)) return;
    for (const w of watchlist) {
      if (typeof w !== 'object' || w.symbol !== symbol) continue;
      const alarms = w.alarms || (w.targetPrice ? [{ op: 'above', price: w.targetPrice }] : []);
      for (const a of alarms) {
        if (a.price == null) continue;
        const key = `${symbol}|${a.op}|${a.price}`;
        if (firedAlarmsRef.current.has(key)) continue;
        const trip = (a.op === 'above' && price >= a.price) || (a.op === 'below' && price <= a.price);
        if (trip) {
          firedAlarmsRef.current.add(key);
          alertLog?.addAlert?.({ type: 'warn', source: 'watchlist', symbol,
            message: `ALARM — ${symbol} fiyat ${price.toFixed(2)} TL (hedef ${a.op === 'above' ? '≥' : '≤'} ${a.price})` });
        }
      }
    }
  }, []);

  // ── Batch fetcher: tries fetchBiquoteLatest first, falls back per-symbol ──
  const fetchTier = useCallback(async (symbols) => {
    if (!symbols.length) return;
    let quoteMap = {};
    try {
      const batch = await fetchBiquoteLatest(symbols);
      if (batch?.length) {
        for (const q of batch) if (q?.symbol && q.price) quoteMap[q.symbol] = q;
      }
    } catch {}
    const missing = symbols.filter(s => !quoteMap[s]);
    if (missing.length) {
      await Promise.all(missing.map(async (s) => {
        try {
          const q = await fetchBigParaQuote(s);
          if (q?.price) quoteMap[s] = q;
        } catch {}
      }));
    }
    for (const s of symbols) {
      const q = quoteMap[s];
      if (!q?.price) continue;
      updateLivePrice(s, q);
      runRiskChecks(s, q.price);
      runWatchlistAlarms(s, q.price);
    }
  }, [updateLivePrice, runRiskChecks, runWatchlistAlarms]);

  // Initialize from portfolio/watchlist at mount
  useEffect(() => {
    const initial = {};
    portfolio?.positions?.forEach(p => {
      if (p.status === 'open' && p.symbol) {
        initial[p.symbol] = { price: p.entryPrice ?? p.avgPrice ?? 0, timestamp: Date.now(), change: 0 };
      }
    });
    watchlist?.forEach(w => {
      const s = typeof w === 'string' ? w : w?.symbol;
      if (s && !initial[s]) initial[s] = { price: w?.price || 0, timestamp: Date.now(), change: 0 };
    });
    setLivePrices(prev => ({ ...initial, ...prev }));
  }, [portfolio?.positions?.length, watchlist?.length]);

  // ── Three independent polling timers (one per tier) ──────────
  useEffect(() => {
    let mounted = true;
    const inFlight = { fast: false, normal: false, slow: false };
    const timers = { fast: null, normal: null, slow: null };

    const pollTier = async (tier) => {
      if (!mounted) return;
      // Pause when market closed OR tab hidden
      const gated = !isWithinMarketHours() || !isTabVisible();
      if (!gated && !inFlight[tier]) {
        const buckets = buildTieredSymbols();
        const list = buckets[tier];
        setTierStats({ fast: buckets.fast.length, normal: buckets.normal.length, slow: buckets.slow.length });
        if (list?.length) {
          inFlight[tier] = true;
          setIsPolling(true);
          try { await fetchTier(list); }
          finally { inFlight[tier] = false; setIsPolling(false); }
        }
      }
      if (!mounted) return;
      const intervalMs = tier === 'fast' ? TIER_FAST_MS : tier === 'normal' ? TIER_NORMAL_MS : TIER_SLOW_MS;
      timers[tier] = setTimeout(() => pollTier(tier), intervalMs);
    };

    pollTier('fast');
    pollTier('normal');
    pollTier('slow');

    // Resume immediately when tab becomes visible
    const onVis = () => {
      if (isTabVisible() && isWithinMarketHours()) {
        // kick a fast-tier poll to refresh quickly
        pollTier('fast');
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }

    return () => {
      mounted = false;
      for (const t of Object.keys(timers)) {
        if (timers[t]) { clearTimeout(timers[t]); timers[t] = null; }
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
    };
  }, [buildTieredSymbols, fetchTier]);

  // Manual one-shot refresh of all tiers
  const pollOnce = useCallback(async () => {
    const buckets = buildTieredSymbols();
    const all = uniq([...buckets.fast, ...buckets.normal, ...buckets.slow]);
    if (all.length) await fetchTier(all);
  }, [buildTieredSymbols, fetchTier]);

  return {
    livePrices,
    lastUpdate,
    isPolling,
    tierStats,
    updateLivePrice,
    pollOnce,
    marketOpen: isWithinMarketHours(),
  };
}
