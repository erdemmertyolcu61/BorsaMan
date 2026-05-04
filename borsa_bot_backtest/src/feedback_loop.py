"""
feedback_loop.py - 4-phase Optuna feedback orchestrator.

Phase 1 (EXPLORE):  Random search wide param space (n=300) → top 50 candidates
Phase 2 (EXPLOIT):  Optuna TPE seeded with phase-1 winners → 200 more trials
Phase 3 (VALIDATE): Walk-forward each top-K, drop overfit
Phase 4 (CROSS):    Best survivor tested on N other symbols (out-of-sample stocks)
                    Only models with ≥55% cross-symbol win rate go to registry.

Persistence: every iteration appends to a SQLite Optuna study, so runs are resumable.
"""
from __future__ import annotations
from typing import Dict, Any, List, Callable
from dataclasses import dataclass, asdict
import time
import pandas as pd

from .backtest_engine import run_backtest, BacktestResult
from .walk_forward import walk_forward_run
from .strategy import STRATEGY_REGISTRY
from .strategy_suggesters import SUGGESTERS, suggest_risk
from .risk_manager import RiskConfig
from .multi_objective import composite_score, cross_symbol_score
from .model_registry import save_model, is_valid_for_registry
from .study_persistence import create_or_load_study


@dataclass
class FeedbackConfig:
    strategy_name: str
    primary_symbol: str
    cross_validation_symbols: List[str]
    explore_trials: int = 300
    exploit_trials: int = 200
    walk_forward_top_k: int = 30
    cross_validation_top_k: int = 8
    n_walk_windows: int = 4
    initial_balance: float = 100_000.0
    commission_rate: float = 0.001
    slippage_rate: float = 0.0005
    include_risk_search: bool = True
    persist_study: bool = True


def _build_strategy_and_risk(strategy_name: str, params: Dict[str, Any]):
    """Split a flat params dict into (strategy_kwargs, risk_kwargs)."""
    risk_keys = {"risk_per_trade", "max_position_size", "stop_atr_mult", "take_profit_rr"}
    s_params = {k: v for k, v in params.items() if k not in risk_keys}
    r_params = {k: v for k, v in params.items() if k in risk_keys}
    StratCls = STRATEGY_REGISTRY[strategy_name]
    strat = StratCls(s_params)
    risk = RiskConfig(**r_params) if r_params else RiskConfig()
    return strat, risk, s_params, r_params


def _objective_factory(df: pd.DataFrame, cfg: FeedbackConfig) -> Callable:
    """Build an Optuna objective that maximizes composite_score on primary symbol."""
    suggester = SUGGESTERS[cfg.strategy_name]

    def objective(trial):
        params = dict(suggester(trial))
        if cfg.include_risk_search:
            params.update(suggest_risk(trial))
        strat, risk, _, _ = _build_strategy_and_risk(cfg.strategy_name, params)
        try:
            res = run_backtest(
                df, strat,
                initial_balance=cfg.initial_balance,
                commission_rate=cfg.commission_rate,
                slippage_rate=cfg.slippage_rate,
                risk_cfg=risk,
            )
            score = composite_score(res.metrics)
            # Stash metrics on the trial for later analysis
            for k, v in res.metrics.items():
                trial.set_user_attr(k, v)
            return score
        except Exception as e:
            trial.set_user_attr("error", str(e))
            return float("-inf")

    return objective


