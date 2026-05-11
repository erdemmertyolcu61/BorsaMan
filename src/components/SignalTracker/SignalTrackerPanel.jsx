import { useState, useMemo } from 'react';

/**
 * SignalTrackerPanel - 3-tab signal history with Win Rate / Reliability / Breakdown
 */

function DayChip({ value }) {
  if (value == null) return <span style={{ fontSize: 9, color: 'var(--t3)' }}>—</span>;
  const color = value > 0 ? 'var(--green)' : value < 0 ? 'var(--red)' : 'var(--t3)';
  return (
    <span style={{ fontSize: 9, color, fontWeight: 600 }}>
      {value > 0 ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

// v29: Anlık getiri + hedef-yolu birleşik göstergesi (signal hâlâ OPEN ise)
function LiveProgressChip({ currentReturn, targetProgress, outcome }) {
  if (outcome === 'TARGET_HIT' || outcome === 'STOP_HIT' || outcome === 'WIN' || outcome === 'LOSS') {
    return <span style={{ fontSize: 9, color: 'var(--t3)' }}>—</span>;
  }
  if (currentReturn == null) return <span style={{ fontSize: 9, color: 'var(--t3)' }}>—</span>;
  const color = currentReturn > 0 ? 'var(--green)' : currentReturn < 0 ? 'var(--red)' : 'var(--t3)';
  const pct = targetProgress;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: 9, color, fontWeight: 700 }}>
        {currentReturn > 0 ? '+' : ''}{currentReturn.toFixed(1)}%
      </span>
      {pct != null && (
        <div style={{ width: 38, height: 3, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}
             title={`Hedef yolunda %${pct.toFixed(0)}`}>
          <div style={{
            height: '100%',
            width: Math.max(0, Math.min(100, pct)) + '%',
            background: pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--cyan)' : pct >= 0 ? 'var(--yellow)' : 'var(--red)',
            transition: 'width 600ms ease',
          }} />
        </div>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }) {
  const map = {
    TARGET_HIT: { label: 'HEDEF', color: 'var(--green)' },
    STOP_HIT:   { label: 'STOP', color: 'var(--red)' },
    WIN:        { label: 'KAZANÇ', color: 'var(--green)' },
    LOSS:       { label: 'KAYIP', color: 'var(--red)' },
    OPEN:       { label: 'ACIK', color: 'var(--t3)' },
  };
  const o = map[outcome] || { label: '—', color: 'var(--t3)' };
  return (
    <span style={{
      fontSize: 8, color: o.color, fontWeight: 700,
      background: o.color + '22', padding: '1px 6px', borderRadius: 3,
    }}>{o.label}</span>
  );
}

export default function SignalTrackerPanel({ tracker, onAnalyze }) {
  const [tab, setTab] = useState('overview');
  const signals = tracker?.signals || [];
  const stats = tracker?.stats || {};

  const reliability = stats.reliability ?? 0;
  const winRate = stats.winRate ?? 0;

  const sortedSignals = useMemo(
    () => [...signals].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    [signals]
  );

  const reliabilityColor = reliability >= 70 ? 'var(--green)' : reliability >= 50 ? 'var(--yellow)' : 'var(--red)';
  const winRateColor = winRate >= 60 ? 'var(--green)' : winRate >= 45 ? 'var(--yellow)' : 'var(--red)';

  return (
    <div className="trade-box fi" style={{ marginTop: 14 }}>
      <div className="trade-title" style={{ color: 'var(--purple)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Sinyal Takibi ({signals.length})</span>
        {tracker?.clearHistory && (
          <button onClick={() => { if (window.confirm('Tum sinyal gecmisi silinsin mi?')) tracker.clearHistory(); }} style={{
            fontSize: 9, background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--t3)', padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
          }}>Sifirla</button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 10, borderBottom: '1px solid var(--border)' }}>
        {[
          { id: 'overview', label: 'Genel' },
          { id: 'signals', label: 'Sinyaller' },
          { id: 'breakdown', label: 'Dagilim' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 14px', fontSize: 10, fontWeight: 600,
            background: tab === t.id ? 'var(--bg3)' : 'transparent',
            color: tab === t.id ? 'var(--cyan)' : 'var(--t2)',
            border: 'none',
            borderBottom: tab === t.id ? '2px solid var(--cyan)' : '2px solid transparent',
            cursor: 'pointer', fontFamily: 'inherit',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && (
        <div style={{ fontSize: 11 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {/* Reliability gauge */}
            <div style={{ background: 'var(--bg2)', padding: 10, borderRadius: 5 }}>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4 }}>GUVENILIRLIK</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: reliabilityColor }}>{reliability}</div>
              <div style={{
                height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden', marginTop: 6,
              }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, reliability))}%`,
                  height: '100%', background: reliabilityColor, transition: 'width 0.3s',
                }} />
              </div>
              <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 4 }}>
                Win-rate, orneklem buyuklugu ve 5 gun getirisinden hesaplanir.
              </div>
            </div>

            {/* Win rate */}
            <div style={{ background: 'var(--bg2)', padding: 10, borderRadius: 5 }}>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4 }}>KAZANMA ORANI</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: winRateColor }}>%{winRate.toFixed(0)}</div>
              <div style={{ fontSize: 9, color: 'var(--t2)', marginTop: 6 }}>
                Kazanan: <b style={{ color: 'var(--green)' }}>{stats.wins || 0}</b>
                &nbsp; Kayip: <b style={{ color: 'var(--red)' }}>{stats.losses || 0}</b>
              </div>
              <div style={{ fontSize: 8, color: 'var(--t3)' }}>
                Kapali pozisyonlar: {stats.closed || 0}
              </div>
            </div>
          </div>

          {/* Avg returns */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
            {[
              { key: 'avgD1', label: '1G Ort.' },
              { key: 'avgD3', label: '3G Ort.' },
              { key: 'avgD5', label: '5G Ort.' },
            ].map(({ key, label }) => {
              const v = stats[key] || 0;
              const c = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t3)';
              return (
                <div key={key} style={{ background: 'var(--bg2)', padding: 8, borderRadius: 4, textAlign: 'center' }}>
                  <div style={{ fontSize: 8, color: 'var(--t3)' }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: c }}>
                    {v > 0 ? '+' : ''}{v.toFixed(1)}%
                  </div>
                </div>
              );
            })}
          </div>

          {/* Signal count */}
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 10, textAlign: 'center' }}>
            Toplam {signals.length} sinyal izlendi. Son guncelleme otomatik 10 dakikada bir.
          </div>
        </div>
      )}

      {/* Signals tab */}
      {tab === 'signals' && (
        <div style={{ fontSize: 10, maxHeight: 300, overflowY: 'auto' }}>
          {sortedSignals.length === 0 ? (
            <div style={{ color: 'var(--t3)', textAlign: 'center', padding: 20 }}>Sinyal yok</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--t3)', fontSize: 9 }}>
                  <th style={{ padding: '4px 6px', textAlign: 'left' }}>Sembol</th>
                  <th style={{ padding: '4px 6px', textAlign: 'left' }}>Sinyal</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }}>Skor</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center', color: 'var(--cyan)' }} title="Anlık getiri ve hedef-yolu yüzdesi (10dk'da bir güncellenir)">Anlık</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }}>1G</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }}>3G</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }}>5G</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {sortedSignals.slice(0, 40).map(s => (
                  <tr key={s.id} onClick={() => onAnalyze && onAnalyze(s.symbol)} style={{
                    cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  }}>
                    <td style={{ padding: '4px 6px', fontWeight: 600, color: 'var(--t1)' }}>{s.symbol}</td>
                    <td style={{ padding: '4px 6px', color: s.cls === 'buy' ? 'var(--green)' : s.cls === 'sell' ? 'var(--red)' : 'var(--t2)' }}>
                      {s.signal}
                    </td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}>{(s.score ?? 0).toFixed(1)}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                      <LiveProgressChip
                        currentReturn={s.currentReturn ?? s.dailyChange}
                        targetProgress={s.targetProgress}
                        outcome={s.outcome}
                      />
                    </td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d1} /></td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d3} /></td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d5} /></td>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}><OutcomeBadge outcome={s.outcome || 'OPEN'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Breakdown tab */}
      {tab === 'breakdown' && (
        <div style={{ fontSize: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--cyan)', fontWeight: 700, marginBottom: 6 }}>Kaynak Bazinda</div>
            {Object.keys(stats.bySource || {}).length === 0 ? (
              <div style={{ color: 'var(--t3)' }}>Veri yok</div>
            ) : (
              Object.entries(stats.bySource).map(([src, s]) => {
                const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
                return (
                  <div key={src} style={{ padding: '4px 6px', borderLeft: '2px solid var(--cyan)', marginBottom: 4, background: 'var(--bg2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{src}</span>
                      <span style={{ color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>{wr.toFixed(0)}%</span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--t3)' }}>{s.wins}/{s.total}</div>
                  </div>
                );
              })
            )}
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 700, marginBottom: 6 }}>Tur Bazinda</div>
            {Object.keys(stats.byClass || {}).length === 0 ? (
              <div style={{ color: 'var(--t3)' }}>Veri yok</div>
            ) : (
              Object.entries(stats.byClass).map(([cl, s]) => {
                const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
                return (
                  <div key={cl} style={{ padding: '4px 6px', borderLeft: '2px solid var(--purple)', marginBottom: 4, background: 'var(--bg2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{cl.toUpperCase()}</span>
                      <span style={{ color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>{wr.toFixed(0)}%</span>
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--t3)' }}>{s.wins}/{s.total}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
