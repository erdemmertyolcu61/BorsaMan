import { useState, useEffect } from 'react';
import { getLiveIndicators } from '../../utils/macroData.js';

// v31.47: "Makroekonomik Takvim" → "Makro göstergeler". The header used to count
// 8 client-generated "upcoming events" with invented forecasts; the tiles fell
// back to a hard-coded USDTRY 38.42 and a stale TCMB 50% shown as live. Every
// tile now says where its number comes from or that it has none.

const nf = (d) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const nf2 = nf(2);

function shortDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return '';
  try {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', timeZone: 'Europe/Istanbul' });
  } catch { return key; }
}

function Tile({ ind, kind }) {
  const has = Number.isFinite(ind?.value) && ind.value !== 0;
  let sub;
  let subColor = 'var(--t3)';
  if (!has) {
    sub = 'veri yok';
  } else if (kind === 'policyRate') {
    const when = shortDate(ind.asOf);
    if (ind.stale) {
      sub = `son bilinen${when ? ` · ${when}` : ''}`;
      subColor = 'var(--yellow)';
    } else {
      const arrow = ind.trend === 'dusus' ? '▼ ' : ind.trend === 'yukselis' ? '▲ ' : '';
      sub = `${arrow}karar${when ? ` ${when}` : ''}`;
      subColor = ind.trend === 'dusus' ? 'var(--green)' : ind.trend === 'yukselis' ? 'var(--red)' : 'var(--t3)';
    }
  } else if (ind.trend) {
    sub = `${ind.trend === 'yukselis' ? '▲' : '▼'} 5 gün`;
    subColor = ind.trend === 'yukselis' ? 'var(--green)' : 'var(--red)';
  } else {
    sub = '';
  }
  const value = !has ? '—'
    : kind === 'policyRate' ? `%${nf2.format(ind.value)}`
      : `${nf2.format(ind.value)}${ind.unit ? ` ${ind.unit}` : ''}`;
  return (
    <div style={{ padding: '10px', background: 'var(--bg3)', borderRadius: 10, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{ind?.label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: has ? 'var(--t1)' : 'var(--t3)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, fontWeight: 500, marginTop: 2, color: subColor }}>{sub}</div>
    </div>
  );
}

export default function MacroPanel() {
  const [indicators, setIndicators] = useState(null);
  const [foreignFlow, setForeignFlow] = useState(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let alive = true;
    getLiveIndicators().then(data => { if (alive) setIndicators(data); });
    import('../../utils/foreignFlowEngine.js')
      .then(m => m.fetchMarketForeignFlow())
      .then(data => { if (alive) setForeignFlow(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
      overflow: 'hidden', marginTop: 14,
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        style={{
          width: '100%', padding: '12px 14px', border: 'none', cursor: 'pointer',
          background: 'transparent', borderBottom: expanded ? '1px solid var(--border)' : 'none',
          display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', color: 'var(--t1)',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'left' }}>Makro göstergeler</span>
        <span style={{ fontSize: 12, color: 'var(--t3)', transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>

      {expanded && (
        <div style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 14 }}>
            {!indicators ? (
              <div style={{ gridColumn: 'span 2', textAlign: 'center', padding: 16, color: 'var(--t3)', fontSize: 12 }}>
                Makro veriler yükleniyor…
              </div>
            ) : (
              ['policyRate', 'vix', 'usdtry', 'brent'].map(key => <Tile key={key} kind={key} ind={indicators[key]} />)
            )}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Yabancı net hisse alımı (TCMB, haftalık)</span>
              {foreignFlow && !foreignFlow.error && Number.isFinite(foreignFlow.latestWeeklyFlow) && (
                <span style={{ color: foreignFlow.latestWeeklyFlow >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {foreignFlow.latestWeeklyFlow > 0 ? '+' : ''}{nf(1).format(foreignFlow.latestWeeklyFlow)} mn $
                </span>
              )}
            </div>
            {!foreignFlow ? (
              <div style={{ fontSize: 12, color: 'var(--t3)', padding: 10, textAlign: 'center', background: 'var(--bg3)', borderRadius: 10, lineHeight: 1.5 }}>
                EVDS anahtarı yok — Ayarlar&apos;dan eklenince görünür (ücretsiz: evds3.tcmb.gov.tr).
                Hisse bazlı yabancı oranı anahtarsız: Piyasa sekmesi.
              </div>
            ) : foreignFlow.error ? (
              <div style={{ fontSize: 12, color: 'var(--red)', padding: 10, textAlign: 'center', background: 'var(--red2)', borderRadius: 10 }}>
                {foreignFlow.error}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 44 }}>
                {foreignFlow.flows.slice(-8).map((f, i) => {
                  const h = Math.min(40, Math.max(8, Math.abs(f.valueUSD) / 10));
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${f.date}: $${f.valueUSD}M`}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: f.valueUSD >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {f.valueUSD > 0 ? '+' : ''}{Math.round(f.valueUSD)}
                      </span>
                      <div style={{
                        width: '100%', height: h, borderRadius: 4,
                        background: f.valueUSD >= 0 ? 'rgba(34,197,94,.55)' : 'rgba(239,68,68,.55)',
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
