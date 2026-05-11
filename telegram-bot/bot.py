#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import os
import re
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time as dt_time
from pathlib import Path
from typing import Any

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - Python < 3.9 fallback
    ZoneInfo = None


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("BMAN_TG_CONFIG", ROOT / "config.json"))

DEFAULT_CONFIG: dict[str, Any] = {
    "project_name": "BorsaMan Telegram",
    "telegram_token": "",
    "token_source_json": "/opt/wifi-monitor/config.json",
    "token_source_key": "telegram_token",
    "admin_chat_ids": [],
    "admin_chat_id_source_json": "/opt/wifi-monitor/config.json",
    "admin_chat_id_source_key": "telegram_chat_id",
    "borsaman_root": "/home/rpi/BorsaMan",
    "public_web_url": "https://bman.ta7tur.com/",
    "site_urls": [
        "https://bman.ta7tur.com/",
    ],
    "status_urls": [
        "http://127.0.0.1:8080/",
    ],
    "poll_timeout": 3,
    "poll_sleep": 0.2,
    "telegram_api_timeout_seconds": 8,
    "telegram_send_timeout_seconds": 8,
    "telegram_callback_timeout_seconds": 2,
    "telegram_handler_workers": 4,
    "http_status_timeout_seconds": 2,
    "command_timeout_seconds": 2,
    "drop_pending_on_start": True,
    "trade_reports_enabled": True,
    "trade_report_timezone": "Europe/Istanbul",
    "morning_report_time": "09:30",
    "closing_report_time": "18:10",
    "daily_trade_pick_count": 5,
    "daily_trade_cash_per_pick": 10000,
    "daily_trade_data_layer": "1d_5y",
    "trade_plan_version": "2026-05-03-r2",
    "trade_ledger_file": "state/trade-ledger.json",
    "gemini_enabled": True,
    "gemini_append_to_reports": True,
    "gemini_append_to_manual_reports": False,
    "gemini_model": "gemini-2.5-flash",
    "gemini_api_key": "",
    "gemini_api_key_source_json": "/opt/wifi-monitor/config.json",
    "gemini_api_key_source_keys": [
        "gemini_api_key",
        "google_api_key",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    ],
    "gemini_timeout_seconds": 20,
    "research_enabled": True,
    "research_data_dir": "data/yahoo/1d_5y",
    "research_out_dir": "reports/research",
    "research_data_source": "telegram-yahoo-1d-5y",
    "research_jobs_file": "state/research-jobs.json",
    "research_max_random_trials": 3000,
    "research_max_symbols": 250,
    "research_default_symbols": "THYAO,ASELS,SISE,EREGL,GARAN,KCHOL,PETKM,SAHOL,TOASO,TUPRS",
    "research_default_bot_id": "telegram-research",
    "research_node_bin": "node",
    "research_script": "scripts/research/backtest-batch.mjs",
    "docs": {
        "komutlar": "docs/telegram-admin-panel.md",
        "backtest": "docs/research-backtesting.md",
        "telegram": "docs/telegram-bot-ux.md",
        "skor": "reports/research/SCOREBOARD_STANDARD.md",
        "sonuc": "reports/research/RUN_SUMMARY_20260503.md",
    },
    "daily_trade_symbols": [
        "AKBNK",
        "ASELS",
        "BIMAS",
        "EREGL",
        "GARAN",
        "KCHOL",
        "PETKM",
        "SAHOL",
        "SISE",
        "THYAO",
        "TOASO",
        "TUPRS",
    ],
}

MAIN_MENU = {
    "keyboard": [
        [{"text": "/gunluk"}, {"text": "/kapanis"}],
        [{"text": "/web"}, {"text": "/skor"}],
        [{"text": "/katalog"}, {"text": "/cache"}],
        [{"text": "/sistem"}, {"text": "/servis"}],
        [{"text": "/site"}, {"text": "/oturumlar"}],
        [{"text": "/erisim"}, {"text": "/durum"}],
        [{"text": "/test"}, {"text": "/raporlar"}],
        [{"text": "/dokuman"}, {"text": "/testdurum"}],
        [{"text": "/yardim"}],
    ],
    "resize_keyboard": True,
}


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def load_config() -> dict[str, Any]:
    config = DEFAULT_CONFIG.copy()
    config.update(load_json(CONFIG_PATH))
    return config


def read_json_key(path: str | Path, key: str) -> str:
    data = load_json(Path(path))
    value = data.get(key, "")
    return str(value).strip() if value is not None else ""


def split_ids(value: Any) -> set[str]:
    if isinstance(value, list):
        parts = value
    else:
        parts = str(value or "").replace(";", ",").split(",")
    return {str(part).strip() for part in parts if str(part).strip()}


