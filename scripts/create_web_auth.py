#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import secrets
from pathlib import Path


DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "config" / "web-auth.json"
ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    salt_b64 = base64.b64encode(salt).decode("ascii")
    digest_b64 = base64.b64encode(digest).decode("ascii")
    return f"pbkdf2_sha256${ITERATIONS}${salt_b64}${digest_b64}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Create BorsaMan web login config.")
    parser.add_argument("--user", required=True, help="Login username.")
    parser.add_argument("--password", help="Login password. If omitted, prompt securely.")
    parser.add_argument("--display-name", default="", help="Optional display name.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output config path.")
    parser.add_argument("--ttl-hours", type=int, default=8, help="Session lifetime in hours.")
    args = parser.parse_args()

    password = args.password or getpass.getpass("Password: ")
    if not password:
        raise SystemExit("Password cannot be empty.")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        try:
            config = json.loads(output.read_text(encoding="utf-8"))
        except Exception:
            config = {}
    else:
        config = {}
    users = config.get("users", [])
    if not isinstance(users, list):
        users = []
    users = [user for user in users if str(user.get("username", "")).casefold() != args.user.casefold()]
    users.append({
        "username": args.user,
        "display_name": args.display_name or args.user,
        "password_hash": hash_password(password),
    })
    config = {
        **config,
        "enabled": True,
        "session_ttl_seconds": max(args.ttl_hours, 1) * 60 * 60,
        "users": users,
    }
    output.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output}")
    print(f"Users: {args.user}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
