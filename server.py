#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DIST_DIR = Path(os.environ.get("BMAN_DIST_DIR", ROOT / "dist")).resolve()
AUTH_CONFIG = Path(os.environ.get("BMAN_AUTH_CONFIG", ROOT / "config" / "web-auth.json")).resolve()
HOST = os.environ.get("BMAN_HOST", "0.0.0.0")
PORT = int(os.environ.get("BMAN_PORT", "8080"))
COOKIE_NAME = "bman_session"
DEFAULT_TTL_SECONDS = 8 * 60 * 60
ADVISOR_CACHE_PATH = Path(os.environ.get("BMAN_ADVISOR_CACHE", ROOT / "reports" / "advisor" / "latest.json")).resolve()
ADVISOR_PROGRESS_PATH = Path(os.environ.get("BMAN_ADVISOR_PROGRESS", ROOT / "reports" / "advisor" / "progress.json")).resolve()
ADVISOR_SCRIPT = Path(os.environ.get("BMAN_ADVISOR_SCRIPT", ROOT / "scripts" / "advisor" / "build-advisor-cache.mjs")).resolve()
ADVISOR_ENABLED = os.environ.get("BMAN_ADVISOR_BACKGROUND", "1").lower() not in {"0", "false", "no"}
ADVISOR_UNIVERSE = os.environ.get("BMAN_ADVISOR_UNIVERSE", "bistall")
ADVISOR_CONCURRENCY = int(os.environ.get("BMAN_ADVISOR_CONCURRENCY", "4"))
ADVISOR_DELAY_MS = int(os.environ.get("BMAN_ADVISOR_DELAY_MS", "350"))
ADVISOR_MARKET_INTERVAL = int(os.environ.get("BMAN_ADVISOR_MARKET_INTERVAL_SECONDS", "1200"))
ADVISOR_IDLE_INTERVAL = int(os.environ.get("BMAN_ADVISOR_IDLE_INTERVAL_SECONDS", "3600"))
ADVISOR_SCAN_TIMEOUT = int(os.environ.get("BMAN_ADVISOR_SCAN_TIMEOUT_SECONDS", "1200"))
ADVISOR_STARTUP_DELAY = int(os.environ.get("BMAN_ADVISOR_STARTUP_DELAY_SECONDS", "20"))
SESSION_STATUS_PATH = Path(os.environ.get("BMAN_SESSION_STATUS", ROOT / "reports" / "admin" / "sessions.json")).resolve()

sessions: dict[str, dict[str, Any]] = {}
advisor_scanner: "AdvisorScanner | None" = None

PROXY_ROUTES = [
    ("/api/isyatirim-hisse", "https://www.isyatirim.com.tr", "/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil", {"Referer": "https://www.isyatirim.com.tr/"}),
    ("/api/isyatirim", "https://www.isyatirim.com.tr", "/_layouts/15/IsYatirim.Website/Common/Data.aspx", {"Referer": "https://www.isyatirim.com.tr/"}),
    ("/api/bigpara", "https://bigpara.hurriyet.com.tr", "/api/v1", {"Referer": "https://bigpara.hurriyet.com.tr/"}),
    ("/api/foreks", "https://web-paragaranti-pubsub.foreks.com", "/web-services", {"Referer": "https://www.paragaranti.com/"}),
    ("/api/tcmb_xml", "https://www.tcmb.gov.tr", "/kurlar/today.xml", {}),
    ("/api/tcmb", "https://www.tcmb.gov.tr", "/wps/wcm/connect/TR/TCMB+TR", {}),
    ("/api/ff_calendar_next", "https://nfs.faireconomy.media", "/ff_calendar_nextweek.json", {}),
    ("/api/ff_calendar", "https://nfs.faireconomy.media", "/ff_calendar_thisweek.json", {}),
    ("/api/genelpara", "https://api.genelpara.com", "/embed/doviz.json", {}),
    ("/yahoo/v10", "https://query1.finance.yahoo.com", "/v10", {}),
    ("/yahoo/v8", "https://query1.finance.yahoo.com", "/v8", {}),
    ("/yahoo/v7", "https://query2.finance.yahoo.com", "/v7", {}),
]


