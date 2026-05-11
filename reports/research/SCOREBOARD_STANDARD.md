# BorsaMan bot scoreboard standard

Status: active local note, also mirrored to Raspberry Pi.

## Purpose

Standardize thousands of historical random-date tests so every BorsaMan bot
version can be compared by the same rules.

## Required run command pattern

```powershell
npm run research:backtest -- --data data/historical --data-source bist-datastore-YYYY-MM --random-trials 1000 --window-days 252 --oos-days 252 --seed fixed-seed --bot-id borsaman-v2 --initial-cash 100000 --position-pct 0.25 --costs 0.001,0.003,0.006
```

## Required identifiers

- `botId`: bot family or release, for example `borsaman-v2`.
- `variantId`: deterministic ID for the exact parameter set.
- `runId`: timestamp or manually supplied run ID.
- `commitSha`: Git commit used for the test.
- `branch`: Git branch used for the test.
- `gitDirty`: whether local uncommitted changes existed.
- `dataSource`: source/export label for the historical data.

## Required per-trade metrics

- trade count
- closed trade count
- wins and losses
- win rate
- average win
- average loss
- payoff ratio
- expectancy
- profit factor
- max consecutive wins
- max consecutive losses

## Required balance metrics

- initial cash
- position percentage
- final balance
- net profit/loss amount
- balance return percentage
- balance profit factor
- equity curve
- max balance drawdown amount
- max balance drawdown percentage

## Required robustness checks

- rolling window folds: `--fold-days` and `--step-days`
- random historical windows: `--random-trials`, `--window-days`, `--seed`
- out-of-sample tail fold: `--oos-days`
- fee/slippage sensitivity: `--costs`
- parameter sensitivity: thresholds, max holds, stops, targets, min RR, RSI levels

## Output files

Local:

```text
reports/research/backtest-research-<run-id>.json
reports/research/backtest-research-<run-id>.csv
reports/research/scoreboard-<bot-id>.json
```

Raspberry Pi mirror:

```text
/home/rpi/BorsaMan/reports/research/SCOREBOARD_STANDARD.md
/home/rpi/BorsaMan/reports/research/scoreboard-<bot-id>.json
```

Google Drive target:

```text
Drive/BorsaMan/research/
```

Drive sync method is still undecided: Google Drive connector, Google Drive API,
or rclone. Do not store private credentials in the repo.

## Acceptance rule

A bot/variant is not considered strong from one high score alone. It needs:

- enough closed trades
- positive expectancy
- profit factor above realistic costs
- tolerable drawdown
- stable results across rolling windows, random windows, and out-of-sample
- no obvious sensitivity collapse when fees/slippage or parameters move
