import { describe, it, expect } from 'vitest';
import {
  nextSessionFeatures, indexFeatures, scoreNextSession, forecastNextSession, forecastFromScanBars,
  rankMovers, settleDayTrade, FEATURE_KEYS, MODEL_FEATURES, DAYTRADE_RULE, MIN_BARS, NEXT_SESSION_EVIDENCE, maxGapPctOf,
} from '../nextSession.js';
import { NEXT_SESSION_MODEL } from '../nextSessionModel.js';

const dayKey = (d) => String(d).slice(0, 10);

/** Deterministik seri: `amp` gunluk salinim genisligi (%), `drift` gunluk egilim (%). */
function series(n, { amp = 1, drift = 0, start = 100, vol = 1e6 } = {}) {
  const bars = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const step = drift + (i % 2 === 0 ? amp : -amp) * 0.5;
    const prev = c;
    c = prev * (1 + step / 100);
    const hi = Math.max(prev, c) * (1 + amp / 200);
    const lo = Math.min(prev, c) * (1 - amp / 200);
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    bars.push({ date: d, open: prev, high: hi, low: lo, close: c, volume: vol });
  }
  return bars;
}

describe('nextSessionFeatures', () => {
  it('yetersiz barda null doner', () => {
    expect(nextSessionFeatures(series(MIN_BARS - 1))).toBeNull();
    expect(nextSessionFeatures(null)).toBeNull();
  });

  it('gecersiz kapanis iceren seriyi reddeder', () => {
    const b = series(80);
    b[40] = { ...b[40], close: 0 };
    expect(nextSessionFeatures(b)).toBeNull();
  });

  it('tum ozellik anahtarlarini uretir', () => {
    const f = nextSessionFeatures(series(300), indexFeatures(series(80).map((x) => x.close)));
    for (const k of FEATURE_KEYS) expect(f).toHaveProperty(k);
    expect(Number.isFinite(f.atr)).toBe(true);
    expect(Number.isFinite(f.d200)).toBe(true);
    expect(Number.isFinite(f.xD20)).toBe(true);
  });

  it('kisa seride uzun ortalamalar null kalir, endekssiz cagrida endeks olculeri null', () => {
    const f = nextSessionFeatures(series(70));
    expect(f.d200).toBeNull();
    expect(f.hi252).toBeNull();
    expect(f.xChg1).toBeNull();
    expect(Number.isFinite(f.d50)).toBe(true);
  });

  it('gunun mumunu dogru okur: degisim, kapanis konumu, seri', () => {
    const b = series(70, { amp: 0 });            // duz seri
    const p = b[b.length - 1].close;
    b.push({ date: '2026-04-01', open: p, high: p * 1.05, low: p * 0.99, close: p * 1.04, volume: 3e6 });
    const f = nextSessionFeatures(b);
    expect(f.chg1).toBeCloseTo(4, 2);
    expect(f.clv).toBeCloseTo((1.04 - 0.99) / (1.05 - 0.99), 2);
    expect(f.rng).toBeCloseTo(6, 2);
    expect(f.streak).toBe(1);
    expect(f.volR).toBeCloseTo(3, 1);
    expect(f.limUp).toBe(0);
  });

  it('tavan ve taban kapanisini isaretler', () => {
    const up = series(70, { amp: 0 });
    const p = up[up.length - 1].close;
    up.push({ date: '2026-04-01', open: p * 1.05, high: p * 1.1, low: p * 1.04, close: p * 1.1, volume: 1e6 });
    expect(nextSessionFeatures(up).limUp).toBe(1);
    const dn = series(70, { amp: 0 });
    dn.push({ date: '2026-04-01', open: p * 0.97, high: p * 0.98, low: p * 0.9, close: p * 0.9, volume: 1e6 });
    const f = nextSessionFeatures(dn);
    expect(f.limDn).toBe(1);
    expect(f.limUp).toBe(0);
  });

  it('yuksek/dusuk alani bozuksa kapanisa cekilir (aralik negatif olmaz)', () => {
    const b = series(70);
    const last = b[b.length - 1];
    b[b.length - 1] = { ...last, high: last.close * 0.5, low: last.close * 2 };
    const f = nextSessionFeatures(b);
    expect(f.rng).toBe(0);
    expect(f.clv).toBe(0.5);
  });
});

