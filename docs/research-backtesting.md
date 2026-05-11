# Historical backtesting research

This workflow tests the BorsaMan signal engine against local historical OHLCV
files. It does not download market data. Put your own files under
`data/historical/` and run the batch script.

## Data format

Use one file per symbol:

```text
data/historical/THYAO.csv
data/historical/ASELS.csv
data/historical/GARAN.json
```

CSV columns can be comma or semicolon separated. Header aliases are accepted:

```csv
date,open,high,low,close,volume
2024-01-02,100.00,103.00,99.50,102.40,12500000
```

JSON can be either an array of bars or an object with `prices`:

```json
{
  "prices": [
    { "date": "2024-01-02", "open": 100, "high": 103, "low": 99.5, "close": 102.4, "volume": 12500000 }
  ]
}
```

## Run

```powershell
npm run research:backtest -- --data data/historical
```

## Build a Yahoo data pool

The practical maximum free Yahoo pool is layered:

```text
data/yahoo/1d_5y/       5 years daily OHLCV
data/yahoo/1h_730d/     about 2 years hourly OHLCV
data/yahoo/15m_60d/     60 days 15-minute OHLCV
data/yahoo/5m_60d/      60 days 5-minute OHLCV
data/yahoo/1m_7d/       7 days 1-minute OHLCV
```

Dry-run the plan first:

```powershell
npm run data:yahoo -- --list quick --layers max --dry-run
```

Download a small starter pool:

```powershell
npm run data:yahoo -- --list quick --layers max --out data/yahoo
```

Download BIST100 daily first, then add high-detail layers if needed:

```powershell
npm run data:yahoo -- --list bist100 --layers 1d_5y --out data/yahoo
npm run data:yahoo -- --list bist100 --layers 1h_730d,15m_60d,5m_60d,1m_7d --out data/yahoo --sleep-ms 1000
```

Downloaded file names include what they contain:

```text
THYAO.IS__yahoo__1d__1d_5y__20210503_to_20260501.csv
```

Meaning: symbol, source, interval, requested layer, actual first date, actual
last date. A download manifest is also written:

```text
data/yahoo/DOWNLOAD_MANIFEST.csv
data/yahoo/DOWNLOAD_MANIFEST.json
```

Catalog any downloaded folder:

```powershell
npm run data:catalog -- --data data/yahoo --out data/yahoo
```

That writes:

```text
data/yahoo/DATA_CATALOG.csv
data/yahoo/DATA_CATALOG.json
```

Useful focused runs:

```powershell
npm run research:backtest -- --symbols THYAO,ASELS --strategies signal --thresholds 60,65,70,75
npm run research:backtest -- --random-trials 1000 --window-days 252 --oos-days 252 --seed bist-2026 --bot-id borsaman-v2 --data-source bist-datastore-2026-05
npm run research:backtest -- --initial-cash 100000 --position-pct 0.25
npm run research:backtest -- --costs 0.001,0.003,0.006 --thresholds 55,60,65,70,75
npm run research:backtest -- --full-history --limit 5
npm run research:backtest -- --fold-days 252 --step-days 63 --min-trades 10
```

Reports are written to `reports/research/` as JSON and CSV. The CSV contains
every run; the JSON also includes `top`, `bestBySymbol`, config, failures,
trade ledger, and equity curves. A compact bot scoreboard is also written as
`scoreboard-<bot-id>.json`.

## What gets optimized

The runner creates a parameter matrix around the existing engine:

- signal score thresholds
- minimum risk/reward for signal mode
- RSI oversold levels
- maximum holding days
- fallback stop percentages
- fallback target percentages
- trading cost assumptions
- random historical windows
- virtual starting balance
- position size as a fraction of balance

By default it uses rolling walk-forward folds of 252 bars stepped by 63 bars.
That helps avoid trusting a setup that only works in one lucky period.

For thousands of random historical checks, use:

```powershell
npm run research:backtest -- --random-trials 1000 --window-days 252 --seed fixed-seed --bot-id borsaman-v2
```

The seed makes runs reproducible. Change the seed to sample different windows.

## Bot identity and scoreboards

Each row records:

- `runId`: run timestamp or your explicit `--run-id`
- `botId`: bot family, for example `borsaman-v2`
- `variantId`: deterministic ID for the parameter set
- `commitSha`, `branch`, `gitDirty`: exact repo state used for the run
- `dataSource`: source label from `--data-source`
- `variant`: readable parameter string

Use `botId` for comparing bot versions and `variantId` for comparing exact
rules. The scoreboard file is small enough to copy to the Raspberry Pi or sync
to Drive after each research run.

## Metrics to watch

Bot success should be checked from multiple angles:

- sample size: closed trades, symbols tested, folds/windows tested
- per-trade edge: expectancy, win rate, average win/loss, payoff ratio
- efficiency: profit factor and balance profit factor
- account path: final balance, balance return, equity curve, max drawdown
- risk-adjusted return: Sharpe, Sortino, Calmar
- durability: max consecutive losses, drawdown duration, exposure percentage
- robustness: rolling windows, random windows, out-of-sample period, sensitivity
  to fees/slippage and parameter changes

Good candidates should have enough trades, positive expectancy, profit factor
above costs, drawdown you can actually tolerate, and stable behavior across
different date windows. A beautiful result in one date range is not enough.

## Data source priority

Use official or licensed sources for serious scoring:

1. Borsa Istanbul DataStore historical end-of-day and intraday exports.
2. Borsa Istanbul licensed data vendors or institutional feeds.
3. Secondary free sources only for smoke tests or cross-checking, not final
   ranking.

For every imported data batch, keep source name, export date, symbol list,
adjustment policy, and detected data gaps. That makes a bot score explainable
later instead of just "it looked good once."

Reference links:

- Borsa Istanbul historical data sales: https://www.borsaistanbul.com/en/data/historical-data-sales
- Borsa Istanbul data dissemination: https://borsaistanbul.com/en/sayfa/3223/data-dissemination
- CFA Institute backtesting and simulation overview: https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation
- Profit factor definition: https://www.vaultcharts.com/backtesting-metrics/profit-factor
- Expectancy definition: https://www.vaultcharts.com/backtesting-metrics/expectancy

## Important engine change

`genSignal()` returns a normalized 0-100 score. The older backtest entry rule
used `score >= 2.5`, which made the signal strategy far too permissive. The
default signal threshold is now 65 and can be changed per run:

```powershell
npm run research:backtest -- --thresholds 55,60,65,70,75,80
```

## Suggested research loop

1. Pull or confirm the latest repo commit before a research run.
2. Load at least 3-5 years of daily data for BIST30 or BIST100.
3. Run a broad random-window search with fixed seed and bot ID.
4. Open the CSV and filter for enough closed trades, positive expectancy,
   profit factor above 1.2, and controlled drawdown.
5. Re-run narrower ranges around the best candidates.
6. Keep a separate unseen period for final validation before changing live
   trading rules.

This is not investment advice. The goal is to find which rule sets are robust
enough to deserve deeper review, not to guarantee future returns.
