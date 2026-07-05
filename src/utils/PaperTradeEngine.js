// ════════════════════════════════════════════════════════════════════
// PaperTradeEngine.js — ML-Scored Forward Testing Engine
// ════════════════════════════════════════════════════════════════════
//
// Purpose: SQLite-backed paper trading that specifically tests ML rule
// performance by selecting TOP 3 ML-scored stocks per scan, allocating
// max 33% capital per position, and enforcing strict -3% stop-loss.
//
// Integration:
//   - Listens to `advisor-scan-complete` CustomEvent
//   - Filters picks with mlConfidenceBoost > 0
//   - Persists to SQLite via electronAPI.paperDb.*
//   - Falls back to localStorage when Electron is not available
//
// This engine runs ALONGSIDE the existing usePaperTrading hook.
// The existing hook handles general paper trading (risk-based sizing).
// THIS engine focuses specifically on ML forward-testing with fixed rules.
// ════════════════════════════════════════════════════════════════════

import { applyEntryCost, applyExitCost, liquiditySlippagePct } from './tradingCosts.js';

const STORAGE_KEY = 'bist_paper_ml_engine_v1';
const START_CAPITAL = 100_000;
const MAX_POSITIONS = 3;          // TOP 3 ML picks only
const MAX_POS_PCT = 0.33;         // 33% capital per trade
const STOP_LOSS_PCT = -0.03;      // fallback -3% stop (pick's own stop preferred)
const TIME_EXIT_DAYS = 3;         // rotate stagnant positions after 3 trading days
const TIME_EXIT_MIN_GAIN_PCT = 1; // keep only if gross P&L >= +1% at day 3
const MIN_ML_BOOST = 0;           // mlConfidenceBoost > 0 (any ML match)
const MIN_ENTRY_TL = 3_000;       // minimum position size

// ── Helpers ──