describe('bozuk fiyat serisi', () => {
  it('son 60 barda bolunme benzeri sicrama tahmini guvenilmez isaretler ve listeden cikarir', () => {
    const clean = series(200, { amp: 6 });
    const split = clean.map((b, i) => (i >= 170 ? { ...b, open: b.open / 3, high: b.high / 3, low: b.low / 3, close: b.close / 3 } : b));
    expect(nextSessionFeatures(clean).art).toBe(0);
    expect(nextSessionFeatures(split).art).toBe(1);
    const fc = forecastNextSession(split);
    expect(fc.artifact).toBe(true);
    expect(rankMovers([{ symbol: 'SPLT', _ns: fc }, { symbol: 'OK', _ns: forecastNextSession(clean) }]).map((x) => x.symbol)).toEqual(['OK']);
  });

  it('60 bardan eski sicrama sayilmaz', () => {
    const b = series(300, { amp: 2 });
    const old = b.map((x, i) => (i < 100 ? { ...x, open: x.open * 3, high: x.high * 3, low: x.low * 3, close: x.close * 3 } : x));
    expect(nextSessionFeatures(old.slice(-260)).art).toBe(0);
  });
});

describe('indexFeatures', () => {
  it('21 kapanistan azsa null', () => {
    expect(indexFeatures([1, 2, 3])).toBeNull();
  });
  it('yukselen seride pozitif egilim ve seri sayaci', () => {
    const c = Array.from({ length: 40 }, (_, i) => 100 * 1.01 ** i);
    const f = indexFeatures(c);
    expect(f.xChg1).toBeCloseTo(1, 2);
    expect(f.xRet5).toBeGreaterThan(4.9);
    expect(f.xD20).toBeGreaterThan(0);
    expect(f.xStreak).toBe(39);
  });
});

describe('scoreNextSession', () => {
  const tiny = {
    move: { intercept: 0, terms: [['atr', 0, 10, 5, 2, 1]] },
    green: { intercept: -1, terms: [['chg1', -5, 5, 0, 1, 0.5]] },
  };

  it('standartlar, kirpar ve lojistige cevirir', () => {
    const s = scoreNextSession({ atr: 7, chg1: 2 }, tiny);
    expect(s.pMove).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);       // (7-5)/2 = 1
    expect(s.pGreen).toBeCloseTo(1 / (1 + Math.exp(0)), 6);       // -1 + 0.5*2 = 0
    const clipped = scoreNextSession({ atr: 999, chg1: -999 }, tiny);
    expect(clipped.pMove).toBeCloseTo(1 / (1 + Math.exp(-2.5)), 6);
    expect(clipped.pGreen).toBeCloseTo(1 / (1 + Math.exp(3.5)), 6);
  });

  it('eksik ozellik egitim ortalamasi sayilir (katki 0)', () => {
    const s = scoreNextSession({ atr: null }, tiny);
    expect(s.pMove).toBeCloseTo(0.5, 6);
  });

  it('modelsiz ya da ozelliksiz cagrida null', () => {
    expect(scoreNextSession(null, tiny)).toBeNull();
    expect(scoreNextSession({ atr: 1 }, { move: { intercept: 0, terms: [] }, green: tiny.green })).toBeNull();
  });
});

