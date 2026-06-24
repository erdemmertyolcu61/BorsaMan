"""RSI Mean-Reversion Strategy."""
import pandas as pd
from .base import Strategy


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, 1e-10)
    return 100 - (100 / (1 + rs))


class RSIReversalStrategy(Strategy):
    name = "rsi_reversal"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        period = int(self.params.get("rsi_period", 14))
        oversold = float(self.params.get("oversold", 30))
        overbought = float(self.params.get("overbought", 70))

        close = df["close"].astype(float)
        rsi = _rsi(close, period)

        signals = pd.Series("HOLD", index=df.index)
        # Buy when RSI crosses up through oversold
        cross_up = (rsi > oversold) & (rsi.shift(1) <= oversold)
        # Sell when RSI crosses down through overbought
        cross_dn = (rsi < overbought) & (rsi.shift(1) >= overbought)

        signals[cross_up] = "BUY"
        signals[cross_dn] = "SELL"
        return signals
