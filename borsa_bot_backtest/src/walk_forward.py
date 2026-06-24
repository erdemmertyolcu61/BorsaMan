"""
walk_forward.py - Rolling in-sample / out-of-sample validation.

Splits data into N windows; for each window:
  - IS slice (default 70%): used for parameter selection
  - OOS slice (default 30%): performance evaluated on unseen data
Verdict: stable / borderline / overfit based on OOS efficiency + degradation.
"""
from __future__ import annotations
from typing import Callable, Dict, Any, List, Tuple
import pandas as pd
import numpy as np

from .backtest_engine import run_backtest, BacktestResult
from .strategy.base import Strategy


def walk_forward_run(
    df: pd.DataFrame,
    strategy: Strategy,
    n_windows: int = 4,
    in_sample_pct: float = 0.7,
    **bt_kwargs,
) -> Dict[str, Any]:
    """Run walk-forward validation. Returns per-window stats + verdict."""
    if len(df) < 250 * n_windows:
        # Not enough data — just run single backtest as IS only
        res = run_backtest(df, strategy, **bt_kwargs)
        return {
            "windows": [],
            "summary": {
                "median_oos_return": 0.0,
                "median_efficiency": 0.0,
                "pct_profitable_oos": 0.0,
                "avg_degradation": 0.0,
            },
            "verdict": "insufficient_data",
            "single_run_metrics": res.metrics,
        }

    win_size = len(df) // n_windows
    windows = []
    for i in range(n_windows):
        start = i * win_size
        end = (i + 1) * win_size if i < n_windows - 1 else len(df)
        slice_df = df.iloc[start:end].reset_index(drop=True)
        is_end = int(len(slice_df) * in_sample_pct)
        is_df = slice_df.iloc[:is_end]
        oos_df = slice_df.iloc[is_end:]

        if len(is_df) < 30 or len(oos_df) < 10:
            continue

        is_res = run_backtest(is_df, strategy, **bt_kwargs)
        oos_res = run_backtest(oos_df, strategy, **bt_kwargs)
        is_ret = is_res.metrics["total_return_pct"]
        oos_ret = oos_res.metrics["total_return_pct"]
        efficiency = (oos_ret / is_ret) if abs(is_ret) > 0.5 else 0.0
        degradation = abs(is_res.metrics["win_rate_pct"] - oos_res.metrics["win_rate_pct"])

        windows.append({
            "window": i,
            "is_return_pct": is_ret,
            "oos_return_pct": oos_ret,
            "is_win_rate": is_res.metrics["win_rate_pct"],
            "oos_win_rate": oos_res.metrics["win_rate_pct"],
            "efficiency": efficiency,
            "degradation": degradation,
        })

    if not windows:
        return {"windows": [], "summary": {}, "verdict": "no_valid_windows"}

    eff_arr = np.array([w["efficiency"] for w in windows])
    oos_arr = np.array([w["oos_return_pct"] for w in windows])
    deg_arr = np.array([w["degradation"] for w in windows])
    pct_profit = float((oos_arr > 0).mean() * 100)
    median_eff = float(np.median(eff_arr))
    median_oos = float(np.median(oos_arr))
    avg_deg = float(deg_arr.mean())

    if median_eff >= 0.5 and pct_profit >= 60 and avg_deg < 20:
        verdict = "stable"
    elif median_eff < 0.2 or pct_profit < 40 or avg_deg > 35:
        verdict = "overfit"
    else:
        verdict = "borderline"

    return {
        "windows": windows,
        "summary": {
            "median_oos_return": median_oos,
            "median_efficiency": median_eff,
            "pct_profitable_oos": pct_profit,
            "avg_degradation": avg_deg,
        },
        "verdict": verdict,
    }
