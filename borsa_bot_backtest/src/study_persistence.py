"""
study_persistence.py - SQLite-backed Optuna study persistence.

Allows long-running optimization to be paused/resumed across CLI invocations.
Studies live in results/optuna_studies/<name>.db
"""
from __future__ import annotations
from pathlib import Path
from typing import Optional


def get_storage_url(study_name: str, base_dir: str = "./results/optuna_studies") -> str:
    p = Path(base_dir)
    p.mkdir(parents=True, exist_ok=True)
    db_path = p / f"{study_name}.db"
    return f"sqlite:///{db_path.resolve()}"


def create_or_load_study(
    study_name: str,
    direction: str = "maximize",
    base_dir: str = "./results/optuna_studies",
    sampler: Optional[object] = None,
    pruner: Optional[object] = None,
):
    """Create a new study or resume an existing one with the same name."""
    try:
        import optuna
    except ImportError:
        raise RuntimeError("Install optuna: pip install optuna")

    storage = get_storage_url(study_name, base_dir)
    return optuna.create_study(
        study_name=study_name,
        storage=storage,
        direction=direction,
        sampler=sampler or optuna.samplers.TPESampler(seed=42, n_startup_trials=20),
        pruner=pruner,
        load_if_exists=True,
    )


def list_studies(base_dir: str = "./results/optuna_studies") -> list:
    p = Path(base_dir)
    if not p.exists():
        return []
    return [f.stem for f in p.glob("*.db")]
