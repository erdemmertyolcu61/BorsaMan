/**
 * Hisse detayı — teknik tablo (v31.50). Karar üretmez; ham gösterge değerleri
 * ve getiriler. Sentetik barlar: istanbulDayKey ile gün anahtarı.
 */
import { describe, it, expect } from 'vitest';
import { computeReturns, historicalVolatility, range52w, buildTechnicalSnapshot } from '../technicalSnapshot.js';
import { calcAllJs } from '../indicators.js';

function bars(n, { start = '2025-06-02', drift = 0.001, wave = 0.02 } = {}) {
  const out = [];
  let d = new Date(start + 'T15:00:00Z');
  let price = 100;
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 864e5);
    price = price * (1 + drift) * (1 + wave * Math.sin(i / 5) / 10);
    out.push({ date: new Date(d), open: price * 0.995, high: price * 1.01, low: price * 0.99, close: price, volume: 1000 + (i % 7) * 100 });
    d = new Date(d.getTime() + 864e5);
  }
  return out;
}

describe('getiriler', () => {
  it('pencereler bar sayısıyla; endeks verilirse fark puan olarak', () => {
    const p = bars(300);
    const b = bars(300, { drift: 0 });
    const r = computeReturns(p, b);
    const w1 = r.find(x => x.key === 'w1');
    const n = p.length;
    expect(w1.value).toBeCloseTo(((p[n - 1].close - p[n - 6].close) / p[n - 6].close) * 100, 9);
    expect(w1.rel).toBeCloseTo(w1.value - w1.bench, 9);
    expect(r.map(x => x.key)).toContain('y1');
  });

  it('endeks penceresi tarihle hizalanır — endeks serisinde eksik gün olsa da', () => {
    const p = bars(300);
    const full = bars(300, { drift: 0 });
    const gappy = full.filter((_, i) => i % 9 !== 4);   // Yahoo gibi gün atlayan seri
    const n = p.length;
    const baseDay = p[n - 22].date.toISOString().slice(0, 10);
    const exact = full.find(x => x.date.toISOString().slice(0, 10) === baseDay);
    const before = [...gappy].reverse().find(x => x.date.toISOString().slice(0, 10) <= baseDay);
    const m1 = computeReturns(p, gappy).find(x => x.key === 'm1');
    const end = gappy[gappy.length - 1].close;
    expect(m1.bench).toBeCloseTo(((end - before.close) / before.close) * 100, 9);
    expect(before.date.getTime()).toBeLessThanOrEqual(exact.date.getTime());
  });

  it('yılbaşından beri = önceki yılın son kapanışından', () => {
    const p = bars(300);   // 2025-06 → 2026-07
    const r = computeReturns(p);
    const ytd = r.find(x => x.key === 'ytd');
    const lastOf2025 = [...p].reverse().find(x => x.date.toISOString().slice(0, 4) === '2025');
    expect(ytd.value).toBeCloseTo(((p[p.length - 1].close - lastOf2025.close) / lastOf2025.close) * 100, 9);
  });

  it('kısa seride uzun pencere yok', () => {
    expect(computeReturns(bars(30)).map(x => x.key)).not.toContain('m3');
    expect(computeReturns([])).toEqual([]);
  });
});

describe('oynaklık ve 52 hafta', () => {
  it('sabit büyümede tarihsel oynaklık ~0', () => {
    expect(historicalVolatility(bars(40, { wave: 0 }))).toBeLessThan(1e-6);
    expect(historicalVolatility(bars(5))).toBeNull();
  });

  it('52 hafta en yüksek/düşük ve uzaklık', () => {
    const p = bars(300);
    const r = range52w(p);
    const slice = p.slice(-252);
    expect(r.high).toBe(Math.max(...slice.map(x => x.high)));
    expect(r.low).toBe(Math.min(...slice.map(x => x.low)));
    expect(r.fromHigh).toBeLessThanOrEqual(0);
  });
});

describe('teknik tablo', () => {
  const p = bars(260);
  const ind = calcAllJs(p);
  const snap = buildTechnicalSnapshot(p, ind);

  it('yedi grup; RSI motorun değeri', () => {
    expect(snap.groups.map(g => g.id)).toEqual(['ma', 'momentum', 'trend', 'volatility', 'volume', 'levels', 'patterns']);
    const rsi = snap.groups.find(g => g.id === 'momentum').rows.find(r => r.label === 'RSI (14)');
    expect(rsi.value).toBe(ind.lastRSI);
  });

  it('SMA satırları fiyata uzaklığı taşır', () => {
    const sma20 = snap.groups.find(g => g.id === 'ma').rows.find(r => r.label === 'SMA 20');
    const close = p[p.length - 1].close;
    expect(sma20.sub).toBeCloseTo(((close - ind.lastMA20) / ind.lastMA20) * 100, 9);
  });

  it('pivot, seans sürerken son TAMAMLANMIŞ bardan kurulur', () => {
    const forming = p.map((x, i) => (i === p.length - 1 ? { ...x, high: x.high * 1.2, _isForming: true } : x));
    const s = buildTechnicalSnapshot(forming, calcAllJs(forming));
    const pivot = s.groups.find(g => g.id === 'levels').rows.find(r => r.label === 'Pivot (klasik)');
    const prev = p[p.length - 2];
    expect(pivot.value).toBeCloseTo((prev.high + prev.low + prev.close) / 3, 9);
  });

  it('bar yoksa boş', () => {
    expect(buildTechnicalSnapshot([], null).groups).toEqual([]);
  });
});
