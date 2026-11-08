// technicalSnapshot.js — "Hisse detayı" sekmesinin teknik tablosu (v31.50)
//
// Motorun (calcAll) ürettiği göstergeleri ve birkaç ek hesabı (EMA, pivot,
// Fibonacci, getiriler, tarihsel oynaklık) gruplar hâlinde ham sayı olarak
// döndürür. Sinyal ya da AL/SAT kararı ÜRETMEZ: o karar Analiz sekmesinde,
// tarama ile aynı yoldan verilir; burada ikinci bir karar çelişki yaratırdı.
// Her satırın notu yalnız göstergenin klasik okumasıdır ("70 üstü aşırı alım").

import { calcEMA, calcPivots, calcFibonacci } from './indicators.js';
import { istanbulDayKey } from './fetchEngine.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const last = (arr) => (Array.isArray(arr) ? arr[arr.length - 1] : arr);
const num = (v) => (isNum(v) ? v : isNum(last(v)) ? last(v) : null);
const pctDiff = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / b) * 100 : null);

export const RETURN_WINDOWS = Object.freeze([
  { key: 'w1', label: '1 hafta', bars: 5 },
  { key: 'm1', label: '1 ay', bars: 21 },
  { key: 'm3', label: '3 ay', bars: 63 },
  { key: 'm6', label: '6 ay', bars: 126 },
  { key: 'y1', label: '1 yıl', bars: 252 },
]);

/** `key` gününde ya da ondan önceki son barın kapanışı (gün anahtarı YYYY-MM-DD). */
function closeAtOrBefore(bars, keys, key) {
  for (let i = bars.length - 1; i >= 0; i--) if (keys[i] && keys[i] <= key) return bars[i].close;
  return null;
}

/**
 * Barlardan getiriler; `bench` verilirse aynı TARİH aralığında endeks getirisi ve
 * fark. Endeks penceresi bar sayısıyla değil tarihle hizalanır: Yahoo gün atlar
 * (BIST 100 serisi oradan geliyor), bar sayısı iki seride farklı tarihlere düşerdi.
 */
export function computeReturns(prices, bench = null) {
  const n = prices?.length || 0;
  if (n < 2) return [];
  const close = prices[n - 1].close;
  const keys = prices.map(p => istanbulDayKey(p.date));
  const endKey = keys[n - 1];
  const bKeys = bench?.length ? bench.map(p => istanbulDayKey(p.date)) : null;
  const benchClose = bKeys ? closeAtOrBefore(bench, bKeys, endKey) : null;
  const benchFrom = (key) => (bKeys && isNum(benchClose) && key ? pctDiff(benchClose, closeAtOrBefore(bench, bKeys, key)) : null);
  const row = (key, label, base, baseKey) => {
    const r = pctDiff(close, base);
    const b = benchFrom(baseKey);
    return { key, label, value: r, bench: b, rel: isNum(r) && isNum(b) ? r - b : null };
  };
  const rows = [];
  for (const w of RETURN_WINDOWS) {
    if (n <= w.bars) continue;
    rows.push(row(w.key, w.label, prices[n - 1 - w.bars].close, keys[n - 1 - w.bars]));
  }
  // Yılbaşından beri: önceki yılın son kapanışından
  const year = endKey?.slice(0, 4);
  if (year) {
    for (let i = n - 1; i >= 0; i--) {
      if (keys[i] && keys[i].slice(0, 4) < year) {
        rows.splice(Math.min(3, rows.length), 0, row('ytd', 'Yılbaşından beri', prices[i].close, keys[i]));
        break;
      }
    }
  }
  return rows;
}

