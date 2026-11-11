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

  // START_CAPITAL 100k, risk %2 -> 2000 TL. MAX_POS_PCT %33 tavani, stop
  // mesafesi ~%6.1'in ALTINDA kaldiginda baglar. Asagidaki testler tavanin
  // BAGLAMADIGI araligi (-%7 .. -%11) ve tavanin BAGLADIGI durumu ayri ayri
  // dogrular — ikisi de kasitli davranis.
  const sizeFor = async (stop, symbol = 'THYAO') => {
    localStorage.clear();
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol, stop }));
    const t = e._state.openTrades[0];
    return { size: t.size_tl ?? t.sizeTl, entry: t.entry_price ?? t.entryPrice,
             stop: t.stop_price ?? t.stopPrice };
  };

  it('v31.31: sizes by RISK, so a wider stop opens a SMALLER position', async () => {
    // The forward test has to size the way calcPosition tells the user to size
    // (maxRiskTL / riskPerShare), otherwise it validates a different strategy
    // than the one the app recommends. Measured consequence: under fixed-capital
    // sizing a wider stop looks better, under fixed-risk it looks worse - the
    // convention flips the answer, so both sides must use the same one.
    const tight = await sizeFor(93, 'TIGHT');   // -7%
    const wide = await sizeFor(89, 'WIDE');     // -11%
    expect(wide.size).toBeLessThan(tight.size);
    // Position scales as 1/stopDistance, so ~7/11 of the tighter one.
    expect(wide.size / tight.size).toBeCloseTo(7 / 11, 1);
  });

  it('v31.31: TL at risk is the invariant, not TL deployed', async () => {
    const riskOf = (r) => r.size * ((r.entry - r.stop) / r.entry);
    const a = await sizeFor(93, 'A');   // -7%
    const b = await sizeFor(89, 'B');   // -11%
    // 2% of 100k = 2000 TL at risk either way (slippage moves entry a hair).
    expect(riskOf(a)).toBeCloseTo(2000, -2);
    expect(riskOf(b)).toBeCloseTo(riskOf(a), -2);
  });

  it('v31.31: the capital ceiling still clips an implausibly tight stop', async () => {
    // 2% risk against a 0.5% stop would ask for 4x capital; MAX_POS_PCT must hold.
    const hair = await sizeFor(99.5, 'HAIRLINE');   // -0.5%
    const two = await sizeFor(98, 'TWO');           // -2%
    expect(hair.size).toBeLessThanOrEqual(100_000 * 0.33 + 1);
    // Both are clipped to the same ceiling, so risk-sizing does NOT run away.
    expect(hair.size).toBeCloseTo(two.size, 0);
  });

  it('v31.34: a stop hit found after a background gap fills at the STOP, not the crash price', async () => {
    // The mobile case: the WebView freezes, the price drifts far below the stop,
    // and the user reopens the app hours later. Booking the crashed price claims
    // a fill nobody could have got - and these closes feed computeLiveEdge, so
    // the error reaches live scoring.
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'GAPDOWN', price: 100, stop: 96.5 }));
    const t = e._state.openTrades[0];
    const entry = t.entry_price ?? t.entryPrice;
    const stop = t.stop_price ?? t.stopPrice;

    // No previous check recorded -> treated as "we were not watching".
    await e.checkPrices({ GAPDOWN: { price: 88 } });

    const closed = e._state.closedTrades.at(-1);
    const exit = closed.exit_price ?? closed.exitPrice;
    // The engine applies exit slippage on top (a real seller crosses the spread),
    // so the fill sits just BELOW the stop - not at the 88 crash price.
    expect(exit).toBeLessThanOrEqual(stop);
    expect(exit).toBeGreaterThan(stop - 0.5);
    expect(exit).toBeGreaterThan(90);            // nowhere near the crashed 88
    expect(String(closed.exit_reason ?? closed.exitReason)).toMatch(/^STOP/);
    const pct = ((exit - entry) / entry) * 100;
    expect(pct).toBeGreaterThan(-6);             // ~-3.6%, not ~-12%
  });

  it('v31.34: a stop hit while actively watching still fills at the live price', async () => {
    const e = await mkEngine();
    await e._openTrade(mkPick({ symbol: 'WATCHED', price: 100, stop: 96.5 }));
    // First check establishes "we are watching"; the second lands inside the window.
    await e.checkPrices({ WATCHED: { price: 99 } });
    await e.checkPrices({ WATCHED: { price: 96.2 } });
    const closed = e._state.closedTrades.at(-1);
    const exit = closed.exit_price ?? closed.exitPrice;
    // Live basis: the fill tracks the observed 96.2 (minus the same slippage),
    // and crucially it is NOT snapped up to the 96.5 stop.
    expect(exit).toBeLessThan(96.2);
    expect(exit).toBeGreaterThan(95.8);
    expect(closed.exit_reason ?? closed.exitReason).toBe('STOP');
  });

});

