import { describe, it, expect } from 'vitest';
import {
  AL_RULE, AL_LIST_EVIDENCE, selectAlList, recordAlList, alListToSettle, settleAlPick, settleAlList,
  summarizeAlList, alTaken, MAX_DAYS, MAX_TRIES,
} from '../alListScorecard.js';
import { PLAN_CONST } from '../tradePlan.js';
import { MAX_PLAN_BARS, simulatePlanReturn } from '../planSimulation.js';

const dayKey = (d) => String(d).slice(0, 10);
// Cuma 20.11.2026 18:30 TRT (seans disi) ve 11:00 TRT (seans ici)
const EVENING = Date.parse('2026-11-20T15:30:00Z');
const MIDDAY = Date.parse('2026-11-20T08:00:00Z');
const pick = (symbol, confidence, extra = {}) => ({
  symbol, cls: 'buy', score: 60, confidence, price: 100, stop: 95, _sessionDay: '2026-11-20', _regime: 'BULL', ...extra,
});
const detailOf = (picks) => ({ topPicks: picks, results: picks });
const bar = (date, open, high, low, close, extra = {}) => ({ date, open, high, low, close, volume: 1e6, ...extra });

describe('kural sabitleri', () => {
  it('urunun tek cikis kuraliyla ayni (paper + sinyal takibi)', () => {
    expect(AL_RULE.breakevenPct).toBe(PLAN_CONST.BREAKEVEN_PCT);
    expect(AL_RULE.trailActivePct).toBe(PLAN_CONST.TRAIL_ACTIVE_PCT);
    expect(AL_RULE.lockFraction).toBe(PLAN_CONST.LOCK_FRACTION);
    expect(AL_RULE.maxSessions).toBe(MAX_PLAN_BARS);
    expect(AL_RULE.topN).toBe(3);
  });
  it('ekrandaki gecmis cumlesi olcumle tutarli bicimde', () => {
    expect(AL_LIST_EVIDENCE.top3AvgNet).toBeLessThan(AL_LIST_EVIDENCE.poolAvgNet);   // sira ayirmiyor
    expect(AL_LIST_EVIDENCE.poolByYear[2026]).toBeLessThan(0);
  });
});

describe('selectAlList / recordAlList', () => {
  it('ekrandaki siraya gore ilk 3 + siradakiler kaydedilir', () => {
    const picks = [pick('AAA', 70), pick('BBB', 90), pick('CCC', 80), pick('DDD', 60), { ...pick('SSS', 99), cls: 'sell' }];
    expect(selectAlList(detailOf(picks)).map((p) => p.symbol)).toEqual(['BBB', 'CCC', 'AAA', 'DDD']);
    const days = recordAlList([], detailOf(picks), EVENING);
    expect(days).toHaveLength(1);
    expect(days[0].basisDay).toBe('2026-11-20');
    expect(days[0].picks.map((p) => [p.symbol, p.rank, p.stop])).toEqual([['BBB', 1, 95], ['CCC', 2, 95], ['AAA', 3, 95]]);
    expect(days[0].next).toEqual([{ symbol: 'DDD', watchOnly: false }]);
    expect(days[0].settled).toBe(false);
  });

  it('seans ici tarama kaydedilmez; ayni dayanak gunu icin ilk liste kalir', () => {
    expect(recordAlList([], detailOf([pick('AAA', 70)]), MIDDAY)).toEqual([]);
    const first = recordAlList([], detailOf([pick('AAA', 70)]), EVENING);
    expect(recordAlList(first, detailOf([pick('ZZZ', 99)]), EVENING + 3600e3)).toBe(first);
  });

  it('dayanak gunu pickler yoksa saatten (hafta sonu taramasi → cuma)', () => {
    const sat = Date.parse('2026-11-21T09:00:00Z');
    const days = recordAlList([], detailOf([pick('AAA', 70, { _sessionDay: undefined })]), sat);
    expect(days[0].basisDay).toBe('2026-11-20');
  });

  it('izle-only bayragi ve rejim tasinir; tavan sinirli, en yeni basta', () => {
    const d1 = recordAlList([], detailOf([pick('AAA', 70, { _watchOnly: true, _regime: 'BEAR' })]), EVENING);
    expect(d1[0].picks[0].watchOnly).toBe(true);
    expect(d1[0].regime).toBe('BEAR');
    let many = [];
    for (let i = 0; i < MAX_DAYS + 4; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
      many = recordAlList(many, detailOf([pick('AAA', 70, { _sessionDay: d })]), EVENING);
    }
    expect(many).toHaveLength(MAX_DAYS);
    expect(many[0].basisDay > many[1].basisDay).toBe(true);
  });
});

