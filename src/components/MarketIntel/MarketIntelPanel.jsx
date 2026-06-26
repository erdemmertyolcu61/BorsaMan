import React, { useState, useEffect } from 'react';
import { getMarketIntel } from '../../utils/marketIntelEngine.js';

export default function MarketIntelPanel() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    const raw = localStorage.getItem('bist_daily_intel_cache');
    if (raw) {
      try {
        const cached = JSON.parse(raw);
        setReport(cached.report);
        setLastUpdate(cached.ts);
      } catch (e) {}
    }
  }, []);

  const handleRefreshIntel = async () => {
    setLoading(true);
    setReport(null);
    const newReport = await getMarketIntel(true);
    setReport(newReport);
    setLastUpdate(Date.now());
    setLoading(false);
  };

  const renderMarkdown = (text) => {
    if (!text) return null;
    return text.split('\n').map((line, i) => {
      // Basic bold parsing for **text**
      const parts = line.split(/(\*\*.*?\*\*)/g).map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={j}>{part.slice(2, -2)}</strong>;
        }
        return part;
      });
      return <div key={i} style={{ minHeight: '1em', marginBottom: '4px' }}>{parts}</div>;
    });
  };

  return (
    <div className="pan">
      <div className="pan-h">
        <div className="dot"></div>
        Piyasa İstihbaratı ve Uzman Beklentileri
      </div>
      
      <div className="sec">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <div className="lbl">Son Güncelleme: {lastUpdate ? new Date(lastUpdate).toLocaleString('tr-TR') : 'Hiç güncellenmedi'}</div>
          </div>
          <button 
            className="btn btn-go" 
            onClick={handleRefreshIntel} 
            disabled={loading}
            style={{ width: 'auto', padding: '10px 24px' }}
          >
            {loading ? 'Arama Yapılıyor...' : 'Günün Özetini Yenile'}
          </button>
        </div>

        {loading && (
          <div className="trade-box" style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div className="spinner" style={{ width: '24px', height: '24px', marginBottom: '16px' }}></div>
            <div className="trade-title" style={{ color: 'var(--green)' }}>AI İnterneti Tarıyor...</div>
            <div className="lbl">Aracı kurum raporları, uzman yorumları ve finans haberleri analiz ediliyor. Lütfen bekleyin.</div>
          </div>
        )}

        {!loading && report && report.error && (
          <div className="trade-box" style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--red)' }}>
            Hata oluştu: {typeof report.error === 'string' ? report.error : JSON.stringify(report.error)}
          </div>
        )}

        {!loading && report && !report.error && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {/* HABERLER */}
            <div className="ai-box" style={{ margin: 0, maxHeight: 'none' }}>
              <div className="ai-hdr">
                <div className="ai-avatar">📰</div>
                Günün Önemli Finans Haberleri
              </div>
              <div className="ai-content">
                {typeof report.newsMarkdown === 'string' ? renderMarkdown(report.newsMarkdown) : 'Veri alınamadı.'}
              </div>
            </div>

            {/* UZMAN GORUSLERI */}
            <div className="ai-box" style={{ margin: 0, maxHeight: 'none', borderColor: 'var(--green)' }}>
              <div className="ai-hdr" style={{ color: 'var(--green)' }}>
                <div className="ai-avatar" style={{ background: 'linear-gradient(135deg, var(--green), var(--cyan))' }}>🎯</div>
                Aracı Kurum ve Uzman Görüşleri
              </div>
              <div className="ai-content">
                {typeof report.expertMarkdown === 'string' ? renderMarkdown(report.expertMarkdown) : 'Veri alınamadı.'}
              </div>
            </div>
            
            {/* ETKİLENEN HİSSELER */}
            {Array.isArray(report.impacts) && report.impacts.length > 0 && (
              <div className="trade-box" style={{ margin: 0, gridColumn: '1 / -1' }}>
                <div className="trade-title">Yapay Zekanın Favori Hisseleri (Gelen Veriye Göre)</div>
                <div className="sr-tbl-wrap">
                  <table className="stable">
                    <thead>
                      <tr>
                        <th>Hisse</th>
                        <th>Gerekçe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.impacts.map((imp, idx) => (
                        <tr key={idx}>
                          <td className="s-sym">{imp.symbol}</td>
                          <td style={{ color: 'var(--t2)', fontSize: '12px' }}>{imp.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {!loading && !report && (
          <div className="trade-box" style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--t3)' }}>
            Henüz rapor oluşturulmadı. "Günün Özetini Yenile" butonuna tıklayarak AI analizini başlatabilirsiniz.
          </div>
        )}
      </div>
    </div>
  );
}
