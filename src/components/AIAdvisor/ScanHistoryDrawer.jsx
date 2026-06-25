import { useState } from 'react';

export default function ScanHistoryDrawer({ history = [], onAnalyze }) {
  const [isOpen, setIsOpen] = useState(false);

  // Sort by score descending and limit to Top 5 results
  const top5History = [...history]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);

  if (!top5History || top5History.length === 0) return null;

  return (
    <>
      {/* JARVIS STYLE FLOATING PILL */}
      {!isOpen && (
        <div 
          onClick={() => setIsOpen(true)}
          style={{
            position: 'relative',
            background: 'rgba(0, 229, 255, 0.1)',
            border: '1px solid var(--cyan)',
            borderRadius: 8,
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginRight: 10,
            cursor: 'pointer',
            /* no big shadow */
            transition: 'all 0.3s ease',
            backdropFilter: 'blur(8px)',
            animation: 'pillFadeIn 0.5s ease-out'
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.borderColor = 'rgba(0, 229, 255, 0.6)';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.borderColor = 'rgba(0, 229, 255, 0.3)';
          }}
        >
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--green)',
            boxShadow: '0 0 10px var(--green)',
            animation: 'pulseGreen 2s infinite'
          }} />
          <span style={{
            fontFamily: 'Space Grotesk',
            fontSize: 10,
            fontWeight: 800,
            color: 'var(--t1)',
            letterSpacing: 1.5,
            textTransform: 'uppercase'
          }}>
            JARVIS HISTORY
          </span>
          <div style={{
            background: 'rgba(0, 229, 255, 0.15)',
            color: 'var(--cyan)',
            fontSize: 8,
            fontWeight: 800,
            padding: '2px 6px',
            borderRadius: 4,
            border: '1px solid rgba(0, 229, 255, 0.3)',
            marginLeft: 4
          }}>
            KAYITLI
          </div>
        </div>
      )}

      {/* REFINED PANEL (Matching the requested high-detail style) */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1200,
        background: 'var(--bg2)',
        borderTop: '2px solid var(--cyan)',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.8)',
        transition: 'all 0.4s cubic-bezier(0.19, 1, 0.22, 1)',
        transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
        opacity: isOpen ? 1 : 0,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '420px',
      }}>
        {/* Header Section */}
        <div style={{
          padding: '10px 24px',
          background: 'var(--bg1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{
              fontFamily: 'Space Grotesk',
              fontSize: 12,
              fontWeight: 800,
              color: 'var(--cyan)',
              letterSpacing: 1.5,
              textTransform: 'uppercase'
            }}>
              SON BAŞARILI AI ANALİZİ ({top5History.length})
            </span>
            <div style={{
              fontSize: 8,
              color: 'var(--t3)',
              background: 'var(--bg3)',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              letterSpacing: 0.5
            }}>
              OTOMATİK YEDEK
            </div>
          </div>
          
          <button 
            onClick={() => setIsOpen(false)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--t3)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '4px',
              transition: 'color 0.2s'
            }}
            onMouseOver={(e) => e.currentTarget.style.color = 'var(--red)'}
            onMouseOut={(e) => e.currentTarget.style.color = 'var(--t3)'}
          >
            ✕
          </button>
        </div>

        {/* High-Detail Cards Grid (Matching AI Advisor Style) */}
        <div style={{
          padding: '16px 24px',
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 10,
          background: 'linear-gradient(to bottom, var(--bg2), #06090f)',
        }}>
          {top5History.map((p) => (
            <div key={p.symbol} 
              onClick={() => onAnalyze && onAnalyze(p.symbol)}
              style={{
                background: 'var(--bg3)', 
                borderLeft: '3px solid var(--green)', 
                borderRadius: 4, 
                padding: '10px 14px',
                cursor: 'pointer',
                transition: 'transform 0.2s, border-color 0.2s',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.borderColor = 'var(--cyan)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'var(--green)';
              }}
            >
              {/* Header: Symbol & Signal */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--t1)', fontFamily: 'Space Grotesk' }}>{p.symbol}</span>
                  <span style={{ fontSize: 9, color: 'var(--t3)', marginLeft: 6 }}>{p.sector}</span>
                </div>
                <span style={{ fontWeight: 800, color: 'var(--green)', fontSize: 10, textTransform: 'uppercase' }}>{p.signal}</span>
              </div>

              {/* Metrics Row: Price, Change, R/O, Score */}
              <div style={{ display: 'flex', gap: 10, marginTop: 6, color: 'var(--t2)', fontSize: 10, fontWeight: 500 }}>
                <span>{p.price.toFixed(2)} TL</span>
                <span style={{ color: p.change >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                  {p.change >= 0 ? '+' : ''}{p.change.toFixed(1)}%
                </span>
                <span>R/O 1:{p.rr?.toFixed(1)}</span>
                <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>Skor: {p.score?.toFixed(1)}</span>
              </div>

              {/* Technical Detail Row: Stop, Hedef, Vade */}
              <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10, fontWeight: 600 }}>
                <span style={{ color: 'var(--red)' }}>Stop: {p.stop?.toFixed(2)}</span>
                <span style={{ color: 'var(--green)' }}>Hedef: {p.target?.toFixed(2)}</span>
                <span style={{ color: 'var(--t3)', fontSize: 9, fontWeight: 400 }}>{p.holdText || '1-3 gün (kısa vade)'}</span>
              </div>
            </div>
          ))}
        </div>
        
        {/* Footer info line */}
        <div style={{
          padding: '8px 24px',
          fontSize: 9,
          color: 'var(--t3)',
          textAlign: 'center',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg0)'
        }}>
          * Bu veriler yeni bir tarama tamamlanana kadar güncel kalır. Yeni tarama bittiğinde otomatik güncellenir.
        </div>
      </div>

      <style>{`
        @keyframes pulseGreen {
          0% { box-shadow: 0 0 5px var(--green); }
          50% { box-shadow: 0 0 15px var(--green); }
          100% { box-shadow: 0 0 5px var(--green); }
        }
        @keyframes pillFadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
