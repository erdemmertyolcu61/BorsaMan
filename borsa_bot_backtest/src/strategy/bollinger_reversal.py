"""Bollinger Band reversion — buy at lower band, exit at mean or upper."""
import pandas as pd
from .base import Strategy


class BollingerReversalStrategy(Strategy):
    name = "bollinger_reversal"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        period = int(self.params.get("period", 20))
        std_mult = float(self.params.get("std", 2.0))
        exit_mode = str(self.params.get("exit_mode", "mean"))

        close = df["close"].astype(float)
        ma = close.rolling(period).mean()
        sd = close.rolling(period).std()
        upper = ma + std_mult * sd
        lower = ma - std_mult * sd

        signals = pd.Series("HOLD", index=df.index)
        # Buy: close crosses up through lower band
        signals[(close > lower) & (close.shift(1) <= lower.shift(1))] = "BUY"
        # Sell: at mean or opposite band
        if exit_mode == "mean":
            signals[(close >= ma) & (close.shift(1) < ma.shift(1))] = "SELL"
        else:
            signals[(close >= upper) & (close.shift(1) < upper.shift(1))] = "SELL"
        return signals