def resolve_token(config: dict[str, Any]) -> str:
    for key in ("BMAN_TG_TOKEN", "TELEGRAM_BOT_TOKEN"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    if str(config.get("telegram_token", "")).strip():
        return str(config["telegram_token"]).strip()
    source = str(config.get("token_source_json", "")).strip()
    source_key = str(config.get("token_source_key", "telegram_token")).strip()
    if source and source_key:
        return read_json_key(source, source_key)
    return ""


def resolve_admin_ids(config: dict[str, Any]) -> set[str]:
    for key in ("BMAN_TG_ADMIN_CHAT_IDS", "TELEGRAM_ADMIN_IDS"):
        env_value = os.environ.get(key, "").strip()
        if env_value:
            return split_ids(env_value)
    ids = split_ids(config.get("admin_chat_ids", []))
    if ids:
        return ids
    source = str(config.get("admin_chat_id_source_json", "")).strip()
    source_key = str(config.get("admin_chat_id_source_key", "telegram_chat_id")).strip()
    if source and source_key:
        return split_ids(read_json_key(source, source_key))
    return set()


def resolve_gemini_key(config: dict[str, Any]) -> str:
    for key in ("BMAN_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    direct = str(config.get("gemini_api_key", "")).strip()
    if direct:
        return direct
    source = str(config.get("gemini_api_key_source_json", "")).strip()
    keys = config.get("gemini_api_key_source_keys", [])
    if isinstance(keys, str):
        keys = [keys]
    if source and isinstance(keys, list):
        data = load_json(Path(source))
        for key in keys:
            value = str(data.get(str(key), "")).strip()
            if value:
                return value
    return ""


class TelegramClient:
    def __init__(
        self,
        token: str,
        api_timeout: float = 12,
        send_timeout: float = 8,
        callback_timeout: float = 2,
    ):
        if not token:
            raise RuntimeError("Telegram token is not configured.")
        self.base_url = f"https://api.telegram.org/bot{token}/"
        self.api_timeout = api_timeout
        self.send_timeout = send_timeout
        self.callback_timeout = callback_timeout

    def api(
        self,
        method: str,
        payload: dict[str, Any] | None = None,
        request_timeout: float | None = None,
    ) -> dict[str, Any]:
        payload = payload or {}
        data = urllib.parse.urlencode(payload).encode("utf-8")
        request = urllib.request.Request(self.base_url + method, data=data)
        with urllib.request.urlopen(request, timeout=request_timeout or self.api_timeout) as response:
            body = response.read().decode("utf-8", "replace")
        result = json.loads(body)
        if not result.get("ok"):
            raise RuntimeError(result.get("description", "Telegram API returned ok=false"))
        return result

    def send_message(self, chat_id: str | int, text: str, reply_markup: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {
            "chat_id": str(chat_id),
            "text": text[:3900],
            "disable_web_page_preview": "true",
        }
        if reply_markup:
            payload["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
        self.api("sendMessage", payload, request_timeout=self.send_timeout)

    def answer_callback_query(self, callback_query_id: str, text: str = "") -> None:
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text[:180]
        self.api("answerCallbackQuery", payload, request_timeout=self.callback_timeout)

    def get_updates(self, offset: int | None, timeout: int) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": json.dumps(["message", "callback_query"]),
        }
        if offset is not None:
            payload["offset"] = offset
        return self.api("getUpdates", payload, request_timeout=max(self.api_timeout, timeout + 5)).get("result", [])


def gemini_generate(config: dict[str, Any], prompt: str) -> str:
    if not config.get("gemini_enabled", True):
        return ""
    api_key = resolve_gemini_key(config)
    if not api_key:
        return ""
    model = str(config.get("gemini_model", "gemini-2.5-flash")).strip() or "gemini-2.5-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent"
    body = {
        "contents": [
            {
                "parts": [
                    {
                        "text": prompt,
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.35,
            "maxOutputTokens": 700,
        },
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    timeout = float(config.get("gemini_timeout_seconds", 20))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", "replace"))
    parts = payload.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    text = "\n".join(str(part.get("text", "")).strip() for part in parts if part.get("text"))
    return text.strip()


def append_gemini_note(config: dict[str, Any], report_text: str, kind: str) -> str:
    if not config.get("gemini_append_to_reports", True):
        return report_text
    prompt = "\n".join(
        [
            "BorsaMan Telegram raporunu oku ve admin kullanicilar icin cok kisa bir yorum yaz.",
            "Kurallar: En fazla 4 madde. Yeni hisse uydurma. Rakamlari degistirme.",
            "Net, ihtiyatli ve Turkce yaz. Son satira 'Yatirim tavsiyesi degildir.' ekle.",
            f"Rapor tipi: {kind}",
            "",
            report_text[:3200],
        ]
    )
    try:
        note = gemini_generate(config, prompt)
    except Exception as exc:
        return report_text + f"\n\nGemini notu alinamadi: {type(exc).__name__}"
    if not note:
        return report_text
    return report_text + "\n\nGemini notu:\n" + note[:1200]


def run_command(args: list[str], timeout: float = 2) -> str:
    try:
        proc = subprocess.run(
            args,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
        return proc.stdout.strip()
    except Exception as exc:
        return f"error: {exc}"


def http_status(url: str, timeout: float = 2) -> str:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return str(response.status)
    except Exception as exc:
        return f"error: {type(exc).__name__}"


def latest_file(pattern: str) -> Path | None:
    files = sorted(Path().glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def public_web_url(config: dict[str, Any]) -> str:
    url = str(config.get("public_web_url", "")).strip()
    if url:
        return url
    urls = [str(item).strip() for item in config.get("site_urls", []) if str(item).strip()]
    return urls[0] if urls else "https://bman.ta7tur.com/"


def resolve_borsaman_root(config: dict[str, Any]) -> Path:
    override = os.environ.get("BMAN_ROOT") or os.environ.get("BORSAMAN_ROOT")
    if override:
        return Path(override).expanduser()
    configured = Path(str(config.get("borsaman_root", "/home/rpi/BorsaMan"))).expanduser()
    if configured.exists():
        return configured
    sibling = ROOT.parent / "BorsaMan"
    if sibling.exists():
        return sibling
    return configured


def resolve_state_path(config: dict[str, Any]) -> Path:
    raw = Path(str(config.get("trade_ledger_file", "state/trade-ledger.json")))
    return raw if raw.is_absolute() else ROOT / raw


def resolve_research_jobs_path(config: dict[str, Any]) -> Path:
    raw = Path(str(config.get("research_jobs_file", "state/research-jobs.json")))
    return raw if raw.is_absolute() else ROOT / raw


def load_state(config: dict[str, Any]) -> dict[str, Any]:
    path = resolve_state_path(config)
    if not path.exists():
        return {}
    try:
        data = load_json(path)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(config: dict[str, Any], state: dict[str, Any]) -> None:
    path = resolve_state_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
    temp_path.replace(path)


def local_now(config: dict[str, Any]) -> datetime:
    tz_name = str(config.get("trade_report_timezone", "Europe/Istanbul"))
    if ZoneInfo is None:
        return datetime.now()
    try:
        return datetime.now(ZoneInfo(tz_name))
    except Exception:
        return datetime.now()


def load_research_jobs(config: dict[str, Any]) -> dict[str, Any]:
    path = resolve_research_jobs_path(config)
    if not path.exists():
        return {"jobs": {}}
    try:
        data = load_json(path)
        if not isinstance(data.get("jobs"), dict):
            data["jobs"] = {}
        return data
    except Exception:
        return {"jobs": {}}


def save_research_jobs(config: dict[str, Any], data: dict[str, Any]) -> None:
    path = resolve_research_jobs_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    temp_path.replace(path)


def parse_hhmm(value: Any, fallback: str) -> dt_time:
    text = str(value or fallback).strip()
    try:
        hour_text, minute_text = text.split(":", 1)
        return dt_time(hour=int(hour_text), minute=int(minute_text[:2]))
    except Exception:
        hour_text, minute_text = fallback.split(":", 1)
        return dt_time(hour=int(hour_text), minute=int(minute_text))


def is_trading_day(now: datetime) -> bool:
    return now.weekday() < 5


def ascii_key(text: str) -> str:
    table = str.maketrans(
        {
            "ç": "c",
            "Ç": "c",
            "ğ": "g",
            "Ğ": "g",
            "ı": "i",
            "I": "i",
            "İ": "i",
            "ö": "o",
            "Ö": "o",
            "ş": "s",
            "Ş": "s",
            "ü": "u",
            "Ü": "u",
        }
    )
    translated = text.translate(table)
    normalized = unicodedata.normalize("NFKD", translated)
    without_marks = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    cleaned = re.sub(r"[^a-zA-Z0-9_/\-= ]+", " ", without_marks)
    return re.sub(r"\s+", " ", cleaned).strip().lower()


BUTTON_ALIASES = {
    "gunluk trade": "/gunluk",
    "gunluktrade": "/gunluk",
    "daily trade": "/gunluk",
    "kapanis raporu": "/kapanis",
    "closing": "/kapanis",
    "status": "/durum",
    "bot status": "/durum",
    "bot durum": "/durum",
    "website": "/web",
    "web sitesi": "/web",
    "score": "/skor",
    "scores": "/skor",
    "catalog": "/katalog",
    "data catalog": "/katalog",
    "tara": "/cache",
    "cache status": "/cache",
    "system": "/sistem",
    "system_status": "/sistem",
    "system status": "/sistem",
    "service": "/servis",
    "services": "/servis",
    "service_status": "/servis",
    "service status": "/servis",
    "site kontrol": "/site",
    "site kontrolu": "/site",
    "site_check": "/site",
    "site check": "/site",
    "sessions": "/oturumlar",
    "sessions_status": "/oturumlar",
    "session_status": "/oturumlar",
    "session": "/oturumlar",
    "access": "/erisim",
    "access_status": "/erisim",
    "access_requests": "/erisim",
    "access requests": "/erisim",
    "erisim talepleri": "/erisim",
    "test yardim": "/test",
    "test_yardim": "/test",
    "test help": "/test",
    "test durum": "/testdurum",
    "test_durum": "/testdurum",
    "test status": "/testdurum",
    "reports": "/raporlar",
    "report list": "/raporlar",
    "documents": "/dokuman",
    "docs": "/dokuman",
    "help": "/yardim",
}


def normalize_button_payload(text: str) -> str:
    raw = (text or "").strip()
    for prefix in ("cmd:", "command:", "menu:", "action:"):
        if raw.lower().startswith(prefix):
            raw = raw.split(":", 1)[1].strip()
            break
    key = ascii_key(normalize_text(raw))
    return BUTTON_ALIASES.get(key, raw)


def safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def pct(new: float, old: float) -> float:
    if old == 0:
        return 0.0
    return ((new / old) - 1.0) * 100.0


def round_price(value: float) -> float:
    if value >= 100:
        return round(value, 2)
    if value >= 10:
        return round(value, 2)
    return round(value, 3)


def find_symbol_csv(root: Path, symbol: str, layer: str) -> Path | None:
    data_dir = root / "data" / "yahoo" / layer
    candidates: list[Path] = []
    for token in (f"{symbol}.IS", symbol):
        candidates.extend(data_dir.glob(f"{token}__yahoo__*.csv"))
        candidates.extend(data_dir.glob(f"{token}*.csv"))
    candidates = sorted(set(candidates), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def read_price_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for item in reader:
            date_text = str(item.get("date", "")).strip()
            if not date_text:
                continue
            row = {
                "date": date_text[:10],
                "open": safe_float(item.get("open")),
                "high": safe_float(item.get("high")),
                "low": safe_float(item.get("low")),
                "close": safe_float(item.get("close")),
                "volume": safe_float(item.get("volume")) or 0.0,
            }
            if all(row[key] is not None for key in ("open", "high", "low", "close")):
                rows.append(row)
    return rows


def compute_rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) <= period:
        return 50.0
    gains: list[float] = []
    losses: list[float] = []
    window = closes[-(period + 1) :]
    for prev, current in zip(window, window[1:]):
        change = current - prev
        if change >= 0:
            gains.append(change)
            losses.append(0.0)
        else:
            gains.append(0.0)
            losses.append(abs(change))
    avg_gain = mean(gains)
    avg_loss = mean(losses)
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def score_symbol(symbol: str, rows: list[dict[str, Any]], cash_per_pick: float) -> dict[str, Any] | None:
    if len(rows) < 35:
        return None
    last = rows[-1]
    prev = rows[-2]
    close = float(last["close"])
    prev_close = float(prev["close"])
    closes = [float(row["close"]) for row in rows if row.get("close") is not None]
    ranges = [float(row["high"]) - float(row["low"]) for row in rows[-14:]]
    volumes = [float(row.get("volume") or 0.0) for row in rows[-21:-1]]
    avg_range = mean(ranges) or max(close * 0.015, 0.01)
    avg_volume = mean(volumes)
    volume_ratio = (float(last.get("volume") or 0.0) / avg_volume) if avg_volume else 1.0
    rsi = compute_rsi(closes)
    momentum_5d = pct(close, closes[-6]) if len(closes) >= 6 else 0.0
    change_pct = pct(close, prev_close)
    sma5 = mean(closes[-5:])
    sma20 = mean(closes[-20:])
    recent_lows = [float(row["low"]) for row in rows[-20:]]
    recent_highs = [float(row["high"]) for row in rows[-20:]]
    support = min(recent_lows)
    resistance = max(recent_highs)

    score = 50.0
    score += max(-18.0, min(22.0, momentum_5d * 4.0))
    score += max(-12.0, min(14.0, change_pct * 3.0))
    score += 8.0 if close > sma20 else -6.0
    score += 6.0 if sma5 > sma20 else -4.0
    score += max(-5.0, min(10.0, (volume_ratio - 1.0) * 8.0))
    if 42.0 <= rsi <= 68.0:
        score += 10.0
    elif 35.0 <= rsi < 42.0 or 68.0 < rsi <= 75.0:
        score += 3.0
    else:
        score -= 8.0

    risk = max(close * 0.014, avg_range * 0.55)
    technical_stop = support * 0.995 if support < close else close - risk
    stop = max(close - risk, technical_stop)
    if stop >= close:
        stop = close - risk
    target = close + (close - stop) * 2.4
    if resistance > close and resistance < target * 1.25:
        target = max(target, resistance * 1.005)
    rr = (target - close) / max(close - stop, 0.01)
    quantity = int(cash_per_pick // close) if close > 0 else 0

    tags: list[str] = []
    if momentum_5d > 2:
        tags.append("momentum")
    if volume_ratio > 1.2:
        tags.append("hacim")
    if close > sma20 and sma5 > sma20:
        tags.append("trend")
    if 42 <= rsi <= 68:
        tags.append("rsi-ok")

    return {
        "symbol": symbol,
        "date": str(last["date"]),
        "entry": round_price(close),
        "stop": round_price(stop),
        "target": round_price(target),
        "rr": round(rr, 2),
        "score": round(score, 2),
        "changePct": round(change_pct, 2),
        "momentum5dPct": round(momentum_5d, 2),
        "rsi": round(rsi, 1),
        "volumeRatio": round(volume_ratio, 2),
        "support": round_price(support),
        "resistance": round_price(resistance),
        "quantity": quantity,
        "cash": round(quantity * close, 2),
        "targetPnL": round((target - close) * quantity, 2),
        "stopPnL": round((stop - close) * quantity, 2),
        "tags": tags,
    }


def generate_daily_plan(config: dict[str, Any], now: datetime) -> dict[str, Any]:
    root = resolve_borsaman_root(config)
    layer = str(config.get("daily_trade_data_layer", "1d_5y"))
    symbols = [str(item).strip().upper().replace(".IS", "") for item in config.get("daily_trade_symbols", [])]
    cash_per_pick = float(config.get("daily_trade_cash_per_pick", 10000))
    pick_count = int(config.get("daily_trade_pick_count", 5))
    picks: list[dict[str, Any]] = []
    missing: list[str] = []
    for symbol in symbols:
        path = find_symbol_csv(root, symbol, layer)
        if not path:
            missing.append(symbol)
            continue
        try:
            rows = read_price_rows(path)
            pick = score_symbol(symbol, rows, cash_per_pick)
            if pick:
                pick["dataFile"] = str(path.name)
                picks.append(pick)
        except Exception:
            missing.append(symbol)
    picks.sort(key=lambda item: (float(item.get("score", 0)), float(item.get("rr", 0))), reverse=True)
    selected = picks[:pick_count]
    latest_data_date = max((str(item.get("date", "")) for item in selected), default="")
    return {
        "date": now.date().isoformat(),
        "generatedAt": now.isoformat(),
        "source": f"yahoo/{layer}",
        "version": str(config.get("trade_plan_version", "2026-05-03-r2")),
        "webUrl": public_web_url(config),
        "cashPerPick": cash_per_pick,
        "latestDataDate": latest_data_date,
        "missingSymbols": missing,
        "picks": selected,
    }


def get_or_create_plan(config: dict[str, Any], state: dict[str, Any], now: datetime) -> dict[str, Any]:
    date_key = now.date().isoformat()
    plans = state.setdefault("plans", {})
    plan = plans.get(date_key)
    expected_version = str(config.get("trade_plan_version", "2026-05-03-r2"))
    if isinstance(plan, dict) and plan.get("picks") and plan.get("version") == expected_version:
        return plan
    plan = generate_daily_plan(config, now)
    plans[date_key] = plan
    return plan


def format_morning_report(plan: dict[str, Any]) -> str:
    picks = plan.get("picks", [])
    lines = [
        f"Gunluk trade plani - {plan.get('date')}",
        f"Web: {plan.get('webUrl')}",
        f"Kaynak: {plan.get('source')} | Veri tarihi: {plan.get('latestDataDate') or 'yok'}",
        "",
    ]
    if not picks:
        lines.append("Bugun icin trade adayi uretilemedi. Veri dosyalarini ve sembol listesini kontrol et.")
        return "\n".join(lines)
    for index, pick in enumerate(picks, start=1):
        tags = ", ".join(pick.get("tags", [])) or "normal"
        lines.extend(
            [
                f"{index}) {pick['symbol']} | skor {pick['score']} | RR 1:{pick['rr']}",
                f"   Giris {pick['entry']} | Stop {pick['stop']} | Hedef {pick['target']}",
                f"   RSI {pick['rsi']} | 5g mom {pick['momentum5dPct']}% | hacim x{pick['volumeRatio']} | {tags}",
                f"   {int(plan.get('cashPerPick', 10000))} TL hesap: {pick['quantity']} lot | hedef {pick['targetPnL']} TL | stop {pick['stopPnL']} TL",
            ]
        )
    return "\n".join(lines)


def evaluate_pick(config: dict[str, Any], pick: dict[str, Any]) -> dict[str, Any]:
    root = resolve_borsaman_root(config)
    layer = str(config.get("daily_trade_data_layer", "1d_5y"))
    symbol = str(pick.get("symbol", "")).upper()
    path = find_symbol_csv(root, symbol, layer)
    if not path:
        return {"symbol": symbol, "status": "veri-yok", "pnl": 0.0}
    rows = read_price_rows(path)
    if not rows:
        return {"symbol": symbol, "status": "veri-yok", "pnl": 0.0}
    latest = rows[-1]
    latest_date = str(latest["date"])
    entry = float(pick.get("entry", 0))
    stop = float(pick.get("stop", 0))
    target = float(pick.get("target", 0))
    quantity = int(pick.get("quantity", 0))
    high = float(latest["high"])
    low = float(latest["low"])
    close = float(latest["close"])
    plan_date = str(pick.get("date", ""))
    if latest_date <= plan_date:
        return {"symbol": symbol, "status": "taze-veri-yok", "date": latest_date, "pnl": 0.0}
    hit_target = high >= target
    hit_stop = low <= stop
    if hit_target and hit_stop:
        exit_price = stop
        status = "hedef-ve-stop-gordu"
    elif hit_target:
        exit_price = target
        status = "hedefe-vardi"
    elif hit_stop:
        exit_price = stop
        status = "stop-oldu"
    else:
        exit_price = close
        status = "kapanista-acik"
    pnl = (exit_price - entry) * quantity
    return {
        "symbol": symbol,
        "status": status,
        "date": latest_date,
        "entry": round_price(entry),
        "exit": round_price(exit_price),
        "close": round_price(close),
        "pnl": round(pnl, 2),
        "pnlPct": round(pct(exit_price, entry), 2) if entry else 0.0,
    }


def build_closing_summary(config: dict[str, Any], state: dict[str, Any], now: datetime) -> dict[str, Any]:
    plan = get_or_create_plan(config, state, now)
    results = [evaluate_pick(config, pick) for pick in plan.get("picks", [])]
    total_pnl = round(sum(float(item.get("pnl", 0.0)) for item in results), 2)
    summary = {
        "date": now.date().isoformat(),
        "generatedAt": now.isoformat(),
        "webUrl": public_web_url(config),
        "planDate": plan.get("date"),
        "latestDataDate": max((str(item.get("date", "")) for item in results), default=""),
        "targetHits": sum(1 for item in results if item.get("status") == "hedefe-vardi"),
        "stopHits": sum(1 for item in results if item.get("status") == "stop-oldu"),
        "openOrClosed": sum(1 for item in results if item.get("status") == "kapanista-acik"),
        "freshDataMissing": sum(1 for item in results if item.get("status") in ("taze-veri-yok", "veri-yok")),
        "totalPnL": total_pnl,
        "results": results,
    }
    closings = state.setdefault("closings", {})
    closings[now.date().isoformat()] = summary
    return summary


def format_closing_report(summary: dict[str, Any]) -> str:
    lines = [
        f"Seans sonu trade ozeti - {summary.get('date')}",
        f"Web: {summary.get('webUrl')}",
        f"Veri tarihi: {summary.get('latestDataDate') or 'yok'}",
        f"Hedef: {summary.get('targetHits', 0)} | Stop: {summary.get('stopHits', 0)} | Kapanista: {summary.get('openOrClosed', 0)} | Veri bekleyen: {summary.get('freshDataMissing', 0)}",
        f"Toplam tahmini P/L: {summary.get('totalPnL', 0)} TL",
        "",
    ]
    results = summary.get("results", [])
    if not results:
        lines.append("Degerlendirilecek gunluk trade plani yok.")
        return "\n".join(lines)
    for item in results:
        lines.append(
            f"- {item.get('symbol')}: {item.get('status')} | giris {item.get('entry', '-')} -> cikis {item.get('exit', '-')} | P/L {item.get('pnl', 0)} TL ({item.get('pnlPct', 0)}%)"
        )
    return "\n".join(lines)


def build_plan_reply(config: dict[str, Any]) -> str:
    now = local_now(config)
    state = load_state(config)
    plan = get_or_create_plan(config, state, now)
    save_state(config, state)
    report = format_morning_report(plan)
    if config.get("gemini_append_to_manual_reports", False):
        return append_gemini_note(config, report, "gunluk trade plani")
    return report


def build_closing_reply(config: dict[str, Any]) -> str:
    now = local_now(config)
    state = load_state(config)
    summary = build_closing_summary(config, state, now)
    save_state(config, state)
    report = format_closing_report(summary)
    if config.get("gemini_append_to_manual_reports", False):
        return append_gemini_note(config, report, "seans sonu ozeti")
    return report


def format_status(config: dict[str, Any]) -> str:
    return "\n".join(
        [
            "BorsaMan web",
            public_web_url(config),
            "",
            "Gunluk trade plani ve raporlar buradan takip edilecek.",
        ]
    )


def format_web(config: dict[str, Any]) -> str:
    return "\n".join(
        [
            "BorsaMan web",
            public_web_url(config),
            "",
            "Giris, gunluk trade, skor ve rapor ekrani burada.",
        ]
    )


def format_catalog(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    catalog_json = root / "data" / "yahoo" / "DATA_CATALOG.json"
    manifest_json = root / "data" / "yahoo" / "DOWNLOAD_MANIFEST.json"
    if catalog_json.exists():
        data = load_json(catalog_json)
        files = data.get("files", [])
        layers = sorted({str(item.get("layer", "")) for item in files if isinstance(item, dict)})
        symbols = sorted({str(item.get("symbol", "")) for item in files if isinstance(item, dict)})
        return "\n".join(
            [
                "Veri katalogu",
                f"Dosya: {len(files)}",
                f"Katman: {', '.join([x for x in layers if x]) or 'unknown'}",
                f"Sembol: {len([x for x in symbols if x])}",
                f"Kaynak: {catalog_json}",
            ]
        )
    if manifest_json.exists():
        data = load_json(manifest_json)
        return f"Download manifest bulundu: {manifest_json}\nKayit: {len(data) if isinstance(data, list) else 'unknown'}"
    return "Veri katalogu bulunamadi. Beklenen: data/yahoo/DATA_CATALOG.json"


def format_score(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    report_dir = root / "reports" / "research"
    files = sorted(report_dir.glob("scoreboard-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return f"Skor defteri bulunamadi. Klasor: {report_dir}"
    path = files[0]
    data = load_json(path)
    summary = data.get("summary", data if isinstance(data, dict) else {})
    best = data.get("best", {}) if isinstance(data, dict) else {}
    lines = [
        "Son skor defteri",
        f"Dosya: {path.name}",
        f"Guncelleme: {datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    for key in ("botId", "variantId", "runId", "commitSha", "trials", "symbols"):
        if key in summary:
            lines.append(f"{key}: {summary[key]}")
        elif key in data:
            lines.append(f"{key}: {data[key]}")
    if isinstance(best, dict) and best:
        lines.append("Best:")
        for key, value in list(best.items())[:8]:
            lines.append(f"- {key}: {value}")
    return "\n".join(lines)


def age_text(epoch_or_iso: Any) -> str:
    try:
        if isinstance(epoch_or_iso, (int, float)):
            ts = float(epoch_or_iso)
        else:
            ts = datetime.fromisoformat(str(epoch_or_iso).replace("Z", "+00:00")).timestamp()
        seconds = max(0, int(time.time() - ts))
        if seconds < 60:
            return f"{seconds}s"
        if seconds < 3600:
            return f"{seconds // 60}dk"
        return f"{seconds // 3600}s {seconds % 3600 // 60}dk"
    except Exception:
        return "bilinmiyor"


def read_meminfo() -> tuple[int, int] | None:
    path = Path("/proc/meminfo")
    if not path.exists():
        return None
    values: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            values[parts[0].rstrip(":")] = int(parts[1])
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if not total or available is None:
        return None
    used = total - available
    return used // 1024, total // 1024


def format_system(config: dict[str, Any]) -> str:
    command_timeout = float(config.get("command_timeout_seconds", 2))
    host = socket.gethostname()
    uptime = run_command(["uptime", "-p"], timeout=command_timeout)
    loadavg = Path("/proc/loadavg").read_text(encoding="utf-8", errors="ignore").split()[:3] if Path("/proc/loadavg").exists() else []
    mem = read_meminfo()
    disk = run_command(["df", "-h", "/"], timeout=command_timeout).splitlines()
    disk_line = disk[-1] if disk else "disk bilinmiyor"
    lines = [
        "Sistem durumu",
        f"Host: {host}",
        f"Uptime: {uptime}",
        f"Load: {' '.join(loadavg) if loadavg else 'bilinmiyor'}",
        f"Disk: {disk_line}",
    ]
    if mem:
        lines.insert(4, f"RAM: {mem[0]} MB / {mem[1]} MB")
    return "\n".join(lines)


def format_service_status(config: dict[str, Any]) -> str:
    timeout = float(config.get("command_timeout_seconds", 2))
    services = ["borsaman.service", "borsaman-telegram.service", "cloudflared.service"]
    lines = ["Servis durumu"]
    checks: dict[concurrent.futures.Future[str], tuple[str, str]] = {}
    results: dict[tuple[str, str], str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        for service in services:
            checks[executor.submit(run_command, ["systemctl", "is-active", service], timeout)] = (service, "active")
            checks[executor.submit(run_command, ["systemctl", "is-enabled", service], timeout)] = (service, "enabled")
        for future, key in checks.items():
            try:
                results[key] = future.result(timeout=timeout + 0.5)
            except Exception as exc:
                results[key] = f"error: {type(exc).__name__}"
    for service in services:
        state = results.get((service, "active"), "bilinmiyor")
        enabled = results.get((service, "enabled"), "bilinmiyor")
        lines.append(f"- {service}: {state} / {enabled}")
    return "\n".join(lines)


def format_site_check(config: dict[str, Any]) -> str:
    timeout = float(config.get("http_status_timeout_seconds", 2))
    urls = [str(url) for url in config.get("status_urls", []) if str(url).strip()]
    if not urls:
        urls = ["http://127.0.0.1:8080/"]
    lines = ["Site kontrol", f"Public: {public_web_url(config)}"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(urls), 4) or 1) as executor:
        results = list(executor.map(lambda url: (url, http_status(url, timeout=timeout)), urls))
    for url, status in results:
        lines.append(f"- {url}: {status}")
    return "\n".join(lines)


def format_cache_status(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    cache_file = root / "reports" / "advisor" / "latest.json"
    if not cache_file.exists():
        return f"AI cache bulunamadi.\nBeklenen: {cache_file}"
    data = load_json(cache_file)
    updated = data.get("updatedAt") or data.get("ts")
    picks = data.get("topPicks", [])
    lines = [
        "AI Advisor cache",
        f"Guncelleme: {updated} ({age_text(updated)} once)",
        f"Evren: {data.get('universe', '-')}",
        f"Mod: {data.get('scanMode', '-')}",
        f"Taranan: {data.get('scanned', 0)} / {data.get('totalSymbols', 0)}",
        f"Hata: {data.get('failed', 0)}",
        f"Sure: {round(float(data.get('durationMs', 0)) / 1000, 1)}s",
    ]
    if picks:
        lines.append("En iyi:")
        for pick in picks[:5]:
            lines.append(f"- {pick.get('symbol')}: skor {pick.get('score')} RR {pick.get('rr')}")
    return "\n".join(lines)


def format_sessions(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    path = root / "reports" / "admin" / "sessions.json"
    if not path.exists():
        return f"Oturum defteri henuz yok.\nBeklenen: {path}"
    data = load_json(path)
    lines = [
        "Web oturumlari",
        f"Aktif: {data.get('activeCount', 0)}",
        f"Guncelleme: {age_text(data.get('updatedAt'))} once",
    ]
    users = data.get("users", {})
    if isinstance(users, dict) and users:
        lines.append("Kullanicilar:")
        for username, count in users.items():
            lines.append(f"- {username}: {count}")
    return "\n".join(lines)


def format_access_status(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    auth_file = root / "config" / "web-auth.json"
    if not auth_file.exists():
        return f"Web auth config bulunamadi.\nBeklenen: {auth_file}"
    data = load_json(auth_file)
    users = data.get("users", [])
    lines = [
        "Erisim durumu",
        f"Auth aktif: {bool(data.get('enabled', True))}",
        f"Kullanici sayisi: {len(users) if isinstance(users, list) else 0}",
    ]
    if isinstance(users, list):
        for user in users:
            lines.append(f"- {user.get('username', '-')}")
    return "\n".join(lines)


def parse_key_values(text: str) -> dict[str, str]:
    params: dict[str, str] = {}
    for raw in text.split():
        token = raw.strip()
        if not token or token.startswith("/"):
            continue
        if "=" not in token:
            params[token.lower()] = "1"
            continue
        key, value = token.split("=", 1)
        params[key.strip().lower()] = value.strip()
    return params


def clean_symbols(value: str, max_symbols: int) -> list[str]:
    symbols: list[str] = []
    for part in value.replace(";", ",").split(","):
        symbol = part.strip().upper().replace(".IS", "")
        if not symbol:
            continue
        if not symbol.replace("_", "").isalnum() or len(symbol) > 12:
            continue
        if symbol not in symbols:
            symbols.append(symbol)
    return symbols[:max_symbols]


def clean_number_list(value: str, max_items: int = 12) -> str:
    out: list[str] = []
    for part in value.replace(";", ",").split(","):
        number = safe_float(part.strip())
        if number is None:
            continue
        out.append(str(number).rstrip("0").rstrip("."))
    return ",".join(out[:max_items])


def safe_int_param(params: dict[str, str], names: tuple[str, ...], default: int, minimum: int, maximum: int) -> int:
    value = None
    for name in names:
        if name in params:
            value = safe_float(params[name])
            break
    if value is None:
        value = default
    return max(minimum, min(maximum, int(value)))


def safe_float_param(params: dict[str, str], names: tuple[str, ...], default: float, minimum: float, maximum: float) -> float:
    value = None
    for name in names:
        if name in params:
            value = safe_float(params[name])
            break
    if value is None:
        value = default
    return max(minimum, min(maximum, float(value)))


def research_help_text() -> str:
    return "\n".join(
        [
            "Backtest paneli",
            "",
            "Baslat:",
            "/test symbols=THYAO,ASELS trials=300 window=252 seed=deneme bot=bot-v1",
            "",
            "Rolling:",
            "/test mode=rolling symbols=THYAO,SISE fold=252 step=63 oos=252",
            "",
            "Parametreler:",
            "symbols=THYAO,ASELS veya symbols=all limit=50",
            "trials=0..3000, window=80..1500, oos=0..1500",
            "thresholds=55,65,75, holds=15,25, rr=0,1",
            "stops=0.05, targets=0.06, costs=0.0015,0.003",
            "cash=100000, pos=0.25, mintrades=3",
            "",
            "Sonuc:",
            "/testdurum jobId",
            "/raporlar",
            "/dokuman komutlar",
        ]
    )


def build_research_command(config: dict[str, Any], text: str) -> tuple[list[str], dict[str, Any]] | tuple[None, dict[str, Any]]:
    if not config.get("research_enabled", True):
        return None, {"error": "Research komutlari config tarafinda kapali."}

    root = resolve_borsaman_root(config)
    script = root / str(config.get("research_script", "scripts/research/backtest-batch.mjs"))
    data_dir = root / str(config.get("research_data_dir", "data/yahoo/1d_5y"))
    out_dir = root / str(config.get("research_out_dir", "reports/research"))
    if not script.exists():
        return None, {"error": f"Backtest script bulunamadi: {script}"}
    if not data_dir.exists():
        return None, {"error": f"Veri klasoru bulunamadi: {data_dir}"}

    params = parse_key_values(text)
    max_symbols = int(config.get("research_max_symbols", 250))
    max_trials = int(config.get("research_max_random_trials", 3000))
    mode = params.get("mode", "random").lower()
    if "rolling" in params:
        mode = "rolling"
    if "quick" in params:
        mode = "quick"

    default_symbols = str(config.get("research_default_symbols", "THYAO,ASELS,SISE"))
    symbols_value = params.get("symbols", default_symbols)
    limit = safe_int_param(params, ("limit",), 0, 0, max_symbols)
    use_all_symbols = symbols_value.lower() in {"all", "tum", "hepsi", "*"}
    symbols = [] if use_all_symbols else clean_symbols(symbols_value, max_symbols)
    if not use_all_symbols and not symbols:
        return None, {"error": "Gecerli sembol yok. Ornek: symbols=THYAO,ASELS"}
    if use_all_symbols and limit <= 0:
        limit = min(50, max_symbols)

    trials_default = 25 if mode == "quick" else 300
    trials = safe_int_param(params, ("trials", "random-trials"), trials_default, 0, max_trials)
    window = safe_int_param(params, ("window", "window-days"), 252, 80, 1500)
    oos = safe_int_param(params, ("oos", "oos-days"), 252, 0, 1500)
    fold = safe_int_param(params, ("fold", "fold-days"), 252, 80, 1500)
    step = safe_int_param(params, ("step", "step-days"), 63, 20, 500)
    cash = safe_int_param(params, ("cash", "initial-cash"), 100000, 1000, 100000000)
    pos = safe_float_param(params, ("pos", "position-pct"), 0.25, 0.01, 1.0)
    min_trades = safe_int_param(params, ("mintrades", "min-trades"), 3, 1, 100)
    bot_id = params.get("bot", params.get("bot-id", str(config.get("research_default_bot_id", "telegram-research"))))
    bot_id = "".join(ch for ch in bot_id if ch.isalnum() or ch in {"-", "_"})[:64] or "telegram-research"
    seed = params.get("seed", f"telegram-{int(time.time())}")
    seed = "".join(ch for ch in seed if ch.isalnum() or ch in {"-", "_"})[:80] or "telegram-seed"

    cmd = [
        str(config.get("research_node_bin", "node")),
        str(script),
        "--data",
        str(data_dir),
        "--out",
        str(out_dir),
        "--data-source",
        str(config.get("research_data_source", "telegram-yahoo-1d-5y")),
        "--strategies",
        params.get("strategies", "signal"),
        "--thresholds",
        clean_number_list(params.get("thresholds", "55,65,75")) or "55,65,75",
        "--max-holds",
        clean_number_list(params.get("holds", params.get("max-holds", "15,25"))) or "15,25",
        "--stops",
        clean_number_list(params.get("stops", "0.05")) or "0.05",
        "--targets",
        clean_number_list(params.get("targets", "0.06")) or "0.06",
        "--costs",
        clean_number_list(params.get("costs", "0.0015,0.003")) or "0.0015,0.003",
        "--min-rrs",
        clean_number_list(params.get("rr", params.get("min-rrs", "0,1"))) or "0,1",
        "--seed",
        seed,
        "--bot-id",
        bot_id,
        "--initial-cash",
        str(cash),
        "--position-pct",
        str(pos),
        "--min-trades",
        str(min_trades),
    ]
    if symbols:
        cmd.extend(["--symbols", ",".join(symbols)])
    if limit > 0:
        cmd.extend(["--limit", str(limit)])
    if mode == "rolling":
        cmd.extend(["--fold-days", str(fold), "--step-days", str(step), "--oos-days", str(oos)])
    else:
        cmd.extend(["--random-trials", str(trials), "--window-days", str(window), "--oos-days", str(oos)])

    meta = {
        "mode": mode,
        "symbols": symbols if symbols else ["all"],
        "limit": limit,
        "trials": trials if mode != "rolling" else 0,
        "window": window,
        "fold": fold if mode == "rolling" else 0,
        "step": step if mode == "rolling" else 0,
        "oos": oos,
        "botId": bot_id,
        "seed": seed,
        "root": str(root),
        "outDir": str(out_dir),
    }
    return cmd, meta


def start_research_job(config: dict[str, Any], text: str) -> str:
    cmd, meta = build_research_command(config, text)
    if not cmd:
        return meta.get("error", "Backtest komutu hazirlanamadi.")
    jobs = load_research_jobs(config)
    job_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = resolve_borsaman_root(config)
    log_dir = root / str(config.get("research_out_dir", "reports/research"))
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"telegram-job-{job_id}.log"
    try:
        handle = log_file.open("w", encoding="utf-8")
        proc = subprocess.Popen(
            cmd,
            cwd=str(root),
            stdout=handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=(os.name != "nt"),
        )
        handle.close()
    except Exception as exc:
        return f"Backtest baslatilamadi: {exc}"

    jobs["jobs"][job_id] = {
        "jobId": job_id,
        "pid": proc.pid,
        "status": "running",
        "startedAt": datetime.now().isoformat(timespec="seconds"),
        "logFile": str(log_file),
        "command": cmd,
        "meta": meta,
    }
    save_research_jobs(config, jobs)
    symbols_label = ",".join(meta.get("symbols", []))
    return "\n".join(
        [
            "Backtest baslatildi.",
            f"jobId: {job_id}",
            f"pid: {proc.pid}",
            f"mod: {meta.get('mode')}",
            f"sembol: {symbols_label}",
            f"trials: {meta.get('trials')} | oos: {meta.get('oos')}",
            "",
            f"Durum: /testdurum {job_id}",
            "Raporlar: /raporlar",
        ]
    )


def pid_running(pid: Any) -> bool:
    try:
        pid_int = int(pid)
    except Exception:
        return False
    if pid_int <= 0:
        return False
    proc_path = Path(f"/proc/{pid_int}")
    if Path("/proc").exists():
        return proc_path.exists()
    try:
        os.kill(pid_int, 0)
        return True
    except Exception:
        return False


def parse_research_log(log_file: Path) -> dict[str, str]:
    if not log_file.exists():
        return {}
    text = log_file.read_text(encoding="utf-8", errors="replace")
    out: dict[str, str] = {"tail": "\n".join(text.splitlines()[-10:])}
    for line in text.splitlines():
        if line.startswith("Report JSON:"):
            out["json"] = line.split(":", 1)[1].strip()
        elif line.startswith("Report CSV:"):
            out["csv"] = line.split(":", 1)[1].strip()
        elif line.startswith("Scoreboard:"):
            out["scoreboard"] = line.split(":", 1)[1].strip()
        elif line.startswith("Total runs:"):
            out["totalRuns"] = line.split(":", 1)[1].strip()
        elif line.startswith("Failures:"):
            out["failures"] = line.split(":", 1)[1].strip()
    return out


def refresh_research_job(config: dict[str, Any], job_id: str) -> dict[str, Any] | None:
    jobs = load_research_jobs(config)
    job = jobs.get("jobs", {}).get(job_id)
    if not isinstance(job, dict):
        return None
    running = pid_running(job.get("pid"))
    log_info = parse_research_log(Path(str(job.get("logFile", ""))))
    if running:
        job["status"] = "running"
    elif job.get("status") == "running":
        job["status"] = "finished" if log_info.get("scoreboard") else "finished_unknown"
        job["finishedAt"] = datetime.now().isoformat(timespec="seconds")
    if log_info:
        job["outputs"] = log_info
    jobs["jobs"][job_id] = job
    save_research_jobs(config, jobs)
    return job


def summarize_scoreboard(root: Path, relative_path: str) -> list[str]:
    path = root / relative_path
    if not path.exists():
        path = Path(relative_path)
    if not path.exists():
        return []
    data = load_json(path)
    variants = data.get("variantSummary", [])
    lines = [f"Scoreboard: {path.name}"]
    if isinstance(variants, list) and variants:
        best = sorted(variants, key=lambda item: float(item.get("robustnessScore", 0)), reverse=True)[0]
        lines.extend(
            [
                f"En iyi: {best.get('variant')}",
                f"Skor: {best.get('robustnessScore')} | avgRet: {best.get('avgReturnPct')}%",
                f"Win: {best.get('avgWinRate')}% | PF: {best.get('avgProfitFactor')}",
                f"Drawdown: {best.get('worstDrawdownPct')}% | Trades: {best.get('closedTrades')}",
            ]
        )
    return lines


def format_research_status(config: dict[str, Any], job_id: str = "") -> str:
    jobs = load_research_jobs(config).get("jobs", {})
    if not job_id:
        if not jobs:
            return "Backtest isi yok. Baslatmak icin: /test symbols=THYAO,ASELS trials=200"
        job_id = sorted(jobs.keys())[-1]
    job = refresh_research_job(config, job_id)
    if not job:
        return f"Job bulunamadi: {job_id}"
    root = resolve_borsaman_root(config)
    outputs = job.get("outputs", {})
    lines = [
        f"Backtest job: {job_id}",
        f"Durum: {job.get('status')}",
        f"PID: {job.get('pid')}",
        f"Baslangic: {job.get('startedAt')}",
        f"Mod: {job.get('meta', {}).get('mode')}",
    ]
    if outputs:
        lines.append(f"Total runs: {outputs.get('totalRuns', '-')}")
        lines.append(f"Failures: {outputs.get('failures', '-')}")
        if outputs.get("scoreboard"):
            lines.extend(summarize_scoreboard(root, outputs["scoreboard"]))
        lines.append(f"Log: {job.get('logFile')}")
    else:
        lines.append(f"Log: {job.get('logFile')}")
    return "\n".join(lines[:28])


def format_reports(config: dict[str, Any]) -> str:
    root = resolve_borsaman_root(config)
    report_dir = root / str(config.get("research_out_dir", "reports/research"))
    files = sorted(report_dir.glob("scoreboard-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]
    if not files:
        return f"Scoreboard bulunamadi.\nKlasor: {report_dir}"
    lines = ["Son research raporlari"]
    for path in files:
        data = load_json(path)
        variants = data.get("variantSummary", [])
        best = variants[0] if isinstance(variants, list) and variants else {}
        if isinstance(variants, list) and variants:
            best = sorted(variants, key=lambda item: float(item.get("robustnessScore", 0)), reverse=True)[0]
        lines.append("")
        lines.append(path.name)
        lines.append(f"botId: {data.get('botId', '-')}")
        lines.append(f"runId: {data.get('runId', '-')}")
        if best:
            lines.append(f"best: {best.get('variant')}")
            lines.append(f"skor: {best.get('robustnessScore')} avgRet: {best.get('avgReturnPct')}% PF: {best.get('avgProfitFactor')}")
    return "\n".join(lines)


def format_docs(config: dict[str, Any], name: str = "") -> str:
    docs = config.get("docs", {})
    if not isinstance(docs, dict) or not docs:
        return "Dokuman config yok."
    key = name.strip().lower()
    if not key:
        lines = ["Dokumanlar"]
        for doc_name in sorted(docs):
            lines.append(f"- /dokuman {doc_name}")
        return "\n".join(lines)
    if key not in docs:
        return "Dokuman bulunamadi.\n\n" + format_docs(config)
    root = resolve_borsaman_root(config)
    path = root / str(docs[key])
    if not path.exists():
        return f"Dokuman dosyasi yok: {path}"
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if len(text) > 3600:
        text = text[:3500].rstrip() + "\n\n...devami dosyada: " + str(path)
    return text


def format_ai_reply(config: dict[str, Any], question: str) -> str:
    question = question.strip()
    if not question:
        return "Kullanim: /ai portfoy ve gunluk trade raporuna gore neye dikkat edelim?"
    if not resolve_gemini_key(config):
        return "Gemini API key bulunamadi. BMAN_GEMINI_API_KEY veya config icindeki gemini_api_key_source ayarlanacak."
    state = load_state(config)
    today = local_now(config).date().isoformat()
    plan = state.get("plans", {}).get(today, {})
    closing = state.get("closings", {}).get(today, {})
    context = {
        "today": today,
        "web": public_web_url(config),
        "plan": plan,
        "closing": closing,
    }
    prompt = "\n".join(
        [
            "BorsaMan admin asistanisin. Verilen bot defterine ve soruya gore cevap ver.",
            "Yeni veri uydurma, emin olmadigin yerde bunu soyle. Kisa, aksiyon odakli ve Turkce yaz.",
            "Son satira 'Yatirim tavsiyesi degildir.' ekle.",
            "",
            "Baglam JSON:",
            json.dumps(context, ensure_ascii=False)[:5000],
            "",
            "Soru:",
            question[:1000],
        ]
    )
    try:
        answer = gemini_generate(config, prompt)
    except Exception as exc:
        return f"Gemini yaniti alinamadi: {type(exc).__name__}"
    return answer or "Gemini bos yanit dondu."


def help_text() -> str:
    return "\n".join(
        [
            "BorsaMan Telegram komutlari",
            "/durum - web adresi",
            "/web - web adresi",
            "/gunluk - bugunun trade plani",
            "/kapanis - seans sonu hedef/stop ozeti",
            "/ai soru - Gemini ile rapor yorumu",
            "/cache - AI Advisor cache durumu",
            "/sistem - RPi sistem durumu",
            "/servis - systemd servis durumu",
            "/site - lokal site kontrolu",
            "/oturumlar - aktif web oturumlari",
            "/erisim - web kullanici listesi",
            "/test ... - parametreli backtest baslat",
            "/testdurum [jobId] - backtest is durumu",
            "/raporlar - son research raporlari",
            "/dokuman [ad] - admin dokumanlari",
            "/katalog - indirilen veri katalog ozeti",
            "/skor - son bot skor defteri",
            "/ping - bot yasiyor mu kontrolu",
            "/yardim - bu liste",
        ]
    )


def normalize_text(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("/"):
        first, *rest = text.split(maxsplit=1)
        if "@" in first:
            first = first.split("@", 1)[0]
        return " ".join([first, *rest]).strip()
    return text


def handle_text(text: str, config: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    text = normalize_button_payload(text)
    normalized = normalize_text(text).lower()
    key = ascii_key(normalized)
    if normalized in ("/start", "start", "menu", "menü"):
        return ("BorsaMan Telegram aktif.\n\n" + help_text(), MAIN_MENU)
    if key in ("/durum", "durum"):
        return (format_status(config), MAIN_MENU)
    if key in ("/web", "web"):
        return (format_web(config), MAIN_MENU)
    if key in ("/gunluk", "gunluk", "gunluk trade", "gunluktrade"):
        return (build_plan_reply(config), MAIN_MENU)
    if key in ("/kapanis", "kapanis", "/sonuc", "sonuc", "/rapor", "rapor"):
        return (build_closing_reply(config), MAIN_MENU)
    if key.startswith("/ai ") or key.startswith("ai "):
        question = normalized.split(" ", 1)[1] if " " in normalized else ""
        return (format_ai_reply(config, question), MAIN_MENU)
    if key in ("/cache", "cache", "/tara", "tara"):
        return (format_cache_status(config), MAIN_MENU)
    if key in ("/sistem", "sistem", "sistem durumu"):
        return (format_system(config), MAIN_MENU)
    if key in ("/servis", "servis", "servis durumu"):
        return (format_service_status(config), MAIN_MENU)
    if key in ("/site", "site", "site kontrol", "site kontrolu"):
        return (format_site_check(config), MAIN_MENU)
    if key in ("/oturumlar", "oturumlar", "oturum"):
        return (format_sessions(config), MAIN_MENU)
    if key in ("/erisim", "erisim", "erisim talepleri"):
        return (format_access_status(config), MAIN_MENU)
    if key in ("/test", "test", "test yardim", "/testyardim", "testyardim"):
        return (research_help_text(), MAIN_MENU)
    if key.startswith("/test ") or key.startswith("test "):
        raw = normalized.split(" ", 1)[1] if " " in normalized else ""
        return (start_research_job(config, raw), MAIN_MENU)
    if key in ("/testdurum", "test durum", "testdurum"):
        return (format_research_status(config), MAIN_MENU)
    if key.startswith("/testdurum ") or key.startswith("testdurum ") or key.startswith("test durum "):
        job_id = normalized.split()[-1]
        return (format_research_status(config, job_id), MAIN_MENU)
    if key in ("/raporlar", "raporlar", "rapor listesi"):
        return (format_reports(config), MAIN_MENU)
    if key in ("/dokuman", "dokuman", "dokumanlar"):
        return (format_docs(config), MAIN_MENU)
    if key.startswith("/dokuman ") or key.startswith("dokuman "):
        doc_name = normalized.split(" ", 1)[1] if " " in normalized else ""
        return (format_docs(config, doc_name), MAIN_MENU)
    if key in ("/katalog", "katalog"):
        return (format_catalog(config), MAIN_MENU)
    if key in ("/skor", "skor"):
        return (format_score(config), MAIN_MENU)
    if key in ("/yardim", "/help", "yardim", "help"):
        return (help_text(), MAIN_MENU)
    if key in ("/ping", "ping"):
        return ("pong", None)
    return ("Anlamadim.\n\n" + help_text(), MAIN_MENU)


def message_chat_id(message: dict[str, Any]) -> str:
    return str(message.get("chat", {}).get("id", ""))


def message_user_id(message: dict[str, Any]) -> str:
    return str(message.get("from", {}).get("id", ""))


def is_admin(message: dict[str, Any], admin_ids: set[str]) -> bool:
    return is_admin_identity(message_chat_id(message), message_user_id(message), admin_ids)


def is_admin_identity(chat_id: str, user_id: str, admin_ids: set[str]) -> bool:
    if not admin_ids:
        return False
    return str(chat_id) in admin_ids or str(user_id) in admin_ids


def callback_chat_id(callback: dict[str, Any]) -> str:
    message = callback.get("message") or {}
    if isinstance(message, dict):
        return message_chat_id(message)
    return ""


def callback_user_id(callback: dict[str, Any]) -> str:
    user = callback.get("from") or {}
    if isinstance(user, dict):
        return str(user.get("id", ""))
    return ""


def callback_payload(callback: dict[str, Any]) -> str:
    data = str(callback.get("data") or "").strip()
    if data:
        return data
    message = callback.get("message") or {}
    if isinstance(message, dict):
        return str(message.get("text") or "").strip()
    return ""


def process_update(
    client: TelegramClient,
    config: dict[str, Any],
    admin_ids: set[str],
    item: dict[str, Any],
) -> None:
    try:
        callback = item.get("callback_query")
        if isinstance(callback, dict) and callback:
            callback_id = str(callback.get("id") or "")
            chat_id = callback_chat_id(callback)
            user_id = callback_user_id(callback)
            payload = callback_payload(callback) or "/yardim"
            if callback_id:
                try:
                    client.answer_callback_query(callback_id, "Alindi, hazirlaniyor...")
                except Exception as exc:
                    print(f"Callback ack failed: {exc}", flush=True)
            if not chat_id:
                return
            if not is_admin_identity(chat_id, user_id, admin_ids):
                client.send_message(chat_id, "Bu bot su anda sadece admin kullanicilara acik.")
                return
            reply, markup = handle_text(payload, config)
            client.send_message(chat_id, reply, markup)
            return

        message = item.get("message") or {}
        if not isinstance(message, dict):
            return
        text = message.get("text", "")
        chat_id = message_chat_id(message)
        if not text or not chat_id:
            return
        if not is_admin(message, admin_ids):
            client.send_message(chat_id, "Bu bot su anda sadece admin kullanicilara acik.")
            return
        reply, markup = handle_text(text, config)
        client.send_message(chat_id, reply, markup)
    except Exception as exc:
        print(f"Update handler error: {exc}", flush=True)


def drop_pending_updates(client: TelegramClient) -> int | None:
    updates = client.get_updates(offset=None, timeout=0)
    if not updates:
        return None
    return max(int(item["update_id"]) for item in updates) + 1


def send_to_admins(
    client: TelegramClient,
    admin_ids: set[str],
    text: str,
    reply_markup: dict[str, Any] | None = MAIN_MENU,
) -> int:
    sent = 0
    for chat_id in sorted(admin_ids):
        try:
            client.send_message(chat_id, text, reply_markup)
            sent += 1
        except Exception as exc:
            print(f"Could not send scheduled report to {chat_id}: {exc}", flush=True)
    return sent


def maybe_run_scheduled_reports(
    client: TelegramClient,
    config: dict[str, Any],
    admin_ids: set[str],
) -> None:
    if not config.get("trade_reports_enabled", True) or not admin_ids:
        return
    now = local_now(config)
    if not is_trading_day(now):
        return

    morning_at = parse_hhmm(config.get("morning_report_time"), "09:30")
    closing_at = parse_hhmm(config.get("closing_report_time"), "18:10")
    current_time = now.time().replace(second=0, microsecond=0)
    date_key = now.date().isoformat()
    state = load_state(config)
    sent = state.setdefault("sent", {})

    if current_time >= morning_at and sent.get("morning") != date_key:
        plan = get_or_create_plan(config, state, now)
        message = append_gemini_note(config, format_morning_report(plan), "otomatik gunluk trade plani")
        if send_to_admins(client, admin_ids, message):
            sent["morning"] = date_key
            save_state(config, state)

    if current_time >= closing_at and sent.get("closing") != date_key:
        summary = build_closing_summary(config, state, now)
        message = append_gemini_note(config, format_closing_report(summary), "otomatik seans sonu ozeti")
        if send_to_admins(client, admin_ids, message):
            sent["closing"] = date_key
            save_state(config, state)


def polling_loop(client: TelegramClient, config: dict[str, Any], admin_ids: set[str]) -> None:
    timeout = int(config.get("poll_timeout", 30))
    sleep = float(config.get("poll_sleep", 1))
    workers = max(1, int(config.get("telegram_handler_workers", 4)))
    offset = None
    if config.get("drop_pending_on_start", True):
        try:
            offset = drop_pending_updates(client)
        except Exception as exc:
            print(f"Could not drop pending updates yet: {exc}", flush=True)
    print("BorsaMan Telegram polling started.", flush=True)
    print(f"Admins configured: {len(admin_ids)}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tg-handler") as executor:
        while True:
            try:
                maybe_run_scheduled_reports(client, config, admin_ids)
                updates = client.get_updates(offset=offset, timeout=timeout)
                for item in updates:
                    offset = int(item["update_id"]) + 1
                    executor.submit(process_update, client, config, admin_ids, item)
            except urllib.error.HTTPError as exc:
                print(f"Telegram HTTP error: {exc.code} {exc.reason}", flush=True)
                time.sleep(3)
            except Exception as exc:
                print(f"Bot loop error: {exc}", flush=True)
                time.sleep(3)
            time.sleep(sleep)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--getme", action="store_true", help="Print bot identity without starting polling.")
    parser.add_argument("--once", help="Handle one local command and print the reply.")
    args = parser.parse_args()

    config = load_config()
    token = resolve_token(config)
    admin_ids = resolve_admin_ids(config)

    if args.once:
        reply, _ = handle_text(args.once, config)
        print(reply)
        return 0

    client = TelegramClient(
        token,
        api_timeout=float(config.get("telegram_api_timeout_seconds", 12)),
        send_timeout=float(config.get("telegram_send_timeout_seconds", 8)),
        callback_timeout=float(config.get("telegram_callback_timeout_seconds", 2)),
    )
    if args.getme:
        me = client.api("getMe").get("result", {})
        print(f"@{me.get('username')} id={me.get('id')} first_name={me.get('first_name')!r}")
        print(f"admins={','.join(sorted(admin_ids)) if admin_ids else '<none>'}")
        return 0

    polling_loop(client, config, admin_ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
