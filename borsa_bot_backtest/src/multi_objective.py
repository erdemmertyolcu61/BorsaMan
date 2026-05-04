"""
multi_objective.py - Composite scoring + Pareto-aware objective functions.

A backtest result is NOT just total return. We penalize:
  - Drawdown (deep DD = unrecoverable in real life)
  - Low trade count (statistically insignificant)
  - Low Sharpe (return without risk control)
  - Walk-forward overfit verdict
  - Cross-symbol degradation
"""
from __future__ import annotations
from typing import Dict, Any, List
import math


def composite_score(metrics: Dict[str, float], wf_summary: Dict[str, float] | None = None) -> float:
    """
    Aggregates a backtest's quality into a single number for ranking.

    Formula:
      base = total_return - 0.6 × |max_drawdown| - 25 × (sharpe < 0)
      penalty:
        - low trade count (<10): heavy penalty
        - profit_factor < 1.0: heavy penalty
        - poor walk-forward: subtract 30 (overfit) or 10 (borderline)
        - low cross-validation efficiency: subtract median_eff scaling
    """
    ret = metrics.get("total_return_pct", 0.0)
    dd = abs(metrics.get("max_drawdown_pct", 0.0))
    sharpe = metrics.get("sharpe_ratio", 0.0)
    pf = metrics.get("profit_factor", 0.0)
    trades = metrics.get("trade_count", 0)

    score = ret - 0.6 * dd
    if sharpe < 0:
        score -= 25
    elif sharpe > 1.0:
        score += 5

    if trades < 10:
        score -= 50
    elif trades < 25:
        score -= 15

    if pf < 1.0 and trades >= 10:
        score -= 30
    elif pf >= 1.5:
        score += 5
    elif pf >= 2.0:
        score += 10

    if wf_summary:
        verdict = wf_summary.get("verdict", "")
        if verdict == "overfit":
            score -= 30
        elif verdict == "borderline":
            score -= 10
        elif verdict == "stable":
            score += 8
        # Pull score toward median OOS return to discourage IS-only champions
        median_oos = wf_summary.get("summary", {}).get("median_oos_return", 0.0)
        score = 0.6 * score + 0.4 * (ret + median_oos) / 2

    return float(score)


def pareto_front(rows: List[Dict[str, float]]) -> List[Dict[str, float]]:
    """
    Two-objective Pareto front: maximize total_return, minimize max_drawdown.
    A row is on the front if no other row dominates it on BOTH axes.
    """
    front = []
    for cand in rows:
        cand_ret = cand.get("total_return_pct", 0.0)
        cand_dd = abs(cand.get("max_drawdown_pct", 0.0))
        dominated = False
        for other in rows:
            if other is cand:
                continue
            o_ret = other.get("total_return_pct", 0.0)
            o_dd = abs(other.get("max_drawdown_pct", 0.0))
            # other strictly dominates cand?
            if o_ret >= cand_ret and o_dd <= cand_dd and (o_ret > cand_ret or o_dd < cand_dd):
                dominated = True
                break
        if not dominated:
            front.append(cand)
    return front


def cross_symbol_score(per_symbol_metrics: Dict[str, Dict[str, float]]) -> Dict[str, float]:
    """
    Aggregate metrics across multiple symbols for a single param config.
    Returns: median return, % of profitable symbols, worst-case DD, robustness score.
    """
    if not per_symbol_metrics:
        return {}
    rets = sorted(m.get("total_return_pct", 0.0) for m in per_symbol_metrics.values())
    dds = [abs(m.get("max_drawdown_pct", 0.0)) for m in per_symbol_metrics.values()]
    pcts_profitable = sum(1 for r in rets if r > 0) / len(rets) * 100
    median_ret = rets[len(rets) // 2]
    worst_dd = max(dds) if dds else 0.0
    # Robustness: median return × (% profitable) − worst-DD penalty
    robustness = median_ret * (pcts_profitable / 100.0) - 0.3 * worst_dd
    return {
        "median_return_pct": median_ret,
        "pct_profitable_symbols": pcts_profitable,
        "worst_drawdown_pct": worst_dd,
        "robustness_score": robustness,
        "n_symbols": len(rets),
    }
