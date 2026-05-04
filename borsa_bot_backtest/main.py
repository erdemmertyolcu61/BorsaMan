"""
main.py - CLI entry point for backtest lab.

Examples:
    python main.py single --symbol ASELS --strategy ma_cross
    python main.py sweep  --symbol ASELS --strategy rsi_reversal --mode random --n 1000
    python main.py wf     --symbol THYAO --strategy bollinger_reversal
"""
from __future__ import annotations

import argparse
import sys
import yaml
from pathlib import Path

from src.data_loader import DataLoader, load_symbols_csv
from src.strategy import STRATEGY_REGISTRY
from src.backtest_engine import run_backtest
from src.walk_forward import walk_forward_run
from src.optimizer import grid_search, random_search
from src.risk_manager import RiskConfig
from src.report import write_run_report, write_sweep_report
from src.feedback_loop import run_feedback_loop, FeedbackConfig
from src.model_registry import load_models


CONFIG_DIR = Path(__file__).parent / "configs"


def load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def cmd_single(args):
    """Single backtest of one strategy on one symbol."""
    data_cfg = load_yaml("data_config.yaml")
    exp_cfg = load_yaml("experiment.yaml")
    StratCls = STRATEGY_REGISTRY[args.strategy]
    params = {}
    if args.params:
        for kv in args.params.split(","):
            k, v = kv.split("=")
            try: v = float(v)
            except ValueError: pass
            params[k.strip()] = v
    strat = StratCls(params)

    loader = DataLoader(
        cache_dir=data_cfg["data"]["cache_dir"],
        processed_dir=data_cfg["data"]["processed_dir"],
    )
    df = loader.fetch_yf(
        args.symbol,
        data_cfg["data"]["start_date"],
        data_cfg["data"]["end_date"],
        data_cfg["data"]["timeframe"],
    )
    if df.empty:
        print(f"[main] No data for {args.symbol}")
        sys.exit(1)

    risk = RiskConfig(
        risk_per_trade=exp_cfg["risk"]["risk_per_trade"],
        max_position_size=exp_cfg["risk"]["max_position_size"],
        max_open_positions=exp_cfg["risk"]["max_open_positions"],
        stop_atr_mult=exp_cfg["risk"]["stop_loss_atr_mult"],
        take_profit_rr=exp_cfg["risk"]["take_profit_rr"],
    )
    result = run_backtest(
        df, strat,
        initial_balance=exp_cfg["experiment"]["initial_balance"],
        commission_rate=exp_cfg["experiment"]["commission_rate"],
        slippage_rate=exp_cfg["experiment"]["slippage_rate"],
        risk_cfg=risk,
    )
    print("\n──── Backtest Sonuclari ────")
    for k, v in result.metrics.items():
        print(f"  {k:24s} {v}")
    out = write_run_report(result, name=f"{args.symbol}_{args.strategy}")
    print(f"\nReport: {out}")


def cmd_sweep(args):
    """Grid or random parameter sweep."""
    data_cfg = load_yaml("data_config.yaml")
    exp_cfg = load_yaml("experiment.yaml")
    strat_cfg = load_yaml("strategy_params.yaml")[args.strategy]

    loader = DataLoader(
        cache_dir=data_cfg["data"]["cache_dir"],
        processed_dir=data_cfg["data"]["processed_dir"],
    )
    df = loader.fetch_yf(
        args.symbol,
        data_cfg["data"]["start_date"],
        data_cfg["data"]["end_date"],
        data_cfg["data"]["timeframe"],
    )
    # Drop 'enabled' from search space
    space = {k: v for k, v in strat_cfg.items() if k != "enabled"}
    if args.mode == "grid":
        out = grid_search(
            df, args.strategy, space,
            initial_balance=exp_cfg["experiment"]["initial_balance"],
            commission_rate=exp_cfg["experiment"]["commission_rate"],
            slippage_rate=exp_cfg["experiment"]["slippage_rate"],
            top_k=args.top_k,
        )
    else:
        out = random_search(df, args.strategy, space, n=args.n)

    print("\n──── Top 10 ────")
    print(out.head(10).to_string())
    p = write_sweep_report(out, name=f"sweep_{args.symbol}_{args.strategy}_{args.mode}")
    print(f"\nReport: {p}")


def cmd_wf(args):
    """Walk-forward validation of a strategy on a symbol."""
    data_cfg = load_yaml("data_config.yaml")
    exp_cfg = load_yaml("experiment.yaml")
    StratCls = STRATEGY_REGISTRY[args.strategy]
    params = {}
    if args.params:
        for kv in args.params.split(","):
            k, v = kv.split("=")
            try: v = float(v)
            except ValueError: pass
            params[k.strip()] = v

    loader = DataLoader()
    df = loader.fetch_yf(
        args.symbol,
        data_cfg["data"]["start_date"],
        data_cfg["data"]["end_date"],
        data_cfg["data"]["timeframe"],
    )
    wf = walk_forward_run(df, StratCls(params), n_windows=exp_cfg["backtest"]["walk_forward"]["n_windows"])
    print(f"\nVerdict: {wf['verdict']}")
    print(f"Summary: {wf.get('summary')}")
    for w in wf.get("windows", []):
        print(f"  Window {w['window']}: IS={w['is_return_pct']:.1f}% OOS={w['oos_return_pct']:.1f}% eff={w['efficiency']:.2f}")


