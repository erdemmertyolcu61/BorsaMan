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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 14 }}>
            {!indicators ? (
              <div style={{ gridColumn: 'span 4', textAlign: 'center', padding: 20, color: 'var(--yellow)', fontSize: 11, animation: 'pulse 1.5s infinite' }}>
                ⟳ Canlı Makro Veriler Senkronize Ediliyor...
              </div>
            ) : (
              ['policyRate', 'tufe', 'usdtry', 'bist100'].map(key => {
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
              {foreignFlow && <span style={{ color: foreignFlow.latestWeeklyFlow >= 0 ? 'var(--green)' : 'var(--red)' }}>Son Hafta: {foreignFlow.latestWeeklyFlow > 0 ? '+' : ''}{foreignFlow.latestWeeklyFlow}M $</span>}
            </div>
            {!foreignFlow ? (
              <div style={{ fontSize: 10, color: 'var(--t3)', padding: '10px', textAlign: 'center', background: 'var(--bg3)', borderRadius: 8 }}>
                Veri bekleniyor... (API anahtarı girilmemiş olabilir)
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

          {/* Rate Decision Impact */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
              Faiz Kararı → BIST100 Etkisi
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 50 }}>
              {impacts.map((imp, i) => {
                const h = Math.max(8, Math.abs(imp.bist100Change) * 12);
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ fontSize: 8, fontWeight: 700, color: imp.bist100Change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {imp.bist100Change > 0 ? '+' : ''}{imp.bist100Change}%
                    </span>
                    <div style={{
                      width: '100%', height: h, borderRadius: 3,
                      background: imp.bist100Change >= 0
                        ? 'linear-gradient(180deg, rgba(74,222,128,.6), rgba(74,222,128,.2))'
                        : 'linear-gradient(180deg, rgba(248,113,113,.6), rgba(248,113,113,.2))',
                    }} />
                    <span style={{ fontSize: 7, color: 'var(--t3)' }}>
                      {new Date(imp.date).toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Upcoming Events Timeline */}
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Yaklaşan Etkinlikler</span>
            {events && events.length > 0 && (
              <span style={{ fontSize: 8, fontWeight: 500, color: 'var(--t3)', textTransform: 'none', letterSpacing: 0 }}>
                {events.filter(e => e.source === 'forexfactory').length > 0 ? '🟢 Canlı Veri' : '📋 Yerel Takvim'}
              </span>
            )}
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {!events ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--yellow)', fontSize: 11, animation: 'pulse 1.5s infinite' }}>
                ⟳ Etkinlik Takvimi Yükleniyor...
              </div>
            ) : events.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--t3)', fontSize: 11 }}>
                Yakın zamanda önemli bir etkinlik bulunamadı.
              </div>
            ) : (
              events.slice(0, 20).map((evt, i) => {
                const evtDate = new Date(evt.date);
                const daysUntil = Math.ceil((evtDate - now) / 86400000);
                const cfg = getEventTypeConfig(evt.type);
                const isPast = daysUntil < 0;
                return (
                  <div key={evt.id || i} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
                    borderBottom: i < 19 ? '1px solid rgba(255,255,255,.04)' : 'none',
                    opacity: isPast ? 0.55 : 1,
                  }}>
                    <span style={{ fontSize: 14, width: 24, textAlign: 'center' }}>{cfg.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{evt.title}</div>
                      <div style={{ fontSize: 8, color: 'var(--t3)', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span>{evtDate.toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                        {evt.source === 'forexfactory' && <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>FF</span>}
                      </div>
                    </div>
                    <div style={{
                      padding: '3px 8px', borderRadius: 10, fontSize: 8, fontWeight: 700,
                      color: getImpactColor(evt.impact),
                      background: evt.impact === 'high' ? 'rgba(239,68,68,.1)' : evt.impact === 'medium' ? 'rgba(245,158,11,.1)' : 'rgba(107,114,128,.1)',
                    }}>
                      {evt.impact === 'high' ? 'YÜKSEK' : evt.impact === 'medium' ? 'ORTA' : 'DÜŞÜK'}
                    </div>
                    {(evt.forecast || evt.previous || evt.actual) && (
                      <div style={{ fontSize: 8, color: 'var(--t2)', minWidth: 70, textAlign: 'right' }}>
                        {evt.actual && <span style={{ color: 'var(--green)', fontWeight: 700 }}>G: {evt.actual} </span>}
                        {evt.forecast && <span>T: {evt.forecast} </span>}
                        {evt.previous && <span style={{ color: 'var(--t3)' }}>Ö: {evt.previous}</span>}
                      </div>
                    )}
                    <div style={{
                      fontSize: 9, fontWeight: 700, minWidth: 44, textAlign: 'right',
                      color: daysUntil < 0 ? 'var(--t3)' : daysUntil <= 1 ? 'var(--red)' : daysUntil <= 3 ? 'var(--orange)' : daysUntil <= 7 ? 'var(--yellow)' : 'var(--t3)',
                    }}>
                      {daysUntil === 0 ? 'BUGÜN' : daysUntil === 1 ? 'YARIN' : daysUntil < 0 ? (daysUntil + ' gün') : (daysUntil + ' gün')}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
