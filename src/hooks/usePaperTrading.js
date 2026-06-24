/**
 * usePaperTrading — Phase 8: Real-time Paper Trading Simulation
 *
 * Backtest = hafta sonu laboratuari (hangi parametreler calisiyor kanitlar).
 * Paper trading = bu parametreleri canli piyasada dogrular. Hicbir gercek para yok.
 *
 * Akis:
 *   1. AI Advisor scan tamamlandiginda `advisor-scan-complete` CustomEvent'i dinler
 *   2. Auto-trade aciksa confidence >= MIN_CONFIDENCE olan AL sinyallerini otomatik girer
 *   3. Her 30 saniyede BigPara batch ile canli fiyat kontrolu yapar
 *   4. Stop/hedef vurunca pozisyonu otomatik kapatir
 *   5. Performans metriklerini hesaplar (winRate, expectancy, maxDD, Sharpe)
 *   6. Phase 9 icin: `paper-trade-performance` CustomEvent dispatch eder (parametre bridge)
 *
 * Strateji parametreleri (backtest sonuclariyla eslestirilecek):
 *   - MIN_CONFIDENCE: GOOD (65) | STRONG (75) | FAIR (55)
 *   - RISK_PER_TRADE: %1-3 risk per position
 *   - MAX_POSITION_PCT: max tek pozisyon buyuklugu
 *   - stopMultiplier: ATR stop agresiflik
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchBigParaBatchPrices } from '../utils/fetchEngine.js';
import { isMarketOpen } from './useAIAdvisor.js';

// ── Konfigurasyon (Phase 9'da backtest sonuclari ile auto-tune edilecek) ──
const STORAGE_KEY     = 'bist_paper_trading_v1';
const START_CAPITAL   = 100_000;     // 100K TL paper kapital
const RISK_PER_TRADE  = 0.02;        // %2 risk per pozisyon
const MAX_POS_PCT     = 0.15;        // Max tek pozisyon %15 kapital
const MAX_POSITIONS   = 8;           // Max esanlik acik pozisyon
const MIN_CONFIDENCE  = 65;          // GOOD tier minimum (backtest ile tune edilebilir)
const MAX_CLOSED      = 500;         // Maks kapali islem gecmisi
const MONITOR_MS      = 30_000;      // 30s fiyat kontrolu
const MIN_POS_TL      = 2_000;       // Min 2K TL pozisyon (slipaj riski)
const MAX_EQUITY_PTS  = 200;         // Equity curve point sayisi

// ── localStorage yardimcilari ──
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

function freshState() {
  return {
    capital: START_CAPITAL,
    startCapital: START_CAPITAL,
    startDate: new Date().toISOString(),
    positions: [],
    closedTrades: [],
    autoTrade: false,
    equityCurve: [{ ts: Date.now(), value: START_CAPITAL }],
    config: {
      minConfidence: MIN_CONFIDENCE,
      riskPerTrade: RISK_PER_TRADE,
      maxPosPct: MAX_POS_PCT,
      maxPositions: MAX_POSITIONS,
    },
  };
}

function initialState() {
  const saved = loadState();
  if (!saved) return freshState();
  // Merge saved config with defaults (backward compat)
  return {
    ...freshState(),
    ...saved,
    config: { ...freshState().config, ...(saved.config || {}) },
  };
}

// ── Performans hesaplayici (pure function) ──
function calcPerformance(state) {
  const closed = state.closedTrades || [];
  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);

  const totalPnl     = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate      = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgWinPct    = wins.length   ? wins.reduce((s, t) => s + (t.pnlPct || 0), 0) / wins.length : 0;
  const avgLossPct   = losses.length ? losses.reduce((s, t) => s + (t.pnlPct || 0), 0) / losses.length : 0;
  const expectancy   = (winRate / 100) * avgWinPct + (1 - winRate / 100) * avgLossPct;
  const profitFactor = losses.reduce((s, t) => s + Math.abs(t.pnl), 0) > 0
    ? wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + Math.abs(t.pnl), 0)
    : wins.length ? Infinity : 0;

  // Mevcut open pozisyonlarin unrealized equity
  const unrealizedPnl = (state.positions || []).reduce((s, p) => {
    const cp = p.currentPrice || p.entry;
    return s + (cp - p.entry) / p.entry * p.size;
  }, 0);
  const openSize = (state.positions || []).reduce((s, p) => s + (p.size || 0), 0);
  const totalEquity = state.capital + openSize + unrealizedPnl;

  // Max drawdown (equity curve uzerinden)
  let peak = state.startCapital;
  let maxDD = 0;
  for (const pt of state.equityCurve || []) {
    if (pt.value > peak) peak = pt.value;
    const dd = peak > 0 ? (peak - pt.value) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (simplified — returns vs 0 RF, daily-ish)
  const returns = (state.equityCurve || []).slice(1).map((pt, i) => {
    const prev = state.equityCurve[i];
    return prev?.value > 0 ? (pt.value - prev.value) / prev.value : 0;
  });
  const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    totalPnl,
    totalPnlPct: state.startCapital > 0 ? (totalPnl / state.startCapital) * 100 : 0,
    winRate,
    totalTrades: closed.length,
    openTrades: (state.positions || []).length,
    wins: wins.length,
    losses: losses.length,
    avgWinPct,
    avgLossPct,
    expectancy,
    profitFactor,
    maxDD,
    sharpe: isFinite(sharpe) ? sharpe : 0,
    totalEquity,
    totalEquityPct: state.startCapital > 0 ? (totalEquity - state.startCapital) / state.startCapital * 100 : 0,
    unrealizedPnl,
    // Streak
    currentStreak: (() => {
      let streak = 0;
      for (let i = 0; i < closed.length; i++) {
        const isWin = closed[i].pnl > 0;
        if (i === 0) { streak = isWin ? 1 : -1; continue; }
        const lastWin = closed[i - 1].pnl > 0;
        if (isWin === lastWin) streak = isWin ? streak + 1 : streak - 1;
        else break;
      }
      return streak;
    })(),
  };
}

export function usePaperTrading() {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist on every state change
  useEffect(() => { saveState(state); }, [state]);

  // ── Pozisyon ac ──
  const openPosition = useCallback((pick) => {
    setState(prev => {
      const cfg = prev.config;
      const existingSyms = new Set(prev.positions.map(p => p.symbol));

      // Guard: max pozisyon / duplicate
      if (prev.positions.length >= (cfg.maxPositions || MAX_POSITIONS)) return prev;
      if (existingSyms.has(pick.symbol)) return prev;

      const entry  = pick.price || pick.entry;
      if (!entry || entry <= 0) return prev;

      const stop   = pick.stop   || entry * 0.95;
      const target = pick.target || entry * 1.10;
      const stopPct = Math.max(0.005, Math.abs(entry - stop) / entry);

      // Risk-based position sizing
      const riskAmount  = prev.capital * (cfg.riskPerTrade || RISK_PER_TRADE);
      const maxPosTL    = prev.capital * (cfg.maxPosPct || MAX_POS_PCT);
      const positionTL  = Math.min(maxPosTL, riskAmount / stopPct);

      if (positionTL < MIN_POS_TL) return prev;
      if (positionTL > prev.capital) return prev;

      const position = {
        id: Date.now() + Math.random(),
        symbol:  pick.symbol,
        sector:  pick.sector || '',
        entry,
        stop,
        target,
        currentPrice: entry,
        size: Math.round(positionTL * 100) / 100,
        openedAt: new Date().toISOString(),
        signal:     pick.signal || '',
        cls:        pick.cls || 'buy',
        score:      pick.score || 0,
        confidence: pick.confidence || 0,
        grade:      pick.grade || '',
        tier:       pick.tier || '',
        rr:         pick.rr || 0,
        _earlyPick: pick._earlyPick || false,
        recentPump: pick.recentPump || 0,
        source:     pick._source || 'advisor',
        // Signal Attribution: trade acilirken hangi sinyaller ateslemisti?
        // Kapaninca bySignalType win-rate'ini guncellemek icin kullanilir.
        firedSignals: Array.isArray(pick.firedSignals) ? pick.firedSignals : [],
      };

      return {
        ...prev,
        capital: prev.capital - position.size,
        positions: [...prev.positions, position],
      };
    });
  }, []);

  // ── Pozisyon kapat ──
  const closePosition = useCallback((symbol, reason, exitPrice) => {
    setState(prev => {
      const pos = prev.positions.find(p => p.symbol === symbol);
      if (!pos) return prev;

      const price  = exitPrice || pos.currentPrice || pos.entry;
      const pnl    = (price - pos.entry) / pos.entry * pos.size;
      const pnlPct = (price - pos.entry) / pos.entry * 100;
      const held   = Date.now() - new Date(pos.openedAt).getTime();

      const closed = {
        ...pos,
        exit: price,
        exitReason: reason,  // 'STOP' | 'TARGET' | 'MANUAL' | 'EOD'
        closedAt: new Date().toISOString(),
        heldMs: held,
        pnl:    Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
      };

      const newCapital = prev.capital + pos.size + pnl;
      const newClosed  = [closed, ...prev.closedTrades].slice(0, MAX_CLOSED);

      // Equity curve guncelle
      const newOpenSize = prev.positions
        .filter(p => p.symbol !== symbol)
        .reduce((s, p) => s + p.size + ((p.currentPrice || p.entry) - p.entry) / p.entry * p.size, 0);
      const newEquityVal = newCapital + newOpenSize;
      const newCurve = [
        ...prev.equityCurve,
        { ts: Date.now(), value: Math.round(newEquityVal * 100) / 100, trade: closed.symbol, pnlPct },
      ].slice(-MAX_EQUITY_PTS);

      // Phase 9 bridge: performans eventini dispatch et
      const perfSnap = calcPerformance({ ...prev, capital: newCapital, positions: prev.positions.filter(p => p.symbol !== symbol), closedTrades: newClosed, equityCurve: newCurve });
      window.dispatchEvent(new CustomEvent('paper-trade-performance', { detail: { ...perfSnap, lastTrade: closed } }));

      return {
        ...prev,
        capital:      newCapital,
        positions:    prev.positions.filter(p => p.symbol !== symbol),
        closedTrades: newClosed,
        equityCurve:  newCurve,
      };
    });
  }, []);

  // ── Canli fiyat guncelleme + stop/target kontrolu ──
  const monitorRef = useRef(false);
  useEffect(() => {
    const monitor = async () => {
      if (monitorRef.current) return;
      const positions = stateRef.current.positions;
      if (!positions.length) return;

      monitorRef.current = true;
      try {
        const prices = await fetchBigParaBatchPrices();
        if (!prices || Object.keys(prices).length === 0) return;

        // Once fiyatlari guncelle
        setState(prev => {
          const updated = prev.positions.map(pos => {
            const live = prices[pos.symbol];
            if (!live?.price) return pos;
            return { ...pos, currentPrice: live.price };
          });
          return { ...prev, positions: updated };
        });

        // Sonra stop/target kontrolu (state guncellendikten sonra)
        setTimeout(() => {
          const { positions: current } = stateRef.current;
          for (const pos of current) {
            const live = prices[pos.symbol];
            if (!live?.price) continue;
            if (live.price <= pos.stop)   closePosition(pos.symbol, 'STOP',   live.price);
            else if (live.price >= pos.target) closePosition(pos.symbol, 'TARGET', live.price);
          }
        }, 100);
      } finally {
        monitorRef.current = false;
      }
    };

    const interval = setInterval(monitor, MONITOR_MS);
    return () => clearInterval(interval);
  }, [closePosition]);

  // ── Advisor scan tamamlandiginda TOP 5'i otomatik al ──
  // v25: User talep — "ilk 5 hisseyi direkt alarak islemleri denesin"
  // Confidence filter kaldirildi (sadece cls='buy' yeterli) ve limit 2 → 5 yapildi.
  useEffect(() => {
    const handler = (e) => {
      // topPicks = UI'da gosterilen hisseler, advisor sirasiyla.
      // results (ham tarama verisi) KULLANMA — bu 600+ sembol icerir, UI goruntusunu yansiitmaz.
      const picks = (e.detail || {}).topPicks || [];
      if (!picks?.length) return;

      const { autoTrade } = stateRef.current;
      if (!autoTrade) return;

      const existingSyms = new Set(stateRef.current.positions.map(p => p.symbol));

      // Advisor'in gosterdigi sirayi koru — ilk 5 buy pick'i sirayla al
      const eligible = picks.filter(p => p && p.cls === 'buy' && p.symbol && !existingSyms.has(p.symbol));
      const topFive = eligible.slice(0, 5);
      console.log(`[PaperTrading] Auto-trading TOP 5 (advisor order):`,
        topFive.map(p => ({ sym: p.symbol, conf: p.confidence })));

      for (const pick of topFive) {
        openPosition({ ...pick, _source: 'advisor_auto' });
      }
    };

    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, [openPosition]);

  // ── Manuel kontroller ──
  const toggleAutoTrade = useCallback(() => {
    setState(prev => ({ ...prev, autoTrade: !prev.autoTrade }));
  }, []);

  const manualOpen = useCallback((pick) => {
    openPosition({ ...pick, _source: 'manual' });
  }, [openPosition]);

  const manualClose = useCallback((symbol, exitPrice) => {
    const pos = stateRef.current.positions.find(p => p.symbol === symbol);
    closePosition(symbol, 'MANUAL', exitPrice || pos?.currentPrice || pos?.entry);
  }, [closePosition]);

  const updateConfig = useCallback((patch) => {
    setState(prev => ({ ...prev, config: { ...prev.config, ...patch } }));
  }, []);

  const reset = useCallback(() => {
    const s = freshState();
    setState(s);
  }, []);

  // ── EOD (borsa kapanis) tum pozisyonlari kapat ──
  useEffect(() => {
    const handler = () => {
      const { positions, autoTrade } = stateRef.current;
      if (!autoTrade || !positions.length) return;
      // 17:30 kapanisi: eod mode'da tum acik pozisyonlari kapat
      for (const pos of positions) {
        closePosition(pos.symbol, 'EOD', pos.currentPrice || pos.entry);
      }
    };
    window.addEventListener('market-close-eod', handler);
    return () => window.removeEventListener('market-close-eod', handler);
  }, [closePosition]);

  const performance = calcPerformance(state);

  return {
    // State
    capital:      state.capital,
    startCapital: state.startCapital,
    startDate:    state.startDate,
    positions:    state.positions,
    closedTrades: state.closedTrades,
    autoTrade:    state.autoTrade,
    equityCurve:  state.equityCurve,
    config:       state.config,
    // Actions
    openPosition:  manualOpen,
    closePosition: manualClose,
    toggleAutoTrade,
    updateConfig,
    reset,
    // Derived
    performance,
  };
}