def load_auth_config() -> dict[str, Any]:
    if not AUTH_CONFIG.exists():
        return {"enabled": True, "configured": False, "users": [], "session_ttl_seconds": DEFAULT_TTL_SECONDS}
    try:
        with AUTH_CONFIG.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {"enabled": True, "configured": False, "users": [], "session_ttl_seconds": DEFAULT_TTL_SECONDS}
    if not isinstance(data, dict):
        data = {}
    users = data.get("users", [])
    configured = isinstance(users, list) and len(users) > 0
    return {
        "enabled": data.get("enabled", True),
        "configured": configured,
        "users": users if isinstance(users, list) else [],
        "session_ttl_seconds": int(data.get("session_ttl_seconds", DEFAULT_TTL_SECONDS)),
    }


def parse_password_hash(value: str) -> tuple[int, bytes, bytes] | None:
    try:
        scheme, iterations, salt, digest = value.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return None
        return int(iterations), base64.b64decode(salt), base64.b64decode(digest)
    except Exception:
        return None


def verify_password(password: str, stored_hash: str) -> bool:
    parsed = parse_password_hash(stored_hash)
    if not parsed:
        return False
    iterations, salt, expected = parsed
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def find_user(username: str, config: dict[str, Any]) -> dict[str, Any] | None:
    wanted = username.strip().casefold()
    for user in config.get("users", []):
        if str(user.get("username", "")).strip().casefold() == wanted:
            return user
    return None


def new_session(username: str, ttl_seconds: int) -> str:
    token = secrets.token_urlsafe(32)
    sessions[token] = {"username": username, "expires": time.time() + ttl_seconds}
    write_session_snapshot()
    return token


def clean_sessions() -> None:
    now = time.time()
    expired = [token for token, data in sessions.items() if data.get("expires", 0) <= now]
    for token in expired:
        sessions.pop(token, None)
    if expired:
        write_session_snapshot()


