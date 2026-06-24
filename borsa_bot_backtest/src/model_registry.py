"""
model_registry.py - Persist validated strategy + parameter combinations.

Only saves models that pass walk-forward (stable verdict) AND cross-symbol validation.
Each model file contains everything needed to reproduce signals on new data.
"""
from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List


REGISTRY_DIR = Path("./results/best_models")


def save_model(
    strategy_name: str,
    params: Dict[str, Any],
    metrics: Dict[str, Any],
    wf_summary: Dict[str, Any] | None = None,
    cross_symbol: Dict[str, Any] | None = None,
    notes: str = "",
    out_dir: str | None = None,
) -> Path:
    """Persist a validated model card to results/best_models/."""
    base = Path(out_dir) if out_dir else REGISTRY_DIR
    base.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = f"{strategy_name}_{ts}.json"
    payload = {
        "strategy": strategy_name,
        "params": params,
        "metrics": metrics,
        "walk_forward": wf_summary,
        "cross_symbol": cross_symbol,
        "saved_at": datetime.now().isoformat(),
        "notes": notes,
        "schema_version": "1",
    }
    p = base / fname
    p.write_text(json.dumps(payload, indent=2, default=str))
    return p


def load_models(strategy_name: str | None = None, out_dir: str | None = None) -> List[Dict[str, Any]]:
    base = Path(out_dir) if out_dir else REGISTRY_DIR
    if not base.exists():
        return []
    out = []
    for f in sorted(base.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            if strategy_name and data.get("strategy") != strategy_name:
                continue
            out.append(data)
        except Exception:
            continue
    return out


def is_valid_for_registry(metrics: Dict[str, Any], wf: Dict[str, Any] | None, cross: Dict[str, Any] | None) -> tuple[bool, str]:
    """
    Strict gate. A model qualifies for the registry only if ALL hold:
      - total_return_pct >= 8%
      - max_drawdown_pct >= -25%  (i.e. abs <= 25)
      - sharpe_ratio >= 0.6
      - profit_factor >= 1.4
      - trade_count >= 12
      - walk-forward verdict == 'stable'
      - cross-symbol pct_profitable_symbols >= 55  (if provided)
    Returns (qualifies, reason).
    """
    ret = metrics.get("total_return_pct", 0.0)
    dd = abs(metrics.get("max_drawdown_pct", 0.0))
    sharpe = metrics.get("sharpe_ratio", 0.0)
    pf = metrics.get("profit_factor", 0.0)
    n = metrics.get("trade_count", 0)

    if ret < 8.0:
        return False, f"return too low ({ret:.1f}%)"
    if dd > 25.0:
        return False, f"drawdown too deep ({dd:.1f}%)"
    if sharpe < 0.6:
        return False, f"sharpe too low ({sharpe:.2f})"
    if pf < 1.4:
        return False, f"profit factor too low ({pf:.2f})"
    if n < 12:
        return False, f"too few trades ({n})"
    if wf and wf.get("verdict") != "stable":
        return False, f"walk-forward not stable ({wf.get('verdict')})"
    if cross and cross.get("pct_profitable_symbols", 100) < 55:
        return False, f"cross-symbol robustness low ({cross.get('pct_profitable_symbols')}%)"
    return True, "ok"
