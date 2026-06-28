import { useState, useMemo } from 'react';
import { computeUnifiedStats } from '../../utils/unifiedAccuracy.js';

const CONF_LABEL = {
  insufficient: { txt: 'YETERSİZ VERİ', color: 'var(--t3, #6b7280)' },
  low:          { txt: 'DÜŞÜK GÜVEN',   color: 'var(--orange, #f59e0b)' },
  medium:       { txt: 'ORTA GÜVEN',    color: 'var(--yellow, #eab308)' },
  high:         { txt: 'YÜKSEK GÜVEN',  color: 'var(--green, #10b981)' },
};

function pct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

function signed(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function Breakdown({ title, data }) {
  const rows = Object.entries(data || {})
    .filter(([, m]) => m && m.total > 0)
    .sort((a, b) => b[1].total - a[1].total);
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)', marginBottom: 4 }}>{title}</div>
      {rows.map(([k, m]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
          <span style={{ color: 'var(--t2, #9ca3af)' }}>{k}</span>
          <span>
            <span style={{ color: (m.accuracy ?? m.winRate) >= 55 ? 'var(--green, #10b981)' : (m.accuracy ?? m.winRate) >= 45 ? 'var(--yellow, #eab308)' : 'var(--red, #ef4444)' }}>
              {pct(m.accuracy ?? m.winRate, 0)}
            </span>
            <span style={{ color: 'var(--t3, #6b7280)' }}> · {m.total} · </span>
            <span style={{ color: (m.avgReturn ?? 0) >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)' }}>
              {signed(m.avgReturn)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function SignalTypeTable({ data }) {
  const rows = Object.entries(data || {})
    .filter(([, m]) => m && m.total >= 3)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15);
  if (!rows.length) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)', marginBottom: 6 }}>SİNYAL TİPİ KIRILIMI</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px 50px 60px', gap: '2px 6px', fontSize: 11, overflowX: 'auto' }}>
        <span style={{ color: 'var(--t3)', fontWeight: 600 }}>Sinyal</span>
        <span style={{ color: 'var(--t3)', fontWeight: 600, textAlign: 'right' }}>Örnek</span>
        <span style={{ color: 'var(--t3)', fontWeight: 600, textAlign: 'right' }}>Win%</span>
        <span style={{ color: 'var(--t3)', fontWeight: 600, textAlign: 'right' }}>Avg Ret</span>
        {rows.map(([sig, m]) => {
          const wr = m.winRate;
          return [
            <span key={`${sig}-n`} style={{ color: 'var(--t2, #9ca3af)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sig.replace(/_/g, ' ')}
            </span>,
            <span key={`${sig}-t`} style={{ textAlign: 'right', color: 'var(--t2)' }}>{m.total}</span>,
            <span key={`${sig}-w`} style={{ textAlign: 'right', color: wr >= 55 ? 'var(--green, #10b981)' : wr >= 45 ? 'var(--yellow, #eab308)' : 'var(--red, #ef4444)' }}>
              {pct(wr, 0)}
            </span>,
            <span key={`${sig}-r`} style={{ textAlign: 'right', color: m.avgReturn >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)' }}>
              {signed(m.avgReturn, 1)}
            </span>,
          ];
        })}
      </div>
    </div>
  );
}

function CalibrationChart({ data }) {
  if (!data?.length) return null;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)', marginBottom: 6 }}>CONFIDENCE KALİBRASYON</div>
      <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 4 }}>Tahmin edilen vs gerçekleşen win rate (dekad bazlı)</div>
      {data.map(b => {
        const gap = b.actual - b.predicted;
        const barW = Math.max(4, (b.count / maxCount) * 100);
        return (
          <div key={b.bucket} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11 }}>
            <span style={{ width: 42, color: 'var(--t2)', textAlign: 'right', flexShrink: 0 }}>{b.bucket}</span>
            <div style={{ flex: 1, position: 'relative', height: 14, background: 'var(--bg2, #1a1f2e)', borderRadius: 3 }}>
              <div style={{
                width: `${barW}%`, height: '100%', borderRadius: 3,
                background: gap >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)', opacity: 0.6,
              }} />
              <span style={{ position: 'absolute', right: 4, top: 0, lineHeight: '14px', fontSize: 10, color: 'var(--t1)' }}>
                {pct(b.actual, 0)} ({b.count})
              </span>
            </div>
            <span style={{ width: 44, fontSize: 10, flexShrink: 0, color: gap >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)' }}>
              {gap >= 0 ? '+' : ''}{gap.toFixed(0)}pp
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SourceBadges({ data }) {
  if (!data) return null;
  const sources = [
    { key: 'journal', label: 'Forward Test', color: 'var(--cyan, #22d3ee)' },
    { key: 'tracker', label: 'Sinyal Takip', color: 'var(--purple, #a78bfa)' },
    { key: 'paper', label: 'Paper Trade', color: 'var(--orange, #f59e0b)' },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {sources.map(s => {
        const d = data[s.key];
        if (!d || !d.total) return null;
        return (
          <span key={s.key} style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            border: `1px solid ${s.color}`, color: s.color,
          }}>
            {s.label}: {d.total} · {pct(d.winRate, 0)}
          </span>
        );
      })}
    </div>
  );
}

export default function ForwardAccuracyPanel({ journal, signalTracker }) {
  const [unifiedMode, setUnifiedMode] = useState(false);

  const unifiedStats = useMemo(() => {
    if (!unifiedMode) return null;
    return computeUnifiedStats({
      journalDays: journal?.days || [],
      signals: signalTracker?.signals || [],
    });
  }, [unifiedMode, journal?.days, signalTracker?.signals]);

  if (!journal) return null;
  const { stats, exportCSV, clearJournal } = journal;
  const conf = CONF_LABEL[stats.sampleConfidence] || CONF_LABEL.insufficient;
  const insufficient = stats.sampleConfidence === 'insufficient';

  const hasTracker = signalTracker?.signals?.length > 0;

  return (
    <div className="trade-box" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1, #e5e7eb)', letterSpacing: 0.5 }}>
            🎯 TAHMİN İSABETİ <span style={{ color: 'var(--cyan, #22d3ee)' }}>
              {unifiedMode ? '(Birleşik)' : '(Forward Test)'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)', marginTop: 2 }}>
            {unifiedMode
              ? 'Forward test + sinyal takip birleşik doğruluk — çapraz doğrulanmış'
              : 'Sistemin ürettiği AL tahminleri ertesi gün gerçekte ne yaptı — değişmez kayıt'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasTracker && (
            <button
              onClick={() => setUnifiedMode(v => !v)}
              style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                background: unifiedMode ? 'var(--cyan, #22d3ee)' : 'transparent',
                color: unifiedMode ? 'var(--bg1, #0a0e17)' : 'var(--cyan, #22d3ee)',
                border: '1px solid var(--cyan, #22d3ee)', fontWeight: 600,
              }}
            >
              {unifiedMode ? '⊕ BİRLEŞİK' : '⊕ Birleştir'}
            </button>
          )}
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
            color: conf.color, border: `1px solid ${conf.color}`,
          }}>
            {conf.txt}
          </span>
        </div>
      </div>

      {unifiedMode && unifiedStats ? (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Metric label="Birleşik Win Rate"
              value={pct(unifiedStats.overall.winRate, 1)}
              color={unifiedStats.overall.winRate >= 55 ? 'var(--green, #10b981)' : unifiedStats.overall.winRate >= 45 ? 'var(--yellow, #eab308)' : 'var(--red, #ef4444)'}
              big />
            <Metric label="Avg Getiri" value={signed(unifiedStats.overall.avgReturn)}
              color={unifiedStats.overall.avgReturn >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)'} big />
            <Metric label="Toplam Örnek" value={`${unifiedStats.overall.total}`} />
          </div>

          <SourceBadges data={unifiedStats.bySources} />
          <Breakdown title="REJİME GÖRE" data={unifiedStats.byRegime} />
          <Breakdown title="GRADE'E GÖRE" data={unifiedStats.byGrade} />
          <Breakdown title="TIER'A GÖRE" data={unifiedStats.byTier} />
          <SignalTypeTable data={unifiedStats.bySignalType} />
          <CalibrationChart data={unifiedStats.calibration} />
        </>
      ) : insufficient ? (
        <div style={{ padding: '14px 0', textAlign: 'center', color: 'var(--t2, #9ca3af)', fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>⏳</div>
          Henüz güvenilir bir isabet sayısı için yeterli tahmin olgunlaşmadı.
          <div style={{ fontSize: 12, color: 'var(--t3, #6b7280)', marginTop: 6 }}>
            Değerlendirilen: <b>{stats.evaluated}</b> / Bekleyen: <b>{stats.pending}</b> ·
            {' '}{stats.days} işlem günü kaydedildi
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)', marginTop: 4 }}>
            Sistem çalışıp tarama yaptıkça (10 örnek → düşük, 30 → orta, 100 → yüksek güven) rakam anlamlanır.
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Metric label="Ertesi-gün yön isabeti"
              value={pct(stats.directionalAccuracy, 1)}
              color={stats.directionalAccuracy >= 55 ? 'var(--green, #10b981)' : stats.directionalAccuracy >= 50 ? 'var(--yellow, #eab308)' : 'var(--red, #ef4444)'}
              big />
            <Metric label="Beklenti (avg getiri)" value={signed(stats.expectancy)}
              color={stats.expectancy >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)'} big />
            <Metric label="Örnek" value={`${stats.evaluated}`} sub={`${stats.pending} bekliyor`} />
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
            <Mini label="D1" v={signed(stats.avgD1)} />
            <Mini label="D3" v={signed(stats.avgD3)} />
            <Mini label="D5" v={signed(stats.avgD5)} />
            <Mini label="Hedef tuttu" v={`${stats.targetHits}`} pos />
            <Mini label="Stop yedi" v={`${stats.stopHits}`} neg />
          </div>

          <Breakdown title="REJİME GÖRE" data={stats.byRegime} />
          <Breakdown title="GRADE'E GÖRE" data={stats.byGrade} />
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={exportCSV} className="btn-mini"
          style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                   background: 'transparent', color: 'var(--cyan, #22d3ee)',
                   border: '1px solid var(--cyan, #22d3ee)', borderRadius: 4 }}>
          CSV İndir
        </button>
        <button onClick={() => { if (confirm('Tahmin defteri sıfırlansın mı? Ölçüm geçmişi silinir.')) clearJournal(); }}
          style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer',
                   background: 'transparent', color: 'var(--t3, #6b7280)',
                   border: '1px solid var(--t3, #6b7280)', borderRadius: 4 }}>
          Sıfırla
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, color, big }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--t3, #6b7280)' }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 18, fontWeight: 700, color: color || 'var(--t1, #e5e7eb)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--t3, #6b7280)' }}>{sub}</div>}
    </div>
  );
}

function Mini({ label, v, pos, neg }) {
  return (
    <span style={{ color: 'var(--t2, #9ca3af)' }}>
      {label}:{' '}
      <b style={{ color: pos ? 'var(--green, #10b981)' : neg ? 'var(--red, #ef4444)' : 'var(--t1, #e5e7eb)' }}>{v}</b>
    </span>
  );
}
