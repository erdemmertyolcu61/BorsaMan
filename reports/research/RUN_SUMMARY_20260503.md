# BorsaMan Research Run Summary - 2026-05-03

## Dataset

- Source: `data/yahoo/1d_5y`
- Label: `yahoo-quick-1d-5y`
- Symbols: 12 large BIST symbols
- Bars: about 1,249 daily bars per symbol, from 2021-05-03 to 2026-04-30

## Random Window Run

Command shape:

```bash
node scripts/research/backtest-batch.mjs \
  --data data/yahoo/1d_5y \
  --data-source yahoo-quick-1d-5y \
  --strategies signal \
  --thresholds 55,65,75 \
  --max-holds 15,25 \
  --stops 0.05 \
  --targets 0.06 \
  --costs 0.0015,0.003 \
  --min-rrs 0,1 \
  --random-trials 100 \
  --window-days 252 \
  --oos-days 252 \
  --seed borsaman-efficiency-20260503 \
  --bot-id borsaman-efficiency-v1 \
  --initial-cash 100000 \
  --position-pct 0.25 \
  --min-trades 3
```

Outputs:

- `reports/research/backtest-research-20260503-105149.json`
- `reports/research/backtest-research-20260503-105149.csv`
- `reports/research/scoreboard-borsaman-efficiency-v1.json`

Results:

- Total runs: 29,088
- Failures: 0
- Best robustness variant: `signal_s75_rr1_h15_sl0.05_tp0.06_c0.0015`
- Eligible samples: 41
- Closed trades: 149
- Average win rate: 66.3008%
- Average payoff: 5.2266
- Average expectancy: 2.4426%
- Average profit factor: 10.798
- Median balance return: 2.644%
- Average balance return: 2.4455%
- Positive sample rate: 100%
- Worst balance drawdown: 1.6961%
- Random average return: 2.4522%
- OOS average return: 2.1758%
- Robustness score: 85.6499

## Rolling Window Run

Command shape:

```bash
node scripts/research/backtest-batch.mjs \
  --data data/yahoo/1d_5y \
  --data-source yahoo-quick-1d-5y \
  --strategies signal \
  --thresholds 55,65,75 \
  --max-holds 15,25 \
  --stops 0.05 \
  --targets 0.06 \
  --costs 0.0015,0.003 \
  --min-rrs 0,1 \
  --fold-days 252 \
  --step-days 63 \
  --oos-days 252 \
  --seed borsaman-rolling-20260503 \
  --bot-id borsaman-efficiency-rolling-v1 \
  --initial-cash 100000 \
  --position-pct 0.25 \
  --min-trades 3
```

Outputs:

- `reports/research/backtest-research-20260503-112104.json`
- `reports/research/backtest-research-20260503-112104.csv`
- `reports/research/scoreboard-borsaman-efficiency-rolling-v1.json`

Results:

- Total runs: 5,184
- Best robustness variant: `signal_s75_rr1_h15_sl0.05_tp0.06_c0.0015`
- Eligible samples: 9
- Closed trades: 33
- Average win rate: 67.4074%
- Average payoff: 6.4764
- Average expectancy: 3.0414%
- Average profit factor: 13.4559
- Median balance return: 2.6565%
- Average balance return: 2.9509%
- Positive sample rate: 100%
- Worst balance drawdown: 1.6961%
- Rolling average return: 3.0478%
- OOS average return: 2.1758%
- Robustness score: 90.4893

## Interpretation

The first strong candidate is strict:

```text
strategy = signal
signal threshold = 75
min RR = 1
max hold = 15 days
fallback stop = 5%
fallback target = 6%
per-side cost = 0.15%
```

This is promising but not final. The sample is still limited to 12 Yahoo daily
symbols. Before calling it production-grade, repeat with wider BIST coverage,
licensed/cleaner data, and stricter no-selection-bias reporting.

