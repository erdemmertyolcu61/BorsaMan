import { useState, useEffect } from 'react';
import { getUpcomingEvents, getRateDecisionImpact, getEventTypeConfig, getImpactColor, getLiveIndicators, getLiveEvents } from '../../utils/macroData.js';

export default function MacroPanel() {
  const [events, setEvents] = useState(null);
  const [indicators, setIndicators] = useState(null);
  const [foreignFlow, setForeignFlow] = useState(null);
  const [impacts] = useState(() => getRateDecisionImpact());
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    getLiveIndicators().then(data => setIndicators(data));
    getLiveEvents().then(data => setEvents(data));
    import('../../utils/foreignFlowEngine.js')
      .then(m => m.fetchMarketForeignFlow())
      .then(data => setForeignFlow(data))
      .catch(() => {});
  }, []);

  const now = new Date();

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      overflow: 'hidden', marginTop: 14,
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', padding: '10px 14px', border: 'none', cursor: 'pointer',
          background: 'linear-gradient(135deg, rgba(59,130,246,.06), rgba(139,92,246,.04))',
          borderBottom: expanded ? '1px solid var(--border)' : 'none',
          display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 16 }}>📅</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)', flex: 1, textAlign: 'left' }}>
          Makroekonomik Takvim
        </span>
        <span style={{ fontSize: 9, color: 'var(--t3)', marginRight: 6 }}>
          {events ? events.length : 0} yaklaşan etkinlik
        </span>
        <span style={{ fontSize: 10, transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', color: 'var(--t3)' }}>▼</span>
      </button>

      {expanded && (
        <div style={{ padding: 14 }}>
          {/* Key Indicators */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
            {!indicators ? (
              <div style={{ gridColumn: 'span 4', textAlign: 'center', padding: 20, color: 'var(--yellow)', fontSize: 11, animation: 'pulse 1.5s infinite' }}>
                ⟳ Canlı Makro Veriler Senkronize Ediliyor...
              </div>
            ) : (
              ['policyRate', 'vix', 'usdtry', 'brent'].map(key => {
                const ind = indicators[key];
                return (
                  <div key={key} style={{
                    padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8,
                    border: '1px solid var(--border)', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{ind.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginTop: 2 }}>
                      {key === 'bist100' ? ind.value.toLocaleString() : ind.value.toFixed(2)}{ind.unit ? ' ' + ind.unit : ''}
                    </div>
                    <div style={{
                      fontSize: 8, fontWeight: 600, marginTop: 2,
                      color: ind.trend === 'yukselis' ? 'var(--green)' : ind.trend === 'dusus' ? 'var(--red)' : 'var(--t3)',
                    }}>
                      {ind.trend === 'yukselis' ? '▲' : ind.trend === 'dusus' ? '▼' : '◆'} {ind.trend.toUpperCase()}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Foreign Flow Section */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
              <span>Yabancı Para Girişi (TCMB EVDS)</span>
              {foreignFlow && !foreignFlow.error && <span style={{ color: foreignFlow.latestWeeklyFlow >= 0 ? 'var(--green)' : 'var(--red)' }}>Son Hafta: {foreignFlow.latestWeeklyFlow > 0 ? '+' : ''}{foreignFlow.latestWeeklyFlow}M $</span>}
            </div>
            {!foreignFlow ? (
              <div style={{ fontSize: 10, color: 'var(--t3)', padding: '10px', textAlign: 'center', background: 'var(--bg3)', borderRadius: 8 }}>
                Veri bekleniyor... (API anahtarı girilmemiş olabilir)
              </div>
            ) : foreignFlow.error ? (
              <div style={{ fontSize: 10, color: 'var(--red)', padding: '10px', textAlign: 'center', background: 'rgba(248, 113, 113, 0.1)', borderRadius: 8 }}>
                {foreignFlow.error}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 40 }}>
                {foreignFlow.flows.slice(-8).map((f, i) => {
                  const h = Math.min(40, Math.max(8, Math.abs(f.valueUSD) / 10));
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${f.date}: $${f.valueUSD}M`}>
                      <span style={{ fontSize: 7, fontWeight: 700, color: f.valueUSD >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {f.valueUSD > 0 ? '+' : ''}{Math.round(f.valueUSD)}
                      </span>
                      <div style={{
                        width: '100%', height: h, borderRadius: 3,
                        background: f.valueUSD >= 0
                          ? 'linear-gradient(180deg, rgba(74,222,128,.8), rgba(74,222,128,.3))'
                          : 'linear-gradient(180deg, rgba(248,113,113,.8), rgba(248,113,113,.3))',
                      }} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
