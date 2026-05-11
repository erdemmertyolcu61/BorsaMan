# BorsaMan Telegram

Standalone Telegram bridge for BorsaMan.

This project is intentionally separate from `/home/rpi/BorsaMan`. For now it can
reuse the existing wifidog bot token through a token source file, and later it
can be switched to a dedicated BorsaMan bot by editing `config.json` or setting
an environment variable.

## Token priority

The bot reads the token in this order:

1. `BMAN_TG_TOKEN`
2. `TELEGRAM_BOT_TOKEN`
3. `telegram_token` in `config.json`
4. `token_source_json` + `token_source_key` in `config.json`

Admin chat IDs are read in this order:

1. `BMAN_TG_ADMIN_CHAT_IDS`
2. `TELEGRAM_ADMIN_IDS`
3. `admin_chat_ids` in `config.json`
4. `admin_chat_id_source_json` + `admin_chat_id_source_key` in `config.json`

## Useful commands

```bash
python3 bot.py --getme
python3 bot.py --once /durum
python3 bot.py --once /gunluk
python3 bot.py --once /kapanis
python3 bot.py
```

## Telegram commands

- `/start` or `menu`
- `/durum`
- `/web`
- `/gunluk`
- `/kapanis`
- `/ai soru`
- `/test ...`
- `/testdurum [jobId]`
- `/raporlar`
- `/dokuman [ad]`
- `/katalog`
- `/skor`
- `/yardim`
- `/ping`

The persistent Telegram keyboard sends slash commands now (`/gunluk`,
`/site`, `/testdurum`, etc.), so tapping a button follows the same path as
typing the command. Older inline/callback buttons are also handled and acked
quickly.

## Scheduled trade reports

When `trade_reports_enabled` is true, the bot sends reports to admin chat IDs
on weekdays:

- `morning_report_time`: daily trade plan, default `09:30`
- `closing_report_time`: target/stop/closing summary, default `18:10`

The bot writes the plan and closing evaluation to `state/trade-ledger.json`.
The public web URL shown by `/durum` and `/web` is `public_web_url`, currently
`https://bman.ta7tur.com/`.

## Gemini notes

Gemini is optional. The bot looks for the key in this order:

1. `BMAN_GEMINI_API_KEY`
2. `GEMINI_API_KEY`
3. `GOOGLE_API_KEY`
4. `gemini_api_key` in `config.json`
5. `gemini_api_key_source_json` with one of `gemini_api_key`, `google_api_key`,
   `GEMINI_API_KEY`, `GOOGLE_API_KEY`

When `gemini_append_to_reports` is true and a key is found, `/gunluk`,
`/kapanis`, and scheduled reports can include a short Gemini note. For speed,
manual `/gunluk` and `/kapanis` skip Gemini unless
`gemini_append_to_manual_reports` is true. `/ai soru` answers an admin question
using the current trade ledger context.

## Research panel

The bot can start bounded backtest jobs in the background:

```bash
python3 bot.py --once "/test symbols=THYAO,ASELS trials=50 window=252 bot=quick"
python3 bot.py --once "/testdurum"
python3 bot.py --once "/raporlar"
python3 bot.py --once "/dokuman komutlar"
```

Runtime job state is written to `state/research-jobs.json`. Reports are written
by BorsaMan's research script under `reports/research/`.

For local/admin dry-runs outside the RPi, set `BMAN_ROOT` to the BorsaMan repo
root so `/raporlar` and `/dokuman` read the right folders.

## RPi service handoff

On the RPi this bot runs as a standalone systemd service:

```bash
sudo cp systemd/borsaman-telegram.service /etc/systemd/system/borsaman-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable --now borsaman-telegram.service
```

The live config file is `/home/rpi/BorsaManTelegram/config.json`. Keep it out
of git because it may point to real token sources, Gemini keys, admin chat IDs,
and runtime state. Commit only `config.example.json`.
