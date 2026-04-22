import { useState, useEffect } from 'react';
import { useActiveAgents } from '../../hooks/useActiveAgents.js';

export default function ActiveAgentsPanel({ portfolio, onAnalyze }) {
  const {
    agentStatus,
    lastScan,
    opportunities,
    scanProgress,
    alerts,
    startAgent,
    stopAgent,
    runAgentScan,
    runTop10Prediction,
    clearAlerts
  } = useActiveAgents(portfolio, null);

  const [panelOpen, setPanelOpen] = useState(false);

  const statusColors = {
    idle: 'var(--t3)',
    scanning: 'var(--orange)',
    predicting: 'var(--cyan)'
  };

  const statusLabels = {
    idle: 'BEKLIYOR',
    scanning: 'TARANIYOR',
    predicting: 'TAHMIN'
  };

  return (
    <>
      {/* Agent Control Bar */}
      <div style={{ 
        background: 'var(--bg2)', 
        borderBottom: '1px solid var(--border)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ 
            width: 8, height: 8, borderRadius: '50%', 
            background: agentStatus === 'idle' ? 'var(--t3)' : 'var(--green)',
            boxShadow: agentStatus !== 'idle' ? '0 0 8px var(--green)' : 'none',
            animation: agentStatus !== 'idle' ? 'pulse 2s infinite' : 'none'
          }} />
          <span style={{ fontWeight: 700, color: 'var(--cyan)', fontSize: 12, letterSpacing: 0.5 }}>
            🤖 ACTIVE AGENT
          </span>
          <span style={{ color: statusColors[agentStatus], fontSize: 11, fontWeight: 600 }}>
            {statusLabels[agentStatus]}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button 
            onClick={agentStatus === 'idle' ? startAgent : stopAgent}
            style={{
              background: agentStatus === 'idle' ? 'var(--green)' : 'var(--red)',
              color: '#000',
              border: 'none',
              borderRadius: 4,
              padding: '4px 12px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            {agentStatus === 'idle' ? '▶ BAŞLAT' : '■ DUR'}
          </button>
          
          <button 
            onClick={() => {
              runAgentScan();
              runTop10Prediction();
            }}
            disabled={agentStatus !== 'idle'}
            style={{
              background: agentStatus === 'idle' ? 'var(--blue)' : 'var(--bg3)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '4px 12px',
              fontSize: 10,
              fontWeight: 600,
              cursor: agentStatus === 'idle' ? 'pointer' : 'default',
              opacity: agentStatus === 'idle' ? 1 : 0.5
            }}
          >
            🔄 TARA
          </button>

          <button 
            onClick={() => setPanelOpen(!panelOpen)}
            style={{
              background: 'var(--bg3)',
              color: 'var(--t1)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            {panelOpen ? '▼' : '▲'} PANEL
          </button>
        </div>
      </div>

      {/* Expanded Panel */}
      {panelOpen && (
        <div style={{ 
          background: 'var(--bg1)', 
          borderBottom: '1px solid var(--cyan)',
          maxHeight: 400,
          overflow: 'auto',
          padding: 12
        }}>
          {/* Status */}
          <div style={{ marginBottom: 12, display: 'flex', gap: 16, fontSize: 10, color: 'var(--t3)' }}>
            <span>Son tarama: {lastScan ? lastScan.toLocaleTimeString('tr-TR') : '-'}</span>
            <span>Tarama: {scanProgress.done}/{scanProgress.total}</span>
            <span>Agent: {agentStatus}</span>
          </div>

          {/* Opportunities */}
          {opportunities.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', marginBottom: 8 }}>
                🎯 FIRSATLAR ({opportunities.length})
              </div>
              {opportunities.slice(0, 5).map((opp, i) => (
                <div key={opp.symbol} style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'var(--bg2)', padding: '6px 10px', borderRadius: 4, marginBottom: 4,
                  borderLeft: opp.cls === 'buy' ? '3px solid var(--green)' : '3px solid var(--red)'
                }}>
                  <div>
                    <button onClick={() => onAnalyze && onAnalyze(opp.symbol)} style={{
                      background: 'none', border: 'none', color: 'var(--green)', 
                      fontWeight: 700, cursor: 'pointer', fontSize: 12
                    }}>
                      {opp.symbol}
                    </button>
                    <span style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 8 }}>
                      {opp.change?.toFixed(1)}%
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: opp.score >= 70 ? 'var(--green)' : 'var(--yellow)' }}>
                      {opp.score?.toFixed(0)}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--t3)', marginLeft: 6 }}>
                      {opp.signal}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent Alerts */}
          {alerts.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span>SON UYARILAR</span>
                <button onClick={clearAlerts} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 9 }}>
                  TEMIZLA
                </button>
              </div>
              {alerts.slice(0, 5).map((alert, i) => (
                <div key={alert.id} style={{ 
                  fontSize: 10, color: alert.type === 'error' ? 'var(--red)' : alert.type === 'opportunity' ? 'var(--green)' : 'var(--t3)',
                  padding: '4px 0', borderBottom: '1px solid var(--border)'
                }}>
                  <span style={{ fontWeight: 600 }}>{alert.title}</span>
                  <span style={{ marginLeft: 8 }}>{alert.message}</span>
                </div>
              ))}
            </div>
          )}

          {opportunities.length === 0 && alerts.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--t3)', fontSize: 11, padding: 20 }}>
              Agent aktif değil. "BAŞLAT" butonuna basarak piyasa taramasını başlatabilirsiniz.
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </>
  );
}