def cmd_feedback(args):
    """4-phase Optuna feedback loop with cross-validation."""
    data_cfg = load_yaml("data_config.yaml")
    exp_cfg = load_yaml("experiment.yaml")

    loader = DataLoader(
        cache_dir=data_cfg["data"]["cache_dir"],
        processed_dir=data_cfg["data"]["processed_dir"],
    )
    df_primary = loader.fetch_yf(
        args.symbol,
        data_cfg["data"]["start_date"],
        data_cfg["data"]["end_date"],
        data_cfg["data"]["timeframe"],
    )
    if df_primary.empty:
        print(f"[main] No primary data for {args.symbol}")
        sys.exit(1)

    # Cross-validation universe (excluding primary)
    cross_syms = [s.strip().upper() for s in (args.cross or "").split(",") if s.strip()]
    if not cross_syms:
        cross_syms = [s for s in load_symbols_csv("./data/symbols.csv") if s != args.symbol][: args.cross_n]
    cross_data = loader.fetch_universe(
        cross_syms,
        data_cfg["data"]["start_date"],
        data_cfg["data"]["end_date"],
        data_cfg["data"]["timeframe"],
    )
    print(f"[main] Cross-validation symbols loaded: {len(cross_data)}")

    cfg = FeedbackConfig(
        strategy_name=args.strategy,
        primary_symbol=args.symbol,
        cross_validation_symbols=list(cross_data.keys()),
        explore_trials=args.explore,
        exploit_trials=args.exploit,
        walk_forward_top_k=args.wf_top_k,
        cross_validation_top_k=args.cross_top_k,
        n_walk_windows=exp_cfg["backtest"]["walk_forward"]["n_windows"],
        initial_balance=exp_cfg["experiment"]["initial_balance"],
        commission_rate=exp_cfg["experiment"]["commission_rate"],
        slippage_rate=exp_cfg["experiment"]["slippage_rate"],
        include_risk_search=args.risk_search,
        persist_study=not args.no_persist,
    )
    summary = run_feedback_loop(df_primary, cross_data, cfg)
    print("\n──── Feedback Loop Summary ────")
    import json
    print(json.dumps(summary, indent=2, default=str))


def cmd_registry(args):
    """List validated models in best_models/."""
    models = load_models(strategy_name=args.strategy)
    if not models:
        print("(empty registry — run `feedback` to populate)")
        return
    print(f"\n──── {len(models)} validated model(s) ────")
    for m in models:
        print(f"\n● {m['strategy']} — saved {m['saved_at']}")
        print(f"  params: {m['params']}")
        mt = m.get("metrics", {})
        print(f"  return={mt.get('total_return_pct'):.1f}%  dd={mt.get('max_drawdown_pct'):.1f}%  "
              f"sharpe={mt.get('sharpe_ratio'):.2f}  trades={mt.get('trade_count')}")
        if m.get("cross_symbol"):
            cs = m["cross_symbol"]
            print(f"  cross-symbol: {cs.get('pct_profitable_symbols'):.0f}% profitable, "
                  f"median={cs.get('median_return_pct'):.1f}%")


def main():
    parser = argparse.ArgumentParser(description="BIST Backtest Lab")
    sub = parser.add_subparsers(dest="cmd")

    p1 = sub.add_parser("single", help="Single backtest")
    p1.add_argument("--symbol", required=True)
    p1.add_argument("--strategy", required=True, choices=list(STRATEGY_REGISTRY.keys()))
    p1.add_argument("--params", default="", help="comma-separated k=v pairs")

    p2 = sub.add_parser("sweep", help="Parameter sweep")
    p2.add_argument("--symbol", required=True)
    p2.add_argument("--strategy", required=True, choices=list(STRATEGY_REGISTRY.keys()))
    p2.add_argument("--mode", default="random", choices=["grid", "random"])
    p2.add_argument("--n", type=int, default=1000)
    p2.add_argument("--top-k", type=int, default=20)

    p3 = sub.add_parser("wf", help="Walk-forward validation")
    p3.add_argument("--symbol", required=True)
    p3.add_argument("--strategy", required=True, choices=list(STRATEGY_REGISTRY.keys()))
    p3.add_argument("--params", default="")

    p4 = sub.add_parser("feedback", help="4-phase Optuna feedback loop with cross-validation")
    p4.add_argument("--symbol", required=True, help="Primary symbol for optimization")
    p4.add_argument("--strategy", required=True, choices=list(STRATEGY_REGISTRY.keys()))
    p4.add_argument("--explore", type=int, default=300, help="Phase 1: random/explore trials")
    p4.add_argument("--exploit", type=int, default=200, help="Phase 2: TPE-focused trials")
    p4.add_argument("--wf-top-k", type=int, default=30, help="Phase 3: walk-forward this many top candidates")
    p4.add_argument("--cross-top-k", type=int, default=8, help="Phase 4: cross-validate this many WF survivors")
    p4.add_argument("--cross", default="", help="Comma-separated symbols for cross-validation (default: top 10 from symbols.csv)")
    p4.add_argument("--cross-n", type=int, default=10, help="If --cross empty, use top N from symbols.csv")
    p4.add_argument("--risk-search", action="store_true", help="Also optimize risk params (slower)")
    p4.add_argument("--no-persist", action="store_true", help="Disable SQLite study persistence")

    p5 = sub.add_parser("registry", help="List validated models")
    p5.add_argument("--strategy", default=None)

    args = parser.parse_args()
    if args.cmd == "single":
        cmd_single(args)
    elif args.cmd == "sweep":
        cmd_sweep(args)
    elif args.cmd == "wf":
        cmd_wf(args)
    elif args.cmd == "feedback":
        cmd_feedback(args)
    elif args.cmd == "registry":
        cmd_registry(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
