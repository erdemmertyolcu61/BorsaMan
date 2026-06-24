"""
data_loader.py - BIST OHLCV data acquisition.

Caches raw downloads to data/raw/ as Parquet (10x faster reload than CSV).
Standardizes columns: datetime, open, high, low, close, volume, symbol
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import pandas as pd
import numpy as np

try:
    import yfinance as yf
except ImportError:
    yf = None

REQUIRED_COLS = ["datetime", "open", "high", "low", "close", "volume", "symbol"]


class DataLoader:
    """Load BIST symbol OHLCV from yfinance / CSV / parquet, with on-disk cache."""

    def __init__(self, cache_dir: str = "./data/raw", processed_dir: str = "./data/processed"):
        self.cache_dir = Path(cache_dir)
        self.processed_dir = Path(processed_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.processed_dir.mkdir(parents=True, exist_ok=True)

    # ──────────────────────────────────────────────────────────────────────
    # yfinance fetcher
    # ──────────────────────────────────────────────────────────────────────
    def _yf_symbol(self, symbol: str) -> str:
        """BIST symbols on Yahoo: 'ASELS' → 'ASELS.IS'"""
        s = symbol.strip().upper()
        return s if s.endswith(".IS") else f"{s}.IS"

    def _cache_path(self, symbol: str, timeframe: str) -> Path:
        clean = symbol.replace(".IS", "")
        return self.cache_dir / f"{clean}_{timeframe}.parquet"

    def fetch_yf(
        self,
        symbol: str,
        start: str,
        end: str,
        timeframe: str = "1d",
        force_refresh: bool = False,
    ) -> pd.DataFrame:
        """
        Fetch single-symbol OHLCV from Yahoo Finance.
        Returns DataFrame with columns matching REQUIRED_COLS.
        """
        if yf is None:
            raise RuntimeError("yfinance not installed. pip install yfinance")

        cache_p = self._cache_path(symbol, timeframe)
        if cache_p.exists() and not force_refresh:
            df = pd.read_parquet(cache_p)
            df_start = df["datetime"].min()
            df_end = df["datetime"].max()
            req_start = pd.Timestamp(start, tz=df_start.tz) if df_start.tz else pd.Timestamp(start)
            req_end = pd.Timestamp(end, tz=df_end.tz) if df_end.tz else pd.Timestamp(end)
            # If cache covers requested range, slice and return
            if df_start <= req_start and df_end >= req_end:
                mask = (df["datetime"] >= req_start) & (df["datetime"] <= req_end)
                return df.loc[mask].reset_index(drop=True)

        yf_sym = self._yf_symbol(symbol)
        ticker = yf.Ticker(yf_sym)
        try:
            raw = ticker.history(start=start, end=end, interval=timeframe, auto_adjust=False)
        except Exception as e:
            print(f"[data_loader] {symbol}: yfinance error: {e}")
            return pd.DataFrame(columns=REQUIRED_COLS)

        if raw is None or raw.empty:
            return pd.DataFrame(columns=REQUIRED_COLS)

        df = raw.reset_index().rename(
            columns={
                "Date": "datetime",
                "Datetime": "datetime",
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Volume": "volume",
            }
        )
        df["symbol"] = symbol.replace(".IS", "")
        df = df[REQUIRED_COLS].copy()
        df = df.dropna(subset=["close"])

        # Persist to cache
        try:
            df.to_parquet(cache_p, index=False)
        except Exception as e:
            print(f"[data_loader] {symbol}: cache write failed: {e}")
        return df

    def fetch_universe(
        self,
        symbols: List[str],
        start: str,
        end: str,
        timeframe: str = "1d",
        force_refresh: bool = False,
    ) -> Dict[str, pd.DataFrame]:
        """Fetch many symbols. Returns dict {symbol: DataFrame}."""
        out = {}
        for sym in symbols:
            try:
                df = self.fetch_yf(sym, start, end, timeframe, force_refresh)
                if not df.empty and len(df) >= 60:
                    out[sym] = df
                else:
                    print(f"[data_loader] {sym}: insufficient data ({len(df)} bars)")
            except Exception as e:
                print(f"[data_loader] {sym}: failed — {e}")
        return out

    # ──────────────────────────────────────────────────────────────────────
    # CSV fetcher (offline / pre-downloaded data)
    # ──────────────────────────────────────────────────────────────────────
    def fetch_csv(self, symbol: str, csv_path: str) -> pd.DataFrame:
        df = pd.read_csv(csv_path)
        df.columns = [c.lower() for c in df.columns]
        if "datetime" not in df.columns:
            for alt in ("date", "time", "timestamp"):
                if alt in df.columns:
                    df = df.rename(columns={alt: "datetime"})
                    break
        df["datetime"] = pd.to_datetime(df["datetime"])
        if "symbol" not in df.columns:
            df["symbol"] = symbol
        return df[REQUIRED_COLS].dropna(subset=["close"])


def load_symbols_csv(path: str = "./data/symbols.csv") -> List[str]:
    """Read symbol universe from CSV."""
    df = pd.read_csv(path)
    return df["symbol"].astype(str).str.upper().tolist()


if __name__ == "__main__":
    # Smoke test
    loader = DataLoader()
    df = loader.fetch_yf("ASELS", "2024-01-01", "2024-06-01")
    print(df.head())
    print(f"Loaded {len(df)} bars for ASELS")