/** 20 günlük log getirilerin yıllıklandırılmış standart sapması (%). */
export function historicalVolatility(prices, lookback = 20) {
  const n = prices?.length || 0;
  if (n < lookback + 1) return null;
  const rets = [];
  for (let i = n - lookback; i < n; i++) {
    const a = prices[i - 1].close, b = prices[i].close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < lookback * 0.8) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

/** 52 hafta (252 bar) en yüksek / en düşük ve fiyatın onlara uzaklığı. */
export function range52w(prices) {
  const n = prices?.length || 0;
  if (!n) return null;
  const slice = prices.slice(Math.max(0, n - 252));
  let hi = -Infinity, lo = Infinity;
  for (const p of slice) { if (p.high > hi) hi = p.high; if (p.low < lo) lo = p.low; }
  const close = prices[n - 1].close;
  return { high: hi, low: lo, fromHigh: pctDiff(close, hi), fromLow: pctDiff(close, lo), bars: slice.length };
}

const tone = (cond, up = 'up', down = 'down') => (cond == null ? null : cond ? up : down);

/**
 * @param {Array} prices kronolojik günlük barlar
 * @param {object} ind   calcAll çıktısı
 * @param {{bench?: Array}} [opts]
 * @returns {{groups: Array<{id, title, rows: Array<{label, value, fmt, tone?, note?}>}>, returns, range}}
 */
export function buildTechnicalSnapshot(prices, ind, { bench = null } = {}) {
  const n = prices?.length || 0;
  if (!n || !ind) return { groups: [], returns: [], range: null };
  const close = prices[n - 1].close;
  const closes = prices.map(p => p.close);
  const lastBar = prices[n - 1];
  // Pivot bir sonraki seans için TAMAMLANMIŞ son bardan kurulur.
  const pivotBar = lastBar?._isForming && n > 1 ? prices.slice(0, n - 1) : prices;
  const pv = calcPivots(pivotBar);
  const fib = calcFibonacci(prices);

  const ma = [
    ['SMA 20', num(ind.lastMA20)], ['SMA 50', num(ind.lastMA50)],
    ['SMA 100', num(ind.lastMA100)], ['SMA 200', num(ind.lastMA200)],
    ['EMA 9', last(calcEMA(closes, 9))], ['EMA 21', last(calcEMA(closes, 21))],
    ['EMA 50', last(calcEMA(closes, 50))], ['EMA 200', n >= 200 ? last(calcEMA(closes, 200)) : null],
  ].map(([label, v]) => ({
    label, value: isNum(v) ? v : null, fmt: 'price',
    sub: isNum(v) ? pctDiff(close, v) : null, subFmt: 'pct',
    tone: isNum(v) ? tone(close >= v) : null,
    note: isNum(v) ? (close >= v ? 'fiyat üstünde' : 'fiyat altında') : 'yetersiz veri',
  }));
  const ma50 = num(ind.lastMA50), ma200 = num(ind.lastMA200);
  if (isNum(ma50) && isNum(ma200)) {
    ma.push({ label: 'SMA 50 / 200', value: ma50 >= ma200 ? 'Altın kesişim bölgesi' : 'Ölüm kesişimi bölgesi', fmt: 'text', tone: tone(ma50 >= ma200), note: '50 günlük ortalama 200 günlüğün ' + (ma50 >= ma200 ? 'üstünde' : 'altında') });
  }

  const rsi = num(ind.lastRSI);
  const k = num(ind.lastStochK), d = num(ind.lastStochD);
  const macd = num(ind.lastMACD), macdSig = num(ind.lastMACDSig), hist = num(ind.lastMACDHist);
  const wr = num(ind.lastWilliamsR);
  const mfi = num(ind.mfi);
  const trix = ind.trix && isNum(ind.trix.lastTRIX) ? ind.trix.lastTRIX : null;
  const momentum = [
    { label: 'RSI (14)', value: rsi, fmt: 'num1', tone: rsi == null ? null : rsi >= 70 ? 'warn' : rsi <= 30 ? 'warn' : null, note: rsi == null ? '' : rsi >= 70 ? 'aşırı alım (70+)' : rsi <= 30 ? 'aşırı satım (30−)' : rsi >= 50 ? 'nötr-pozitif' : 'nötr-negatif' },
    { label: 'Stokastik RSI %K / %D', value: k, fmt: 'num1', sub: d, subFmt: 'num1', tone: k == null ? null : k >= 80 ? 'warn' : k <= 20 ? 'warn' : null, note: k == null ? '' : k >= 80 ? 'aşırı alım (80+)' : k <= 20 ? 'aşırı satım (20−)' : (k >= d ? '%K, %D üstünde' : '%K, %D altında') },
    { label: 'MACD (12,26,9)', value: macd, fmt: 'num2', sub: macdSig, subFmt: 'num2', tone: isNum(macd) && isNum(macdSig) ? tone(macd >= macdSig) : null, note: isNum(macd) && isNum(macdSig) ? (macd >= macdSig ? 'sinyal çizgisi üstünde' : 'sinyal çizgisi altında') : '' },
    { label: 'MACD histogram', value: hist, fmt: 'num2', tone: isNum(hist) ? tone(hist >= 0) : null, note: isNum(hist) ? (hist >= 0 ? 'pozitif' : 'negatif') : '' },
    { label: 'Williams %R (14)', value: wr, fmt: 'num1', tone: wr == null ? null : wr >= -20 ? 'warn' : wr <= -80 ? 'warn' : null, note: wr == null ? '' : wr >= -20 ? 'aşırı alım (−20 üstü)' : wr <= -80 ? 'aşırı satım (−80 altı)' : 'orta bölge' },
    { label: 'MFI (14)', value: mfi, fmt: 'num1', tone: mfi == null ? null : mfi >= 80 ? 'warn' : mfi <= 20 ? 'warn' : null, note: mfi == null ? '' : mfi >= 80 ? 'para girişi aşırı (80+)' : mfi <= 20 ? 'para çıkışı aşırı (20−)' : 'hacimli RSI, orta bölge' },
    { label: 'ROC 10 / 20 gün', value: num(ind.lastROC10), fmt: 'pct', sub: num(ind.lastROC20), subFmt: 'pct', tone: isNum(num(ind.lastROC10)) ? tone(num(ind.lastROC10) >= 0) : null, note: 'değişim oranı' },
    { label: 'TRIX (15) / sinyal', value: trix, fmt: 'num1', sub: ind.trix && isNum(ind.trix.lastSignal) ? ind.trix.lastSignal : null, subFmt: 'num1', tone: isNum(trix) ? tone(trix >= 0) : null, note: isNum(trix) ? `baz puan · üçlü EMA ${trix >= 0 ? 'yükseliyor' : 'düşüyor'}` : '' },
  ];

  const adx = num(ind.adx), pdi = num(ind.plusDI), mdi = num(ind.minusDI);
  const st = ind.supertrend || {};
  const ich = ind.ichimoku || {};
  const trend = [
    { label: 'ADX (14)', value: adx, fmt: 'num1', note: adx == null ? '' : adx >= 40 ? 'çok güçlü trend' : adx >= 25 ? 'güçlü trend' : adx >= 20 ? 'trend oluşuyor' : 'trendsiz / yatay' },
    { label: '+DI / −DI', value: pdi, fmt: 'num1', sub: mdi, subFmt: 'num1', tone: isNum(pdi) && isNum(mdi) ? tone(pdi >= mdi) : null, note: isNum(pdi) && isNum(mdi) ? (pdi >= mdi ? 'alıcılar baskın' : 'satıcılar baskın') : '' },
    { label: 'Supertrend (10,3)', value: isNum(st.value) ? st.value : null, fmt: 'price', tone: st.trend ? tone(st.trend === 'UP') : null, note: st.trend === 'UP' ? 'yukarı yönlü' : st.trend === 'DOWN' ? 'aşağı yönlü' : '' },
    { label: 'Ichimoku Tenkan / Kijun', value: num(ich.lastTenkan), fmt: 'price', sub: num(ich.lastKijun), subFmt: 'price', tone: isNum(num(ich.lastTenkan)) && isNum(num(ich.lastKijun)) ? tone(num(ich.lastTenkan) >= num(ich.lastKijun)) : null, note: 'dönüşüm / taban çizgisi' },
    { label: 'Ichimoku bulutu', value: num(ich.kumoTop), fmt: 'price', sub: num(ich.kumoBottom), subFmt: 'price', tone: ich.cloudPosition === 'above' ? 'up' : ich.cloudPosition === 'below' ? 'down' : null, note: ich.cloudPosition === 'above' ? 'fiyat bulutun üstünde' : ich.cloudPosition === 'below' ? 'fiyat bulutun altında' : ich.cloudPosition === 'inside' ? 'fiyat bulutun içinde' : '' },
  ];

  const atr = num(ind.atr);
  const bu = num(ind.lastBU), bm = num(ind.lastBM), bl = num(ind.lastBL);
  const pctB = isNum(bu) && isNum(bl) && bu !== bl ? (close - bl) / (bu - bl) : null;
  const bw = isNum(bu) && isNum(bl) && isNum(bm) && bm ? ((bu - bl) / bm) * 100 : null;
  const hv = historicalVolatility(prices, 20);
  const sq = ind.ttmSqueeze || {};
  const ch = ind.chandelier || {};
  const volatility = [
    { label: 'ATR (14)', value: atr, fmt: 'price', sub: isNum(atr) && close ? (atr / close) * 100 : null, subFmt: 'pct', note: 'ortalama günlük aralık' },
    { label: 'Tarihsel oynaklık (20g)', value: hv, fmt: 'pct', note: 'yıllıklandırılmış' },
    { label: 'Bollinger üst / alt', value: bu, fmt: 'price', sub: bl, subFmt: 'price', note: isNum(bm) ? `orta ${bm.toFixed(2)}` : '' },
    { label: 'Bollinger %B', value: pctB, fmt: 'num2', tone: pctB == null ? null : pctB > 1 || pctB < 0 ? 'warn' : null, note: pctB == null ? '' : pctB > 1 ? 'üst bandın dışında' : pctB < 0 ? 'alt bandın dışında' : 'bant içinde' },
    { label: 'Bant genişliği', value: bw, fmt: 'pct', note: sq.squeezeOn ? `TTM sıkışma açık (${sq.squeezeCount || 0} gün)` : 'sıkışma yok' },
    { label: 'Chandelier çıkış (uzun)', value: num(ch.longStop), fmt: 'price', tone: isNum(num(ch.longStop)) ? tone(close >= num(ch.longStop)) : null, note: '22 gün en yüksek − 3×ATR' },
  ];

  const vols = prices.slice(Math.max(0, n - 20)).map(p => p.volume || 0);
  const avgVol = vols.length ? vols.reduce((s, x) => s + x, 0) / vols.length : null;
  const turnover = prices.slice(Math.max(0, n - 20)).map(p => (p.volume || 0) * (p.close || 0));
  const avgTurnover = turnover.length ? turnover.reduce((s, x) => s + x, 0) / turnover.length : null;
  const vp = ind.volumeProfile || {};
  const OBV_TXT = { accumulation: 'birikim (fiyat düşerken OBV artıyor)', distribution: 'dağıtım (fiyat artarken OBV düşüyor)', confirmation: 'fiyatı teyit ediyor', neutral: 'nötr' };
  const ADL_TXT = { accumulation: 'birikim', distribution: 'dağıtım', neutral: 'nötr' };
  const cmf = num(ind.cmf);
  const vwap = num(ind.vwap);
  const volume = [
    { label: 'Son hacim (lot)', value: lastBar.volume ?? null, fmt: 'big', sub: num(ind.volRatio), subFmt: 'ratio', note: '20 günlük ortalamaya oranı' },
    { label: 'Ortalama hacim (20g)', value: avgVol, fmt: 'big', note: 'lot' },
    { label: 'İşlem hacmi (TL, son / 20g ort.)', value: (lastBar.volume || 0) * close, fmt: 'tl', sub: avgTurnover, subFmt: 'tl' },
    { label: 'OBV eğilimi', value: OBV_TXT[ind.obvTrend] || '—', fmt: 'text', tone: ind.obvTrend === 'accumulation' || ind.obvTrend === 'confirmation' ? 'up' : ind.obvTrend === 'distribution' ? 'down' : null },
    { label: 'Chaikin para akışı (20)', value: cmf, fmt: 'num3', tone: isNum(cmf) ? tone(cmf >= 0) : null, note: isNum(cmf) ? (cmf >= 0.05 ? 'para girişi' : cmf <= -0.05 ? 'para çıkışı' : 'dengede') : '' },
    { label: 'Birikim/dağıtım çizgisi', value: ADL_TXT[ind.adlTrend] || '—', fmt: 'text', tone: ind.adlTrend === 'accumulation' ? 'up' : ind.adlTrend === 'distribution' ? 'down' : null },
    { label: 'VWAP (20g)', value: vwap, fmt: 'price', sub: isNum(vwap) ? pctDiff(close, vwap) : null, subFmt: 'pct', tone: isNum(vwap) ? tone(close >= vwap) : null },
    { label: 'Hacim profili POC (50g)', value: num(vp.poc), fmt: 'price', note: isNum(vp.valueAreaLow) && isNum(vp.valueAreaHigh) ? `değer alanı ${vp.valueAreaLow.toFixed(2)} – ${vp.valueAreaHigh.toFixed(2)}` : '' },
  ];

  const sr = Array.isArray(ind.sr) ? ind.sr : [];
  const supports = sr.filter(l => l.price < close).sort((a, b) => b.price - a.price).slice(0, 2);
  const resists = sr.filter(l => l.price > close).sort((a, b) => a.price - b.price).slice(0, 2);
  const rg = range52w(prices);
  const levels = [
    ...resists.reverse().map((l, i) => ({ label: `Direnç ${resists.length - i}`, value: l.price, fmt: 'price', sub: pctDiff(l.price, close), subFmt: 'pct', note: `${l.count} kez test` })),
    ...supports.map((l, i) => ({ label: `Destek ${i + 1}`, value: l.price, fmt: 'price', sub: pctDiff(l.price, close), subFmt: 'pct', note: `${l.count} kez test` })),
    ...(pv ? [
      { label: 'Pivot (klasik)', value: pv.pp, fmt: 'price', note: 'son tamamlanan seanstan' },
      { label: 'R1 / R2', value: pv.r1, fmt: 'price', sub: pv.r2, subFmt: 'price' },
      { label: 'S1 / S2', value: pv.s1, fmt: 'price', sub: pv.s2, subFmt: 'price' },
    ] : []),
    ...(fib ? [
      { label: 'Fibonacci %38,2 / %61,8', value: fib['0.382'], fmt: 'price', sub: fib['0.618'], subFmt: 'price', note: `60 günlük ${fib.trend === 'up' ? 'yükseliş' : 'düşüş'} dalgası` },
    ] : []),
    ...(rg ? [
      { label: '52 hafta en yüksek', value: rg.high, fmt: 'price', sub: rg.fromHigh, subFmt: 'pct' },
      { label: '52 hafta en düşük', value: rg.low, fmt: 'price', sub: rg.fromLow, subFmt: 'pct' },
    ] : []),
  ];

  const DIV_TXT = { bullish: 'pozitif uyumsuzluk', bearish: 'negatif uyumsuzluk', bullish_div: 'pozitif uyumsuzluk', bearish_div: 'negatif uyumsuzluk', hidden_bullish: 'gizli pozitif uyumsuzluk', hidden_bearish: 'gizli negatif uyumsuzluk' };
  const patterns = [
    ...(Array.isArray(ind.candlePatterns) ? ind.candlePatterns : []).map(p => ({
      label: p.desc || p.name, value: p.type === 'bullish' ? 'pozitif' : p.type === 'bearish' ? 'negatif' : 'nötr', fmt: 'text',
      tone: p.type === 'bullish' ? 'up' : p.type === 'bearish' ? 'down' : null, note: 'son mum',
    })),
    ...(ind.rsiDivergence ? [{ label: 'RSI', value: DIV_TXT[ind.rsiDivergence] || ind.rsiDivergence, fmt: 'text', tone: String(ind.rsiDivergence).includes('bull') ? 'up' : 'down', note: 'son 20 bar' }] : []),
    ...(ind.obvDivergence ? [{ label: 'OBV', value: DIV_TXT[ind.obvDivergence] || ind.obvDivergence, fmt: 'text', tone: String(ind.obvDivergence).includes('bull') ? 'up' : 'down', note: 'son 15 bar' }] : []),
  ];

  const groups = [
    { id: 'ma', title: 'Hareketli ortalamalar', rows: ma },
    { id: 'momentum', title: 'Momentum', rows: momentum },
    { id: 'trend', title: 'Trend gücü', rows: trend },
    { id: 'volatility', title: 'Oynaklık', rows: volatility },
    { id: 'volume', title: 'Hacim ve para akışı', rows: volume },
    { id: 'levels', title: 'Seviyeler', rows: levels },
    { id: 'patterns', title: 'Formasyon ve uyumsuzluk', rows: patterns.length ? patterns : [{ label: 'Son mumda formasyon yok', value: '—', fmt: 'text' }] },
  ];
  return { groups, returns: computeReturns(prices, bench), range: rg };
}