// v31.53: the exit is the trailing stop only — the rule planSimulation measures and the
// app recommends. Until v31.52 this engine sold the whole position at the target and
// closed anything below +1% after three days, so the forward test ran a different
// (measured-worse) strategy than the one it was meant to validate.
describe('PaperTradeEngine v31.53 — trailing-only exit', () => {
  beforeEach(() => { try { localStorage.clear(); } catch {} });

  // A quote for one Istanbul session; sessionDate is what the batch price list carries.
  const q = (day, price, o = {}) => ({ price, sessionDate: `${day}T15:00:00.000+03:00`, ...o });
  const openOn = async (e, day, o = {}) => {
    await e._openTrade(mkPick({ _openedAt: Date.parse(`${day}T06:55:00Z`), _fillBasis: 'session_open', ...o }));
    return e._state.openTrades.at(-1);
  };
  const lastClosed = (e) => { const c = e._state.closedTrades[0]; return { reason: c.exit_reason ?? c.exitReason, exit: c.exit_price ?? c.exitPrice, pct: c.pnl_pct }; };

  it('does NOT sell at the target — the position keeps running', async () => {
    const e = await mkEngine();
    await openOn(e, '2026-11-02', { symbol: 'RUN', target: 108 });
    await e.checkPrices({ RUN: q('2026-11-02', 112, { open: 100, high: 112.5, low: 99.5 }) });
    expect(e._state.openTrades).toHaveLength(1);
  });

  it('no longer closes a quiet position after three days', async () => {
    const e = await mkEngine();
    await openOn(e, '2026-11-02', { symbol: 'QUIET' });
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
      await e.checkPrices({ QUIET: q(d, 100.4, { open: 100.2, high: 100.9, low: 99.8 }) });
    }
    expect(e._state.openTrades).toHaveLength(1);
  });

  it('ratchets the stop from a session high on the NEXT session and exits there in profit', async () => {
    const e = await mkEngine();
    const t = await openOn(e, '2026-11-02', { symbol: 'TREND' });
    const entry = t.entry_price ?? t.entryPrice;
    // Day 1 peaks at +10% and fades: the stop stays where it was all day.
    await e.checkPrices({ TREND: q('2026-11-02', 104, { open: 100, high: entry * 1.10, low: 99.5 }) });
    expect(e._state.openTrades).toHaveLength(1);
    expect(e._state.openTrades[0].stop_price).toBeCloseTo(96.5, 2);
    // Day 2: the stop is now entry + half of the peak gain. Price sits above it.
    await e.checkPrices({ TREND: q('2026-11-03', entry * 1.07, { open: entry * 1.07, high: entry * 1.08, low: entry * 1.06 }) });
    expect(e._state.openTrades[0].stop_price).toBeCloseTo(entry * 1.05, 1);
    // Later that day the session low touches the locked stop.
    await e.checkPrices({ TREND: q('2026-11-03', entry * 1.055, { open: entry * 1.07, high: entry * 1.08, low: entry * 1.045 }) });
    expect(e._state.openTrades).toHaveLength(0);
    const c = lastClosed(e);
    expect(c.reason).toMatch(/^TRAIL/);
    expect(c.pct).toBeGreaterThan(4);       // ~+5% minus exit cost — the old engine sold at the +8% target or timed out
  });

  it('a stop touched while the app was closed still exits, at the stop', async () => {
    const e = await mkEngine();
    await openOn(e, '2026-11-02', { symbol: 'DIP', stop: 96.5 });
    // First look of the day: price has recovered to 99, but the session low was 95.
    await e.checkPrices({ DIP: q('2026-11-02', 99, { open: 100, high: 100.5, low: 95 }) });
    expect(e._state.openTrades).toHaveLength(0);
    const c = lastClosed(e);
    expect(c.reason).toBe('STOP_STALE');
    expect(c.exit).toBeGreaterThan(96);     // the stop level (minus slippage), not the 95 low and not the 99 quote
    expect(c.exit).toBeLessThanOrEqual(96.5);
  });

  it('a session that opens below the stop fills at the open, not at the stop', async () => {
    const e = await mkEngine();
    await openOn(e, '2026-11-02', { symbol: 'GAP', stop: 96.5 });
    await e.checkPrices({ GAP: q('2026-11-02', 100.5, { open: 100, high: 101, low: 99.5 }) });
    await e.checkPrices({ GAP: q('2026-11-03', 93, { open: 92, high: 93.5, low: 91 }) });
    const c = lastClosed(e);
    expect(c.reason).toBe('STOP_GAP');
    expect(c.exit).toBeLessThan(92.01);
    expect(c.exit).toBeGreaterThan(91.5);
  });

  it('the day\'s range from before an intraday entry is ignored', async () => {
    const e = await mkEngine();
    // Bought during the session (live basis): the stock had traded at 95 that morning.
    await e._openTrade(mkPick({ symbol: 'LATE', stop: 96.5, _openedAt: Date.parse('2026-11-02T10:30:00Z') }));
    await e.checkPrices({ LATE: q('2026-11-02', 100.2, { open: 96, high: 101, low: 95 }) });
    expect(e._state.openTrades).toHaveLength(1);
  });

  it('survives a restart: the ratcheted stop is read back from storage', async () => {
    const e1 = await mkEngine();
    const t = await openOn(e1, '2026-11-02', { symbol: 'KEEP' });
    const entry = t.entry_price ?? t.entryPrice;
    await e1.checkPrices({ KEEP: q('2026-11-02', entry * 1.09, { open: 100, high: entry * 1.10, low: 99.5 }) });
    e1._persist();                            // the scan path persists after opening; _openTrade alone does not
    const e2 = await mkEngine();              // same localStorage, fresh engine
    await e2.checkPrices({ KEEP: q('2026-11-03', entry * 1.06, { open: entry * 1.06, high: entry * 1.065, low: entry * 1.055 }) });
    expect(e2._state.openTrades[0].stop_price).toBeCloseTo(entry * 1.05, 1);
  });

  it('closes at the session limit and clears trailing state on reset', async () => {
    const e = await mkEngine();
    await openOn(e, '2026-01-01', { symbol: 'OLD', stop: 90 });
    for (let d = 0; d <= 30; d++) {
      const day = new Date(Date.parse('2026-01-01T12:00:00Z') + d * DAY).toISOString().slice(0, 10);
      await e.checkPrices({ OLD: q(day, 100.5, { open: 100.4, high: 101, low: 100 }) });
    }
    expect(e._state.openTrades).toHaveLength(0);
    expect(lastClosed(e).reason).toBe('TIME_LIMIT');
    await openOn(e, '2026-03-02', { symbol: 'NEW' });
    await e.checkPrices({ NEW: q('2026-03-02', 101, { open: 100, high: 101, low: 99.8 }) });
    expect(Object.keys(JSON.parse(localStorage.getItem('bist_paper_ml_trail_v1')))).toHaveLength(1);
    await e.reset();
    expect(JSON.parse(localStorage.getItem('bist_paper_ml_trail_v1'))).toEqual({});
  });
});
