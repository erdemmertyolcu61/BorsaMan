"""
report.py - HTML/CSV report writers for backtest output.

Persists results into results/runs/{name}/ with:
  - trades.csv
  - equity.csv
  - metrics.json
  - report.html (Plotly-based, optional)
"""
from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime
import pandas as pd

from .backtest_engine import BacktestResult


def write_run_report(
    result: BacktestResult,
    out_dir: str = "./results/runs",
    name: str = None,
    extra: dict = None,
) -> Path:
    name = name or f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    p = Path(out_dir) / name
    p.mkdir(parents=True, exist_ok=True)

    # CSVs
    if result.trades is not None and not result.trades.empty:
        result.trades.to_csv(p / "trades.csv", index=False)
    pd.DataFrame({"datetime": result.equity_curve.index, "equity": result.equity_curve.values}).to_csv(
        p / "equity.csv", index=False
    )

    # Metrics
    payload = {**result.metrics, "initial_balance": result.initial_balance, "final_balance": result.final_balance}
    if extra:
        payload.update(extra)
    (p / "metrics.json").write_text(json.dumps(payload, indent=2, default=str))

    # Optional HTML chart (if plotly available)
    try:
        import plotly.graph_objects as go
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=result.equity_curve.index, y=result.equity_curve.values, name="Equity"))
        fig.update_layout(title=f"Equity Curve — {name}", height=420)
        fig.write_html(str(p / "equity.html"))
    except ImportError:
        pass

    return p


def write_sweep_report(df: pd.DataFrame, out_dir: str = "./results/reports", name: str = None) -> Path:
    name = name or f"sweep_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    p = Path(out_dir) / f"{name}.csv"
    p.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(p, index=False)
    return p
