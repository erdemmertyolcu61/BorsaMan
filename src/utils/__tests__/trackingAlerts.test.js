import { describe, it, expect } from 'vitest';
import {
  classifySignalAlert, buildTrackingAlerts, alertKey, formatAlert,
  ALERT_KINDS, NEAR_TARGET_PCT,
} from '../trackingAlerts.js';

const buy = (o = {}) => ({
  id: 's1', symbol: 'THYAO', entryPrice: 100, target: 110, stop: 95, cls: 'buy', status: 'active', ...o,
});

describe('classifySignalAlert', () => {
  it('fires TARGET_HIT at or above the target', () => {
    expect(classifySignalAlert(buy(), 110).kind).toBe(ALERT_KINDS.TARGET_HIT);
    expect(classifySignalAlert(buy(), 118).kind).toBe(ALERT_KINDS.TARGET_HIT);
  });

  it('fires STOP_HIT at or below the stop', () => {
    const a = classifySignalAlert(buy(), 95);
    expect(a.kind).toBe(ALERT_KINDS.STOP_HIT);
    expect(a.pct).toBe(-5);
  });

  it('reports STOP first if a malformed signal puts the stop above the target', () => {
    // A single live price cannot cross both levels on a well-formed signal
    // (stop < entry < target) - that ambiguity only exists inside a daily bar's
    // range, which is evaluateOutcomeFromBars' problem. This guards the
    // malformed case, and keeps the same convention: never book an unprovable win.
    expect(classifySignalAlert(buy({ stop: 120, target: 110 }), 115).kind)
      .toBe(ALERT_KINDS.STOP_HIT);
  });

  it('warns when the target is within reach but not hit', () => {
    expect(classifySignalAlert(buy(), 109).kind).toBe(ALERT_KINDS.NEAR_TARGET);
    expect(classifySignalAlert(buy(), 105)).toBe(null);     // still far
    expect(NEAR_TARGET_PCT).toBe(1.5);
  });

  it('does not call a losing position "near target"', () => {
    // 1 TL from a 10 TL target only because the target is close to entry would
    // still be a loss; the move has to be going the right way.
    expect(classifySignalAlert(buy({ target: 99 }), 98)).toBe(null);
  });

  it('inverts every direction for a sell signal', () => {
    const sell = buy({ cls: 'sell', target: 90, stop: 105 });
    expect(classifySignalAlert(sell, 90).kind).toBe(ALERT_KINDS.TARGET_HIT);
    expect(classifySignalAlert(sell, 105).kind).toBe(ALERT_KINDS.STOP_HIT);
    expect(classifySignalAlert(sell, 91).kind).toBe(ALERT_KINDS.NEAR_TARGET);
    // Direction-adjusted P&L: a short is UP when the price falls.
    expect(classifySignalAlert(sell, 91).pct).toBe(9);
  });

  it('is defensive about missing data', () => {
    expect(classifySignalAlert(buy(), 0)).toBe(null);
    expect(classifySignalAlert(buy(), undefined)).toBe(null);
    expect(classifySignalAlert({ entryPrice: 0 }, 10)).toBe(null);
    expect(classifySignalAlert(null, 10)).toBe(null);
    expect(classifySignalAlert({ entryPrice: 100, cls: 'buy' }, 130)).toBe(null); // no levels
  });
});

describe('buildTrackingAlerts', () => {
  const prices = { THYAO: 111, GARAN: 94, ASELS: 101 };
  const signals = [
    buy({ id: 'a', symbol: 'THYAO' }),
    buy({ id: 'b', symbol: 'GARAN' }),
    buy({ id: 'c', symbol: 'ASELS' }),
  ];

  it('produces one alert per qualifying signal', () => {
    const { alerts } = buildTrackingAlerts(signals, prices);
    expect(alerts.map(a => a.symbol).sort()).toEqual(['GARAN', 'THYAO']);
  });

  it('skips signals that are already closed', () => {
    const closed = [buy({ id: 'a', symbol: 'THYAO', status: 'closed' })];
    expect(buildTrackingAlerts(closed, prices).alerts).toEqual([]);
  });

  it('never repeats an alert that was already sent', () => {
    const first = buildTrackingAlerts(signals, prices);
    const second = buildTrackingAlerts(signals, prices, { sent: first.keys });
    expect(first.alerts.length).toBe(2);
    expect(second.alerts).toEqual([]);
  });

  it('lets a NEAR_TARGET reminder recur on a new day but not within one', () => {
    const near = [buy({ id: 'a', symbol: 'THYAO' })];
    const p = { THYAO: 109 };
    const d1 = buildTrackingAlerts(near, p, { dayKey: '2026-08-25' });
    expect(d1.alerts[0].kind).toBe(ALERT_KINDS.NEAR_TARGET);
    expect(buildTrackingAlerts(near, p, { dayKey: '2026-08-25', sent: d1.keys }).alerts).toEqual([]);
    expect(buildTrackingAlerts(near, p, { dayKey: '2026-08-26', sent: d1.keys }).alerts).toHaveLength(1);
  });

  it('ranks realised outcomes above near-misses and caps the count', () => {
    const many = [
      buy({ id: 'n', symbol: 'ASELS', target: 102 }),   // near
      buy({ id: 't', symbol: 'THYAO' }),                // target hit
      buy({ id: 's', symbol: 'GARAN' }),                // stop hit
    ];
    const { alerts } = buildTrackingAlerts(many, prices);
    expect(alerts[alerts.length - 1].kind).toBe(ALERT_KINDS.NEAR_TARGET);
    expect(buildTrackingAlerts(many, prices, { max: 1 }).alerts).toHaveLength(1);
    expect(buildTrackingAlerts(many, prices, { max: 0 }).alerts).toEqual([]);
  });

  it('ignores symbols with no price and bad input', () => {
    expect(buildTrackingAlerts(signals, {}).alerts).toEqual([]);
    expect(buildTrackingAlerts(null, prices).alerts).toEqual([]);
    expect(buildTrackingAlerts(signals, null).alerts).toEqual([]);
  });
});

describe('alertKey', () => {
  it('is stable for terminal outcomes and day-scoped for reminders', () => {
    const s = buy();
    expect(alertKey(s, ALERT_KINDS.TARGET_HIT, '2026-08-25'))
      .toBe(alertKey(s, ALERT_KINDS.TARGET_HIT, '2026-08-26'));
    expect(alertKey(s, ALERT_KINDS.NEAR_TARGET, '2026-08-25'))
      .not.toBe(alertKey(s, ALERT_KINDS.NEAR_TARGET, '2026-08-26'));
  });
});

describe('formatAlert', () => {
  it('writes a readable line for each kind', () => {
    const t = formatAlert({ symbol: 'THYAO', kind: ALERT_KINDS.TARGET_HIT, pct: 7.5, entry: 100, price: 110, target: 110 });
    expect(t.title).toContain('THYAO');
    expect(t.body).toContain('+7.5%');
    expect(formatAlert({ symbol: 'X', kind: ALERT_KINDS.STOP_HIT, pct: -5, entry: 100, price: 95, stop: 95 }).body).toContain('-5%');
    expect(formatAlert({ symbol: 'X', kind: ALERT_KINDS.NEAR_TARGET, pct: 6, price: 109, target: 110 }).title).toContain('yaklas');
    expect(formatAlert(null).title).toBe('');
  });
});
