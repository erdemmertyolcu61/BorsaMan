"""
optimizer.py - Grid + Random + Optuna parameter sweep.

Runs N backtests per (symbol, strategy, params) combination and returns ranked
results. Walks-forward each top candidate to filter out overfit configs.
"""
from __future__ import annotations
from typing import Dict, Any, List, Iterable, Callable, Optional
import itertools
import random
import pandas as pd
import numpy as np

from .backtest_engine import run_backtest
from .walk_forward import walk_forward_run
from .risk_manager import RiskConfig
from .strategy import STRATEGY_REGISTRY


def _expand_grid(param_space: Dict[str, List[Any]]) -> List[Dict[str, Any]]:
    """Cartesian product of param ranges."""
    keys = list(param_space.keys())
    vals = [param_space[k] if isinstance(param_space[k], list) else [param_space[k]] for k in keys]
    out = []
    for combo in itertools.product(*vals):
        out.append(dict(zip(keys, combo)))
    return out


def _sample_random(param_space: Dict[str, List[Any]], n: int, seed: int = 42) -> List[Dict[str, Any]]:
    rng = random.Random(seed)
    keys = list(param_space.keys())
    out = []
    for _ in range(n):
        out.append({k: rng.choice(param_space[k] if isinstance(param_space[k], list) else [param_space[k]]) for k in keys})
    return out


def grid_search(
    df: pd.DataFrame,
    strategy_name: str,
    strategy_param_space: Dict[str, List[Any]],
    risk_param_space: Optional[Dict[str, List[Any]]] = None,
    *,
    initial_balance: float = 100000.0,
    commission_rate: float = 0.001,
    slippage_rate: float = 0.0005,
    walk_forward: bool = True,
    top_k: int = 20,
) -> pd.DataFrame:
    """Run full grid search on strategy + risk params. Returns ranked DataFrame."""
    StratCls = STRATEGY_REGISTRY[strategy_name]
    strat_combos = _expand_grid(strategy_param_space)
    risk_combos = _expand_grid(risk_param_space) if risk_param_space else [{}]

    rows = []
    for sp in strat_combos:
        for rp in risk_combos:
            strat = StratCls(sp)
            risk = RiskConfig(**{k: v for k, v in rp.items() if k in RiskConfig.__dataclass_fields__})
            try:
                res = run_backtest(
                    df,
                    strat,
                    initial_balance=initial_balance,
                    commission_rate=commission_rate,
                    slippage_rate=slippage_rate,
                    risk_cfg=risk,
                )
                row = {**sp, **rp, **res.metrics}
                rows.append(row)
            except Exception as e:
                rows.append({**sp, **rp, "error": str(e)})

    df_out = pd.DataFrame(rows)
    if df_out.empty:
        return df_out
    df_out = df_out.sort_values("total_return_pct", ascending=False).reset_index(drop=True)

    # Walk-forward verdict for top K
    if walk_forward:
        verdicts = []
        for i in range(min(top_k, len(df_out))):
            row = df_out.iloc[i]
            sp = {k: row[k] for k in strategy_param_space if k in row}
            rp = {k: row[k] for k in (risk_param_space or {}) if k in row}
            try:
                strat = StratCls(sp)
                risk = RiskConfig(**{k: v for k, v in rp.items() if k in RiskConfig.__dataclass_fields__})
                wf = walk_forward_run(
                    df, strat,
                    initial_balance=initial_balance,
                    commission_rate=commission_rate,
                    slippage_rate=slippage_rate,
                    risk_cfg=risk,
                )
                verdicts.append({
                    "verdict": wf.get("verdict"),
                    "median_oos": wf.get("summary", {}).get("median_oos_return"),
                    "pct_profitable_oos": wf.get("summary", {}).get("pct_profitable_oos"),
                })
            except Exception:
                verdicts.append({"verdict": "error", "median_oos": None, "pct_profitable_oos": None})
        # pad
        for _ in range(len(df_out) - len(verdicts)):
            verdicts.append({"verdict": "skipped", "median_oos": None, "pct_profitable_oos": None})
        wf_df = pd.DataFrame(verdicts)
        df_out = pd.concat([df_out, wf_df], axis=1)

    return df_out


def random_search(
    df: pd.DataFrame,
    strategy_name: str,
    strategy_param_space: Dict[str, List[Any]],
    n: int = 1000,
    **kwargs,
) -> pd.DataFrame:
    """Random sample n combos from param space — much cheaper than full grid."""
    StratCls = STRATEGY_REGISTRY[strategy_name]
    samples = _sample_random(strategy_param_space, n)
    rows = []
    for sp in samples:
        try:
            strat = StratCls(sp)
            res = run_backtest(
                df, strat,
                initial_balance=kwargs.get("initial_balance", 100000.0),
                commission_rate=kwargs.get("commission_rate", 0.001),
                slippage_rate=kwargs.get("slippage_rate", 0.0005),
            )
            rows.append({**sp, **res.metrics})
        except Exception as e:
            rows.append({**sp, "error": str(e)})
    df_out = pd.DataFrame(rows)
    if df_out.empty:
        return df_out
    return df_out.sort_values("total_return_pct", ascending=False).reset_index(drop=True)


def optuna_optimize(
    df: pd.DataFrame,
    strategy_name: str,
    suggest_fn: Callable,
    n_trials: int = 200,
    direction: str = "maximize",
):
    """
    Optuna Bayesian optimization. suggest_fn receives a `trial` and must return a params dict.
    Example:
        def suggest(trial):
            return {
                "ma_short": trial.suggest_int("ma_short", 5, 30),
                "ma_long":  trial.suggest_int("ma_long", 50, 200),
            }
    """
    try:
        import optuna
    except ImportError:
        raise RuntimeError("Install optuna: pip install optuna")

    StratCls = STRATEGY_REGISTRY[strategy_name]

    def objective(trial):
        params = suggest_fn(trial)
        try:
            strat = StratCls(params)
            res = run_backtest(df, strat)
            # Penalize drawdown — score = return - 0.5 × |drawdown|
            return res.metrics["total_return_pct"] - 0.5 * abs(res.metrics["max_drawdown_pct"])
        except Exception:
            return float("-inf")

    study = optuna.create_study(direction=direction)
    study.optimize(objective, n_trials=n_trials, show_progress_bar=True)
    return study
