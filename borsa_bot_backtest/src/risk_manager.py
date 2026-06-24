"""
risk_manager.py - Position sizing + stop/target placement.

Computes lot size from risk_per_trade × equity, capped by max_position_size.
Stop/target uses ATR (preferred) or fixed % fallback.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass
class RiskConfig:
    risk_per_trade: float = 0.01     # fraction of equity at risk per position
    max_position_size: float = 0.25  # max fraction of equity per position
    max_open_positions: int = 5
    stop_loss_pct: float = 0.02      # fallback stop %
    take_profit_pct: float = 0.04
    stop_atr_mult: float = 2.0
    take_profit_rr: float = 2.5


@dataclass
class PositionPlan:
    quantity: int
    entry: float
    stop: float
    target: float
    risk_tl: float
    cost_tl: float


class RiskManager:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg

    def plan_long(
        self,
        equity_tl: float,
        entry: float,
        atr: Optional[float] = None,
        open_positions: int = 0,
    ) -> Optional[PositionPlan]:
        """Compute position size for a long trade. Returns None if not allowed."""
        if open_positions >= self.cfg.max_open_positions:
            return None
        if entry <= 0 or equity_tl <= 0:
            return None

        # Stop placement
        if atr and atr > 0:
            stop = entry - self.cfg.stop_atr_mult * atr
        else:
            stop = entry * (1 - self.cfg.stop_loss_pct)
        stop = max(0.01, stop)

        risk_per_share = entry - stop
        if risk_per_share <= 0:
            return None

        # Lot size from risk budget
        risk_budget = equity_tl * self.cfg.risk_per_trade
        qty_by_risk = int(risk_budget / risk_per_share)

        # Cap by max_position_size
        max_cost = equity_tl * self.cfg.max_position_size
        qty_by_cost = int(max_cost / entry)

        qty = max(1, min(qty_by_risk, qty_by_cost))
        if qty < 1:
            return None

        # Target
        if atr and atr > 0:
            target = entry + risk_per_share * self.cfg.take_profit_rr
        else:
            target = entry * (1 + self.cfg.take_profit_pct)

        return PositionPlan(
            quantity=qty,
            entry=entry,
            stop=stop,
            target=target,
            risk_tl=qty * risk_per_share,
            cost_tl=qty * entry,
        )
