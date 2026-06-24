"""Strategy base class — every strategy returns a Pandas Series of signals."""
from __future__ import annotations
import pandas as pd
from typing import Dict, Any


class Strategy:
    """
    All strategies share one interface:
        signals = strategy.generate_signals(df, params)
        signals: pd.Series of {'BUY', 'SELL', 'HOLD'} aligned to df.index
    """

    name: str = "base"

    def __init__(self, params: Dict[str, Any] | None = None):
        self.params = params or {}

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        raise NotImplementedError

    @classmethod
    def from_params(cls, params: Dict[str, Any]):
        return cls(params)
