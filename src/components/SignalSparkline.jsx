// SignalSparkline.jsx — Native-SVG sparkline of recent signal outcomes. Zero deps.

export default function SignalSparkline({
  signals = [],
  width = 120,
  height = 28,
  limit = 10,
  showLabel = true,
}) {
  const items = (Array.isArray(signals) ? signals : [])
    .filter(s => s && (s.return1d != null || s.return3d != null || s.return5d != null || s.pnlPct != null || s.outcome))
    .slice(-limit);

  if (!items.length) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--t2, #64748b)' }}>
        <svg width={width} height={height} style={{ opacity: 0.25 }}>
          <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="currentColor" strokeWidth="1" strokeDasharray="2,3" />
        </svg>
        {showLabel && <span>—</span>}
      </div>
    );
  }

  const pick = s => Number(
    s.pnlPct != null ? s.pnlPct
    : s.return5d != null ? s.return5d
    : s.return3d != null ? s.return3d
    : s.return1d != null ? s.return1d
    : 0
  );

  const values = items.map(pick);
  const maxAbs = Math.max(5, ...values.map(v => Math.abs(v) || 0));
  const pad = 2;
  const stepX = items.length > 1 ? (width - pad * 2) / (items.length - 1) : 0;
  const midY = height / 2;
  const scale = (midY - pad) / maxAbs;

  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = midY - v * scale;
    return [x, y];
  });

  const linePath = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const areaPath = `${linePath} L ${pts[pts.length - 1][0].toFixed(1)} ${midY} L ${pts[0][0].toFixed(1)} ${midY} Z`;

  const wins = values.filter(v => v > 0).length;
  const winRate = Math.round((wins / values.length) * 100);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const trendColor = avg >= 0 ? '#22c55e' : '#ef4444';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--t1, #e2e8f0)' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(148,163,184,0.25)" strokeWidth="1" strokeDasharray="2,3" />
        <path d={areaPath} fill={trendColor} fillOpacity="0.14" />
        <path d={linePath} fill="none" stroke={trendColor} strokeWidth="1.4" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={values[i] === 0 ? 1.2 : 1.8}
            fill={values[i] > 0 ? '#22c55e' : values[i] < 0 ? '#ef4444' : '#94a3b8'} />
        ))}
      </svg>
      {showLabel && (
        <span style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
          <span style={{ color: trendColor }}>{avg >= 0 ? '+' : ''}{avg.toFixed(1)}%</span>
          <span style={{ color: 'var(--t2, #64748b)', marginLeft: 4 }}>({winRate}%)</span>
        </span>
      )}
    </div>
  );
}
