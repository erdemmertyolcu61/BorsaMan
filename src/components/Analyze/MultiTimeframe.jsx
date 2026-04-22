import { useState, useCallback } from 'react';
import { fetchSingle } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal } from '../../utils/signals.js';

const TIMEFRAMES = [
  { key: 'weekly', label: 'Haftalik', range: '2y', interval: '1wk' },
  { key: 'daily', label: 'Gunluk', range: '6mo', interval: '1d' },
  { key: 'h4', label: '4 Saat', range: '1mo', interval: '1h' },
  { key: 'h1', label: '1 Saat', range: '5d', interval: '1h' },
];

function trendArrow(t) {
  if (t === 'up') return { icon: '▲', color: 'var(--green)' };
  if (t === 'down') return { icon: '▼', color: 'var(--red)' };
  return { icon: '─', color: 'var(--yellow)' };
}

function signalBadge(cls) {
  if (cls === 'buy') return { bg: 'rgba(0,230,118,0.15)', color: 'var(--green)', border: 'var(--green)' };
  if (cls === 'sell') return { bg: 'rgba(255,23,68,0.15)', color: 'var(--red)', border: 'var(--red)' };
  return { bg: 'rgba(255,214,0,0.1)', color: 'var(--yellow)', border: 'var(--yellow)' };
}

function aggregate4H(prices) {
  if (!prices || prices.length < 4) return prices;
  const out = [];
  for (let i = 0; i < prices.length; i += 4) {
    const chunk = prices.slice(i, i + 4);
    if (chunk.length === 0) continue;
    out.push({
      date: chunk[0].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, c) => a + (c.volume || 0), 0),
    });
  }
  return out;
}

