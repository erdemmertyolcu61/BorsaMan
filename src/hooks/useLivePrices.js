import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchBigParaQuote } from '../utils/fetchEngine.js';

const POLL_INTERVAL_MS = 30_000;     // 30 seconds — live quote refresh
const STOP_CHECK_INTERVAL_MS = 20_000; // dedicated stop/target poll (20s)
const MARKET_OPEN_HOUR = 9;          // start at 09:55 so we catch opening auction
const MARKET_OPEN_MIN = 55;
const MARKET_CLOSE_HOUR = 18;        // stops at 18:10
const MARKET_CLOSE_MIN = 10;
const TRAIL_BREAKEVEN_PCT = 3;       // move stop to breakeven at +3%
const TRAIL_ACTIVE_PCT = 5;          // 50% trail starts at +5%
const TRAIL_LOCK_FRACTION = 0.5;     // trail locks 50% of profit

function isWithinMarketHours(d = new Date()) {
  const day = d.getDay();
  if (day < 1 || day > 5) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  const open = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
  const close = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
  return t >= open && t <= close;
}

// Fire a desktop push notification via Electron IPC (no-op in browser)
function pushDesktopAlert({ title, message, urgency = 'normal', symbol }) {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.notifications?.alert) {
      window.electronAPI.notifications.alert({
        id: `risk-${symbol}-${Date.now()}`,
        type: urgency === 'critical' ? 'critical' : 'warning',
        title, message,
        urgency, silent: false,
      });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
  } catch {}
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

/**
 * useLivePrices
 * Polls BigPara every 30s for portfolio+watchlist symbols during market hours.
 * - Auto-checks stop-loss / target levels and closes positions
 * - Trails stops: breakeven at +3%, 50%-lock at +5%
 * - Fires watchlist price alarms into alertLog
 */
