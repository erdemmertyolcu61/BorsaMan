import { useState, useMemo } from 'react';

function StatCard({ label, value, color = 'var(--t1)', sub, subColor }) {
  return (
    <div style={{ background: 'var(--bg2)', padding: '8px 12px', borderRadius: 6, textAlign: 'center' }}>
      <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: subColor || 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DayChip({ value }) {
  if (value == null) return <span style={{ fontSize: 9, color: 'var(--t3)' }}>—</span>;
  const c = value > 0 ? 'var(--green)' : value < 0 ? 'var(--red)' : 'var(--t3)';
  return <span style={{ fontSize: 9, color: c, fontWeight: 600 }}>{value > 0 ? '+' : ''}{value.toFixed(1)}%</span>;
}

function OutcomeBadge({ outcome }) {
  const map = {
    TARGET_HIT: { label: 'HEDEF', color: 'var(--green)' },
    STOP_HIT: { label: 'STOP', color: 'var(--red)' },
    WIN: { label: 'KAZANÇ', color: 'var(--green)' },
    LOSS: { label: 'KAYIP', color: 'var(--red)' },
    OPEN: { label: 'AÇIK', color: 'var(--t3)' },
  };
  const o = map[outcome] || { label: '—', color: 'var(--t3)' };
  return (
    <span style={{
      fontSize: 8, color: o.color, fontWeight: 700,
      background: o.color + '22', padding: '1px 6px', borderRadius: 3,
    }}>
      {o.label}
    </span>
  );
}

export default function SignalsTab({ tracker, onAnalyze }) {
  // v29: default 'signals' (liste) — kullanicilar Sinyal Takibi'ni acinca taranan
  // hisseleri HEMEN gorsun. Onceki 'overview' sadece istatistik gosteriyordu, liste
  // gizli kaliyordu → "cekilen hisseler eklenmiyor" izlenimi.
  const [tab, setTab] = useState('signals');
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterSrc, setFilterSrc] = useState('all');
  const [sortField, setSortField] = useState('timestamp');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  const {
    signals,
    stats,
    recordSignal,
    updateSignal,
    removeSignal,
    clearHistory,
    filterSignals,
    exportCSV,
    importCSV,
  } = tracker || {}; // tracker App.jsx'ten daima gecilir; hook'u kosullu cagirmak
                     // rules-of-hooks ihlaliydi — defansif {} fallback yeterli.

  const reliability = parseInt(stats?.reliability || 0);
  const relColor = reliability >= 70 ? 'var(--green)' : reliability >= 50 ? 'var(--yellow)' : 'var(--red)';
  const winRate = parseFloat(stats?.winRate || 0);
  const wrColor = winRate >= 60 ? 'var(--green)' : winRate >= 45 ? 'var(--yellow)' : 'var(--red)';

  const filtered = useMemo(() => {
    const all = filterSignals ? filterSignals({}) : signals;
    return all
      .filter(s => {
        if (filterSymbol && !s.symbol.toLowerCase().includes(filterSymbol.toLowerCase())) return false;
        if (filterSrc !== 'all' && (s.source || 'manual') !== filterSrc) return false;
        return true;
      })
      .sort((a, b) => {
        let aVal, bVal;
        switch (sortField) {
          case 'timestamp':
            aVal = new Date(a.timestamp).getTime();
            bVal = new Date(b.timestamp).getTime();
            break;
          case 'score':
            aVal = a.score100 || a.score || 0;
            bVal = b.score100 || b.score || 0;
            break;
          case 'd1':
            aVal = a.perf?.d1 ?? -999;
            bVal = b.perf?.d1 ?? -999;
            break;
          case 'd3':
            aVal = a.perf?.d3 ?? -999;
            bVal = b.perf?.d3 ?? -999;
            break;
          case 'd5':
            aVal = a.perf?.d5 ?? -999;
            bVal = b.perf?.d5 ?? -999;
            break;
          case 'symbol':
            aVal = a.symbol;
            bVal = b.symbol;
            return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
          default:
            aVal = new Date(a.timestamp).getTime();
            bVal = new Date(b.timestamp).getTime();
        }
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      });
  }, [signals, filterSymbol, filterSrc, filterSignals, sortField, sortDir]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(0);
  };

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div style={{ padding: '0 16px 16px', fontSize: 11 }}>

      {/* Tabs + Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        <div style={{ display: 'flex', gap: 2 }}>
          {[
            { id: 'overview', label: 'Genel' },
            { id: 'signals', label: `Sinyaller (${signals.length})` },
            { id: 'breakdown', label: 'Kaynak' },
            { id: 'symbols', label: 'Hisse' },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '5px 12px', fontSize: 10, fontWeight: 600,
              background: tab === t.id ? 'var(--bg3)' : 'transparent',
              color: tab === t.id ? 'var(--cyan)' : 'var(--t2)',
              border: 'none', borderBottom: tab === t.id ? '2px solid var(--cyan)' : '2px solid transparent',
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={exportCSV} style={{
            fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)',
            color: 'var(--t2)', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            CSV İndir
          </button>
          <label style={{
            fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)',
            color: 'var(--t2)', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            CSV Yükle
            <input type="file" accept=".csv" style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = ev => {
                  const n = importCSV(ev.target.result);
                  if (n > 0) alert(`${n} sinyal yüklendi`);
                };
                reader.readAsText(f);
                e.target.value = '';
              }}
            />
          </label>
          <button onClick={() => { if (window.confirm('Tüm sinyal geçmişi silinsin mi?')) clearHistory(); }} style={{
            fontSize: 9, background: 'transparent', border: '1px solid var(--red)',
            color: 'var(--red)', padding: '3px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Sıfırla
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <input
          placeholder="Sembol ara..."
          value={filterSymbol}
          onChange={e => setFilterSymbol(e.target.value)}
          style={{
            background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t1)',
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', width: 120,
          }}
        />
        <select value={filterSrc} onChange={e => setFilterSrc(e.target.value)} style={{
          background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t1)',
          padding: '4px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit',
        }}>
          <option value="all">Tüm Kaynaklar</option>
          {Object.keys(stats?.bySource || {}).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Tab Content */}
      <div style={{ minHeight: 400 }}>
        {tab === 'overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Reliability */}
            <div style={{ background: 'var(--bg2)', padding: 14, borderRadius: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 700, marginBottom: 10 }}>GÜVENİLİRLİK SKORU</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: relColor }}>{reliability}</div>
              <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ width: `${reliability}%`, height: '100%', background: relColor, transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
                Win-rate × 0.5 + örneklem × 0.2 + ortalama getiri × 0.3
              </div>
            </div>
            {/* Performance */}
            <div style={{ background: 'var(--bg2)', padding: 14, borderRadius: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 700, marginBottom: 10 }}>PERFORMANS ÖZETİ</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: 'Aktif', value: stats?.active || 0 },
                  { label: 'Kapalı', value: stats?.closed || 0 },
                  { label: 'Kazançlı', value: stats?.wins || 0, color: 'var(--green)' },
                  { label: 'Kaybeden', value: stats?.losses || 0, color: 'var(--red)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--bg3)', padding: '6px 8px', borderRadius: 4 }}>
                    <div style={{ fontSize: 8, color: 'var(--t3)' }}>{label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: color || 'var(--t1)' }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'signals' && (
          <div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
                <button onClick={() => setPage(0)} disabled={page === 0} style={{ fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--t2)', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit', opacity: page === 0 ? 0.4 : 1 }}>«</button>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--t2)', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' }}>‹</button>
                <span style={{ fontSize: 10, color: 'var(--t2)', padding: '0 8px' }}>
                  {page + 1} / {totalPages} — {filtered.length} sinyal
                </span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1} style={{ fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--t2)', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' }}>›</button>
                <button onClick={() => setPage(totalPages - 1)} disabled={page === totalPages - 1} style={{ fontSize: 9, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--t2)', padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' }}>»</button>
              </div>
            )}
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {filtered.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--t3)', padding: 30, fontSize: 11 }}>
                  Henüz sinyal yok. AI Advisor çalışınca otomatik kaydedilecek.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg3)', color: 'var(--t3)', fontSize: 9 }}>
                      {[
                        { key: 'timestamp', label: 'Tarih / Saat', align: 'left' },
                        { key: 'symbol', label: 'Sembol', align: 'left' },
                        { key: 'cls', label: 'Tip', align: 'center' },
                        { key: 'source', label: 'Kaynak', align: 'center' },
                        { key: 'entry', label: 'Giriş', align: 'center' },
                        { key: 'target', label: 'Hedef', align: 'center' },
                        { key: 'potential', label: 'Potansiyel', align: 'center' },
                        { key: 'rr', label: 'R/R', align: 'center' },
                        { key: 'd1', label: '1G', align: 'center' },
                        { key: 'd3', label: '3G', align: 'center' },
                        { key: 'd5', label: '5G', align: 'center' },
                        { key: 'd7', label: '7G', align: 'center' },
                        { key: 'score', label: 'Skor', align: 'center' },
                        { key: 'outcome', label: 'Sonuç', align: 'center' },
                      ].map(h => (
                        <th key={h.key} onClick={() => handleSort(h.key)} style={{
                          padding: '4px 6px', textAlign: h.align, cursor: 'pointer',
                          background: sortField === h.key ? 'var(--bg2)' : 'transparent',
                        }}>
                          {h.label} {sortField === h.key && (sortDir === 'desc' ? '↓' : '↑')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.map(s => {
                      const entryPrice = s.price || s.entryPrice || null;
                      const targetPrice = s.target || null;
                      const potentialPct = (entryPrice && targetPrice && entryPrice > 0)
                        ? ((targetPrice - entryPrice) / entryPrice) * 100
                        : null;
                      return (
                        <tr key={s.id} onClick={() => onAnalyze && onAnalyze(s.symbol)} style={{
                          cursor: 'pointer', borderBottom: '1px solid var(--border)',
                        }}>
                          <td style={{ padding: '4px 6px', fontSize: 9, color: 'var(--t3)' }}>
                            <div>{new Date(s.timestamp).toLocaleDateString('tr-TR')}</div>
                            <div style={{ color: 'var(--cyan)', fontSize: 8, marginTop: 1 }}>
                              {new Date(s.timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </td>
                          <td style={{ padding: '4px 6px', fontWeight: 600, color: 'var(--t1)', fontSize: 11 }}>{s.symbol}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', color: s.cls === 'buy' ? 'var(--green)' : s.cls === 'sell' ? 'var(--red)' : 'var(--t2)', fontSize: 9 }}>
                            {s.cls?.toUpperCase() || '—'}
                          </td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 9, color: 'var(--t3)' }}>{s.source || 'manual'}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 10 }}>{entryPrice?.toFixed(2) || '—'}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 10, color: 'var(--green)' }}>
                            {targetPrice ? targetPrice.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 9, fontWeight: 600,
                            color: potentialPct != null ? (potentialPct > 0 ? 'var(--green)' : 'var(--red)') : 'var(--t3)'
                          }}>
                            {potentialPct != null ? `${potentialPct > 0 ? '+' : ''}${potentialPct.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 10, color: s.rr >= 2 ? 'var(--green)' : 'var(--t2)' }}>
                            {s.rr ? `1:${s.rr.toFixed(1)}` : '—'}
                          </td>
                          <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d1} /></td>
                          <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d3} /></td>
                          <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d5} /></td>
                          <td style={{ padding: '4px 6px', textAlign: 'center' }}><DayChip value={s.perf?.d7} /></td>
                          <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 10 }}>{s.score100 ? s.score100.toFixed(0) : '—'}</td>
                          <td style={{ padding: '4px 6px', textAlign: 'center' }}><OutcomeBadge outcome={s.outcome || 'OPEN'} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {tab === 'breakdown' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--cyan)', fontWeight: 700, marginBottom: 8 }}>KAYNAK BAZINDA</div>
              {Object.keys(stats?.bySource || {}).length === 0 ? (
                <div style={{ color: 'var(--t3)', fontSize: 10 }}>Veri yok</div>
              ) : (
                Object.entries(stats.bySource).map(([src, s]) => {
                  const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
                  const avgRoi = s.total > 0 ? (s.totalRoi / s.total) : 0;
                  return (
                    <div key={src} style={{
                      padding: '8px 10px', borderLeft: '3px solid var(--cyan)',
                      marginBottom: 6, background: 'var(--bg2)', borderRadius: '0 4px 4px 0',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span style={{ fontSize: 11 }}>{src}</span>
                        <span style={{ color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>%{wr.toFixed(0)}</span>
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                        {s.wins}/{s.total} sinyal · Ort. {avgRoi > 0 ? '+' : ''}{avgRoi.toFixed(1)}%
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 700, marginBottom: 8 }}>TÜR BAZINDA</div>
              {Object.keys(stats?.byClass || {}).length === 0 ? (
                <div style={{ color: 'var(--t3)', fontSize: 10 }}>Veri yok</div>
              ) : (
                Object.entries(stats.byClass).map(([cl, s]) => {
                  const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
                  const avgRoi = s.total > 0 ? (s.totalRoi / s.total) : 0;
                  const clColor = cl === 'buy' ? 'var(--green)' : cl === 'sell' ? 'var(--red)' : 'var(--purple)';
                  return (
                    <div key={cl} style={{
                      padding: '8px 10px', borderLeft: `3px solid ${clColor}`,
                      marginBottom: 6, background: 'var(--bg2)', borderRadius: '0 4px 4px 0',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span style={{ fontSize: 11 }}>{cl.toUpperCase()}</span>
                        <span style={{ color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>%{wr.toFixed(0)}</span>
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                        {s.wins}/{s.total} sinyal · Ort. {avgRoi > 0 ? '+' : ''}{avgRoi.toFixed(1)}%
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {tab === 'symbols' && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--orange)', fontWeight: 700, marginBottom: 8 }}>HİSSE BAZINDA PERFORMANS</div>
            {Object.entries(stats?.bySymbol || {}).length === 0 ? (
              <div style={{ color: 'var(--t3)', fontSize: 10 }}>Veri yok</div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {Object.entries(stats.bySymbol)
                  .sort((a, b) => (b[1].totalRoi / b[1].total) - (a[1].totalRoi / a[1].total))
                  .map(([sym, s]) => {
                    const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
                    const avgRoi = s.total > 0 ? (s.totalRoi / s.total) : 0;
                    return (
                      <div key={sym} onClick={() => onAnalyze && onAnalyze(sym)} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '6px 10px', borderBottom: '1px solid var(--border)',
                        cursor: 'pointer', background: 'var(--bg2)', borderRadius: 4, marginBottom: 4,
                      }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--t1)' }}>{sym}</span>
                          <span style={{ fontSize: 9, color: 'var(--t3)', marginLeft: 8 }}>{s.wins}/{s.total}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>%{wr.toFixed(0)} WR</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: avgRoi > 0 ? 'var(--green)' : 'var(--red)' }}>
                            {avgRoi > 0 ? '+' : ''}{avgRoi.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* GLOBAL PERFORMANCE STATISTICS (FIXED AT BOTTOM) */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 24, paddingTop: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', marginBottom: 12 }}>GENEL PERFORMANS TABLOSU</div>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
          <StatCard label="Güvenilirlik" value={reliability} color={relColor} />
          <StatCard label="Kazanma" value={`%${winRate.toFixed(0)}`} color={wrColor} sub={`${stats?.wins || 0}/${stats?.closed || 0}`} />
          <StatCard label="5G Ort." value={`${stats?.avgD5 || 0}%`} color={(stats?.avgD5 || 0) > 0 ? 'var(--green)' : 'var(--red)'} />
          <StatCard label="P/F" value={stats?.profitFactor || '0'} color={(stats?.profitFactor || 0) >= 1 ? 'var(--green)' : 'var(--red)'} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
          {[
            { label: '1G Ort.', key: 'avgD1' },
            { label: '3G Ort.', key: 'avgD3' },
            { label: '7G Ort.', key: 'avgD7' },
            { label: 'Kazanç Serisi', key: 'winStreak' },
            { label: 'Kayıp Serisi', key: 'loseStreak' },
            { label: 'Max Getiri', key: 'maxReturn' },
          ].map(({ key, label }) => {
            let v = stats?.[key] || '0';
            let c = 'var(--t1)';
            if (key === 'winStreak' || key === 'loseStreak') {
              c = parseInt(v) > 3 ? 'var(--orange)' : 'var(--t2)';
            } else if (key.includes('Return') || key.includes('avg')) {
              v = (typeof v === 'number' ? v.toFixed(1) : parseFloat(v).toFixed(1)) + '%';
              c = parseFloat(stats?.[key] || 0) > 0 ? 'var(--green)' : 'var(--red)';
            }
            return (
              <div key={key} style={{ background: 'var(--bg2)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                <div style={{ fontSize: 8, color: 'var(--t3)' }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}