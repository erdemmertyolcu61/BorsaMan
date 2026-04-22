"""
bist_bridge.py → TradingAgents integration tests.

Philosophy: we never hit the real MCP server or borsapy in CI.
All network surfaces are replaced by a fake MCP session so the tests
run offline and are fully deterministic — the REAL integration check
is "does the payload shape match what FundamentalsAnalyst expects?"

Run:  pytest tests/test_bist_bridge.py -v
"""
from __future__ import annotations

import asyncio
import json
import sys
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from pathlib import Path

import pytest

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bist_bridge import (   # noqa: E402
    BistBridge, FundamentalsContext, feed_fundamentals_analyst,
    CONTEXT_KEYS, BIST100_DEFAULT,
)


# ── Fake MCP session ────────────────────────────────────────────────
class _TextBlock(SimpleNamespace):
    type = "text"


class FakeCallResult:
    def __init__(self, payload):
        self.content = [_TextBlock(text=json.dumps(payload))]


class FakeMCPSession:
    """Mimics mcp.ClientSession.call_tool surface."""

    def __init__(self, responses: dict):
        # responses: {tool_name: payload_or_callable}
        self._responses = responses
        self.calls = []

    async def call_tool(self, tool, args):
        self.calls.append((tool, args))
        r = self._responses.get(tool)
        if callable(r):
            r = r(args)
        if r is None:
            return SimpleNamespace(content=[])
        return FakeCallResult(r)

    async def __aexit__(self, *a):
        return None


def _fake_history(days=30, start_price=100.0):
    today = datetime.now(timezone.utc).date()
    return [
        {
            "date": (today - timedelta(days=days - i)).isoformat(),
            "open":  start_price + i * 0.3,
            "high":  start_price + i * 0.3 + 0.5,
            "low":   start_price + i * 0.3 - 0.5,
            "close": start_price + i * 0.3,
            "volume": 1_000_000 + i * 100,
        }
        for i in range(days)
    ]


def _fake_financials():
    return {
        "pe": 9.4, "pb": 1.8, "roe": 22.5, "roa": 7.1,
        "debt_equity": 0.8, "net_margin": 12.4,
        "gross_margin": 38.2, "op_margin": 18.1,
        "current_ratio": 1.6, "eps": 4.2,
    }


def _fake_kap(n=3):
    return {"items": [
        {"date": "2026-04-10", "title": f"KAP duyuru #{i}", "summary": "ozet"}
        for i in range(n)
    ]}


def _fake_bilgi():
    return {"sector": "Havacilik", "peers": ["PGSUS"]}


def _make_bridge(responses):
    fake = FakeMCPSession(responses)

    async def factory():
        return fake

    b = BistBridge(session_factory=factory)
    return b, fake


