/**
 * QuarterChart — tek seri, çeyrek başına bir sütun (v31.50).
 *
 * dataviz kuralları: tek renk (--blue, koyu yüzeyde doğrulandı), ≤24 px sütun,
 * veri ucunda 4 px yuvarlak / taban kare, kıl çizgisi ızgara, yalnız son değer
 * etiketli, her sütun kendi üzerine gelme/odak ipucunu taşır. Negatif değer
 * sıfır çizgisinin altına iner — işaret konumla okunur, ikinci renk yok.
 * Grafiğin tablo karşılığı hemen altındaki çeyreklik tablodur.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtAxis, fmtBig, fmtPct } from './fmt.js';

const PLOT_H = 170;
const AXIS_H = 22;
const TOP = 18;
const LEFT = 46;
const RIGHT = 8;

function niceStep(range, target = 4) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  return step * mag;
}

/** Yalnız veri ucu yuvarlak sütun yolu. */
function barPath(x, y0, y1, w, r) {
  const up = y1 < y0;                      // pozitif değer yukarı
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, h, w / 2);
  if (h < 0.5) return '';
  if (up) {
    return `M${x},${y0} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + w - rr} Q${x + w},${y1} ${x + w},${y1 + rr} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - rr} Q${x},${y1} ${x + rr},${y1} H${x + w - rr} Q${x + w},${y1} ${x + w},${y1 - rr} V${y0} Z`;
}

function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setW(el.getBoundingClientRect().width || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * @param {{points: Array<{label: string, name: string, value: number|null, yoy?: number|null}>, title: string}} props
 *   points kronolojik (eskiden yeniye)
 */
export default function QuarterChart({ points, title, valueFormat = (v) => fmtBig(v, { unit: 'TL' }) }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  const [hover, setHover] = useState(null);

  const vals = points.map(p => p.value).filter(v => typeof v === 'number' && Number.isFinite(v));
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const n = points.length;

  let ticks = [];
  let yOf = () => TOP;
  if (vals.length) {
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const step = niceStep((hi - lo) || Math.abs(hi) || 1);
    const yMin = Math.floor(lo / step) * step;
    const yMax = Math.ceil(hi / step) * step || step;
    for (let t = yMin; t <= yMax + step / 2; t += step) ticks.push(t);
    yOf = (v) => TOP + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;
  }
  const slot = n ? plotW / n : 0;
  const barW = Math.max(4, Math.min(24, slot - 6));
  const labelEvery = slot >= 38 ? 1 : slot >= 19 ? 2 : 4;
  const zeroY = yOf(0);
  const lastIdx = (() => { for (let i = n - 1; i >= 0; i--) if (points[i].value != null) return i; return -1; })();

  const tip = hover != null ? points[hover] : null;
  const tipX = hover != null ? LEFT + slot * hover + slot / 2 : 0;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 6 }}>{title}</div>
      <div ref={wrapRef} style={{ width: '100%', height: TOP + PLOT_H + AXIS_H }}>
        {width > 0 && vals.length > 0 && (
          <svg width={width} height={TOP + PLOT_H + AXIS_H} role="img" aria-label={title}
            style={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}>
            {ticks.map(t => (
              <g key={t}>
                <line x1={LEFT} x2={width - RIGHT} y1={yOf(t)} y2={yOf(t)}
                  stroke={t === 0 ? 'var(--border2)' : 'var(--border)'} strokeWidth="1" />
                <text x={LEFT - 6} y={yOf(t) + 4} textAnchor="end" fontSize="10" fill="var(--t3)">{fmtAxis(t)}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const x = LEFT + slot * i + (slot - barW) / 2;
              const has = p.value != null;
              return (
                <g key={p.label}>
                  {has && (
                    <path d={barPath(x, zeroY, yOf(p.value), barW, 4)} fill="var(--blue)"
                      opacity={hover == null || hover === i ? 1 : 0.55} />
                  )}
                  {i % labelEvery === (n - 1) % labelEvery && (
                    <text x={LEFT + slot * i + slot / 2} y={TOP + PLOT_H + 15} textAnchor="middle" fontSize="10" fill="var(--t3)">{p.name}</text>
                  )}
                  <rect x={LEFT + slot * i} y={TOP - 10} width={slot} height={PLOT_H + 10} fill="transparent"
                    tabIndex={has ? 0 : -1} aria-label={`${p.name}: ${has ? valueFormat(p.value) : 'veri yok'}`}
                    onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    style={{ outline: 'none', cursor: has ? 'default' : 'auto' }} />
                </g>
              );
            })}
            {lastIdx >= 0 && hover == null && (
              <text x={LEFT + slot * lastIdx + slot / 2}
                y={points[lastIdx].value >= 0 ? yOf(points[lastIdx].value) - 6 : yOf(points[lastIdx].value) + 13}
                textAnchor={lastIdx === n - 1 ? 'end' : 'middle'} dx={lastIdx === n - 1 ? slot / 2 - 2 : 0}
                fontSize="11" fontWeight="600" fill="var(--t1)">{fmtAxis(points[lastIdx].value)}</text>
            )}
          </svg>
        )}
        {width > 0 && !vals.length && (
          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '40px 0', textAlign: 'center' }}>Bu kalem için veri yok.</div>
        )}
      </div>
      {tip && (
        <div style={{
          position: 'absolute', top: 22, left: Math.min(Math.max(tipX - 70, 0), Math.max(0, width - 150)),
          width: 150, pointerEvents: 'none', background: 'var(--bg4)', border: '1px solid var(--border2)',
          borderRadius: 8, padding: '6px 9px', fontSize: 11, lineHeight: 1.45,
        }}>
          <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 13 }}>{tip.value != null ? valueFormat(tip.value) : 'veri yok'}</div>
          <div style={{ color: 'var(--t2)' }}>{tip.name}</div>
          {tip.yoy != null && <div style={{ color: 'var(--t3)' }}>Yıllık {fmtPct(tip.yoy, { signed: true })}</div>}
        </div>
      )}
    </div>
  );
}