describe('settleAlPick', () => {
  const p = { symbol: 'AAA', stop: 95 };
  it('acilis stop\'un altindaysa alinmaz', () => {
    const r = settleAlPick(p, [bar('2026-11-20', 100, 101, 99, 100), bar('2026-11-23', 94, 96, 92, 95)], '2026-11-20', dayKey);
    expect(r.status).toBe('skipped');
    expect(r.entryDay).toBe('2026-11-23');
  });

  it('stop: acilistan giris, %0,3 maliyet; planSimulation ile birebir', () => {
    const bars = [bar('2026-11-23', 100, 102, 99, 101), bar('2026-11-24', 100, 100, 94, 95)];
    const r = settleAlPick(p, bars, '2026-11-20', dayKey);
    expect(r).toMatchObject({ status: 'closed', exitReason: 'stop', entry: 100, sessions: 2, grossPct: -5, netPct: -5.3 });
    const sim = simulatePlanReturn({ cls: 'buy', entryPrice: 100, stop: 95, timestamp: Date.parse('2026-11-23T09:00:00Z') }, bars);
    expect(r.grossPct).toBe(sim.planReturn);
  });

  it('trailing: +%5 ustunde kazancin yarisi kilitlenir, stop gelince kapanir', () => {
    const bars = [bar('2026-11-23', 100, 110, 99, 109), bar('2026-11-24', 108, 108, 104, 104.5)];
    const r = settleAlPick(p, bars, '2026-11-20', dayKey);
    expect(r).toMatchObject({ status: 'closed', exitReason: 'stop', grossPct: 5 });     // 100 + (110-100)/2
  });

  it('pencere bitmediyse islem surer (anlik deger)', () => {
    const r = settleAlPick(p, [bar('2026-11-23', 100, 103, 99, 102)], '2026-11-20', dayKey);
    expect(r).toMatchObject({ status: 'open', sessions: 1, grossPct: 2, netPct: 1.7, exitReason: null });
  });

  it('30 seans dolunca son kapanistan kapanir', () => {
    const bars = Array.from({ length: 32 }, (_, i) => bar(new Date(Date.UTC(2026, 11, 1 + i)).toISOString().slice(0, 10), 100, 101.5, 99, 101));
    const r = settleAlPick(p, bars, '2026-11-30', dayKey);
    expect(r).toMatchObject({ status: 'closed', exitReason: 'timeout', sessions: AL_RULE.maxSessions });
  });

  it('gecersiz stop (yok / %12\'den uzak) paper gibi −%3', () => {
    const r = settleAlPick({ symbol: 'AAA', stop: 50 }, [bar('2026-11-23', 100, 100, 96.5, 98)], '2026-11-20', dayKey);
    expect(r).toMatchObject({ status: 'closed', stop: 97, stopFallback: true, grossPct: -3 });
  });

  it('yaklasik acilis kullanilir ama isaretlenir; dayanak sonrasi bar yoksa null', () => {
    const r = settleAlPick(p, [bar('2026-11-23', 100, 103, 99, 102, { _openApprox: true })], '2026-11-20', dayKey);
    expect(r.approxEntry).toBe(true);
    expect(settleAlPick(p, [bar('2026-11-20', 100, 101, 99, 100)], '2026-11-20', dayKey)).toBeNull();
  });
});

describe('settleAlList / summarizeAlList', () => {
  const rec = () => recordAlList([], detailOf([pick('AAA', 90), pick('BBB', 80), pick('CCC', 70, { _watchOnly: true })]), EVENING);

  it('bugunun bari seans bitmeden kullanilmaz; olusan bar hic kullanilmaz', () => {
    const days = rec();
    const bars = { AAA: [bar('2026-11-23', 100, 103, 99, 102)], BBB: [bar('2026-11-23', 100, 103, 99, 102, { _isForming: true })] };
    expect(settleAlList(days, bars, dayKey, { today: '2026-11-23', sessionOver: false }).changed).toBe(false);
    const r = settleAlList(days, bars, dayKey, { today: '2026-11-23', sessionOver: true });
    expect(r.changed).toBe(true);
    expect(r.days[0].picks.find((x) => x.symbol === 'AAA').result.status).toBe('open');
    expect(r.days[0].picks.find((x) => x.symbol === 'BBB').result).toBeNull();
  });

  it('acik islemler yeniden yerlesir; hepsi kapaninca gun kapanir', () => {
    let days = rec();
    const b1 = { AAA: [bar('2026-11-23', 100, 103, 99, 102)], BBB: [bar('2026-11-23', 94, 95, 93, 94)], CCC: [bar('2026-11-23', 100, 101, 99, 100)] };
    days = settleAlList(days, b1, dayKey).days;
    expect(alListToSettle(days)).toEqual(['AAA']);                    // BBB atlandi, CCC kapandi degil — sonuc var
    const b2 = { AAA: [...b1.AAA, bar('2026-11-24', 101, 101, 94, 95)] };
    const r = settleAlList(days, b2, dayKey);
    expect(r.days[0].picks[0].result.status).toBe('closed');
    const s = summarizeAlList(r.days);
    expect(s).toMatchObject({ closed: 1, wins: 0, open: 0, skipped: 1, watch: 1, days: 1 });
    // 1. gun zirve +%3 → stop alis fiyatina cekildi; 2. gun basabastan cikti (yalniz maliyet)
    expect(s.avgNet).toBeCloseTo(-0.3, 5);
    expect(alTaken(r.days[0].picks[0])).toBe(true);
    expect(alTaken(r.days[0].picks[2])).toBe(false);                // izle-only alinmaz
  });

  it('bar geldigi halde giris seansi yoksa deneme sayilir, sinirda vazgecilir', () => {
    let days = rec();
    const stale = { AAA: [bar('2026-11-20', 100, 101, 99, 100)], BBB: [bar('2026-11-20', 100, 101, 99, 100)], CCC: [bar('2026-11-20', 100, 101, 99, 100)] };
    for (let i = 0; i < MAX_TRIES; i++) days = settleAlList(days, stale, dayKey).days;
    expect(days[0].settled).toBe(true);
    expect(settleAlList(days, stale, dayKey).changed).toBe(false);
    expect(settleAlList(rec(), {}, dayKey).changed).toBe(false);      // ag hatasi deneme sayilmaz
  });

  it('kayit yoksa ozet yok', () => {
    expect(summarizeAlList([])).toBeNull();
    expect(summarizeAlList(rec())).toBeNull();
  });
});