export default function MultiTimeframe({ symbol }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const scan = useCallback(async () => {
    if (!symbol || loading) return;
    setLoading(true);
    const tfs = {};
    for (const tf of TIMEFRAMES) {
      try {
        const r = await fetchSingle(symbol, tf.range, tf.interval, true);
        if (!r || r.prices.length < 15) {
          tfs[tf.key] = null;
          continue;
        }
        let prices = r.prices;
        if (tf.key === 'h4') prices = aggregate4H(r.prices);
        const ind = calcAll(prices);
        const sig = genSignal(ind, prices);
        let trend = 'neutral';
        if (ind.lastClose > (ind.lastMA20 || 0) && ind.lastClose > (ind.lastMA50 || 0)) trend = 'up';
        else if (ind.lastClose < (ind.lastMA20 || Infinity) && ind.lastClose < (ind.lastMA50 || Infinity)) trend = 'down';
        const maAligned =
          ind.lastMA20 && ind.lastMA50 && ind.lastMA100
            ? ind.lastMA20 > ind.lastMA50 && ind.lastMA50 > ind.lastMA100
              ? 'bullish'
              : ind.lastMA20 < ind.lastMA50 && ind.lastMA50 < ind.lastMA100
                ? 'bearish'
                : 'mixed'
            : 'unknown';
        const macdHist = ind.macd?.histogram?.length > 0
          ? ind.macd.histogram[ind.macd.histogram.length - 1]
          : null;
        tfs[tf.key] = {
          signal: sig.signal,
          cls: sig.cls,
          score: sig.score,
          trend,
          rsi: ind.lastRSI,
          macd: macdHist,
          maAligned,
          adx: ind.adx,
          volRatio: ind.volRatio,
          obvTrend: ind.obvTrend,
        };
      } catch {
        tfs[tf.key] = null;
      }
    }
    const valid = Object.values(tfs).filter(Boolean);
    const buyCount = valid.filter(v => v.cls === 'buy').length;
    const sellCount = valid.filter(v => v.cls === 'sell').length;
    const upTrends = valid.filter(v => v.trend === 'up').length;
    let confluence = 'KARISIK';
    let confColor = 'var(--yellow)';
    if (buyCount >= 3 && upTrends >= 3) { confluence = 'GUCLU YUKSELIS'; confColor = 'var(--green)'; }
    else if (buyCount >= 2 && upTrends >= 2) { confluence = 'YUKSELIS'; confColor = 'var(--green)'; }
    else if (sellCount >= 3) { confluence = 'GUCLU DUSUS'; confColor = 'var(--red)'; }
    else if (sellCount >= 2) { confluence = 'DUSUS'; confColor = 'var(--red)'; }
    setData({ timeframes: tfs, confluence, confColor, buyCount, sellCount, upTrends });
    setLoading(false);
  }, [symbol, loading]);

  if (!symbol) return null;

  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', background: 'rgba(171,71,188,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--purple)' }}>
            Multi-Timeframe Analiz
          </span>
          {data && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: data.confColor,
              padding: '2px 8px',
              background: 'rgba(0,0,0,0.2)', borderRadius: 3,
            }}>
              {data.confluence}
            </span>
          )}
        </div>
        <button
          onClick={scan}
          disabled={loading}
          style={{
            background: loading ? 'var(--bg3)' : 'linear-gradient(135deg, var(--purple), var(--cyan))',
            color: '#fff', border: 'none', borderRadius: 4,
            padding: '4px 12px', fontSize: 10,
            cursor: loading ? 'default' : 'pointer',
            fontFamily: 'inherit', fontWeight: 600,
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? 'TARANIYOR...' : 'TARA'}
        </button>
      </div>

      {data && (
        <div style={{ padding: '8px 12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {TIMEFRAMES.map(tf => {
              const v = data.timeframes[tf.key];
              if (!v) {
                return (
                  <div key={tf.key} style={{
                    background: 'var(--bg3)', borderRadius: 5, padding: 8,
                    textAlign: 'center', opacity: 0.4,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)' }}>{tf.label}</div>
                    <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 4 }}>Veri Yok</div>
                  </div>
                );
              }
              const arrow = trendArrow(v.trend);
              const badge = signalBadge(v.cls);
              return (
                <div key={tf.key} style={{
                  background: 'var(--bg3)', borderRadius: 5, padding: 8,
                  borderTop: `2px solid ${badge.border}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t1)' }}>{tf.label}</span>
                    <span style={{ fontSize: 14, color: arrow.color }}>{arrow.icon}</span>
                  </div>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    padding: '3px 6px', borderRadius: 3, textAlign: 'center',
                    background: badge.bg, color: badge.color, marginBottom: 4,
                  }}>
                    {v.signal} ({v.score > 0 ? '+' : ''}{v.score.toFixed(1)})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, fontSize: 9 }}>
                    <span style={{ color: 'var(--t3)' }}>RSI</span>
                    <span style={{
                      textAlign: 'right', fontWeight: 600,
                      color: v.rsi > 70 ? 'var(--red)' : v.rsi < 30 ? 'var(--green)' : 'var(--t2)',
                    }}>
                      {v.rsi ? v.rsi.toFixed(0) : '-'}
                    </span>
                    <span style={{ color: 'var(--t3)' }}>MACD</span>
                    <span style={{
                      textAlign: 'right', fontWeight: 600,
                      color: v.macd > 0 ? 'var(--green)' : v.macd < 0 ? 'var(--red)' : 'var(--t2)',
                    }}>
                      {v.macd != null ? (v.macd > 0 ? '+' : '') + v.macd.toFixed(2) : '-'}
                    </span>
                    <span style={{ color: 'var(--t3)' }}>ADX</span>
                    <span style={{ textAlign: 'right', color: v.adx > 25 ? 'var(--cyan)' : 'var(--t3)' }}>
                      {v.adx ? v.adx.toFixed(0) : '-'}
                    </span>
                    <span style={{ color: 'var(--t3)' }}>MA</span>
                    <span style={{
                      textAlign: 'right', fontSize: 8,
                      color: v.maAligned === 'bullish' ? 'var(--green)'
                        : v.maAligned === 'bearish' ? 'var(--red)' : 'var(--t3)',
                    }}>
                      {v.maAligned === 'bullish' ? 'YUKARI' : v.maAligned === 'bearish' ? 'ASAGI' : 'KARISIK'}
                    </span>
                    <span style={{ color: 'var(--t3)' }}>Hacim</span>
                    <span style={{ textAlign: 'right', color: v.volRatio > 1.5 ? 'var(--cyan)' : 'var(--t3)' }}>
                      {v.volRatio ? v.volRatio.toFixed(1) + 'x' : '-'}
                    </span>
                    <span style={{ color: 'var(--t3)' }}>OBV</span>
                    <span style={{
                      textAlign: 'right', fontSize: 8,
                      color: v.obvTrend === 'accumulation' ? 'var(--green)'
                        : v.obvTrend === 'distribution' ? 'var(--red)' : 'var(--t3)',
                    }}>
                      {v.obvTrend === 'accumulation' ? 'BIRIKM'
                        : v.obvTrend === 'distribution' ? 'DAGIL' : 'NOTR'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{
            marginTop: 8, display: 'flex', gap: 8, fontSize: 9,
            alignItems: 'center', flexWrap: 'wrap',
          }}>
            <span style={{ color: 'var(--green)' }}>{data.buyCount}/4 AL</span>
            <span style={{ color: 'var(--red)' }}>{data.sellCount}/4 SAT</span>
            <span style={{ color: 'var(--cyan)' }}>{data.upTrends}/4 Yukselis</span>
            <span style={{ color: 'var(--t3)', marginLeft: 'auto', fontSize: 8 }}>
              Tum zaman dilimlerinde uyum = Guclu sinyal
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
