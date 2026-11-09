/**
 * Hisse detayı — teknik göstergeler (v31.50). Değerler motorun calcAll
 * çıktısından; AL/SAT kararı burada verilmez (Analiz sekmesi, tarama ile aynı yol).
 */
import { fmtByType, fmtPct, signTone } from './fmt.js';

const TONE = { up: 'var(--green)', down: 'var(--red)', warn: 'var(--orange)' };

function Card({ title, children }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

export function ReturnsTable({ returns }) {
  if (!returns?.length) return <div style={{ fontSize: 12, color: 'var(--t3)' }}>Getiri için yeterli bar yok.</div>;
  const hasBench = returns.some(r => r.bench != null);
  const cell = { padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
      <thead>
        <tr style={{ color: 'var(--t3)', fontSize: 11 }}>
          <th style={{ textAlign: 'left', fontWeight: 600, padding: '0 8px 6px 0' }}>Dönem</th>
          <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 8px 6px' }}>Hisse</th>
          {hasBench && <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 8px 6px' }}>BIST 100</th>}
          {hasBench && <th style={{ textAlign: 'right', fontWeight: 600, padding: '0 0 6px 8px' }}>Fark (puan)</th>}
        </tr>
      </thead>
      <tbody>
        {returns.map(r => (
          <tr key={r.key}>
            <td style={{ ...cell, textAlign: 'left', paddingLeft: 0, color: 'var(--t2)' }}>{r.label}</td>
            <td style={{ ...cell, color: signTone(r.value), fontWeight: 600 }}>{fmtPct(r.value, { signed: true })}</td>
            {hasBench && <td style={{ ...cell, color: 'var(--t2)' }}>{fmtPct(r.bench, { signed: true })}</td>}
            {hasBench && <td style={{ ...cell, paddingRight: 0, color: signTone(r.rel) }}>{r.rel == null ? '—' : `${r.rel > 0 ? '+' : r.rel < 0 ? '−' : ''}${Math.abs(r.rel).toFixed(1).replace('.', ',')}`}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Row({ row }) {
  const color = row.tone ? TONE[row.tone] : 'var(--t1)';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '2px 10px', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, color: 'var(--t2)', minWidth: 0 }}>{row.label}</div>
      <div style={{ fontSize: 12.5, color, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {fmtByType(row.value, row.fmt)}
        {row.sub != null && (
          <span style={{ color: 'var(--t3)', fontWeight: 400, marginLeft: 6 }}>
            {row.subFmt === 'pct' ? `(${fmtByType(row.sub, 'pct')})` : `/ ${fmtByType(row.sub, row.subFmt)}`}
          </span>
        )}
      </div>
      {row.note ? <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--t3)', marginTop: -1 }}>{row.note}</div> : null}
    </div>
  );
}

export default function TechnicalPanel({ snapshot, isMobile }) {
  if (!snapshot?.groups?.length) {
    return <div style={{ fontSize: 12, color: 'var(--t3)', padding: 12 }}>Fiyat serisi alınamadı — teknik göstergeler hesaplanamadı.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(330px, 1fr))', alignItems: 'start' }}>
      <Card title="Getiriler">
        <ReturnsTable returns={snapshot.returns} />
      </Card>
      {snapshot.groups.map(g => (
        <Card key={g.id} title={g.title}>
          {g.rows.map((r, i) => <Row key={r.label + i} row={r} />)}
        </Card>
      ))}
    </div>
  );
}