def write_session_snapshot() -> None:
    try:
        SESSION_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        users: dict[str, int] = {}
        now = time.time()
        active = []
        for data in sessions.values():
            username = str(data.get("username", ""))
            expires = float(data.get("expires", 0))
            if expires <= now:
                continue
            users[username] = users.get(username, 0) + 1
            active.append({"username": username, "expiresAt": int(expires)})
        payload = {
            "updatedAt": int(now),
            "activeCount": len(active),
            "users": users,
            "sessions": active,
        }
        temp_path = SESSION_STATUS_PATH.with_suffix(SESSION_STATUS_PATH.suffix + ".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_path.replace(SESSION_STATUS_PATH)
    except Exception as exc:
        print(f"Could not write session snapshot: {exc}", flush=True)


def parse_cookies(header: str | None) -> dict[str, str]:
    if not header:
        return {}
    cookie = SimpleCookie()
    cookie.load(header)
    return {key: value.value for key, value in cookie.items()}


def html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def is_auth_path(path: str) -> bool:
    return path in {"/login", "/api/auth/session", "/api/auth/login", "/api/auth/logout"}


def is_bist_market_open() -> bool:
    now = time.localtime()
    if now.tm_wday >= 5:
        return False
    minutes = now.tm_hour * 60 + now.tm_min
    return (570 <= minutes < 750) or (840 <= minutes < 1050)


def load_advisor_cache() -> dict[str, Any] | None:
    if not ADVISOR_CACHE_PATH.exists():
        return None
    try:
        with ADVISOR_CACHE_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def load_advisor_progress() -> dict[str, Any]:
    try:
        if not ADVISOR_PROGRESS_PATH.exists():
            return {}
        with ADVISOR_PROGRESS_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def advisor_cache_age_seconds() -> float | None:
    try:
        return max(0.0, time.time() - ADVISOR_CACHE_PATH.stat().st_mtime)
    except Exception:
        return None


class AdvisorScanner:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.pending = False
        self.running = False
        self.last_started_at = 0.0
        self.last_finished_at = 0.0
        self.last_error = ""
        self.last_reason = ""

    def start(self) -> None:
        thread = threading.Thread(target=self._loop, name="advisor-scanner", daemon=True)
        thread.start()

    def trigger(self, reason: str = "manual") -> bool:
        with self._lock:
            if self.running:
                self.pending = True
                return False
            self.pending = True
            self.last_reason = reason
            return True

    def status(self) -> dict[str, Any]:
        age = advisor_cache_age_seconds()
        progress = load_advisor_progress()
        return {
            "enabled": ADVISOR_ENABLED,
            "running": self.running,
            "pending": self.pending,
            "lastStartedAt": self.last_started_at,
            "lastFinishedAt": self.last_finished_at,
            "lastError": self.last_error,
            "lastReason": self.last_reason,
            "cachePath": str(ADVISOR_CACHE_PATH),
            "progressPath": str(ADVISOR_PROGRESS_PATH),
            "cacheAgeSeconds": age,
            "marketOpen": is_bist_market_open(),
            "marketIntervalSeconds": ADVISOR_MARKET_INTERVAL,
            "idleIntervalSeconds": ADVISOR_IDLE_INTERVAL,
            "progress": progress,
            "done": progress.get("done", 0),
            "total": progress.get("total", 0),
            "pct": progress.get("pct", 0),
        }

    def _needs_scan(self) -> bool:
        if not ADVISOR_CACHE_PATH.exists():
            return True
        age = advisor_cache_age_seconds()
        if age is None:
            return True
        interval = ADVISOR_MARKET_INTERVAL if is_bist_market_open() else ADVISOR_IDLE_INTERVAL
        return age >= interval

    def _loop(self) -> None:
        time.sleep(max(0, ADVISOR_STARTUP_DELAY))
        while True:
            try:
                should_run = False
                reason = "scheduled"
                with self._lock:
                    if self.pending:
                        self.pending = False
                        should_run = True
                        reason = self.last_reason or "manual"
                if not should_run:
                    should_run = self._needs_scan()
                if should_run:
                    self.run_once(reason)
            except Exception as exc:
                self.last_error = str(exc)
                print(f"Advisor scanner loop error: {exc}", flush=True)
            time.sleep(30)

    def run_once(self, reason: str) -> bool:
        with self._lock:
            if self.running:
                self.pending = True
                return False
            self.running = True
            self.last_started_at = time.time()
            self.last_reason = reason
            self.last_error = ""
        try:
            node = shutil.which(os.environ.get("BMAN_NODE_BIN", "node"))
            if not node:
                raise RuntimeError("node executable not found")
            if not ADVISOR_SCRIPT.exists():
                raise RuntimeError(f"advisor script not found: {ADVISOR_SCRIPT}")
            command = [
                node,
                str(ADVISOR_SCRIPT),
                "--out",
                str(ADVISOR_CACHE_PATH),
                "--progress",
                str(ADVISOR_PROGRESS_PATH),
                "--universe",
                ADVISOR_UNIVERSE,
                "--concurrency",
                str(ADVISOR_CONCURRENCY),
                "--delay-ms",
                str(ADVISOR_DELAY_MS),
            ]
            nice = shutil.which("nice") if os.name != "nt" else None
            if nice:
                command = [nice, "-n", "10", *command]
            print("Advisor scanner started", flush=True)
            proc = subprocess.run(
                command,
                cwd=str(ROOT),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=ADVISOR_SCAN_TIMEOUT,
            )
            if proc.returncode != 0:
                raise RuntimeError((proc.stdout or "").strip()[-1000:] or f"scanner exit {proc.returncode}")
            print(f"Advisor scanner finished: {(proc.stdout or '').strip()}", flush=True)
            return True
        except Exception as exc:
            self.last_error = str(exc)
            print(f"Advisor scanner failed: {exc}", flush=True)
            return False
        finally:
            with self._lock:
                self.running = False
                self.last_finished_at = time.time()


class BorsaManHandler(SimpleHTTPRequestHandler):
    server_version = "BorsaManHTTP/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args), flush=True)

    def auth_config(self) -> dict[str, Any]:
        return load_auth_config()

    def current_user(self) -> str | None:
        config = self.auth_config()
        if not config.get("enabled", True):
            return "auth-disabled"
        clean_sessions()
        token = parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME)
        if not token:
            return None
        data = sessions.get(token)
        if not data or data.get("expires", 0) <= time.time():
            sessions.pop(token, None)
            return None
        return str(data.get("username", ""))

    def is_authenticated(self) -> bool:
        return self.current_user() is not None

    def send_no_store(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")

    def send_json(self, status: int, payload: dict[str, Any], extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_no_store()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, status: int, html: str, extra_headers: dict[str, str] | None = None) -> None:
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_no_store()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def login_page(self, error: str = "") -> str:
        safe_error = html_escape(error)
        error_block = f'<div class="err">{safe_error}</div>' if safe_error else ""
        return f"""<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BorsaMan Giris</title>
  <style>
    :root {{ color-scheme: dark; --bg:#070b12; --panel:#111827; --line:#243244; --text:#e5edf7; --muted:#8fa0b7; --accent:#00e676; --bad:#ff4d6d; }}
    * {{ box-sizing: border-box; }}
    body {{ margin:0; min-height:100vh; display:grid; place-items:center; background:linear-gradient(135deg,#070b12,#101827); color:var(--text); font-family:Inter,system-ui,Segoe UI,sans-serif; }}
    main {{ width:min(420px, calc(100vw - 32px)); border:1px solid var(--line); background:rgba(17,24,39,.94); padding:28px; border-radius:8px; box-shadow:0 24px 80px rgba(0,0,0,.38); }}
    h1 {{ margin:0 0 6px; font-size:26px; letter-spacing:0; }}
    p {{ margin:0 0 22px; color:var(--muted); line-height:1.5; }}
    label {{ display:block; margin:14px 0 7px; color:var(--muted); font-size:13px; }}
    input {{ width:100%; padding:13px 14px; border-radius:6px; border:1px solid var(--line); background:#0b1220; color:var(--text); font-size:16px; }}
    input:focus {{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(0,230,118,.12); }}
    button {{ width:100%; margin-top:20px; padding:13px 16px; border:0; border-radius:6px; background:var(--accent); color:#03130a; font-weight:800; cursor:pointer; }}
    .err {{ margin:0 0 14px; padding:10px 12px; border:1px solid rgba(255,77,109,.35); background:rgba(255,77,109,.12); color:#ffb3c0; border-radius:6px; }}
    .foot {{ margin-top:18px; font-size:12px; color:var(--muted); }}
  </style>
</head>
<body>
  <main>
    <h1>BorsaMan</h1>
    <p>Devam etmek icin yetkili kullanici ile giris yap.</p>
    {error_block}
    <form method="post" action="/api/auth/login">
      <label for="username">Kullanici adi</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Sifre</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Giris yap</button>
    </form>
    <div class="foot">Erisim sadece tanimli kullanicilar icindir.</div>
  </main>
</body>
</html>"""

    def require_auth(self) -> bool:
        config = self.auth_config()
        if not config.get("enabled", True) or is_auth_path(self.path_only()):
            return True
        if self.is_authenticated():
            return True
        if self.command == "GET" and self.accepts_html():
            self.send_html(HTTPStatus.OK, self.login_page())
        else:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"authenticated": False, "error": "authentication_required"})
        return False

    def accepts_html(self) -> bool:
        accept = self.headers.get("Accept", "")
        return "text/html" in accept or "*/*" in accept or not accept

    def path_only(self) -> str:
        return urllib.parse.urlsplit(self.path).path

    def do_GET(self) -> None:
        path = self.path_only()
        if path == "/login":
            self.send_html(HTTPStatus.OK, self.login_page())
            return
        if path == "/api/auth/session":
            config = self.auth_config()
            user = self.current_user()
            self.send_json(
                HTTPStatus.OK,
                {
                    "enabled": bool(config.get("enabled", True)),
                    "configured": bool(config.get("configured", False)),
                    "authenticated": user is not None,
                    "username": user,
                },
            )
            return
        if not self.require_auth():
            return
        if path == "/api/advisor-cache":
            self.handle_advisor_cache()
            return
        if self.proxy_if_needed():
            return
        self.serve_static()

    def do_POST(self) -> None:
        path = self.path_only()
        if path == "/api/auth/login":
            self.handle_login()
            return
        if path == "/api/auth/logout":
            self.handle_logout()
            return
        if not self.require_auth():
            return
        if path == "/api/advisor-refresh":
            self.handle_advisor_refresh()
            return
        if self.proxy_if_needed():
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def handle_advisor_cache(self) -> None:
        payload = load_advisor_cache()
        status = advisor_scanner.status() if advisor_scanner else {"enabled": False}
        if not payload:
            self.send_json(
                HTTPStatus.ACCEPTED,
                {
                    "ready": False,
                    "message": "advisor_cache_not_ready",
                    "scanner": status,
                },
            )
            return
        payload = dict(payload)
        payload["ready"] = True
        payload["scanner"] = status
        self.send_json(HTTPStatus.OK, payload)

    def handle_advisor_refresh(self) -> None:
        if not advisor_scanner:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"accepted": False, "error": "advisor_scanner_disabled"})
            return
        accepted = advisor_scanner.trigger("manual")
        self.send_json(HTTPStatus.ACCEPTED, {"accepted": True, "startedNow": accepted, "scanner": advisor_scanner.status()})

    def handle_login(self) -> None:
        config = self.auth_config()
        if not config.get("enabled", True):
            self.send_json(HTTPStatus.OK, {"authenticated": True, "username": "auth-disabled"})
            return
        if not config.get("configured", False):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"authenticated": False, "error": "auth_not_configured"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(min(length, 32 * 1024))
        content_type = self.headers.get("Content-Type", "")
        if "application/json" in content_type:
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                data = {}
        else:
            parsed = urllib.parse.parse_qs(raw.decode("utf-8", "replace"))
            data = {key: values[0] for key, values in parsed.items() if values}
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        user = find_user(username, config)
        ok = bool(user and verify_password(password, str(user.get("password_hash", ""))))
        if not ok:
            if "text/html" in self.headers.get("Accept", "") and "application/json" not in content_type:
                self.send_html(HTTPStatus.UNAUTHORIZED, self.login_page("Kullanici adi veya sifre hatali."))
            else:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"authenticated": False, "error": "invalid_credentials"})
            return
        ttl = int(config.get("session_ttl_seconds", DEFAULT_TTL_SECONDS))
        token = new_session(username, ttl)
        cookie = f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={ttl}"
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            cookie += "; Secure"
        if "text/html" in self.headers.get("Accept", "") and "application/json" not in content_type:
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", cookie)
            self.send_no_store()
            self.end_headers()
        else:
            self.send_json(HTTPStatus.OK, {"authenticated": True, "username": username}, {"Set-Cookie": cookie})

    def handle_logout(self) -> None:
        token = parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME)
        if token:
            sessions.pop(token, None)
            write_session_snapshot()
        expired = f"{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        self.send_json(HTTPStatus.OK, {"authenticated": False}, {"Set-Cookie": expired})

    def proxy_if_needed(self) -> bool:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        for prefix, target, rewrite, headers in sorted(PROXY_ROUTES, key=lambda item: len(item[0]), reverse=True):
            if path == prefix or path.startswith(prefix + "/"):
                suffix = path[len(prefix) :]
                target_url = target + rewrite + suffix
                if parsed.query:
                    target_url += "?" + parsed.query
                self.proxy_request(target_url, headers)
                return True
        if path == "/api/proxy":
            query = urllib.parse.parse_qs(parsed.query)
            url = (query.get("url") or [""])[0]
            if not url.startswith(("https://", "http://")):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_proxy_url"})
                return True
            self.proxy_request(url, {})
            return True
        return False

    def proxy_request(self, url: str, headers: dict[str, str]) -> None:
        request_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": self.headers.get("Accept", "*/*"),
        }
        request_headers.update(headers)
        method = self.command
        body = None
        if method in {"POST", "PUT", "PATCH"}:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = self.rfile.read(length)
        try:
            request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = response.read()
                self.send_response(response.status)
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain; charset=utf-8"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "proxy_failed", "message": str(exc)})

    def translate_static_path(self, request_path: str) -> Path:
        parsed_path = urllib.parse.urlsplit(request_path).path
        parsed_path = posixpath.normpath(urllib.parse.unquote(parsed_path))
        parts = [part for part in parsed_path.split("/") if part and part not in {".", ".."}]
        target = DIST_DIR.joinpath(*parts)
        if target.is_dir():
            target = target / "index.html"
        if not target.exists():
            if "." not in (parts[-1] if parts else ""):
                target = DIST_DIR / "index.html"
        return target.resolve()

    def serve_static(self) -> None:
        target = self.translate_static_path(self.path)
        if not str(target).startswith(str(DIST_DIR)) or not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        payload = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if target.name in {"index.html", "sw.js"}:
            self.send_no_store()
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    global advisor_scanner
    if not DIST_DIR.exists():
        raise SystemExit(f"dist directory not found: {DIST_DIR}")
    config = load_auth_config()
    if config.get("enabled", True) and not config.get("configured", False):
        print(f"WARNING: web auth is enabled but no users are configured in {AUTH_CONFIG}", flush=True)
    write_session_snapshot()
    if ADVISOR_ENABLED:
        advisor_scanner = AdvisorScanner()
        advisor_scanner.start()
        print(
            "Advisor background scanner enabled: "
            f"cache={ADVISOR_CACHE_PATH} universe={ADVISOR_UNIVERSE} "
            f"concurrency={ADVISOR_CONCURRENCY}",
            flush=True,
        )
    httpd = ThreadingHTTPServer((HOST, PORT), BorsaManHandler)
    print(f"BorsaMan serving {DIST_DIR} on http://{HOST}:{PORT}", flush=True)
    print(f"Auth config: {AUTH_CONFIG}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