describe('uretilmis model', () => {
  it('iki model de tum ozellikleri ve gecerli katsayilari tasir', () => {
    for (const part of [NEXT_SESSION_MODEL.move, NEXT_SESSION_MODEL.green]) {
      expect(part.terms.map((t) => t[0])).toEqual([...MODEL_FEATURES]);
      for (const [, lo, hi, , sd, b] of part.terms) {
        expect(hi).toBeGreaterThanOrEqual(lo);
        expect(sd).toBeGreaterThan(0);
        expect(Number.isFinite(b)).toBe(true);
      }
    }
    expect(NEXT_SESSION_MODEL.movePct).toBe(DAYTRADE_RULE.movePct);
  });

  it('oynak hisseye sakin hisseden yuksek hareket olasiligi verir', () => {
    const calm = forecastNextSession(series(300, { amp: 0.6 }));
    const wild = forecastNextSession(series(300, { amp: 6 }));
    expect(wild.pMove).toBeGreaterThan(calm.pMove + 0.2);
    for (const f of [calm, wild]) {
      expect(f.pMove).toBeGreaterThan(0); expect(f.pMove).toBeLessThan(1);
      expect(f.pGreen).toBeGreaterThan(0.2); expect(f.pGreen).toBeLessThan(0.8);
    }
  });

  it('alintilanan olcum kuralin sabitleriyle tutarli', () => {
    const E = NEXT_SESSION_EVIDENCE;
    expect(E.hourly.halvesPositive).toBeLessThanOrEqual(E.hourly.halves);
    expect(E.hourly.tightStop).toBeLessThan(E.hourly.withWideStop);   // dar stop getiriyi götürür
    expect(E.daily.skippedAvg).toBeLessThan(0);                          // atlanan işlemler zararlı
    expect(E.daily.withoutGapRule).toBeLessThan(E.daily.avgNet);         // sınır kuralı iyileştirir
    expect(E.daily.openToClose).toBeLessThan(E.daily.avgNet);            // kâr-al olmadan daha kötü
  });
});

describe('forecastFromScanBars', () => {
  it('olusan bari atar; dayanak gunu son KAPANMIS bardir', () => {
    const closed = series(120);
    const forming = { ...closed[closed.length - 1], date: '2026-06-01', close: closed[closed.length - 1].close * 1.09, _isForming: true };
    const a = forecastFromScanBars(closed, null, dayKey);
    const b = forecastFromScanBars([...closed, forming], null, dayKey);
    expect(b.basisDay).toBe(dayKey(closed[closed.length - 1].date));
    expect(b.pMove).toBe(a.pMove);
    expect(b.pGreen).toBe(a.pGreen);
  });

  it('endeksi dayanak gunune hizalar: sonraki endeks barlari sonucu degistirmez', () => {
    const bars = series(120);
    const idx = series(120, { amp: 0.4, drift: 0.1 });
    const later = { date: '2027-01-01', close: idx[idx.length - 1].close * 0.5 };
    const a = forecastFromScanBars(bars, idx, dayKey);
    const b = forecastFromScanBars(bars, [...idx, later], dayKey);
    expect(b.pGreen).toBe(a.pGreen);
    expect(forecastFromScanBars(bars, null, dayKey).pGreen).not.toBe(a.pGreen);
  });

  it('onbellek ayni dayanak gunu icin endeks olculerini bir kez hesaplar', () => {
    const cache = new Map();
    const bars = series(120);
    const idx = series(120, { amp: 0.4 });
    forecastFromScanBars(bars, idx, dayKey, cache);
    expect(cache.size).toBe(1);
    const stored = cache.get(dayKey(bars[bars.length - 1].date));
    forecastFromScanBars(bars, [], dayKey, cache);             // onbellekten okur, bos endeks etkilemez
    expect(cache.get(dayKey(bars[bars.length - 1].date))).toBe(stored);
  });

  it('yetersiz veri ya da gun anahtari yoksa null', () => {
    expect(forecastFromScanBars(series(30), null, dayKey)).toBeNull();
    expect(forecastFromScanBars(series(120), null, () => '')).toBeNull();
    expect(forecastFromScanBars(series(120), null, null)).toBeNull();
  });
});

