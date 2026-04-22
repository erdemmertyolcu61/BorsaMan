// SignalBadge.jsx — Unified action badge. High-contrast, zero-lag (pure CSS, no animation on update).

const MAP = {
  strong_buy:  { label: 'GUCLU AL',  bg: '#065f46', fg: '#d1fae5', bd: '#10b981', dot: '#34d399' },
  buy:         { label: 'AL',        bg: '#059669', fg: '#ecfdf5', bd: '#10b981', dot: '#6ee7b7' },
  hold:        { label: 'TUT',       bg: '#374151', fg: '#e5e7eb', bd: '#6b7280', dot: '#9ca3af' },
  weak_hold:   { label: 'TUT',       bg: '#78350f', fg: '#fef3c7', bd: '#f59e0b', dot: '#fbbf24' },
  sell:        { label: 'SAT',       bg: '#b91c1c', fg: '#fee2e2', bd: '#ef4444', dot: '#fca5a5' },
  strong_sell: { label: 'GUCLU SAT', bg: '#7f1d1d', fg: '#fecaca', bd: '#dc2626', dot: '#f87171' },
  neutral:     { label: 'NOTR',      bg: '#1f2937', fg: '#94a3b8', bd: '#374151', dot: '#64748b' },
};

function _normalize(input) {
  const raw = String(input || '').toLowerCase().trim();
  if (!raw) return 'neutral';
  if (/guclu\s*al|strong\s*buy|very\s*bullish/.test(raw)) return 'strong_buy';
  if (/guclu\s*sat|strong\s*sell|very\s*bearish/.test(raw)) return 'strong_sell';
  if (/\bal\b|buy|bullish/.test(raw)) return 'buy';
  if (/\bsat\b|sell|bearish/.test(raw)) return 'sell';
  if (/zayif|weak|low.edge|dusuk/.test(raw)) return 'weak_hold';
  if (/tut|hold|notr|neutral/.test(raw)) return 'hold';
  return 'neutral';
}

export default function SignalBadge({
  signal,
  size = 'md',          // 'sm' | 'md' | 'lg'
  showDot = true,
  score,                // optional 0-10
  className = '',
  title,
}) {
  const key = _normalize(signal);
  const cfg = MAP[key] || MAP.neutral;
  const pad = size === 'sm' ? '2px 6px' : size === 'lg' ? '5px 12px' : '3px 9px';
  const fs = size === 'sm' ? 10 : size === 'lg' ? 13 : 11;

  return (
    <span
      className={`sig-badge sig-${key} ${className}`}
      title={title || cfg.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: pad,
        background: cfg.bg,
        color: cfg.fg,
        border: `1px solid ${cfg.bd}`,
        borderRadius: 4,
        fontSize: fs,
        fontWeight: 700,
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: 0.3,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {showDot && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: cfg.dot,
          boxShadow: `0 0 6px ${cfg.dot}`,
        }} />
      )}
      {cfg.label}
      {score != null && Number.isFinite(score) && (
        <span style={{ opacity: 0.75, fontWeight: 500, marginLeft: 2 }}>
          {Number(score).toFixed(1)}
        </span>
      )}
    </span>
  );
}
