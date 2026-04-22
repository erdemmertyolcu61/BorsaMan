import { useState, useEffect } from 'react';
import { fetchKAPDisclosures } from '../../utils/kapEngine.js';
import { analyzeKAPList } from '../../utils/claude.js';

export default function KAPPanel({ symbol }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadData() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      setData([]);

      try {
        const disclosures = await fetchKAPDisclosures(symbol);
        if (!disclosures || disclosures.length === 0) {
          setError('Son 14 gunde KAP bildirimi bulunamadi.');
          setLoading(false);
          return;
        }
        
        // Show temp load state with skeletons
        setData(disclosures.map(d => ({ ...d, aiStatus: 'analyzing' })));
        
        const aiResult = await analyzeKAPList(symbol, disclosures);
        
        if (aiResult && Array.isArray(aiResult) && aiResult.length > 0) {
          // Merge AI results
          const merged = disclosures.map(d => {
            const ai = aiResult.find(a => a.id === d.id) || {};
            return {
              ...d,
              sentiment: ai.sentiment || 'Notr',
              score: ai.score || 5, // 1-10
              aiReason: ai.reason || 'AI analizi yapilamadi.',
              aiStatus: 'done'
            };
          });
          setData(merged);
        } else if (aiResult && aiResult.error) {
          setError('AI Hatasi: ' + aiResult.error);
          setData(disclosures.map(d => ({ ...d, aiStatus: 'error', aiReason: aiResult.error })));
        } else {
          // Fallback error
          setData(disclosures.map(d => ({ ...d, aiStatus: 'error', aiReason: 'Bilinmeyen bir AI cozumlume hatasi.' })));
        }

      } catch (err) {
        setError('KAP verisi cekilirken hata oluştu.');
      }
      setLoading(false);
    }

    loadData();
  }, [symbol]);

  if (!symbol) return null;

  return (
    <div className="trade-box fi" style={{ marginTop: 14 }}>
      <div className="trade-title" style={{ color: 'var(--yellow)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>KAP Haberleri & Duyarlilik Analizi</span>
        {loading && <div className="spinner" style={{ width: 14, height: 14 }} />}
      </div>
      
      {error && <div style={{ fontSize: 10, color: 'var(--red)', padding: 10 }}>{error}</div>}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
        {data.map((d, i) => {
          let badgeColor = 'var(--t3)';
          let badgeText = 'Bekleniyor';
          
          if (d.aiStatus === 'done') {
            if (d.sentiment === 'Pozitif') { badgeColor = 'var(--green)'; badgeText = 'Pozitif'; }
            else if (d.sentiment === 'Negatif') { badgeColor = 'var(--red)'; badgeText = 'Negatif'; }
            else { badgeColor = 'var(--yellow)'; badgeText = 'Notr'; }
          } else if (d.aiStatus === 'error') {
            badgeText = 'AI Hata';
            badgeColor = 'var(--orange)';
          } else {
            badgeText = 'AI Analizi...';
            badgeColor = 'var(--cyan)';
          }

          const dateStr = new Date(d.date).toLocaleDateString('tr-TR');
          
          return (
            <div key={i} className="a-item" style={{ 
              background: 'var(--bg2)', 
              padding: '12px', 
              borderRadius: '6px', 
              borderLeft: `4px solid ${badgeColor}`,
              position: 'relative',
              transition: 'transform 0.2s',
              cursor: d.link ? 'pointer' : 'default'
            }} onClick={() => d.link && window.open(d.link, '_blank')}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--t1)', paddingRight: '20px' }}>{d.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--t3)', whiteSpace: 'nowrap' }}>{dateStr}</span>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: badgeColor, background: 'var(--bg3)', padding: '2px 8px', borderRadius: '4px' }}>
                    {badgeText} {d.score ? `(${d.score}/10)` : ''}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--t2)', lineHeight: 1.5, marginBottom: '10px' }}>
                {d.summary}
              </div>
              
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {d.link && (
                  <div style={{ fontSize: '10px', color: 'var(--cyan)', textDecoration: 'underline' }}>
                    KAP Bildirimini Aç ↗
                  </div>
                )}
                {(d.aiStatus === 'done' || d.aiStatus === 'error') && d.aiReason && (
                  <div style={{ 
                    flex: 1,
                    fontSize: '10px', 
                    color: d.aiStatus === 'error' ? 'var(--orange)' : 'var(--t2)', 
                    background: 'var(--bg0)', 
                    padding: '8px', 
                    borderRadius: '4px', 
                    border: `1px solid ${d.aiStatus === 'error' ? 'var(--orange)' : 'var(--bg3)'}`
                  }}>
                    <b style={{ color: 'var(--cyan)' }}>JARVIS:</b> {d.aiReason}
                  </div>
                )}
              </div>
            </div>
          );

        })}
        {data.length === 0 && !loading && !error && (
          <div style={{ fontSize: 10, color: 'var(--t3)' }}>Haber bulunamadi.</div>
        )}
      </div>
    </div>
  );
}
