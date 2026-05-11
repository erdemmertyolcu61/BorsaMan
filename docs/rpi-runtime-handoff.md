# RPi runtime handoff

Status date: 2026-05-11

This note records what is different between the GitHub source tree and the
version that can run on the Raspberry Pi. It is meant to be committed on a
separate branch before pushing the RPi/Telegram deployment work.

## Baseline

- GitHub remote: `https://github.com/erdemmertyolcu61/BorsaMan.git`
- Current known upstream commit: `3b07dd5` (`BorsaMan v2.0.0: AI Advisor ve Sinyal Gelistirmeleri`)
- Current RPi app path: `/home/rpi/BorsaMan`
- Current RPi Telegram path: `/home/rpi/BorsaManTelegram`
- Current RPi old backup: `/home/rpi/BorsaMan-ESKI-20260511-232209`
- Current deployed zip source:
  `C:/Users/fusta/Desktop/BorsaMan-claude-happy-blackburn-b17321.zip`

The live RPi directory is not a git checkout after the zip deploy. Treat the
local repository branch as the source of truth for GitHub, and treat RPi files
as runtime/deploy artifacts.

## What GitHub source needed for RPi

The browser app alone is not enough in production. Vite proxy works only during
dev, so RPi needs a small backend process in front of `dist/`.

Required RPi additions:

- `server.py`: static file server, auth gate, and external market-data proxy.
- `deploy/borsaman.service`: systemd unit for the web process.
- `config/web-auth.example.json`: example login config; real
  `config/web-auth.json` is private and ignored.
- `reports/admin/`, `reports/advisor/`, `reports/research/`,
  `reports/telegram/`: runtime output directories; generated JSON/CSV/log files
  are ignored.
- `telegram-bot/`: standalone Telegram service code, config example, README,
  and systemd unit.
- `scripts/advisor/build-advisor-cache.mjs`: branch target for centralized AI
  Advisor cache generation.

## Current live RPi web service

The currently running RPi web service is minimal and restored from the previous
RPi deployment because the downloaded zip did not include RPi runtime files.

Live unit:

```ini
[Service]
User=rpi
WorkingDirectory=/home/rpi/BorsaMan
ExecStart=/usr/bin/python3 /home/rpi/BorsaMan/server.py
Environment=PORT=8080
Environment=BIND=0.0.0.0
Environment=LOG_LEVEL=INFO
Restart=always
RestartSec=5
```

Live patches applied on 2026-05-11:

- Restored `server.py`, `auth.py`, and `config/bist_symbols.txt` from the old
  RPi backup.
- Changed prewarm defaults to be gentler on the RPi:
  - `PREWARM_INTERVAL=3600`
  - `PREWARM_CONCURRENCY=3`
  - `PREWARM_START_DELAY=300`
- Built the new frontend with `npm run build`.
- Disabled the per-user 648-symbol AI Advisor browser scan in the deployed
  frontend bundle/source. Visitors should not each trigger a full scan.

The branch version should prefer the centralized server cache implementation in
this repository (`/api/advisor-cache` and `/api/advisor-refresh`) instead of the
temporary live minimal prewarm-only server.

## AI Advisor performance change

Problem:

- Every website visitor could start a 648-symbol AI scan.
- Five visitors could multiply the same scan and make RPi CPU/network unusable.

Branch target:

- RPi runs one background advisor cache job.
- Browsers poll `/api/advisor-cache`.
- Manual refresh calls `/api/advisor-refresh` and queues server-side work.
- Browser-side full-universe scan is developer fallback only.

Relevant files:

- `server.py`
- `scripts/advisor/build-advisor-cache.mjs`
- `src/hooks/useAIAdvisor.js`
- `src/components/AIAdvisor/AIAdvisorPanel.jsx`
- `deploy/borsaman.service`

## Telegram runtime

Telegram is intentionally a separate service from the web app on RPi:

- Path: `/home/rpi/BorsaManTelegram`
- Unit: `/etc/systemd/system/borsaman-telegram.service`
- Working directory: `/home/rpi/BorsaManTelegram`
- Config env: `BMAN_TG_CONFIG=/home/rpi/BorsaManTelegram/config.json`
- Exec: `/usr/bin/python3 /home/rpi/BorsaManTelegram/bot.py`

The repo copy lives under `telegram-bot/`.

Important behavior:

- `/durum` and `/web` point users to `https://bman.ta7tur.com/`.
- Scheduled weekday reports:
  - `morning_report_time`: `09:30`
  - `closing_report_time`: `18:10`
- Admin-only access.
- Reuses the existing wifidog token source for now:
  `/opt/wifi-monitor/config.json`.
- Can later switch to a dedicated BorsaMan bot token by changing only
  `telegram-bot/config.json` on the RPi.
- Optional Gemini notes read API keys from environment or the same external
  token-source JSON.

Do not commit:

- `telegram-bot/config.json`
- `telegram-bot/.env`
- `telegram-bot/state/`
- Telegram tokens
- Gemini/API keys
- Admin chat IDs unless they are intentionally public dummy values

## Systemd files

Tracked service templates:

- `deploy/borsaman.service`: preferred branch service for the web app with
  centralized advisor cache settings.
- `deploy/borsaman-live-current.service`: exact minimal live service shape from
  the current RPi for recovery/reference.
- `telegram-bot/systemd/borsaman-telegram.service`: Telegram polling service.

Install commands on RPi:

```bash
sudo cp deploy/borsaman.service /etc/systemd/system/borsaman.service
sudo cp telegram-bot/systemd/borsaman-telegram.service /etc/systemd/system/borsaman-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable --now borsaman.service
sudo systemctl enable --now borsaman-telegram.service
```

## Deploy checklist

1. Pull or copy the branch to `/home/rpi/BorsaMan`.
2. Preserve private runtime files:
   - `/home/rpi/BorsaMan/config/web-auth.json`
   - `/home/rpi/BorsaManTelegram/config.json`
   - `/home/rpi/BorsaManTelegram/state/`
   - data/report folders unless a clean deploy is intended
3. Run `npm ci` if `node_modules` is not present.
4. Run `npm run build`.
5. Verify `dist/` exists.
6. Install/reload systemd units.
7. Check:

```bash
systemctl status borsaman.service
systemctl status borsaman-telegram.service
curl -I http://127.0.0.1:8080/
python3 /home/rpi/BorsaManTelegram/bot.py --once /durum
```

8. Confirm `https://bman.ta7tur.com/` in Cloudflare Tunnel routes to Apache or
   directly to the BorsaMan service as intended.

## Branch preparation notes

Before pushing the branch:

- Review `git status --short`.
- Stage only source, docs, examples, service templates, and `.gitkeep` files.
- Do not stage runtime snapshots under `scratch/rpi-live-*`.
- Do not stage generated backtest CSV/JSON/log files.
- Do not stage zip/tar archives.
- Run at least:

```bash
npm run build
python3 -m py_compile server.py telegram-bot/bot.py
```