function getApi() {
  try {
    return window.electronAPI?.paperDb || null;
  } catch { return null; }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveLocalState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ── Engine Class ──

export class PaperTradeEngine {
  constructor() {
    this._api = getApi();
    this._isElectron = !!this._api;
    this._state = null;
    this._listeners = new Set();
    this._monitorInterval = null;
    this._initialized = false;
  }

  // ── Initialize ──

  async init() {
    if (this._initialized) return this;

    if (this._isElectron) {
      try {
        const portfolio    = await this._api.getPortfolio();

        // Stub mode: better-sqlite3 not installed → main.cjs registers stub handlers
        // that return { _stubMode: true } as a sentinel. Fall back to localStorage so
        // existing user trades are preserved rather than starting from a blank state.
        if (portfolio?._stubMode) {
          console.log('[PaperML] Stub IPC detected (better-sqlite3 unavailable) — using localStorage');
          this._isElectron = false;
          const saved = loadLocalState();
          this._state = saved || {
            cash: START_CAPITAL, startCapital: START_CAPITAL, startDate: Date.now(),
            openTrades: [], closedTrades: [], stats: {}, peakEquity: START_CAPITAL, maxDrawdown: 0,
          };
        } else {
          const openTrades   = await this._api.getOpenTrades();
          const closedTrades = await this._api.getClosedTrades(200);
          const stats        = await this._api.getStats();

          this._state = {
            cash:         portfolio?.cash          ?? START_CAPITAL,
            startCapital: portfolio?.start_capital ?? START_CAPITAL,
            startDate:    portfolio?.start_date    ?? Date.now(),
            openTrades:   openTrades   || [],
            closedTrades: closedTrades || [],
            stats:        stats        || {},
            peakEquity:   portfolio?.peak_equity   ?? START_CAPITAL,
            maxDrawdown:  portfolio?.max_drawdown  ?? 0,
          };
        }
      } catch (err) {
        console.warn('[PaperML] SQLite IPC failed, falling back to localStorage:', err?.message);
        this._isElectron = false;
        const saved = loadLocalState();
        this._state = saved || {
          cash: START_CAPITAL, startCapital: START_CAPITAL, startDate: Date.now(),
          openTrades: [], closedTrades: [], stats: {}, peakEquity: START_CAPITAL, maxDrawdown: 0,
        };
      }
    } else {
      const saved = loadLocalState();
      this._state = saved || {
        cash: START_CAPITAL,
        startCapital: START_CAPITAL,
        startDate: Date.now(),
        openTrades: [],
        closedTrades: [],
        stats: {},
        peakEquity: START_CAPITAL,
        maxDrawdown: 0,
      };
    }

    this._initialized = true;
    this._emit();
    return this;
  }

  // ── State Access ──

  getState() {
    return this._state;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  getSnapshot() {
    return this._buildSnapshot();
  }

  _emit() {
    const snapshot = this._buildSnapshot();
    for (const fn of this._listeners) {
      try { fn(snapshot); } catch {}
    }
  }

  _buildSnapshot() {
    if (!this._state) return null;
    const s = this._state;
    const openEquity = s.openTrades.reduce((sum, t) => {
      const cur = t.current_price || t.entry_price;
      const pnl = (cur - t.entry_price) / t.entry_price * t.size_tl;
      return sum + t.size_tl + pnl;
    }, 0);
    const totalEquity = s.cash + openEquity;

    // Closed stats
    const closed = s.closedTrades;
    const wins = closed.filter(t => (t.pnl_tl || 0) > 0);
    const losses = closed.filter(t => (t.pnl_tl || 0) <= 0);
    const totalPnl = closed.reduce((a, t) => a + (t.pnl_tl || 0), 0);
    const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWinPct = wins.length ? wins.reduce((a, t) => a + (t.pnl_pct || 0), 0) / wins.length : 0;
    const avgLossPct = losses.length ? losses.reduce((a, t) => a + (t.pnl_pct || 0), 0) / losses.length : 0;
    const expectancy = closed.length
      ? (winRate / 100) * avgWinPct + (1 - winRate / 100) * avgLossPct
      : 0;
    const profitFactor = losses.reduce((a, t) => a + Math.abs(t.pnl_tl || 0), 0) > 0
      ? wins.reduce((a, t) => a + (t.pnl_tl || 0), 0) / losses.reduce((a, t) => a + Math.abs(t.pnl_tl || 0), 0)
      : wins.length ? Infinity : 0;

    return {
      cash: s.cash,
      startCapital: s.startCapital,
      startDate: s.startDate,
      openTrades: s.openTrades,
      closedTrades: s.closedTrades,
      totalEquity,
      totalEquityPct: s.startCapital > 0 ? (totalEquity - s.startCapital) / s.startCapital * 100 : 0,
      totalPnl,
      totalPnlPct: s.startCapital > 0 ? (totalPnl / s.startCapital) * 100 : 0,
      winRate,
      wins: wins.length,
      losses: losses.length,
      totalTrades: closed.length,
      avgWinPct,
      avgLossPct,
      expectancy,
      profitFactor,
      maxDrawdown: s.maxDrawdown,
      peakEquity: s.peakEquity,
      // ML specific
      mlBuckets: s.stats?.mlBuckets || [],
    };
  }

  // ── Process Scan Results (TOP 3 ML picks) ──

  async processScanResults(picks) {
    if (!this._initialized) {
      console.log('[PaperTrade] Engine not initialized — initializing now...');
      await this.init();
    }
    console.log('[PaperTrade] Received picks:', picks?.length || 0);
    if (!picks?.length) {
      console.warn('[PaperTrade] ABORT — picks array empty');
      return;
    }

    const s = this._state;
    const existingSymbols = new Set(s.openTrades.map(t => t.symbol));
    console.log('[PaperTrade] State: cash=', s.cash, '| openTrades=', s.openTrades.length, '| existingSymbols=', [...existingSymbols]);

    // All buy-eligible picks not already held
    const eligible = picks.filter(p =>
      p.cls === 'buy' && !existingSymbols.has(p.symbol)
    );
    console.log('[PaperTrade] Buy-eligible picks (cls=buy, not held):', eligible.length, eligible.map(p => p.symbol));

    if (!eligible.length) {
      console.warn('[PaperTrade] ABORT — no buy-eligible picks. Sample cls values:',
        picks.slice(0, 5).map(p => ({ sym: p.symbol, cls: p.cls })));
      return;
    }

    // Priority 1: ML-matched picks, sorted by ML confidence boost descending
    const mlPicks = eligible
      .filter(p => (p.mlMatchedCount || 0) > 0 && (p.mlConfidenceBoost || 0) > MIN_ML_BOOST)
      .sort((a, b) => (b.mlConfidenceBoost || 0) - (a.mlConfidenceBoost || 0));
    console.log('[PaperTrade] ML-matched picks:', mlPicks.length,
      mlPicks.map(p => ({ sym: p.symbol, boost: p.mlConfidenceBoost, matched: p.mlMatchedCount })));

    // Priority 2: If no ML matches, fallback to top SMC score picks
    const fallbackPicks = mlPicks.length > 0
      ? []
      : eligible
          .filter(p => (p.score || 0) >= 55)
          .sort((a, b) => (b.score || 0) - (a.score || 0));
    console.log('[PaperTrade] SMC fallback picks (score>=55):', fallbackPicks.length,
      fallbackPicks.map(p => ({ sym: p.symbol, score: p.score })));

    // ML picks first, then fallback — take TOP 3 within available slots
    const slotsAvailable = MAX_POSITIONS - s.openTrades.length;
    const queue = [...mlPicks, ...fallbackPicks];
    const toOpen = queue.slice(0, Math.min(3, slotsAvailable));
    console.log('[PaperTrade] Queue:', queue.map(p => p.symbol), '| slots=', slotsAvailable, '| willOpen=', toOpen.map(p => p.symbol));

    if (!toOpen.length) {
      console.warn('[PaperTrade] ABORT — no candidates after filtering or no slots (slotsAvailable=', slotsAvailable, ')');
      return;
    }

    for (const pick of toOpen) {
      await this._openTrade(pick);
    }

    if (toOpen.length > 0) {
      this._persist();
      this._emit();
      console.log('[PaperTrade] Done. New openTrades count:', this._state.openTrades.length);
    }
  }

  // ── Open Trade ──

  async _openTrade(pick) {
    const s = this._state;

    // Robust price extraction with multiple fallbacks
    const lastBarClose = (pick.data && Array.isArray(pick.data) && pick.data.length > 0)
      ? pick.data[pick.data.length - 1]?.close
      : null;
    const price = pick.currentPrice
               || pick.price
               || pick.entry
               || pick.close
               || pick.lastClose
               || lastBarClose
               || null;

    // Strict validation — log and skip on invalid price (no silent crash)
    if (!price || price <= 0 || !Number.isFinite(price)) {
      console.warn('[PaperTrade] SKIPPING', pick.symbol, '- Invalid price:', price,
        '| candidates:', {
          currentPrice: pick.currentPrice,
          price: pick.price,
          entry: pick.entry,
          close: pick.close,
          lastClose: pick.lastClose,
          lastBarClose,
        });
      return;
    }

    const currentPrice = price;
    // Realistic fill: a buyer crosses the spread and pays UP. Without this the
    // forward test idealizes entries and overstates returns.
    const legSlippage = liquiditySlippagePct(pick.liquidity);
    const entry = applyEntryCost(currentPrice, 'buy', legSlippage);

    // 33% max capital allocation × regime/governor multiplier.
    // pick._positionSizeMult carries regimeEngine.riskMult × profitGovernor
    // positionMult — in BEAR/DEFENSE the same setup opens with a fraction.
    const posMult = Number.isFinite(pick._positionSizeMult) && pick._positionSizeMult > 0
      ? Math.min(pick._positionSizeMult, 1.5)
      : 1;
    const sizeTl = Math.min(s.cash * MAX_POS_PCT * posMult, s.cash);
    if (sizeTl < MIN_ENTRY_TL) {
      console.warn('[PaperTrade] ABORTING trade for', pick.symbol, '- Position size too small:',
        sizeTl, 'TL (min:', MIN_ENTRY_TL, ', cash:', s.cash, ', posMult:', posMult, ')');
      return;
    }

    // Honor the pick's own ATR/structure stop so the forward test actually
    // validates the advisor's exit logic. Fixed -3% only as sanity fallback
    // (missing or implausible stop: above entry or further than -12%).
    const pickStop = Number(pick.stop);
    const pickStopValid = Number.isFinite(pickStop)
      && pickStop < entry
      && pickStop > entry * 0.88;
    const stopPrice = pickStopValid
      ? Math.round(pickStop * 100) / 100
      : Math.round(entry * (1 + STOP_LOSS_PCT) * 100) / 100;
    const stopSource = pickStopValid ? 'pick' : 'fixed3pct';
    const targetPrice = pick.target || pick.t1 || entry * 1.10;
    const lots = Math.floor(sizeTl / entry);
    console.log('[PaperTrade] Opening trade for', pick.symbol, 'at', currentPrice,
      '| stop=', stopPrice, '| target=', targetPrice, '| sizeTL=', sizeTl, '| lots=', lots);

    const trade = {
      symbol:       pick.symbol,
      direction:    'BUY',
      entryPrice:   entry,
      stopPrice,
      targetPrice,
      sizeTl:       Math.round(sizeTl * 100) / 100,
      lots,
      mlConfidence: pick.mlConfidenceBoost || 0,
      mlBestRule:   pick.mlBestRule ? (typeof pick.mlBestRule === 'string' ? pick.mlBestRule : JSON.stringify(pick.mlBestRule)) : null,
      mlMatched:    pick.mlMatchedCount || 0,
      confidence:   pick.confidence || 0,
      grade:        pick.grade || '',
      tier:         pick.tier || '',
      score100:     pick.score || 0,
      rr:           pick.rr || 0,
      sector:       pick.sector || '',
      firedSignals: pick.firedSignals || [],
      openedAt:     Date.now(),
      entryAtrPct:  pick.atrPct || null,
      entryRsi:     pick.rsi || null,
      entryRegime:  typeof pick.regime === 'string' ? pick.regime : (pick.regime?.regime || pick._regime || null),
      positionMult: posMult,
      stopSource,
      notes:        (pick.mlMatchedCount || 0) > 0
        ? `ML boost: +${(pick.mlConfidenceBoost || 0).toFixed(1)} | Rule: ${pick.mlBestRule?.setupName || 'N/A'}`
        : `SMC score: ${(pick.score || 0).toFixed(0)} | Fallback (no ML match)`,
    };

    console.log('[PaperTrade] isElectron =', this._isElectron, '| _api available =', !!this._api);

    if (this._isElectron) {
      try {
        const id = await this._api.openTrade(trade);
        trade.id = id;
        console.log('[PaperTrade] SQLite insert OK — tradeId=', id);
      } catch (err) {
        console.error('[PaperTrade] SQLite insert FAILED:', err?.message, err);
        return;
      }
    } else {
      trade.id = Date.now() + Math.random();
      trade.status = 'OPEN';
      trade.entry_price = trade.entryPrice;
      trade.stop_price = trade.stopPrice;
      trade.target_price = trade.targetPrice;
      trade.size_tl = trade.sizeTl;
      trade.ml_confidence = trade.mlConfidence;
      trade.ml_best_rule = trade.mlBestRule;
      trade.ml_matched = trade.mlMatched;
      trade.opened_at = trade.openedAt;
    }

    s.cash -= trade.sizeTl;

    if (this._isElectron) {
      // Reload from DB — single source of truth, no redundant push
      await this._api.updatePortfolio({ cash: s.cash });
      s.openTrades = await this._api.getOpenTrades();
    } else {
      // localStorage mode: push directly
      s.openTrades.push(trade);
    }

    console.log(`[PaperML] Opened: ${trade.symbol} @ ${entry} | ML boost: ${trade.mlConfidence} | Size: ${trade.sizeTl} TL`);
  }

  // ── Close Trade ──

  async closeTrade(tradeId, exitPrice, reason = 'MANUAL') {
    const s = this._state;
    const trade = s.openTrades.find(t => t.id === tradeId);
    if (!trade) return;

    const entry = trade.entry_price;
    // Realistic exit: closing a long sells DOWN through the spread. Combined
    // with the entry-side cost in _openTrade, this models full round-trip friction.
    const fillPrice = applyExitCost(exitPrice, 'buy');
    const pnlTl = (fillPrice - entry) / entry * trade.size_tl;

    if (this._isElectron) {
      await this._api.closeTrade(tradeId, fillPrice, reason);
    }

    // Update local state
    s.cash += trade.size_tl + pnlTl;
    s.openTrades = s.openTrades.filter(t => t.id !== tradeId);

    // Update portfolio stats
    const totalEquity = s.cash + s.openTrades.reduce((sum, t) => sum + t.size_tl, 0);
    if (totalEquity > s.peakEquity) s.peakEquity = totalEquity;
    const dd = s.peakEquity > 0 ? (s.peakEquity - totalEquity) / s.peakEquity * 100 : 0;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;

    if (this._isElectron) {
      await this._api.updatePortfolio({
        cash: s.cash,
        peakEquity: s.peakEquity,
        maxDrawdown: Math.round(s.maxDrawdown * 100) / 100,
      });
      s.closedTrades = await this._api.getClosedTrades(200);
      s.openTrades = await this._api.getOpenTrades();
      s.stats = await this._api.getStats();
    } else {
      const closedTrade = {
        ...trade,
        status: 'CLOSED',
        exit_price: Math.round(fillPrice * 100) / 100,
        exit_reason: reason,
        pnl_tl: Math.round(pnlTl * 100) / 100,
        pnl_pct: Math.round((fillPrice - entry) / entry * 10000) / 100,
        closed_at: Date.now(),
        held_ms: Date.now() - trade.opened_at,
      };
      s.closedTrades.unshift(closedTrade);
    }

    this._persist();
    this._emit();

    console.log(`[PaperML] Closed: ${trade.symbol} @ ${exitPrice} | ${reason} | PnL: ${pnlTl > 0 ? '+' : ''}${pnlTl.toFixed(0)} TL`);
  }

  // ── Price Monitor (check stop/target) ──

  async checkPrices(priceMap) {
    if (!this._initialized || !this._state?.openTrades?.length) return;

    const s = this._state;
    let changed = false;

    for (const trade of [...s.openTrades]) {
      const live = priceMap[trade.symbol];
      if (!live?.price) continue;

      // Update current price in memory
      trade.current_price = live.price;
      changed = true;

      // Check stop
      if (live.price <= trade.stop_price) {
        await this.closeTrade(trade.id, live.price, 'STOP');
        continue;
      }

      // Check target
      if (trade.target_price && live.price >= trade.target_price) {
        await this.closeTrade(trade.id, live.price, 'TARGET');
        continue;
      }

      // D3 time exit: a swing pick that has gone nowhere in 3+ trading days is
      // dead capital — rotate it out so cash funds the next fresh setup.
      // Threshold +1% net keeps genuine slow grinders alive.
      const openedAt = trade.opened_at || trade.openedAt;
      const heldDays = openedAt ? (Date.now() - openedAt) / (1000 * 60 * 60 * 24) : 0;
      if (heldDays >= TIME_EXIT_DAYS) {
        const entryP = trade.entry_price || trade.entryPrice;
        const grossPct = entryP ? ((live.price - entryP) / entryP) * 100 : 0;
        if (grossPct < TIME_EXIT_MIN_GAIN_PCT) {
          await this.closeTrade(trade.id, live.price, 'TIME_EXIT');
          continue;
        }
      }
    }

    if (changed) this._emit();
  }

  // ── Reset ──

  async reset() {
    if (this._isElectron) {
      await this._api.reset();
    }
    this._state = {
      cash: START_CAPITAL,
      startCapital: START_CAPITAL,
      startDate: Date.now(),
      openTrades: [],
      closedTrades: [],
      stats: {},
      peakEquity: START_CAPITAL,
      maxDrawdown: 0,
    };
    this._persist();
    this._emit();
  }

  // ── Persistence ──

  _persist() {
    if (!this._isElectron) {
      saveLocalState(this._state);
    }
  }

  // ── Refresh from DB ──

  async refresh() {
    if (!this._isElectron) return;
    const portfolio = await this._api.getPortfolio();
    const openTrades = await this._api.getOpenTrades();
    const closedTrades = await this._api.getClosedTrades(200);
    const stats = await this._api.getStats();

    this._state = {
      ...this._state,
      cash: portfolio?.cash ?? this._state.cash,
      openTrades: openTrades || [],
      closedTrades: closedTrades || [],
      stats: stats || {},
      peakEquity: portfolio?.peak_equity ?? this._state.peakEquity,
      maxDrawdown: portfolio?.max_drawdown ?? this._state.maxDrawdown,
    };
    this._emit();
  }
}

// Singleton
let _engine = null;

export function getPaperTradeEngine() {
  if (!_engine) {
    _engine = new PaperTradeEngine();
  }
  return _engine;
}

export default { PaperTradeEngine, getPaperTradeEngine };
