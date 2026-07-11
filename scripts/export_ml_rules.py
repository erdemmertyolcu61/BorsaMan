#!/usr/bin/env python3
"""
Export discovered ML rules from the Electron SQLite DB to a static JSON snapshot
so web/mobile builds apply the SAME ML boost as the desktop app (platform parity).

Electron keeps using the live DB (feedback loop + weekly retraining); web/mobile
load this bundled snapshot. Regenerate after retraining:

    python scripts/export_ml_rules.py
    python scripts/export_ml_rules.py --db "C:/path/to/bist_ml_engine.db" --limit 120

Mirrors DatabaseManager.getTopRules(): is_active=1 AND total_count>=10,
ORDER BY expectancy DESC, win_rate_pct DESC.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB = os.path.join(
    os.path.expanduser("~"),
    "AppData", "Roaming", "bist-ai-trading-terminal", "bist_ml_engine.db",
)
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "src", "data", "mlRules.json")

# Fields the frontend consumers need (scoreNewSignal + AI Advisor enrichment).
FIELDS = [
    "rule_hash", "setup_name", "conditions", "direction",
    "total_count", "win_count", "loss_count",
    "win_rate_pct", "avg_roi_pct", "avg_win_roi", "avg_loss_roi",
    "expectancy",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB, help="Path to bist_ml_engine.db")
    ap.add_argument("--limit", type=int, default=120, help="Max rules to export")
    ap.add_argument("--min-samples", type=int, default=10, help="Min total_count")
    ap.add_argument("--out", default=OUT_PATH, help="Output JSON path")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        print("Launch the Electron app once so it creates the DB, or pass --db.", file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    have_cols = {r[1] for r in con.execute("PRAGMA table_info(discovered_rules)")}
    # Optional live-feedback counters (DB v5+) — include if present.
    optional = [c for c in ("paper_win_count", "paper_loss_count") if c in have_cols]
    cols = [c for c in FIELDS if c in have_cols] + optional

    rows = con.execute(
        f"""
        SELECT {', '.join(cols)}
        FROM discovered_rules
        WHERE is_active = 1 AND total_count >= ?
        ORDER BY expectancy DESC, win_rate_pct DESC
        LIMIT ?
        """,
        (args.min_samples, args.limit),
    ).fetchall()
    con.close()

    rules = [dict(r) for r in rows]

    payload = {
        "_meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": os.path.basename(args.db),
            "ruleCount": len(rules),
            "minSamples": args.min_samples,
            "note": "Static ML-rule snapshot for web/mobile parity. Regenerate via scripts/export_ml_rules.py after retraining. Electron uses the live DB.",
        },
        "rules": rules,
    }

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Exported {len(rules)} rules -> {out}")
    if rules:
        top = rules[0]
        print(f"  Top rule: {top.get('setup_name')} (WR {top.get('win_rate_pct')}%, exp {top.get('expectancy')})")


if __name__ == "__main__":
    main()
