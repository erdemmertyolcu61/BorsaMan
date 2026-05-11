# Telegram bot UX and question catalog

Status: design + runnable local bot skeleton.

## What the current code can answer

The Telegram bot should convert existing BorsaMan outputs into concise chat
answers. Current code gives us these input/output contracts:

| Module | Input | Output usable in Telegram |
| --- | --- | --- |
| `calcAll(prices)` | OHLCV bars | RSI, MACD, MA, Bollinger, ATR, ADX, OBV, MFI, VWAP, Wyckoff, momentum, volume |
| `genSignal(ind, prices)` | indicators + prices | signal, class, score, confidence, entry, stop, targets, R/R, reasons, long-term view |
| `useAIAdvisor.runScan()` | universe/list | top picks, market sentiment, sector rotation, risk alerts |
| `useSignalTracker` | recorded signals | D1/D3/D5/D7 performance, outcome, reliability, win rate, profit factor |
| `AlertLog` | alert list + advisor + portfolio | 24h alert summary, risk, top picks, portfolio snapshot |
| `PerformanceAnalytics` | portfolio positions | win rate, P/L, expectancy, profit factor, Sharpe, max drawdown, streaks |
| `backtest-batch.mjs` | historical files + params | random-window results, equity curve, scoreboard, best variants |
| `data-catalog.mjs` | downloaded CSV files | symbol/source/interval/date range/row count catalog |

## User questions Telegram should support

Single-symbol analysis:

- `THYAO nasil?`
- `ASELS alinir mi?`
- `GARAN hedef stop ne?`
- `TUPRS risk odul kac?`
- `/sor THYAO`
- `/kaydet THYAO`

Market and opportunity questions:

- `Bugun piyasa nasil?`
- `BIST top firsatlar ne?`
- `Yarina hangi hisseler guclu?`
- `Haftalik beklenti ne?`
- `/top`
- `/gun_oncesi`
- `/gun_sonu`

Performance and accountability:

- `Bot bu hafta ne onerdi?`
- `100 bin TL ile girseydik ne olurdu?`
- `Hangi oneriler tuttu?`
- `Kar zarar raporu ver`
- `/hafta 100000`
- `/skor`
- `/rapor hafta`

Data and system questions:

- `Elimizde hangi veri var?`
- `THYAO verisi hangi tarihten geliyor?`
- `1 dakikalik veri var mi?`
- `/katalog`
- `/durum`

Admin questions:

- `/admin`
- `/broadcast gun_oncesi`
- `/broadcast hafta`
- `/users`

## Daily user experience

Pre-market, around 09:15:

```text
BorsaMan Gun Oncesi
Piyasa modu: hazirlik
Veri: yahoo daily + intraday layers
Top adaylar:
1. THYAO - AL, skor 72, R/R 2.1, stop 285.40, hedef 305.20
2. ASELS - AL, skor 69, R/R 1.8
Risk notu: haber/KAP teyidi olmadan tam pozisyon acma.
```

During session:

```text
BorsaMan Canli Uyari
THYAO hedefe yaklasti: +3.2%
Trailing stop aktif: 292.10
```

End of day, around 18:05:

```text
BorsaMan Gun Sonu
Bugun kaydedilen oneriler: 5
Hedef: 1, stop: 0, acik: 4
Sanal bakiye: 100000 -> 101240 TL
En iyi: THYAO +2.8%
En riskli: GARAN stopa 1.1% yakin
```

Friday weekly P/L:

```text
BorsaMan Haftalik Rapor
Baslangic: 100000 TL
Final: 104350 TL
Net: +4350 TL (+4.35%)
Win rate: 58%
Profit factor: 1.74
Max drawdown: -2.1%
Botun en iyi karari: ASELS
Botun en kotu karari: PETKM
```

Weekend review:

```text
BorsaMan Hafta Sonu Degerlendirme
Hangi sinyaller tuttu?
Hangi sinyaller gecersiz kaldi?
Hangi parametreler skor kaybetti?
Gelecek hafta hangi sektorler izlenecek?
```

## Recommendation lifecycle

1. Bot pre-market or manual command creates a recommendation.
2. Recommendation is stored in `reports/telegram/recommendations.json`.
3. Every report updates current/last available price from local data or live feed.
4. Outcome fields are calculated:
   - `TARGET_HIT`
   - `STOP_HIT`
   - `WIN`
   - `LOSS`
   - `OPEN`
5. Weekly report aggregates recommendations into a virtual 100000 TL account.

## Admin model

Furkan and Erdem will be admin users. We need their numeric Telegram user IDs
and chat IDs. Store them outside the repo:

```powershell
$env:TELEGRAM_BOT_TOKEN="..."
$env:TELEGRAM_ADMIN_IDS="123456,789012"
$env:TELEGRAM_BROADCAST_CHAT_IDS="123456,789012"
```

The repo includes only `config/telegram-bot.example.json`.

## First runnable bot command set

Implemented in `scripts/telegram/telegram-bot.mjs`:

- `/start`
- `/help`
- `/durum`
- `/katalog`
- `/top`
- `/sor SYMBOL`
- `/kaydet SYMBOL`
- `/oneriler`
- `/sonuc`
- `/hafta 100000`
- `/skor`
- `/gun_oncesi`
- `/gun_sonu`
- `/admin`

## Important limits

- Current runnable script uses local Yahoo/data files and research reports.
- Live KAP/news/proxy integration should be added after the proxy service is
  stable on RPi.
- Minute-by-minute trade replay needs a stored intraday decision ledger plus
  1m data for the relevant date.
- This is research and simulation output, not investment advice.