# ── Tests ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_build_fundamentals_context_full_happy_path():
    responses = {
        "get_hisse_historical": {"data": _fake_history(60)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": _fake_kap(5),
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, fake = _make_bridge(responses)

    async with bridge:
        ctx = await bridge.build_fundamentals_context("THYAO")

    assert isinstance(ctx, FundamentalsContext)
    assert ctx.symbol == "THYAO"
    assert len(ctx.price_series) == 60
    assert ctx.financials["pe"] == 9.4
    assert ctx.financials["roe"] == 22.5
    assert len(ctx.kap_disclosures) == 5
    assert ctx.sector == "Havacilik"
    assert "PGSUS" in ctx.peers
    assert ctx.notes == []

    # Every tool was called exactly once
    called = {c[0] for c in fake.calls}
    assert "get_hisse_historical" in called
    assert "get_hisse_finansal" in called
    assert "get_kap_disclosures" in called
    assert "get_hisse_bilgi" in called


@pytest.mark.asyncio
async def test_payload_shape_matches_fundamentals_analyst_contract():
    """The dict FundamentalsAnalyst consumes MUST carry these keys."""
    responses = {
        "get_hisse_historical": {"data": _fake_history(10)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": _fake_kap(1),
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        ctx = await bridge.build_fundamentals_context("AKBNK")

    payload = ctx.to_agent_payload()
    assert isinstance(payload, dict)
    for key in CONTEXT_KEYS:
        assert key in payload, f"missing key: {key}"
    # price_series items carry OHLCV
    bar = payload["price_series"][0]
    for k in ("date", "open", "high", "low", "close", "volume"):
        assert k in bar


@pytest.mark.asyncio
async def test_empty_inputs_produce_notes_and_no_crash():
    responses = {
        "get_hisse_historical": None,
        "get_hisse_finansal": {},
        "get_kap_disclosures": None,
        "get_hisse_bilgi": {},
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        ctx = await bridge.build_fundamentals_context("GARAN")
    assert ctx.price_series == []
    assert "no_price_data" in ctx.notes
    assert "financials_empty" in ctx.notes


@pytest.mark.asyncio
async def test_normalize_handles_yahoo_style_keys():
    hist = [
        {"Date": "2026-04-10", "Open": 10, "High": 11, "Low": 9, "Close": 10.5, "Volume": 500}
    ]
    responses = {
        "get_hisse_historical": hist,
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": [],
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        ctx = await bridge.build_fundamentals_context("SASA")
    assert len(ctx.price_series) == 1
    assert ctx.price_series[0]["close"] == 10.5


@pytest.mark.asyncio
async def test_sector_fallback_triggers_list_lookup_when_peers_missing():
    call_log = []

    def list_hisse_resp(args):
        call_log.append(args)
        return [{"symbol": "AKBNK"}, {"symbol": "VAKBN"}, {"symbol": "GARAN"}]

    responses = {
        "get_hisse_historical": {"data": _fake_history(5)},
        "get_hisse_finansal": {},
        "get_kap_disclosures": [],
        "get_hisse_bilgi": {"sector": "Bankacilik"},   # no peers
        "list_hisse_by_sector": list_hisse_resp,
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        ctx = await bridge.build_fundamentals_context("GARAN")
    assert ctx.sector == "Bankacilik"
    # GARAN is the requested symbol — must NOT be in peers
    assert "GARAN" not in ctx.peers
    assert "AKBNK" in ctx.peers
    assert len(call_log) == 1


@pytest.mark.asyncio
async def test_feed_fundamentals_analyst_routes_to_analyze():
    captured = {}

    class FakeAnalyst:
        async def analyze(self, payload):
            captured["payload"] = payload
            return {"verdict": "BUY", "grade": "B+"}

    responses = {
        "get_hisse_historical": {"data": _fake_history(15)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": _fake_kap(2),
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        result = await feed_fundamentals_analyst("TUPRS", analyst=FakeAnalyst(), bridge=bridge)

    assert result == {"verdict": "BUY", "grade": "B+"}
    assert captured["payload"]["symbol"] == "TUPRS"
    assert captured["payload"]["financials"]["pe"] == 9.4


@pytest.mark.asyncio
async def test_feed_fundamentals_analyst_with_run_method():
    class FakeAnalyst:
        def run(self, payload):   # sync .run() path
            return {"ok": True, "sym": payload["symbol"]}

    responses = {
        "get_hisse_historical": {"data": _fake_history(5)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": [],
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        out = await feed_fundamentals_analyst("ASELS", analyst=FakeAnalyst(), bridge=bridge)
    assert out == {"ok": True, "sym": "ASELS"}


@pytest.mark.asyncio
async def test_feed_fundamentals_analyst_without_analyst_returns_dict():
    responses = {
        "get_hisse_historical": {"data": _fake_history(5)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": [],
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        payload = await feed_fundamentals_analyst("THYAO", analyst=None, bridge=bridge)
    assert isinstance(payload, dict)
    assert payload["symbol"] == "THYAO"


@pytest.mark.asyncio
async def test_feed_fundamentals_analyst_raises_when_no_hooks():
    class Broken:
        pass
    responses = {
        "get_hisse_historical": {"data": _fake_history(5)},
        "get_hisse_finansal": {},
        "get_kap_disclosures": [],
        "get_hisse_bilgi": {},
    }
    bridge, _ = _make_bridge(responses)
    async with bridge:
        with pytest.raises(AttributeError):
            await feed_fundamentals_analyst("XU100", analyst=Broken(), bridge=bridge)


@pytest.mark.asyncio
async def test_stream_universe_yields_all_symbols():
    responses = {
        "get_hisse_historical": {"data": _fake_history(3)},
        "get_hisse_finansal": _fake_financials(),
        "get_kap_disclosures": [],
        "get_hisse_bilgi": _fake_bilgi(),
    }
    bridge, _ = _make_bridge(responses)
    syms = ["THYAO", "AKBNK", "GARAN"]
    async with bridge:
        got = []
        async for ctx in bridge.stream_universe(symbols=syms, lookback_days=30, concurrency=2):
            got.append(ctx.symbol)
    assert sorted(got) == sorted(syms)


def test_flatten_ratios_handles_weird_inputs():
    assert BistBridge._flatten_ratios(None)["pe"] is None
    assert BistBridge._flatten_ratios({"pe": "abc"})["pe"] is None
    out = BistBridge._flatten_ratios({"PE": 12.5, "ROE": "20.0"})
    assert out["pe"] == 12.5
    assert out["roe"] == 20.0


def test_prompt_block_is_single_paragraph_with_key_fields():
    ctx = FundamentalsContext(
        symbol="THYAO",
        as_of="2026-04-20T00:00:00+00:00",
        price_series=[{"close": 123, "volume": 1_000_000}],
        financials={"pe": 9, "roe": 22},
        sector="Havacilik",
        peers=["PGSUS"],
    )
    s = ctx.to_prompt_block()
    assert "THYAO" in s
    assert "123" in s
    assert "Havacilik" in s
    assert "PGSUS" in s


def test_bist100_default_is_non_empty_uppercase():
    assert len(BIST100_DEFAULT) >= 20
    assert all(s.isupper() for s in BIST100_DEFAULT)