def run_feedback_loop(
    df_primary: pd.DataFrame,
    cross_data: Dict[str, pd.DataFrame],
    cfg: FeedbackConfig,
    log: Callable[[str], None] | None = None,
) -> Dict[str, Any]:
    """
    Full 4-phase feedback loop. Returns a summary with:
      - n_trials, best params, metrics
      - walk_forward verdict
      - cross_symbol robustness
      - registry status (saved or rejected with reason)
    """
    log = log or print
    t0 = time.time()
    summary: Dict[str, Any] = {
        "strategy": cfg.strategy_name,
        "primary_symbol": cfg.primary_symbol,
        "phases": {},
    }

    # ────────────────────────────────────────────────────────────────────────
    # Phase 1 + 2: Combined Optuna study (TPE handles explore→exploit naturally)
    # ────────────────────────────────────────────────────────────────────────
    study_name = f"{cfg.strategy_name}_{cfg.primary_symbol}"
    if cfg.persist_study:
        study = create_or_load_study(study_name, direction="maximize")
    else:
        import optuna
        study = optuna.create_study(direction="maximize",
                                    sampler=optuna.samplers.TPESampler(seed=42, n_startup_trials=cfg.explore_trials))

    objective = _objective_factory(df_primary, cfg)
    total_trials = cfg.explore_trials + cfg.exploit_trials
    log(f"[Phase 1+2] Optuna {total_trials} trials on {cfg.primary_symbol} ({cfg.strategy_name}) ...")
    study.optimize(objective, n_trials=total_trials, show_progress_bar=False, gc_after_trial=True)

    completed = [t for t in study.trials if t.state.name == "COMPLETE" and t.value is not None and t.value > float("-inf")]
    completed.sort(key=lambda t: t.value, reverse=True)
    summary["phases"]["1_2_optuna"] = {
        "trials_completed": len(completed),
        "trials_failed": len(study.trials) - len(completed),
        "best_score": completed[0].value if completed else None,
        "best_params": dict(completed[0].params) if completed else None,
    }
    log(f"  → {len(completed)} ok / {len(study.trials)-len(completed)} fail; best score {completed[0].value:.2f}")

    if not completed:
        summary["registry"] = {"saved": False, "reason": "no successful trials"}
        return summary

    # ────────────────────────────────────────────────────────────────────────
    # Phase 3: Walk-forward filter top-K
    # ────────────────────────────────────────────────────────────────────────
    log(f"[Phase 3] Walk-forward validating top {cfg.walk_forward_top_k} ...")
    wf_results = []
    for trial in completed[: cfg.walk_forward_top_k]:
        params = dict(trial.params)
        strat, risk, s_params, r_params = _build_strategy_and_risk(cfg.strategy_name, params)
        try:
            wf = walk_forward_run(
                df_primary, strat,
                n_windows=cfg.n_walk_windows,
                initial_balance=cfg.initial_balance,
                commission_rate=cfg.commission_rate,
                slippage_rate=cfg.slippage_rate,
                risk_cfg=risk,
            )
            verdict = wf.get("verdict")
            wf_score = composite_score(
                {k: trial.user_attrs.get(k, 0) for k in [
                    "total_return_pct", "max_drawdown_pct", "sharpe_ratio",
                    "profit_factor", "trade_count"]},
                wf,
            )
            wf_results.append({
                "params": params,
                "verdict": verdict,
                "wf_summary": wf.get("summary"),
                "metrics": dict(trial.user_attrs),
                "wf_score": wf_score,
            })
        except Exception as e:
            log(f"  WF error: {e}")

    stable = [r for r in wf_results if r["verdict"] == "stable"]
    survivors = stable if stable else [r for r in wf_results if r["verdict"] in ("stable", "borderline")]
    survivors.sort(key=lambda r: r["wf_score"], reverse=True)
    summary["phases"]["3_walk_forward"] = {
        "stable": len(stable),
        "borderline": sum(1 for r in wf_results if r["verdict"] == "borderline"),
        "overfit": sum(1 for r in wf_results if r["verdict"] == "overfit"),
        "survivors_top": [r["params"] for r in survivors[:5]],
    }
    log(f"  → stable={len(stable)}, survivors={len(survivors)}")

    if not survivors:
        summary["registry"] = {"saved": False, "reason": "no walk-forward survivors"}
        return summary

    # ────────────────────────────────────────────────────────────────────────
    # Phase 4: Cross-symbol robustness check on top survivors
    # ────────────────────────────────────────────────────────────────────────
    log(f"[Phase 4] Cross-validating top {cfg.cross_validation_top_k} on {len(cross_data)} symbols ...")
    final_candidates = []
    for cand in survivors[: cfg.cross_validation_top_k]:
        params = cand["params"]
        strat, risk, _, _ = _build_strategy_and_risk(cfg.strategy_name, params)
        per_symbol = {}
        for sym, sym_df in cross_data.items():
            if sym == cfg.primary_symbol:
                continue
            try:
                res = run_backtest(
                    sym_df, strat,
                    initial_balance=cfg.initial_balance,
                    commission_rate=cfg.commission_rate,
                    slippage_rate=cfg.slippage_rate,
                    risk_cfg=risk,
                )
                per_symbol[sym] = res.metrics
            except Exception:
                pass
        cross = cross_symbol_score(per_symbol)
        final_candidates.append({
            **cand,
            "cross_symbol": cross,
            "per_symbol_metrics": per_symbol,
            "final_score": cand["wf_score"] + 0.5 * cross.get("robustness_score", 0.0),
        })

    final_candidates.sort(key=lambda r: r["final_score"], reverse=True)
    summary["phases"]["4_cross_symbol"] = {
        "evaluated": len(final_candidates),
        "best_robustness": final_candidates[0]["cross_symbol"] if final_candidates else None,
    }
    if not final_candidates:
        summary["registry"] = {"saved": False, "reason": "no cross-symbol candidates"}
        return summary

    # ────────────────────────────────────────────────────────────────────────
    # Registry: save winner if it passes the strict gate
    # ────────────────────────────────────────────────────────────────────────
    winner = final_candidates[0]
    qualifies, reason = is_valid_for_registry(
        winner["metrics"],
        {"verdict": winner["verdict"], "summary": winner.get("wf_summary")},
        winner.get("cross_symbol"),
    )
    if qualifies:
        path = save_model(
            strategy_name=cfg.strategy_name,
            params=winner["params"],
            metrics=winner["metrics"],
            wf_summary={"verdict": winner["verdict"], "summary": winner.get("wf_summary")},
            cross_symbol=winner.get("cross_symbol"),
            notes=f"feedback_loop {cfg.primary_symbol}; explore={cfg.explore_trials}, exploit={cfg.exploit_trials}",
        )
        summary["registry"] = {"saved": True, "path": str(path), "reason": "passed all gates"}
        log(f"  ✅ Saved → {path}")
    else:
        summary["registry"] = {"saved": False, "reason": reason}
        log(f"  ❌ Rejected: {reason}")

    summary["winner"] = {
        "params": winner["params"],
        "metrics": winner["metrics"],
        "verdict": winner["verdict"],
        "cross_symbol": winner.get("cross_symbol"),
        "final_score": winner["final_score"],
    }
    summary["elapsed_sec"] = round(time.time() - t0, 1)
    return summary
