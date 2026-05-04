"""Strategy modules — each exposes generate_signals(df, params) → 'BUY'/'SELL'/'HOLD' series."""
from .base import Strategy
from .ma_cross import MACrossStrategy
from .rsi_reversal import RSIReversalStrategy
from .bollinger_reversal import BollingerReversalStrategy

STRATEGY_REGISTRY = {
    "ma_cross": MACrossStrategy,
    "rsi_reversal": RSIReversalStrategy,
    "bollinger_reversal": BollingerReversalStrategy,
}
