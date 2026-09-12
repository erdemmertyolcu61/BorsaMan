import { useState, useEffect } from 'react';
import { fetchKAPDisclosures } from '../../utils/kapEngine.js';
import { analyzeKAPList } from '../../utils/claude.js';

const KIND_COLOR = {
  risk: 'var(--red)',
  caution: 'var(--orange)',
  event: 'var(--cyan)',
  info: 'var(--t3)',
};

export default function KAPPanel({ symbol }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);
  const [error, setError] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      setAiError(null);
      setData([]);
      try {
        const disclosures = await fetchKAPDisclosures(symbol);
        if (cancelled) return;
        if (!disclosures || disclosures.length === 0) {
          // "bildirim yok" ile "KAP'a ulasilamadi" AYNI SEY DEGIL — ikisini ayri soyle.
          setError(disclosures?.unavailable
            ? `KAP verisi alınamadı: ${disclosures.reason || 'kaynak yanıt vermedi'} Bu, bildirim YOK demek değil.`
            : 'Son 30 günde rutin dışı KAP bildirimi yok.');
        } else {
          setData(disclosures);
        }
      } catch {
        if (!cancelled) setError('KAP verisi çekilirken hata oluştu.');
      }
      if (!cancelled) setLoading(false);
    }
    loadData();
    return () => { cancelled = true; };
  }, [symbol]);

  // v31.38: AI yorumu artik OTOMATIK degil. KAP yeniden gercek veri dondurdugu
  // icin her hisse analizinde Claude'a istek gidecekti (API maliyeti) — istege bagli.
  const runAi = async () => {
    if (!data.length || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const aiResult = await analyzeKAPList(symbol, data);
      if (Array.isArray(aiResult) && aiResult.length > 0) {
        setData(prev => prev.map(d => {
          const ai = aiResult.find(a => String(a.id) === String(d.id));
          return ai ? { ...d, sentiment: ai.sentiment || 'Notr', aiScore: ai.score || null, aiReason: ai.reason || '' } : d;
        }));
      } else {
        setAiError(aiResult?.error ? `AI hatası: ${aiResult.error}` : 'AI yorumu alınamadı.');
      }
    } catch {
      setAiError('AI yorumu alınamadı.');
    }
    setAiLoading(false);
  };

  if (!symbol) return null;

  return (
    <div className="trade-box fi" style={{ marginTop: 14 }}>
      <div className="trade-title" style={{ color: 'var(--yellow)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>KAP Bildirimleri (son 30 gün)</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {loading && <div className="spinner" style={{ width: 14, height: 14 }} />}
          {data.length > 0 && (
            <button
              onClick={runAi}
              disabled={aiLoading}
              style={{
                fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 4, cursor: aiLoading ? 'default' : 'pointer',
                background: 'rgba(213,0,249,0.12)', border: '1px solid rgba(213,0,249,0.4)', color: 'var(--purple)', fontFamily: 'inherit',
              }}
              title="Claude API anahtarı gerekir; her tıklama bir istek gönderir"
            >
              {aiLoading ? 'JARVIS okuyor…' : '🤖 JARVIS yorumu'}
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ fontSize: 11, color: 'var(--orange)', padding: 10, lineHeight: 1.5 }}>{error}</div>}
      {aiError && <div style={{ fontSize: 10, color: 'var(--orange)', padding: '0 10px 6px' }}>{aiError}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {data.map((d) => {
          const color = KIND_COLOR[d.kind] || KIND_COLOR.info;
          const sentimentColor = d.sentiment === 'Pozitif' ? 'var(--green)' : d.sentiment === 'Negatif' ? 'var(--red)' : 'var(--yellow)';
          return (
            <div key={d.id} className="a-item" style={{
              background: 'var(--bg2)', padding: '10px 12px', borderRadius: 6, borderLeft: `4px solid ${color}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>{d.title}</div>
                <span style={{ fontSize: 10, color: 'var(--t3)', whiteSpace: 'nowrap' }}>
                  {new Date(d.date).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                {d.label && <span style={{ fontSize: 10, fontWeight: 700, color }}>{d.label}</span>}
                {d.sentiment && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: sentimentColor, background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4 }}>
                    JARVIS: {d.sentiment}{d.aiScore ? ` (${d.aiScore}/10)` : ''}
                  </span>
                )}
              </div>
              {d.summary && d.summary !== d.title && (
                <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>{d.summary}</div>
              )}
              {d.aiReason && (
                <div style={{ fontSize: 10, color: 'var(--t2)', background: 'var(--bg0)', padding: 8, borderRadius: 4, marginTop: 6 }}>
                  <b style={{ color: 'var(--cyan)' }}>JARVIS:</b> {d.aiReason}
                </div>
              )}
              {d.link && (
                <a href={d.link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 6, fontSize: 10, color: 'var(--cyan)' }}>
                  KAP bildirimini aç ↗
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
