// ExpandableStockCard.jsx — Collapsed header + accordion deep-dive.
// Header: symbol · price · signal badge · edge score · expand toggle
// Body (collapsed by default): mini-grid of technicals + free-text notes.

import { useState } from 'react';
import SignalBadge from './SignalBadge.jsx';

function MiniStat({ label, value, tone = 'neutral', mono = true }) {
  const color =
    tone === 'up' ? '#34d399' :
    tone === 'down' ? '#f87171' :
    tone === 'warn' ? '#fbbf24' : '#e2e8f0';
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(148,163,184,0.15)',
      borderRadius: 5,
      padding: '6px 8px',
      display: 'flex', flexDirection: 'column', gap: 2,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{
        fontSize: 12, fontWeight: 700, color,
        fontFamily: mono ? 'JetBrains Mono, monospace' : 'inherit',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value ?? '—'}
      </div>
    </div>
  );
}

export default function ExpandableStockCard({
  symbol,
  price,
  change,          // % change
  signal,          // 'buy'|'sell'|'hold'|...
  score,           // 0-10 edge
  stats = {},      // { rsi, adx, mfi, vwap, atr, setupGrade, support, resistance, volume }
  notes = [],      // array of { label, text, tone } or strings
  defaultOpen = false,
  onClick,
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const up = (change ?? 0) >= 0;
  const chColor = up ? '#34d399' : '#f87171';

  const entries = Object.entries(stats).filter(([, v]) => v != null && v !== '');

  return (
    <div style={{
      background: 'var(--bg2, #0f172a)',
      border: '1px solid rgba(148,163,184,0.18)',
      borderRadius: 7,
      overflow: 'hidden',
      fontFamily: 'JetBrains Mono, monospace',
      transition: 'border-color 120ms',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(148,163,184,0.35)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(148,163,184,0.18)'}
    >
      {/* ── Header ── */}
      <div
        onClick={() => { onClick?.(symbol); setOpen(o => !o); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '9px 12px', cursor: 'pointer',
          background: open ? 'rgba(255,255,255,0.02)' : 'transparent',
        }}
      >
        <div style={{ flex: '0 0 auto', minWidth: 68 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5 }}>{symbol}</div>
        </div>

        <div style={{ flex: '0 0 auto', minWidth: 72, textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {price != null ? Number(price).toFixed(2) : '—'}
          </div>
          {change != null && (
            <div style={{ fontSize: 10, color: chColor, fontWeight: 600 }}>
              {up ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
            </div>
          )}
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <SignalBadge signal={signal} size="sm" score={score} />
        </div>

        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {score != null && (
            <div style={{
              fontSize: 10, color: '#cbd5e1', opacity: 0.7,
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.3)',
              padding: '2px 6px', borderRadius: 4,
            }}>
              EDGE {Number(score).toFixed(1)}
            </div>
          )}
          <span style={{
            fontSize: 11, color: '#94a3b8',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 180ms ease',
            display: 'inline-block',
          }}>▼</span>
        </div>
      </div>

      {/* ── Accordion body ── */}
      <div style={{
        maxHeight: open ? 600 : 0,
        overflow: 'hidden',
        transition: 'max-height 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        borderTop: open ? '1px solid rgba(148,163,184,0.12)' : 'none',
      }}>
        <div style={{ padding: '10px 12px' }}>
          {entries.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(82px, 1fr))',
              gap: 6,
              marginBottom: notes.length ? 10 : 0,
            }}>
              {entries.map(([k, v]) => {
                const label = String(k).toUpperCase();
                let tone = 'neutral';
                const num = Number(v);
                if (k === 'rsi' && Number.isFinite(num)) tone = num > 70 ? 'down' : num < 30 ? 'up' : 'neutral';
                if (k === 'adx' && Number.isFinite(num)) tone = num > 25 ? 'up' : num < 15 ? 'warn' : 'neutral';
                if (k === 'mfi' && Number.isFinite(num)) tone = num > 80 ? 'down' : num < 20 ? 'up' : 'neutral';
                if (k === 'setupGrade') {
                  const g = String(v).toUpperCase();
                  tone = g === 'A' ? 'up' : g === 'D' ? 'down' : g === 'C' ? 'warn' : 'neutral';
                }
                return <MiniStat key={k} label={label} value={v} tone={tone} />;
              })}
            </div>
          )}

          {notes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, lineHeight: 1.5 }}>
              {notes.map((n, i) => {
                const item = typeof n === 'string' ? { text: n } : n;
                const accent =
                  item.tone === 'up' ? '#34d399' :
                  item.tone === 'down' ? '#f87171' :
                  item.tone === 'warn' ? '#fbbf24' : '#64748b';
                return (
                  <div key={i} style={{
                    paddingLeft: 10,
                    borderLeft: `2px solid ${accent}`,
                    color: '#cbd5e1',
                  }}>
                    {item.label && <span style={{ color: accent, fontWeight: 700, marginRight: 6 }}>{item.label}:</span>}
                    {item.text}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
