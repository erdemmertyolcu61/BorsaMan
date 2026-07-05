import { describe, it, expect, beforeEach } from 'vitest';
import { PaperTradeEngine } from '../PaperTradeEngine.js';

const DAY = 1000 * 60 * 60 * 24;

function mkPick(o = {}) {
  return {
    symbol: 'THYAO', cls: 'buy', price: 100, stop: 96.5, target: 108,
    score: 65, grade: 'B', tier: 'GOOD', confidence: 66, rr: 2,
    atrPct: 2, rsi: 55, sector: 'Ulastirma', firedSignals: [],
    mlConfidenceBoost: 2, mlMatchedCount: 1,
    ...o,
  };
}

async function mkEngine() {
  const e = new PaperTradeEngine();
  await e.init();
  return e;
}

describe('PaperTradeEngine v2 (sizing + exits)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch {} });

  it('honors the pick structural stop instead of fixed -3%', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ stop: 96.5 }));
    const t = e._state.openTrades[0];
    expect(t.stopSource).toBe('pick');
    expect(t.stop_price ?? t.stopPrice).toBeCloseTo(96.5, 2);
  });

  it('falls back to -3% when the pick stop is missing or implausible', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'NOSTOP', stop: null }));
    await e._openTrade(mkPick({ symbol: 'FARSTOP', stop: 70 }));  // -30% → implausible
    await e._openTrade(mkPick({ symbol: 'BADSTOP', stop: 105 })); // above entry
    for (const t of e._state.openTrades) {
      expect(t.stopSource).toBe('fixed3pct');
      const entry = t.entry_price ?? t.entryPrice;
      expect((t.stop_price ?? t.stopPrice) / entry).toBeCloseTo(0.97, 2);
    }
  });

  it('scales position size by pick._positionSizeMult (BEAR≈0.4)', async () => {
    const full = await mkEngine();
    await full._openTrade(mkPick());
    const fullSize = full._state.openTrades[0].size_tl ?? full._state.openTrades[0].sizeTl;

    localStorage.clear();
    const bear = await mkEngine();
    await bear._openTrade(mkPick({ _positionSizeMult: 0.4 }));
    const t = bear._state.openTrades[0];
    const bearSize = t.size_tl ?? t.sizeTl;
    expect(t.positionMult).toBe(0.4);
    expect(bearSize).toBeCloseTo(fullSize * 0.4, 0);
  });

  it('caps the multiplier at 1.5 and ignores invalid values', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'CRAZY', _positionSizeMult: 9 }));
    await e._openTrade(mkPick({ symbol: 'BROKEN', _positionSizeMult: -2 }));
    const crazy = e._state.openTrades.find(t => t.symbol === 'CRAZY');
    const broken = e._state.openTrades.find(t => t.symbol === 'BROKEN');
    expect(crazy.positionMult).toBe(1.5);
    expect(broken.positionMult).toBe(1);
  });

  it('TIME_EXIT closes a stagnant 3+ day position below +1%', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'STALE' }));
    const t = e._state.openTrades[0];
    t.opened_at = Date.now() - DAY * 3.5; // age it 3.5 days
    t.openedAt = t.opened_at;
    await e.checkPrices({ STALE: { price: 100.4 } }); // +0.4% gross — dead capital
    expect(e._state.openTrades).toHaveLength(0);
    const closed = e._state.closedTrades[0];
    expect(closed.exit_reason ?? closed.exitReason).toBe('TIME_EXIT');
  });

  it('TIME_EXIT keeps a slow grinder above +1%', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'GRIND' }));
    const t = e._state.openTrades[0];
    t.opened_at = Date.now() - DAY * 4;
    t.openedAt = t.opened_at;
    await e.checkPrices({ GRIND: { price: 102.5 } }); // +2.5% — let it run
    expect(e._state.openTrades).toHaveLength(1);
  });

  it('fresh positions are not time-exited', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'FRESH' }));
    await e.checkPrices({ FRESH: { price: 100.1 } });
    expect(e._state.openTrades).toHaveLength(1);
  });
});
