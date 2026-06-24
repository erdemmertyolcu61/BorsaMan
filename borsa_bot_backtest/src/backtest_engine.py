"""
backtest_engine.py - Event-driven backtest core.

Per-bar flow:
  1. Update open positions (mark-to-market)
  2. Check stop/target hits
  3. Read strategy signal
  4. Apply RiskManager sizing
  5. Simulate fill with commission + slippage
  6. Record trade + equity curve

Outputs: trades DataFrame, equity curve, performance metrics.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any
import pandas as pd
import numpy as np

from .risk_manager import RiskManager, RiskConfig, PositionPlan
from .strategy.base import Strategy


@dataclass
class Position:
    symbol: str
    entry_date: pd.Timestamp
    entry_price: float
    quantity: int
    stop: float
    target: float
    bars_held: int = 0


@dataclass
class Trade:
    symbol: str
    entry_date: pd.Timestamp
    exit_date: pd.Timestamp
    entry_price: float
    exit_price: float
    quantity: int
    pnl_tl: float
    pnl_pct: float
    exit_reason: str
    bars_held: int


@dataclass
class BacktestResult:
    equity_curve: pd.Series
    trades: pd.DataFrame
    metrics: Dict[str, float]
    final_balance: float
    initial_balance: float


def _atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    h, l, c = df["high"], df["low"], df["close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def run_backtest(
    df: pd.DataFrame,
    strategy: Strategy,
    *,
    initial_balance: float = 100000.0,
    commission_rate: float = 0.001,
    slippage_rate: float = 0.0005,
    risk_cfg: Optional[RiskConfig] = None,
    hold_max_days: int = 20,
    trailing_stop_pct: Optional[float] = None,
) -> BacktestResult:
    """Single-symbol backtest. df must have datetime,open,high,low,close,volume."""
    if df.empty or "close" not in df.columns:
        raise ValueError("df missing OHLCV columns")
    df = df.reset_index(drop=True).copy()
    df["atr"] = _atr(df)

    cfg = risk_cfg or RiskConfig()
    rm = RiskManager(cfg)
    signals = strategy.generate_signals(df)

    cash = initial_balance
    pos: Optional[Position] = None
    trades: List[Trade] = []
    equity = []

    for i in range(len(df)):
        bar = df.iloc[i]
        date = bar["datetime"]
        # Mark equity
        if pos is not None:
            mtm = cash + pos.quantity * bar["close"]
        else:
            mtm = cash
        equity.append(mtm)

        # Manage open position first
        if pos is not None:
            pos.bars_held += 1
            exit_price = None
            exit_reason = ""

            # Trailing stop adjust
            if trailing_stop_pct and bar["high"] > pos.entry_price:
                trail_stop = bar["high"] * (1 - trailing_stop_pct)
                if trail_stop > pos.stop:
                    pos.stop = trail_stop

            # Stop hit (intra-bar low)
            if bar["low"] <= pos.stop:
                exit_price = pos.stop * (1 - slippage_rate)
                exit_reason = "STOP"
            # Target hit
            elif bar["high"] >= pos.target:
                exit_price = pos.target * (1 - slippage_rate)
                exit_reason = "TARGET"
            # Sell signal
            elif signals.iloc[i] == "SELL":
                exit_price = bar["close"] * (1 - slippage_rate)
                exit_reason = "SIGNAL"
            # Time stop
            elif pos.bars_held >= hold_max_days:
                exit_price = bar["close"] * (1 - slippage_rate)
                exit_reason = "TIME"

            if exit_price is not None:
                proceeds = pos.quantity * exit_price
                fee = proceeds * commission_rate
                cash += proceeds - fee
                pnl_tl = pos.quantity * (exit_price - pos.entry_price) - fee
                pnl_pct = (exit_price - pos.entry_price) / pos.entry_price * 100
                trades.append(Trade(
                    symbol=str(bar.get("symbol", "?")),
                    entry_date=pos.entry_date,
                    exit_date=date,
                    entry_price=pos.entry_price,
                    exit_price=exit_price,
                    quantity=pos.quantity,
                    pnl_tl=pnl_tl,
                    pnl_pct=pnl_pct,
                    exit_reason=exit_reason,
                    bars_held=pos.bars_held,
                ))
                pos = None

        # Open new position on BUY
        if pos is None and signals.iloc[i] == "BUY":
            entry = bar["close"] * (1 + slippage_rate)
            atr_val = bar.get("atr", None)
            if pd.isna(atr_val):
                atr_val = None
            plan = rm.plan_long(equity_tl=cash, entry=entry, atr=atr_val, open_positions=0)
            if plan and plan.cost_tl <= cash:
                fee = plan.cost_tl * commission_rate
                cash -= plan.cost_tl + fee
                pos = Position(
                    symbol=str(bar.get("symbol", "?")),
                    entry_date=date,
                    entry_price=entry,
                    quantity=plan.quantity,
                    stop=plan.stop,
                    target=plan.target,
                    bars_held=0,
                )

    # Close any open position at last bar
    if pos is not None:
        last = df.iloc[-1]
        exit_price = last["close"] * (1 - slippage_rate)
        proceeds = pos.quantity * exit_price
        fee = proceeds * commission_rate
        cash += proceeds - fee
        pnl_tl = pos.quantity * (exit_price - pos.entry_price) - fee
        pnl_pct = (exit_price - pos.entry_price) / pos.entry_price * 100
        trades.append(Trade(
            symbol=str(last.get("symbol", "?")),
            entry_date=pos.entry_date,
            exit_date=last["datetime"],
            entry_price=pos.entry_price,
            exit_price=exit_price,
            quantity=pos.quantity,
            pnl_tl=pnl_tl,
            pnl_pct=pnl_pct,
            exit_reason="FORCED",
            bars_held=pos.bars_held,
        ))

    equity_series = pd.Series(equity, index=df["datetime"])
    trades_df = pd.DataFrame([asdict(t) for t in trades])
    metrics = _compute_metrics(equity_series, trades_df, initial_balance)
    return BacktestResult(
        equity_curve=equity_series,
        trades=trades_df,
        metrics=metrics,
        final_balance=cash + (pos.quantity * df.iloc[-1]["close"] if pos else 0),
        initial_balance=initial_balance,
    )


def _compute_metrics(equity: pd.Series, trades: pd.DataFrame, initial: float) -> Dict[str, float]:
    final = equity.iloc[-1] if len(equity) else initial
    total_return = (final / initial - 1) * 100

    # Drawdown
    rolling_max = equity.cummax()
    dd = (equity / rolling_max - 1) * 100
    max_dd = float(dd.min()) if len(dd) else 0.0

    # Sharpe (daily returns, annualized to 252 BIST trading days)
    returns = equity.pct_change().dropna()
    sharpe = 0.0
    if len(returns) > 20:
        sharpe = float(returns.mean() / (returns.std() + 1e-9) * np.sqrt(252))

    win_rate = 0.0
    profit_factor = 0.0
    avg_trade = 0.0
    if not trades.empty:
        wins = trades[trades["pnl_tl"] > 0]
        losses = trades[trades["pnl_tl"] <= 0]
        win_rate = len(wins) / len(trades) * 100
        gross_profit = wins["pnl_tl"].sum()
        gross_loss = abs(losses["pnl_tl"].sum()) or 1e-9
        profit_factor = float(gross_profit / gross_loss)
        avg_trade = float(trades["pnl_pct"].mean())

    return {
        "final_balance": float(final),
        "total_return_pct": float(total_return),
        "max_drawdown_pct": max_dd,
        "sharpe_ratio": sharpe,
        "win_rate_pct": float(win_rate),
        "profit_factor": profit_factor,
        "avg_trade_pct": avg_trade,
        "trade_count": int(len(trades)),
    }
