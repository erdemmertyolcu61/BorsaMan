"""
BIST live-data bridge between borsapy/borsa-mcp and TradingAgents' FundamentalsAnalyst.

Design:
  • BistBridge owns the MCP session + borsapy fallback and produces a
    FundamentalsContext dataclass.
  • FundamentalsContext.to_agent_payload() emits the exact dict shape
    TradingAgents' FundamentalsAnalyst consumes (see CONTEXT_KEYS).
  • `feed_fundamentals_analyst(symbol, analyst)` drives the end-to-end flow
    and is the function tests / production code should use.

Usage:
    async with BistBridge() as bridge:
        ctx = await bridge.build_fundamentals_context("THYAO")
    # or, with an analyst instance:
    await feed_fundamentals_analyst("THYAO", analyst=my_analyst)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, AsyncIterator, Callable

log = logging.getLogger("bist_bridge")
if not log.handlers:
    log.addHandler(logging.StreamHandler())
log.setLevel(os.getenv("BIST_BRIDGE_LOG", "INFO"))

# ── optional deps, imported lazily so unit tests can run offline ─────
try:                       # pragma: no cover
    import pandas as pd
except ImportError:        # pragma: no cover
    pd = None

try:                       # pragma: no cover
    import borsapy
except ImportError:        # pragma: no cover
    borsapy = None

try:                       # pragma: no cover
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client, StdioServerParameters
    _MCP_OK = True
except ImportError:        # pragma: no cover
    ClientSession = None
    stdio_client = None
    StdioServerParameters = None
    _MCP_OK = False


BIST100_DEFAULT = [
    "AKBNK", "ARCLK", "ASELS", "BIMAS", "DOHOL", "EKGYO", "EREGL", "FROTO",
    "GARAN", "HALKB", "HEKTS", "ISCTR", "KCHOL", "KOZAA", "KOZAL", "KRDMD",
    "MGROS", "PETKM", "PGSUS", "SAHOL", "SASA", "SISE", "TCELL", "THYAO",
    "TKFEN", "TOASO", "TUPRS", "VAKBN", "VESTL", "YKBNK",
]

CONTEXT_KEYS = (
    "symbol", "as_of", "price_series", "financials",
    "kap_disclosures", "sector", "peers", "notes",
)


@dataclass
class FundamentalsContext:
    symbol: str
    as_of: str
    price_series: list[dict]
    financials: dict
    kap_disclosures: list[dict] = field(default_factory=list)
    sector: Optional[str] = None
    peers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_agent_payload(self) -> dict:
        return asdict(self)

    def to_prompt_block(self) -> str:
        fin = self.financials or {}
        last = self.price_series[-1] if self.price_series else {}
        return (
            f"[BIST:{self.symbol}] as_of={self.as_of} sector={self.sector}\n"
            f"last_close={last.get('close')} volume={last.get('volume')}\n"
            f"pe={fin.get('pe')} pb={fin.get('pb')} roe={fin.get('roe')} "
            f"debt_equity={fin.get('debt_equity')} net_margin={fin.get('net_margin')}\n"
            f"kap_recent={len(self.kap_disclosures)} peers={','.join(self.peers)}"
        )


class BistBridge:
    """
    Streams historical BIST data via borsa-mcp tools, enriches via borsapy,
    and produces a FundamentalsContext ready to feed FundamentalsAnalyst.

    The `_mcp_call` and `_fallback_borsapy_history` / `fetch_financials`
    branches are fully overridable in tests without network.
    """

    def __init__(
        self,
        mcp_command: str = "uvx",
        mcp_args: tuple[str, ...] = ("saidsurucu-borsa-mcp",),
        cache_dir: str = ".cache/bist_bridge",
        session_factory: Optional[Callable] = None,
    ):
        self._mcp_command = mcp_command
        self._mcp_args = list(mcp_args)
        self._cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self._session_ctx = None
        self._session = None
        self._session_factory = session_factory  # test seam

    async def __aenter__(self) -> "BistBridge":
        if self._session_factory is not None:
            self._session = await self._session_factory()
            return self
        if not _MCP_OK:
            log.warning("MCP SDK unavailable — bridge running in fallback-only mode")
            return self
        params = StdioServerParameters(command=self._mcp_command, args=self._mcp_args)
        self._session_ctx = stdio_client(params)
        read, write = await self._session_ctx.__aenter__()
        self._session = await ClientSession(read, write).__aenter__()
        await self._session.initialize()
        log.info("MCP session initialized — borsa-mcp up")
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self._session and hasattr(self._session, "__aexit__"):
            try:
                await self._session.__aexit__(exc_type, exc, tb)
            except Exception:   # pragma: no cover
                pass
        if self._session_ctx:
            try:
                await self._session_ctx.__aexit__(exc_type, exc, tb)
            except Exception:   # pragma: no cover
                pass

    # ── MCP tool call with JSON-text extraction ──────────────────────
    async def _mcp_call(self, tool: str, args: dict) -> Any:
        if not self._session:
            return None
        try:
            result = await self._session.call_tool(tool, args)
            content = getattr(result, "content", None) or []
            for block in content:
                if getattr(block, "type", None) == "text":
                    try:
                        return json.loads(block.text)
                    except (json.JSONDecodeError, TypeError):
                        return block.text
            return None
        except Exception as exc:
            log.warning("MCP tool %s failed: %s", tool, exc)
            return None

    # ── Historical OHLCV (MCP → borsapy fallback) ────────────────────
    async def fetch_ohlcv(self, symbol: str, lookback_days: int = 365) -> list[dict]:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=lookback_days)
        args = {
            "symbol": symbol.upper(),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "interval": "1d",
        }
        data = await self._mcp_call("get_hisse_historical", args)
        if not data:
            data = self._fallback_borsapy_history(symbol, start, end)
        return self._normalize_ohlcv(data)

    def _fallback_borsapy_history(self, symbol: str, start, end) -> Any:
        if borsapy is None:
            return []
        try:
            df = borsapy.get_price(symbol, start=str(start), end=str(end))  # type: ignore[attr-defined]
            if pd is not None and hasattr(df, "empty") and not df.empty:
                df = df.reset_index().rename(columns=str.lower)
                return df.to_dict(orient="records")
        except Exception as exc:
            log.warning("borsapy price fallback failed for %s: %s", symbol, exc)
        return []

    @staticmethod
    def _normalize_ohlcv(rows: Any) -> list[dict]:
        if not rows:
            return []
        if isinstance(rows, dict) and "data" in rows:
            rows = rows["data"]
        if not isinstance(rows, list):
            return []
        norm = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            date = r.get("date") or r.get("Date") or r.get("tarih")
            if hasattr(date, "isoformat"):
                date = date.isoformat()
            try:
                row = {
                    "date": str(date)[:10] if date else None,
                    "open":  float(r.get("open",  r.get("Open",  0)) or 0),
                    "high":  float(r.get("high",  r.get("High",  0)) or 0),
                    "low":   float(r.get("low",   r.get("Low",   0)) or 0),
                    "close": float(r.get("close", r.get("Close", 0)) or 0),
                    "volume": float(r.get("volume", r.get("Volume", 0)) or 0),
                }
            except (TypeError, ValueError):
                continue
            if row["date"] and row["close"]:
                norm.append(row)
        return norm

    # ── Financial ratios ─────────────────────────────────────────────
    async def fetch_financials(self, symbol: str) -> dict:
        data = await self._mcp_call("get_hisse_finansal", {"symbol": symbol.upper()}) or {}
        if not data and borsapy is not None:
            try:
                data = borsapy.get_financials(symbol) or {}   # type: ignore[attr-defined]
                if pd is not None and hasattr(data, "to_dict"):
                    data = data.to_dict()
            except Exception as exc:
                log.warning("borsapy financials fallback failed for %s: %s", symbol, exc)
                data = {}
        return self._flatten_ratios(data)

    @staticmethod
    def _flatten_ratios(raw: dict) -> dict:
        keys = ("pe", "pb", "roe", "roa", "debt_equity", "net_margin",
                "gross_margin", "op_margin", "current_ratio", "eps")
        if not isinstance(raw, dict):
            return {k: None for k in keys}
        out = {}
        for k in keys:
            v = raw.get(k)
            if v is None:
                v = raw.get(k.upper())
            if v is None:
                v = raw.get(k.replace("_", ""))
            try:
                out[k] = float(v) if v is not None else None
            except (TypeError, ValueError):
                out[k] = None
        return out

    # ── KAP + sector ────────────────────────────────────────────────
    async def fetch_kap(self, symbol: str, limit: int = 10) -> list[dict]:
        data = await self._mcp_call("get_kap_disclosures",
                                    {"symbol": symbol.upper(), "limit": limit}) or []
        if isinstance(data, dict):
            data = data.get("items", [])
        if not isinstance(data, list):
            data = []
        return data[:limit]

    async def fetch_sector_meta(self, symbol: str) -> tuple[Optional[str], list[str]]:
        meta = await self._mcp_call("get_hisse_bilgi", {"symbol": symbol.upper()}) or {}
        sector = meta.get("sector") or meta.get("sektor") if isinstance(meta, dict) else None
        peers = meta.get("peers") or [] if isinstance(meta, dict) else []
        if not peers and sector:
            peers_data = await self._mcp_call("list_hisse_by_sector", {"sector": sector}) or []
            if isinstance(peers_data, list):
                peers = [p.get("symbol") for p in peers_data
                         if isinstance(p, dict) and p.get("symbol") and p.get("symbol") != symbol.upper()]
        return sector, list(peers)[:8]

    # ── Main context builder ────────────────────────────────────────
    async def build_fundamentals_context(
        self, symbol: str, lookback_days: int = 365,
    ) -> FundamentalsContext:
        symbol = symbol.upper()
        prices, financials, kap, sector_peers = await asyncio.gather(
            self.fetch_ohlcv(symbol, lookback_days),
            self.fetch_financials(symbol),
            self.fetch_kap(symbol),
            self.fetch_sector_meta(symbol),
        )
        sector, peers = sector_peers
        notes: list[str] = []
        if not prices:
            notes.append("no_price_data")
        if not financials or all(v is None for v in financials.values()):
            notes.append("financials_empty")
        ctx = FundamentalsContext(
            symbol=symbol,
            as_of=datetime.now(timezone.utc).isoformat(),
            price_series=prices,
            financials=financials,
            kap_disclosures=kap,
            sector=sector,
            peers=peers,
            notes=notes,
        )
        log.info("Built context for %s — %d bars, %d KAP entries",
                 symbol, len(prices), len(kap))
        return ctx

    async def stream_universe(
        self, symbols: Optional[list[str]] = None,
        lookback_days: int = 365, concurrency: int = 4,
    ) -> AsyncIterator[FundamentalsContext]:
        universe = symbols or BIST100_DEFAULT
        sem = asyncio.Semaphore(concurrency)

        async def _one(sym: str):
            async with sem:
                try:
                    return await self.build_fundamentals_context(sym, lookback_days)
                except Exception as exc:
                    log.error("stream_universe failed on %s: %s", sym, exc)
                    return None

        for coro in asyncio.as_completed([_one(s) for s in universe]):
            ctx = await coro
            if ctx is not None:
                yield ctx


# ── TradingAgents adapter ────────────────────────────────────────────
async def feed_fundamentals_analyst(
    symbol: str, analyst=None, lookback_days: int = 365,
    bridge: Optional[BistBridge] = None,
) -> Any:
    """Drive the end-to-end flow: pull context → hand to analyst.

    If `analyst` is None, returns the raw payload (dict) so callers can
    log / persist it. Accepts either `.analyze(dict)` or `.run(dict)`.
    """
    owned = bridge is None
    b = bridge or BistBridge()
    try:
        if owned:
            await b.__aenter__()
        ctx = await b.build_fundamentals_context(symbol, lookback_days)
    finally:
        if owned:
            await b.__aexit__(None, None, None)

    payload = ctx.to_agent_payload()
    if analyst is None:
        return payload
    if hasattr(analyst, "analyze"):
        return await _maybe_await(analyst.analyze(payload))
    if hasattr(analyst, "run"):
        return await _maybe_await(analyst.run(payload))
    raise AttributeError("FundamentalsAnalyst lacks .analyze()/.run()")


async def _maybe_await(x):
    if asyncio.iscoroutine(x):
        return await x
    return x


if __name__ == "__main__":   # pragma: no cover
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "THYAO"

    async def _demo():
        async with BistBridge() as b:
            ctx = await b.build_fundamentals_context(sym)
            print(ctx.to_prompt_block())

    asyncio.run(_demo())
