/**
 * DataLayerEdgePanel — "bu veriler işe yarıyor mu?" (v31.50).
 *
 * Kullanıcı kararı (2026-09-12, dataLayerPolicy): yabancı akış ve KAP olayları
 * skora girmez; her sinyale kaydedilir ve burada ölçülür, sonra açılır. Ölçüm
 * v31.38'den beri Piyasa Nabzı ekranının altındaydı; o ekran v31.50'de kaldırıldı,
 * karar bu tabloya baktığı için ölçüm Sinyal sekmesine taşındı.
 */
import { useMemo, useState } from 'react';
import { computeDataLayerEdge, FOREIGN_FLOW_BAND_PP } from '../../utils/dataLayerEdge.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const signed = (v) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(2).replace('.', ',')}` : '—');
const toneOf = (v) => (isNum(v) && v > 0 ? 'var(--green)' : isNum(v) && v < 0 ? 'var(--red)' : 'var(--t3)');

function EdgeTable({ title, rows }) {
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 40px 64px 68px', gap: 6 };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...grid, fontSize: 11, color: 'var(--t3)', fontWeight: 600, paddingBottom: 3 }}>
        <span>{title}</span>
        <span style={{ textAlign: 'right' }}>n</span>
        <span style={{ textAlign: 'right' }}>kazanma</span>
        <span style={{ textAlign: 'right' }}>ort.</span>
      </div>
      {rows.map(([label, cell]) => (
        <div key={label} style={{
          ...grid, fontSize: 12, padding: '4px 0', fontVariantNumeric: 'tabular-nums',
          borderTop: '1px solid var(--border)', opacity: cell.reliable ? 1 : 0.55,
        }}>
          <span style={{ color: 'var(--t2)' }}>{label}</span>
          <span style={{ textAlign: 'right', color: 'var(--t2)' }}>{cell.n}</span>
          <span style={{ textAlign: 'right', color: cell.winRate == null ? 'var(--t3)' : cell.winRate >= 50 ? 'var(--green)' : 'var(--red)' }}>
            {cell.winRate == null ? '—' : `%${cell.winRate.toFixed(0)}`}
          </span>
          <span style={{ textAlign: 'right', color: toneOf(cell.avgReturn) }}>{signed(cell.avgReturn)}</span>
        </div>
      ))}
    </div>
  );
}

export default function DataLayerEdgePanel({ signals = [] }) {
  const [open, setOpen] = useState(false);
  const edge = useMemo(() => computeDataLayerEdge(signals), [signals]);
  return (
    <div className="trade-box" style={{ marginBottom: 16 }}>
      <div role="button" tabIndex={0} onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <span className="trade-title" style={{ margin: 0 }}>Veri katmanı ölçümü — yabancı akış ve KAP</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>{edge.settled} sonuçlanan AL · {open ? 'gizle' : 'göster'}</span>
      </div>
      {open && (
        <>
          <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5, marginTop: 8 }}>
            Bu veriler skoru etkilemiyor; her AL sinyaline kaydedilip burada ölçülüyor. Yabancı verisiyle kaydedilen {edge.withForeign},
            KAP kontrolüyle kaydedilen {edge.withKap}. {edge.minSample} örneğin altındaki satırlar soluk — küçük örnek yanıltır.
          </div>
          <EdgeTable
            title={`Yabancı (hafta, ±${FOREIGN_FLOW_BAND_PP} p)`}
            rows={[['Giriş', edge.foreign.inflow], ['Nötr', edge.foreign.flat], ['Çıkış', edge.foreign.outflow]]}
          />
          <EdgeTable
            title="KAP (son 7 gün)"
            rows={[['Şirket olayı var', edge.kap.event], ['Diğer bildirim', edge.kap.other], ['Bildirim yok', edge.kap.none], ['İşlem tedbiri', edge.kap.risk]]}
          />
          <EdgeTable
            title="KAP olay türü (örtüşebilir)"
            rows={[['Pay geri alımı', edge.kapEvents.buyback], ['Yeni iş anlaşması', edge.kapEvents.new_business]]}
          />
        </>
      )}
    </div>
  );
}