describe('rankMovers', () => {
  const row = (symbol, pMove, turnoverLog = 7) => ({ symbol, _ns: { pMove, pGreen: 0.5, turnoverLog } });

  it('likit olanlari hareket olasiligina gore siralar ve sinirlar', () => {
    const out = rankMovers([row('A', 0.3), row('B', 0.8), row('C', 0.6), row('D', 0.9, 5.9), row('E', 0.5), { symbol: 'F' }], 3);
    expect(out.map((x) => x.symbol)).toEqual(['B', 'C', 'E']);
  });

  it('esitlikte sembole gore kararli siralar; varsayilan derinlik gosterilen sayi', () => {
    const rows = ['Z', 'Y', 'X', 'W', 'V', 'U', 'T'].map((s) => row(s, 0.5));
    const out = rankMovers(rows);
    expect(out).toHaveLength(DAYTRADE_RULE.shownN);
    expect(out[0].symbol).toBe('T');
  });

  it('bos ya da gecersiz girdide bos liste', () => {
    expect(rankMovers(null)).toEqual([]);
    expect(rankMovers([null, {}])).toEqual([]);
  });
});

describe('acilis siniri (kar-al tavanin ustunde)', () => {
  it('sinir kuraldan turetilir: tavan %10, kar-al %4 + %0,1 → %5,67', () => {
    expect(DAYTRADE_RULE.maxGapPct).toBeCloseTo(5.67, 2);
    expect(maxGapPctOf({ limitPct: 10, takeProfitPct: 4, fillEpsPct: 0.1 })).toBeCloseTo((1.10 / 1.041 - 1) * 100, 6);
    // sınırdaki açılışın +%4,1'i tam tavana denk gelir
    expect(100 * (1 + DAYTRADE_RULE.maxGapPct / 100) * 1.041).toBeCloseTo(110, 1);
  });

  it('acilis sinirin ustundeyse islem alinmaz; altindaysa normal', () => {
    const over = settleDayTrade({ open: 106, high: 110, low: 103, close: 104 }, DAYTRADE_RULE, 100);
    expect(over.skipped).toBe(true);
    expect(over.taken).toBe(false);
    expect(over.netPct).toBe(0);
    expect(over.gapPct).toBe(6);
    const under = settleDayTrade({ open: 105, high: 109.4, low: 103, close: 104 }, DAYTRADE_RULE, 100);
    expect(under.skipped).toBe(false);
    expect(under.hit).toBe(true);
    expect(under.netPct).toBeCloseTo(3.7, 6);
  });

  it('onceki kapanis bilinmiyorsa sinir uygulanmaz (eski davranis)', () => {
    const r = settleDayTrade({ open: 106, high: 110.5, low: 103, close: 104 });
    expect(r.skipped).toBe(false);
    expect(r.taken).toBe(true);
    expect(r.gapPct).toBeNull();
  });
});

describe('settleDayTrade', () => {
  it('kar-al seviyesi gecilirse limitten cikar', () => {
    const r = settleDayTrade({ open: 100, high: 104.2, low: 98, close: 101 });
    expect(r.hit).toBe(true);
    expect(r.grossPct).toBe(4);
    expect(r.netPct).toBeCloseTo(4 - DAYTRADE_RULE.costPct, 6);
    expect(r.moved).toBe(true);
  });

  it('seviyeye degip gecmediyse dolmus sayilmaz, kapanistan cikar', () => {
    const r = settleDayTrade({ open: 100, high: 104.05, low: 97, close: 98 });
    expect(r.hit).toBe(false);
    expect(r.grossPct).toBe(-2);
    expect(r.netPct).toBeCloseTo(-2.3, 6);
    expect(r.lowPct).toBe(-3);
  });

  it('hareket esigi kar-aldan ayridir', () => {
    const r = settleDayTrade({ open: 100, high: 103.2, low: 99, close: 102 });
    expect(r.moved).toBe(true);
    expect(r.hit).toBe(false);
    expect(r.netPct).toBeCloseTo(1.7, 6);
  });

  it('tek fiyatli seans alinamaz: sonuc sifir', () => {
    const r = settleDayTrade({ open: 110, high: 110, low: 110, close: 110 });
    expect(r.locked).toBe(true);
    expect(r.hit).toBe(false);
    expect(r.netPct).toBe(0);
  });

  it('eksik barda null', () => {
    expect(settleDayTrade({ open: 0, high: 1, low: 1, close: 1 })).toBeNull();
    expect(settleDayTrade(null)).toBeNull();
  });
});
