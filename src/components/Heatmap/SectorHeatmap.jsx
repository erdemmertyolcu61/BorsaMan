import { useMemo } from 'react';
import { rankSectors } from '../../utils/sectorEngine.js';

// Color interpolation: red (cold) → yellow (neutral) → green (hot)
function strengthColor(strength) {
  if (strength >= 70) return 'rgba(0, 255, 136, 0.85)';
  if (strength >= 60) return 'rgba(0, 200, 100, 0.7)';
  if (strength >= 50) return 'rgba(180, 180, 60, 0.6)';
  if (strength >= 40) return 'rgba(200, 150, 40, 0.55)';
  if (strength >= 30) return 'rgba(220, 80, 40, 0.6)';
  return 'rgba(255, 50, 50, 0.7)';
}

function rotationBadge(rotation) {
  const map = {
    'GUCLU GIRIS': { bg: 'var(--green)', text: '#000' },
    'GIRIS': { bg: 'rgba(0,255,136,0.3)', text: 'var(--green)' },
    'CIKIS': { bg: 'rgba(255,80,80,0.3)', text: 'var(--red)' },
    'ZAYIF': { bg: 'rgba(255,150,50,0.3)', text: 'var(--yellow)' },
    'NOTR': { bg: 'rgba(100,100,100,0.3)', text: 'var(--t3)' },
  };
  return map[rotation] || map['NOTR'];
}

export default function SectorHeatmap({ sectorMetrics }) {
  const ranked = useMemo(() => {
    if (!sectorMetrics || Object.keys(sectorMetrics).length === 0) return [];
    return rankSectors(sectorMetrics);
  }, [sectorMetrics]);

  if (ranked.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>
        Sektor verisi icin AI Advisor taramasini bekleyin...
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--cyan)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Sektor Isi Haritasi
      </div>

      {/* Heatmap Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
        gap: 4,
        marginBottom: 12,
      }}>
        {ranked.map(s => {
          const badge = rotationBadge(s.rotation);
          return (
            <div key={s.sector} style={{
              background: strengthColor(s.strength),
              borderRadius: 6,
              padding: '8px 10px',
              cursor: 'default',
              transition: 'transform 0.15s',
              position: 'relative',
            }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#000', marginBottom: 2 }}>
                {s.sector}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: '#000' }}>
                  {s.strength}
                </span>
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: '2px 5px', borderRadius: 3,
                  background: badge.bg, color: badge.text, textTransform: 'uppercase',
                }}>
                  {s.rotation}
                </span>
              </div>
              <div style={{ fontSize: 8, color: 'rgba(0,0,0,0.7)', marginTop: 2 }}>
                {s.buyCount}AL / {s.sellCount}SAT / {s.holdCount}TUT
                {s.topPick && <span style={{ marginLeft: 4, fontWeight: 700 }}>{s.topPick}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detailed Table */}
      <div style={{ fontSize: 9, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 40px 40px 40px 50px 45px 50px',
          gap: 4, padding: '4px 0', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase',
          borderBottom: '1px solid var(--border)',
        }}>
          <span>Sektor</span>
          <span style={{ textAlign: 'center' }}>Guc</span>
          <span style={{ textAlign: 'center' }}>RSI</span>
          <span style={{ textAlign: 'center' }}>MFI</span>
          <span style={{ textAlign: 'center' }}>Birikim</span>
          <span style={{ textAlign: 'center' }}>ADX</span>
          <span style={{ textAlign: 'center' }}>Degisim</span>
        </div>
        {ranked.map(s => (
          <div key={s.sector + '_row'} style={{
            display: 'grid', gridTemplateColumns: '1fr 40px 40px 40px 50px 45px 50px',
            gap: 4, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
          }}>
            <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{s.sector}</span>
            <span style={{ textAlign: 'center', fontWeight: 700, color: s.strength >= 60 ? 'var(--green)' : s.strength >= 40 ? 'var(--yellow)' : 'var(--red)' }}>
              {s.strength}
            </span>
            <span style={{ textAlign: 'center', color: s.avgRSI > 70 ? 'var(--red)' : s.avgRSI < 30 ? 'var(--green)' : 'var(--t2)' }}>
              {s.avgRSI}
            </span>
            <span style={{ textAlign: 'center', color: s.avgMFI < 30 ? 'var(--green)' : s.avgMFI > 70 ? 'var(--red)' : 'var(--t2)' }}>
              {s.avgMFI}
            </span>
            <span style={{ textAlign: 'center', color: s.accumPct > 50 ? 'var(--green)' : 'var(--t2)' }}>
              %{s.accumPct}
            </span>
            <span style={{ textAlign: 'center', color: s.avgADX > 25 ? 'var(--cyan)' : 'var(--t3)' }}>
              {s.avgADX}
            </span>
            <span style={{ textAlign: 'center', color: s.avgChange >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {s.avgChange >= 0 ? '+' : ''}{s.avgChange}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
