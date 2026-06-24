"""Moving Average Crossover Strategy (golden cross / death cross)."""
import pandas as pd
import numpy as np
from .base import Strategy


class MACrossStrategy(Strategy):
    name = "ma_cross"

    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        short = int(self.params.get("ma_short", 20))
        long_ = int(self.params.get("ma_long", 50))
        filter_ma200 = bool(self.params.get("filter_ma200", False))

        close = df["close"].astype(float)
        ma_s = close.rolling(short).mean()
        ma_l = close.rolling(long_).mean()
        signals = pd.Series("HOLD", index=df.index)

        # Bullish cross
        bull_cross = (ma_s > ma_l) & (ma_s.shift(1) <= ma_l.shift(1))
        # Bearish cross
        bear_cross = (ma_s < ma_l) & (ma_s.shift(1) >= ma_l.shift(1))

        if filter_ma200:
            ma200 = close.rolling(200).mean()
            bull_cross = bull_cross & (close > ma200)

        signals[bull_cross] = "BUY"
        signals[bear_cross] = "SELL"
        return signals