export function useLivePrices(portfolio, updatePortfolio, watchlist, alertLog) {
  const [livePrices, setLivePrices] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [isPolling, setIsPolling] = useState(false);

  const firedAlarmsRef = useRef(new Set());  // key: symbol|op|price
  const tickRef = useRef(0);

  // Refs mirror volatile deps so the polling effect doesn't tear down/re-create
  // on every portfolio/watchlist identity change (prevents timer leak + duplicate fetches).
  const portfolioRef = useRef(portfolio);
  const watchlistRef = useRef(watchlist);
  const updatePortfolioRef = useRef(updatePortfolio);
  const alertLogRef = useRef(alertLog);
  useEffect(() => { portfolioRef.current = portfolio; }, [portfolio]);
  useEffect(() => { watchlistRef.current = watchlist; }, [watchlist]);
  useEffect(() => { updatePortfolioRef.current = updatePortfolio; }, [updatePortfolio]);
  useEffect(() => { alertLogRef.current = alertLog; }, [alertLog]);

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

  // Build the list of symbols to poll (reads via refs → stable identity)
  const buildSymbolList = useCallback(() => {
    const syms = [];
    const pf = portfolioRef.current;
    const wl = watchlistRef.current;
    if (pf?.positions) {
      for (const p of pf.positions) {
        if (p.status === 'open' && p.symbol) syms.push(p.symbol);
      }
    }
    if (Array.isArray(wl)) {
      for (const w of wl) {
        const s = typeof w === 'string' ? w : w?.symbol;
        if (s) syms.push(s);
      }
    }
    return uniq(syms).map(s => s.replace('.IS', '').toUpperCase());
  }, []);

  // ── Auto close stop/target + trailing logic ──
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

    // Stop-loss hit
    if (pos.stopLoss && price <= pos.stopLoss) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id
            ? { ...p, status: 'closed', closePrice: price, closeReason: 'stop-loss', closedAt: new Date().toISOString() }
            : p
        ),
      });
      alertLog?.addAlert?.({
        type: 'error',
        source: 'live_guard',
        symbol,
        message: `STOP — ${symbol} ${price.toFixed(2)} TL (stop ${pos.stopLoss.toFixed(2)})`,
      });
      pushDesktopAlert({
        title: `🚨 STOP TETIKLENDI — ${symbol}`,
        message: `${symbol} fiyati ${price.toFixed(2)} TL'ye dustu. Stop ${pos.stopLoss.toFixed(2)} TL otomatik kapatildi.`,
        urgency: 'critical', symbol,
      });
      return;
    }

    // Target hit
    if (pos.target && price >= pos.target) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id
            ? { ...p, status: 'closed', closePrice: price, closeReason: 'target', closedAt: new Date().toISOString() }
            : p
        ),
      });
      alertLog?.addAlert?.({
        type: 'success',
        source: 'live_guard',
        symbol,
        message: `HEDEF — ${symbol} ${price.toFixed(2)} TL`,
      });
      pushDesktopAlert({
        title: `🎯 HEDEF ULASILDI — ${symbol}`,
        message: `${symbol} fiyati ${price.toFixed(2)} TL (hedef ${pos.target.toFixed(2)}). Pozisyon karla kapatildi.`,
        urgency: 'critical', symbol,
      });
      return;
    }

    // Near-stop warning (within 2% of stop, not yet triggered)
    if (pos.stopLoss && price > pos.stopLoss) {
      const proximity = ((price - pos.stopLoss) / pos.stopLoss) * 100;
      if (proximity <= 2) {
        const warnKey = `near-stop|${pos.id}`;
        if (!firedAlarmsRef.current.has(warnKey)) {
          firedAlarmsRef.current.add(warnKey);
          setTimeout(() => firedAlarmsRef.current.delete(warnKey), 15 * 60 * 1000); // re-arm after 15min
          alertLog?.addAlert?.({
            type: 'warn', source: 'live_guard', symbol,
            message: `STOP YAKIN — ${symbol} ${price.toFixed(2)} TL, stop ${pos.stopLoss.toFixed(2)} (%${proximity.toFixed(1)} uzakta)`,
          });
          pushDesktopAlert({
            title: `⚠️ STOP YAKINDA — ${symbol}`,
            message: `${symbol} stop seviyesine %${proximity.toFixed(1)} uzakta. Fiyat ${price.toFixed(2)}.`,
            urgency: 'normal', symbol,
          });
        }
      }
    }

    // Trailing stop logic
    let newStop = pos.stopLoss;
    if (gainPct >= TRAIL_ACTIVE_PCT) {
      // Lock 50% of current profit
      const lockedStop = entry + ((price - entry) * TRAIL_LOCK_FRACTION);
      if (lockedStop > (newStop ?? -Infinity)) newStop = lockedStop;
    } else if (gainPct >= TRAIL_BREAKEVEN_PCT) {
      if (entry > (newStop ?? -Infinity)) newStop = entry;
    }

    const stopBase = pos.stopLoss ?? newStop ?? 1;
    if (newStop && Math.abs((newStop - (pos.stopLoss ?? 0)) / stopBase) > 0.001 && newStop > (pos.stopLoss ?? -Infinity)) {
      updatePortfolio({
        ...portfolio,
        positions: portfolio.positions.map(p =>
          p.id === pos.id ? { ...p, stopLoss: newStop, trailingActive: true } : p
        ),
      });
      alertLog?.addAlert?.({
        type: 'info',
        source: 'live_guard',
        symbol,
        message: `Trailing stop ${symbol} → ${newStop.toFixed(2)} TL (kar %${gainPct.toFixed(1)})`,
      });
    }
  }, []);

  // ── Watchlist alarm checks ──
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

        const trip =
          (a.op === 'above' && price >= a.price) ||
          (a.op === 'below' && price <= a.price);
        if (trip) {
          firedAlarmsRef.current.add(key);
          alertLog?.addAlert?.({
            type: 'warn',
            source: 'watchlist',
            symbol,
            message: `ALARM — ${symbol} fiyat ${price.toFixed(2)} TL (hedef ${a.op === 'above' ? '≥' : '≤'} ${a.price})`,
          });
        }
      }
    }
  }, []);

  const pollOnce = useCallback(async () => {
    const symbols = buildSymbolList();
    if (!symbols.length) return;
    setIsPolling(true);
    try {
      await Promise.all(symbols.map(async (s) => {
        try {
          const q = await fetchBigParaQuote(s);
          if (!q || !q.price) return;
          updateLivePrice(s, q);
          runRiskChecks(s, q.price);
          runWatchlistAlarms(s, q.price);
        } catch {}
      }));
    } finally {
      setIsPolling(false);
    }
  }, [buildSymbolList, updateLivePrice, runRiskChecks, runWatchlistAlarms]);

  // Initialize prices from portfolio entry/watchlist at mount
  useEffect(() => {
    const initial = {};
    portfolio?.positions?.forEach(p => {
      if (p.status === 'open' && p.symbol) {
        initial[p.symbol] = {
          price: p.entryPrice ?? p.avgPrice ?? 0,
          timestamp: Date.now(),
          change: 0,
        };
      }
    });
    watchlist?.forEach(w => {
      const s = typeof w === 'string' ? w : w?.symbol;
      if (s && !initial[s]) {
        initial[s] = { price: w?.price || 0, timestamp: Date.now(), change: 0 };
      }
    });
    setLivePrices(prev => ({ ...initial, ...prev }));
  }, [portfolio?.positions?.length, watchlist?.length]);

  // Stable ref for pollOnce so the polling effect below mounts exactly once.
  const pollOnceRef = useRef(pollOnce);
  useEffect(() => { pollOnceRef.current = pollOnce; }, [pollOnce]);

  // Start polling loop — mount-once, guaranteed single active timer, reentrancy-safe.
  useEffect(() => {
    let timer = null;
    let mounted = true;
    let inFlight = false;

    const tick = async () => {
      if (!mounted) return;
      tickRef.current += 1;
      if (!inFlight && isWithinMarketHours()) {
        inFlight = true;
        try { await pollOnceRef.current?.(); }
        finally { inFlight = false; }
      }
      if (!mounted) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();

    return () => {
      mounted = false;
      if (timer) { clearTimeout(timer); timer = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    livePrices,
    lastUpdate,
    isPolling,
    updateLivePrice,
    pollOnce,
    marketOpen: isWithinMarketHours(),
  };
}
