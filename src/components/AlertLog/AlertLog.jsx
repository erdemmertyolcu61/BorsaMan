import { useState, useMemo, useCallback } from 'react';

/**
 * AlertLog - Collapsible alert log + 24h summary button
 * Sources: live_guard, watchlist, advisor, signal_tracker, manual
 */
export default function AlertLog({ alertLog, onAnalyze, advisor, livePrice, portfolio }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [filter, setFilter] = useState('all');

  const alerts = alertLog?.alerts || [];

  // Filter alerts by source
  const visibleAlerts = useMemo(() => {
    if (filter === 'all') return alerts;
    return alerts.filter(a => (a.source || 'manual') === filter);
  }, [alerts, filter]);

  const sourceColors = {
    live_guard: 'var(--orange)',
    watchlist: 'var(--cyan)',
    advisor: 'var(--blue)',
    signal_tracker: 'var(--purple)',
    manual: 'var(--t3)',
  };

  const typeColors = {
    critical: 'var(--red)',
    error: 'var(--red)',
    warn: 'var(--yellow)',
    success: 'var(--green)',
    info: 'var(--cyan)',
  };

  // ── 24h Summary ──
  const build24hSummary = useCallback(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = alerts.filter(a => new Date(a.timestamp).getTime() >= cutoff);
    const critical = recent.filter(a => a.type === 'critical' || a.type === 'error');
    const bySource = {};
    for (const a of recent) {
      const src = a.source || 'manual';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    const openPositions = portfolio?.positions?.filter(p => p.status === 'open') || [];
    const totalValue = openPositions.reduce((s, p) => s + ((p.entryPrice || 0) * (p.quantity || 0)), 0);

    const ms = advisor?.marketSentiment;
    const topPicks = advisor?.topPicks?.slice(0, 5) || [];
    const riskAlerts = advisor?.riskAlerts || [];

    setSummary({
      generatedAt: new Date(),
      totalAlerts: recent.length,
      criticalCount: critical.length,
      bySource,
      marketContext: ms ? {
        sentiment: ms.sentiment,
        buys: ms.buys, sells: ms.sells, scanned: ms.scanned,
        avgRSI: ms.avgRSI,
        topSectors: ms.sectorRotation?.slice(0, 3) || [],
      } : null,
      portfolio: {
        openCount: openPositions.length,
        totalValue,
        cash: portfolio?.cash || 0,
      },
      criticalSignals: critical.slice(0, 5),
      riskAlerts: riskAlerts.slice(0, 5),
      topPicks: topPicks.map(p => ({ symbol: p.symbol, score: p.score, signal: p.signal })),
    });
  }, [alerts, advisor, portfolio]);

  const fmtTime = (ts) => {
    try { return new Date(ts).toLocaleTimeString('tr-TR'); } catch { return ''; }
  };

  const uniqueSources = Array.from(new Set(alerts.map(a => a.source || 'manual')));

  return (
    <div className="alert-log" style={{
      position: 'fixed', bottom: 32, right: 16, zIndex: 950,
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
      width: open ? 420 : 180, maxHeight: open ? 480 : 36,
      overflow: 'hidden', transition: 'width 0.25s, max-height 0.25s',
      fontSize: 11,
    }}>
      {/* Header */}
      <div onClick={() => setOpen(o => !o)} style={{
        padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg3)', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontWeight: 700, color: 'var(--yellow)', fontSize: 11 }}>
          Uyarilar ({alerts.length})
        </span>
        <span style={{ color: 'var(--t3)', fontSize: 10 }}>{open ? '▼' : '▲'}</span>
      </div>

      {open && (
        <div style={{ padding: 8, maxHeight: 440, overflowY: 'auto' }}>
          {/* Controls */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={build24hSummary} style={{
              padding: '4px 10px', fontSize: 10, fontWeight: 600,
              background: 'linear-gradient(135deg, var(--cyan), var(--blue))',
              color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>24s Ozet</button>
            <button onClick={() => alertLog?.clearAlerts?.()} style={{
              padding: '4px 8px', fontSize: 10,
              background: 'var(--bg3)', color: 'var(--t2)',
              border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>Temizle</button>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{
              padding: '3px 6px', fontSize: 10,
              background: 'var(--bg3)', color: 'var(--t1)',
              border: '1px solid var(--border)', borderRadius: 3,
              fontFamily: 'inherit',
            }}>
              <option value="all">Tumu</option>
              {uniqueSources.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Summary Panel */}
          {summary && (
            <div style={{
              background: 'var(--bg1)', padding: 10, borderRadius: 5,
              marginBottom: 10, borderLeft: '3px solid var(--cyan)', fontSize: 10, lineHeight: 1.5,
            }}>
              <div style={{ fontWeight: 700, color: 'var(--cyan)', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                <span>Son 24 Saat Ozeti</span>
                <button onClick={() => setSummary(null)} style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 11 }}>×</button>
              </div>
              <div>Toplam: <b>{summary.totalAlerts}</b> uyari ({summary.criticalCount} kritik)</div>
              {Object.keys(summary.bySource).length > 0 && (
                <div style={{ color: 'var(--t3)', fontSize: 9 }}>
                  {Object.entries(summary.bySource).map(([src, c]) => `${src}:${c}`).join(' | ')}
                </div>
              )}
              {summary.marketContext && (
                <div style={{ marginTop: 5 }}>
                  <b style={{ color: 'var(--purple)' }}>Piyasa:</b> {summary.marketContext.sentiment} (AL:{summary.marketContext.buys} SAT:{summary.marketContext.sells}) RSI {summary.marketContext.avgRSI?.toFixed(0)}
                  {summary.marketContext.topSectors.length > 0 && (
                    <div style={{ fontSize: 9, color: 'var(--t3)' }}>Sektor: {summary.marketContext.topSectors.map(s => s.sector).join(', ')}</div>
                  )}
                </div>
              )}
              <div style={{ marginTop: 5 }}>
                <b style={{ color: 'var(--yellow)' }}>Portfoy:</b> {summary.portfolio.openCount} acik pozisyon
                {summary.portfolio.totalValue > 0 && <span> | Deger {summary.portfolio.totalValue.toFixed(0)} TL</span>}
              </div>
              {summary.topPicks.length > 0 && (
                <div style={{ marginTop: 5 }}>
                  <b style={{ color: 'var(--green)' }}>Top Firsat:</b>{' '}
                  {summary.topPicks.map(p => (
                    <span key={p.symbol} onClick={() => onAnalyze && onAnalyze(p.symbol)} style={{ cursor: 'pointer', color: 'var(--green)', marginRight: 6 }}>
                      {p.symbol}({p.score?.toFixed(1)})
                    </span>
                  ))}
                </div>
              )}
              {summary.riskAlerts.length > 0 && (
                <div style={{ marginTop: 5, color: 'var(--orange)' }}>
                  <b>Risk:</b> {summary.riskAlerts.map(r => r.msg).join(' | ')}
                </div>
              )}
              {summary.criticalSignals.length > 0 && (
                <div style={{ marginTop: 5 }}>
                  <b style={{ color: 'var(--red)' }}>Kritik:</b>
                  {summary.criticalSignals.map((c, i) => (
                    <div key={i} style={{ fontSize: 9, color: 'var(--t2)' }}>- {c.message}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Alerts List */}
          {visibleAlerts.length === 0 ? (
            <div style={{ color: 'var(--t3)', textAlign: 'center', padding: 12, fontSize: 10 }}>
              Uyari yok
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {visibleAlerts.slice(0, 50).map((a) => (
                <div key={a.id} onClick={() => a.symbol && onAnalyze && onAnalyze(a.symbol)} style={{
                  padding: '5px 7px',
                  borderRadius: 3,
                  background: 'var(--bg1)',
                  borderLeft: `3px solid ${typeColors[a.type] || 'var(--t3)'}`,
                  cursor: a.symbol ? 'pointer' : 'default',
                  display: 'flex', justifyContent: 'space-between', gap: 6,
                }}>
                  <div style={{ flex: 1, fontSize: 10 }}>
                    <span style={{ color: typeColors[a.type] || 'var(--t2)', fontWeight: 600 }}>{a.message}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontSize: 8 }}>
                    <span style={{ color: 'var(--t3)' }}>{fmtTime(a.timestamp)}</span>
                    <span style={{ color: sourceColors[a.source] || 'var(--t3)', fontWeight: 500 }}>
                      {a.source || 'manual'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
