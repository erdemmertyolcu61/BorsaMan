# BIST Backtest Lab

Geçmiş veri üzerinde **binlerce al-sat denemesi** yaparak strateji + risk parametre kombinasyonlarını test eden bağımsız Python modülü. Mevcut React/Electron sistemini etkilemez — paralel laboratuvar.

⚠ **Eğitim/backtest amaçlıdır. Yatırım tavsiyesi değildir.**

## Hızlı Başlangıç

```bash
cd borsa_bot_backtest
pip install -r requirements.txt

# 1) Tek strateji backtest
python main.py single --symbol ASELS --strategy ma_cross --params ma_short=20,ma_long=50

# 2) Random sweep — 1000 farklı parametre
python main.py sweep --symbol THYAO --strategy rsi_reversal --mode random --n 1000

# 3) Walk-forward validation — overfit tespiti
python main.py wf --symbol GARAN --strategy bollinger_reversal
```

## Klasör Yapısı

```
borsa_bot_backtest/
├─ configs/               # YAML ile yapılandırma (experiment, data, strategy)
├─ data/
│  ├─ raw/               # yfinance Parquet cache (ilk fetch sonrası tekrar indirmez)
│  ├─ processed/         # temizlenmiş veri
│  └─ symbols.csv        # 30 BIST evren listesi (genişletilebilir)
├─ src/
│  ├─ data_loader.py     # yfinance/CSV → standart OHLCV
│  ├─ risk_manager.py    # ATR-bazlı stop, position sizing
│  ├─ backtest_engine.py # event-driven core (commission + slippage + trailing)
│  ├─ walk_forward.py    # IS/OOS rolling validation
│  ├─ optimizer.py       # grid + random + Optuna
│  ├─ report.py          # CSV + JSON + HTML çıktı
│  └─ strategy/          # MA Cross, RSI, Bollinger (genişletilebilir)
├─ results/
│  ├─ runs/              # tek backtest çıktıları
│  ├─ reports/           # sweep CSV'leri
│  └─ best_models/       # validate edilen şampiyonlar
└─ main.py               # CLI
```

## Veri Akışı

1. `DataLoader.fetch_yf()` → Yahoo Finance (BIST hisse `.IS` suffix)
2. İlk indirmede Parquet cache → sonraki çağrılar 10× hızlı
3. `Strategy.generate_signals(df)` → `BUY/SELL/HOLD` Series
4. `run_backtest(df, strategy)` → Trade list + equity curve + 8 metrik
5. `walk_forward_run(...)` → 4 pencere IS/OOS test, verdict: stable/borderline/overfit
6. `grid_search` / `random_search` / `optuna_optimize` → en iyi N parametre

## Metrikler

| Metrik | Anlam |
|---|---|
| `total_return_pct` | Strateji toplam getirisi (%) |
| `max_drawdown_pct` | En kötü tepeden-dipe düşüş |
| `sharpe_ratio` | Risk-ayarlı getiri (252 işgünü annualize) |
| `win_rate_pct` | Kazanan trade oranı |
| `profit_factor` | Brüt kar / brüt zarar |
| `avg_trade_pct` | Ortalama trade getirisi |
| `trade_count` | Toplam trade sayısı |

## Strateji Ekleme

```python
# src/strategy/my_strategy.py
from .base import Strategy
import pandas as pd

class MyStrategy(Strategy):
    name = "my_strategy"
    def generate_signals(self, df: pd.DataFrame) -> pd.Series:
        signals = pd.Series("HOLD", index=df.index)
        # ... your logic
        return signals
```

`src/strategy/__init__.py`'ye `STRATEGY_REGISTRY['my_strategy'] = MyStrategy` ekle.
`configs/strategy_params.yaml`'a parametre uzayını ekle.

## React/Electron Sistemiyle İlişki

- Tamamen bağımsız çalışır, JavaScript projesini etkilemez
- Aynı sembol evrenini kullanır (BIST tickers)
- Gelecekte: backtest sonuçları `results/best_models/`'dan JSON olarak terminal UI'a beslenebilir

## Roadmap

- [x] Aşama 1-2: Veri yükleyici + tek hisse/tek strateji backtest
- [x] Aşama 3-4: Çoklu hisse + grid/random sweep
- [x] Aşama 5: CSV + HTML rapor
- [x] Aşama 6: Walk-forward validation
- [x] **Aşama 7: 4-fazlı Optuna feedback loop + model registry**
  - Phase 1+2: TPE explore→exploit (300+200 trials, SQLite-persistent)
  - Phase 3: Walk-forward overfit filter (top 30 → stable verdict)
  - Phase 4: Cross-symbol robustness (8 candidates × N farklı hisse)
  - Strict registry gate: ret≥%8, |DD|≤%25, sharpe≥0.6, PF≥1.4, trades≥12, WF stable, cross≥%55
  - Sadece bu kapıdan geçen modeller `results/best_models/` altına persist edilir
  - Komut: `python main.py feedback --symbol ASELS --strategy ma_cross --risk-search`
  - Kayıtları gör: `python main.py registry`
- [ ] Aşama 8: Paper trading simülasyonu
- [ ] Aşama 9: Canlı veri bağlantısı (read-only)
- [ ] Aşama 10: Risk-limitli emir sistemi (production gate)
