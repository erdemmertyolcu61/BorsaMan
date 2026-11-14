import { describe, it, expect } from 'vitest';
import { recordMovers, moversToSettle, settleMovers, summarizeMovers, MAX_DAYS, MAX_TRIES } from '../moversScorecard.js';
import { DAYTRADE_RULE } from '../nextSession.js';

const dayKey = (d) => String(d).slice(0, 10);
const mover = (symbol, pMove, basisDay = '2026-11-12', extra = {}) => ({ symbol, pMove, pGreen: 0.5, basisDay, ...extra });
const bar = (date, open, high, low, close, extra = {}) => ({ date, open, high, low, close, volume: 1e6, ...extra });

describe('recordMovers', () => {
  it('listeyi dayanak gunuyle ve sirayla kaydeder', () => {
    const days = recordMovers([], [mover('AAA', 0.8), mover('BBB', 0.7, '2026-11-12', { limitUpClose: true })], 1000);
    expect(days).toHaveLength(1);
    expect(days[0].basisDay).toBe('2026-11-12');
    expect(days[0].picks.map((p) => [p.symbol, p.rank])).toEqual([['AAA', 1], ['BBB', 2]]);
    expect(days[0].picks[1].limitUpClose).toBe(true);
    expect(days[0].settled).toBe(false);
  });

  it('ayni dayanak gunu icin ilk liste kalir', () => {
    const first = recordMovers([], [mover('AAA', 0.8)]);
    const again = recordMovers(first, [mover('ZZZ', 0.9)]);
    expect(again).toBe(first);
  });

  it('verisi geride kalan tek hisse gunu kaydirmaz', () => {
    const days = recordMovers([], [mover('OLD', 0.95, '2026-11-10'), mover('AAA', 0.8), mover('BBB', 0.7)]);
    expect(days[0].basisDay).toBe('2026-11-12');
    expect(days[0].picks.map((p) => p.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('gecersiz girdide degisiklik yapmaz; en yeni gun basta, tavan sinirli', () => {
    const base = recordMovers([], [mover('AAA', 0.8, '2026-11-10')]);
    expect(recordMovers(base, [])).toBe(base);
    expect(recordMovers(base, [{ symbol: 'X' }])).toBe(base);
    const two = recordMovers(base, [mover('BBB', 0.8, '2026-11-11')]);
    expect(two.map((d) => d.basisDay)).toEqual(['2026-11-11', '2026-11-10']);
    let many = [];
    for (let i = 0; i < MAX_DAYS + 5; i++) many = recordMovers(many, [mover('AAA', 0.8, `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`)]);
    expect(many).toHaveLength(MAX_DAYS);
  });
});

describe('settleMovers', () => {
  const days0 = recordMovers([], [mover('AAA', 0.8), mover('BBB', 0.7)]);

  it('dayanak gununden sonraki ilk bari yargilar ve yesil kapanisi onceki kapanisa gore yazar', () => {
    const bars = {
      AAA: [bar('2026-11-11', 9, 10, 9, 9.5), bar('2026-11-12', 9.5, 10.2, 9.4, 10), bar('2026-11-13', 10.2, 10.7, 10.1, 10.3), bar('2026-11-16', 10.3, 12, 10, 11)],
      BBB: [bar('2026-11-12', 20, 20, 19, 19.5), bar('2026-11-13', 19.4, 19.6, 18.8, 19)],
    };
    const { days, changed } = settleMovers(days0, bars, dayKey, { today: '2026-11-14' });
    expect(changed).toBe(true);
    const [a, b] = days[0].picks;
    expect(a.result.day).toBe('2026-11-13');
    expect(a.result.hit).toBe(true);                     // 10.7 / 10.2 = +%4,9
    expect(a.result.netPct).toBeCloseTo(4 - DAYTRADE_RULE.costPct, 6);
    expect(a.result.green).toBe(true);                   // 10.3 > 10
    expect(b.result.hit).toBe(false);
    expect(b.result.green).toBe(false);                  // 19 < 19.5
    expect(days[0].settled).toBe(true);
    expect(moversToSettle(days)).toEqual([]);
  });

  it('bugunun barini seans bitmeden ve olusan bari hic kullanmaz', () => {
    const bars = { AAA: [bar('2026-11-12', 9.5, 10.2, 9.4, 10), bar('2026-11-13', 10.2, 10.7, 10.1, 10.3)], BBB: [bar('2026-11-12', 20, 20, 19, 19.5), bar('2026-11-13', 19.4, 19.6, 18.8, 19, { _isForming: true })] };
    const mid = settleMovers(days0, bars, dayKey, { today: '2026-11-13', sessionOver: false });
    expect(mid.days[0].picks.every((p) => !p.result)).toBe(true);
    const after = settleMovers(days0, bars, dayKey, { today: '2026-11-13', sessionOver: true });
    expect(after.days[0].picks[0].result.day).toBe('2026-11-13');
    expect(after.days[0].picks[1].result).toBeNull();     // olusan bar yargilamaz
    expect(after.days[0].settled).toBe(false);
    expect(moversToSettle(after.days)).toEqual(['BBB']);
  });

  it('bar hic gelmediyse deneme sayilmaz; geldigi halde yargilayan seans yoksa sayilir', () => {
    const none = settleMovers(days0, {}, dayKey, { today: '2026-11-14' });
    expect(none.changed).toBe(false);
    expect(none.days).toBe(days0);
    const noNext = settleMovers(days0, { AAA: [bar('2026-11-12', 9.5, 10.2, 9.4, 10)] }, dayKey, { today: '2026-11-14' });
    expect(noNext.changed).toBe(true);
    expect(noNext.days[0].tries).toBe(1);
    expect(noNext.days[0].settled).toBe(false);
    let d = days0;
    for (let i = 0; i < MAX_TRIES; i++) d = settleMovers(d, { AAA: [bar('2026-11-12', 9.5, 10.2, 9.4, 10)] }, dayKey, { today: '2026-11-14' }).days;
    expect(d[0].settled).toBe(true);                      // vazgecildi: sonsuza dek bar istemez
  });

  it('yerlesmis gune dokunmaz', () => {
    const bars = { AAA: [bar('2026-11-13', 10, 11, 10, 10.5)], BBB: [bar('2026-11-13', 10, 11, 10, 10.5)] };
    const once = settleMovers(days0, bars, dayKey, { today: '2026-11-14' });
    const twice = settleMovers(once.days, bars, dayKey, { today: '2026-11-14' });
    expect(twice.changed).toBe(false);
    expect(twice.days).toBe(once.days);
  });
});

describe('summarizeMovers', () => {
  const res = (netPct, { moved = true, hit = netPct > 3, locked = false, green = netPct > 0 } = {}) => ({ netPct, moved, hit, locked, green });
  const day = (basisDay, results) => ({ basisDay, settled: true, picks: results.map((r, i) => ({ symbol: `S${i}`, rank: i + 1, pMove: 0.6, result: r })) });

  it('kuralin olculdugu ilk N ile gosterilen listeyi ayri toplar', () => {
    const days = [day('2026-11-12', [res(3.7), res(3.7), res(-5), res(-1), res(-1)]), day('2026-11-11', [res(-2), res(-2), res(-2), res(3.7), res(3.7)])];
    const s = summarizeMovers(days);
    expect(s.top.n).toBe(6);
    expect(s.top.days).toBe(2);
    expect(s.top.winPct).toBeCloseTo((2 / 6) * 100, 6);
    expect(s.top.avgNet).toBeCloseTo((3.7 + 3.7 - 5 - 6) / 6, 6);
    expect(s.top.posDayPct).toBe(50);
    expect(s.top.expMovedPct).toBeCloseTo(60, 6);
    expect(s.shown.n).toBe(10);
    expect(s.shown.hitPct).toBe(40);
  });

  it('kilitli seans ve yerlesmemis secim ozete girmez; bos kayitta null', () => {
    const days = [day('2026-11-12', [res(0, { locked: true }), res(3.7), null])];
    const s = summarizeMovers(days);
    expect(s.top.n).toBe(1);
    expect(s.top.winPct).toBe(100);
    expect(summarizeMovers([])).toEqual({ top: null, shown: null });
    expect(summarizeMovers(null)).toEqual({ top: null, shown: null });
  });
});
