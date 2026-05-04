"""
strategy_suggesters.py - Optuna `suggest` functions per strategy.

Each suggester receives an Optuna trial and returns a strategy params dict.
Defines the search space + sensible BIST-tuned default ranges.
"""
from __future__ import annotations
from typing import Dict, Any


def suggest_ma_cross(trial) -> Dict[str, Any]:
    short = trial.suggest_int("ma_short", 5, 30)
    # ma_long must be greater than ma_short
    long_ = trial.suggest_int("ma_long", short + 10, 250)
    return {
        "ma_short": short,
        "ma_long": long_,
        "filter_ma200": trial.suggest_categorical("filter_ma200", [True, False]),
    }


def suggest_rsi_reversal(trial) -> Dict[str, Any]:
    return {
        "rsi_period": trial.suggest_int("rsi_period", 7, 25),
        "oversold": trial.suggest_float("oversold", 20.0, 40.0, step=1.0),
        "overbought": trial.suggest_float("overbought", 60.0, 80.0, step=1.0),
    }


def suggest_bollinger_reversal(trial) -> Dict[str, Any]:
    return {
        "period": trial.suggest_int("period", 10, 40),
        "std": trial.suggest_float("std", 1.5, 3.0, step=0.1),
        "exit_mode": trial.suggest_categorical("exit_mode", ["mean", "opposite_band"]),
    }


def suggest_risk(trial) -> Dict[str, Any]:
    """Common risk-side knobs — used together with strategy params."""
    return {
        "risk_per_trade": trial.suggest_float("risk_per_trade", 0.005, 0.02, step=0.005),
        "max_position_size": trial.suggest_float("max_position_size", 0.1, 0.4, step=0.05),
        "stop_atr_mult": trial.suggest_float("stop_atr_mult", 1.5, 3.0, step=0.25),
        "take_profit_rr": trial.suggest_float("take_profit_rr", 1.5, 3.5, step=0.25),
    }


SUGGESTERS = {
    "ma_cross": suggest_ma_cross,
    "rsi_reversal": suggest_rsi_reversal,
    "bollinger_reversal": suggest_bollinger_reversal,
}
