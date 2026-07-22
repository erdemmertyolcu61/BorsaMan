/**
 * RealPortfolioTab — REAL multi-market (US + BIST) holdings.
 *
 * The terminal's "Portföy" tab is a virtual paper account; this one tracks
 * actual positions, ported from the standalone Python tracker. Positions are
 * kept in localStorage only (personal data) and edited via JSON — mirroring the
 * Python workflow of hand-editing portfolio.json.
 */
import { useState } from 'react';
import { useRealPortfolio } from '../../hooks/useRealPortfolio.js';
import { positionMetrics, summarizeGroup, allocationPct } from '../../utils/realPortfolio.js';

const money = (v, cur) => {
  const n = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v || 0));
  const sym = cur === 'USD' ? '$' : '₺';
  return (v < 0 ? '-' : '') + sym + n;
};
const pct = (v) => (v >= 0 ? '+' : '') + (v || 0).toFixed(2) + '%';
const pnlColor = (v) => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t3)');

function GroupBlock({ title, positions, currency }) {
  if (!positions.length) return null;
  const sum = summarizeGroup(positions);
  return (
    <div className="trade-box" style={{ marginBottom: 12 }}>
      <div className="trade-title" style={{ color: 'var(--cyan)' }}>
        {title} ({positions.length}) · {money(sum.totalValue, currency)}
        <span style={{ marginLeft: 8, color: pnlColor(sum.totalReturn), fontWeight: 700 }}>
          {' · '}{money(sum.totalReturn, currency)} ({pct(sum.totalReturnPct)})
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--t3)' }}>
              {['Hisse', 'Adet', 'Ort. Maliyet', 'Güncel', 'Değer', 'K/Z', 'K/Z %', 'Ağırlık'].map(h => (
                <th key={h} style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map(p => {
              const m = positionMetrics(p);
              return (
                <tr key={p.ticker} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--t1)' }}>{p.ticker}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--t2)' }}>{p.quantity}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--t2)' }}>{money(p.avgCost, currency)}</td>
                  <td style={{ padding: '6px 8px', color: m.hasPrice ? 'var(--t1)' : 'var(--orange)' }}>
                    {m.hasPrice ? money(p.currentPrice, currency) : 'veri yok'}
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--t2)' }}>{m.hasPrice ? money(m.value, currency) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: pnlColor(m.ret), fontWeight: 700 }}>{m.hasPrice ? money(m.ret, currency) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: pnlColor(m.ret), fontWeight: 700 }}>{m.hasPrice ? pct(m.retPct) : '—'}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--t3)' }}>{m.hasPrice ? allocationPct(p, positions).toFixed(1) + '%' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sum.missingTickers.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--orange)', marginTop: 6 }}>
          Fiyat alınamadı: {sum.missingTickers.join(', ')} — toplamlara dahil edilmedi.
        </div>
      )}
    </div>
  );
}

export default function RealPortfolioTab() {
  const { positions, setPositions, refresh, loading, lastUpdate, usdTry, totals, alerts } = useRealPortfolio();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');

  const openEditor = () => {
    setDraft(JSON.stringify({ positions: positions.map(({ currentPrice, ...p }) => p) }, null, 2));
    setErr('');
    setEditing(true);
  };

  const save = () => {
    try {
      const parsed = JSON.parse(draft);
      setPositions(parsed);
      setEditing(false);
      setErr('');
      setTimeout(refresh, 50);
    } catch (e) {
      setErr('Geçersiz JSON: ' + (e.message || e));
    }
  };

  const us = positions.filter(p => p.market === 'US');
  const bist = positions.filter(p => p.market === 'BIST');

  return (
    <div style={{ padding: '14px 16px 28px', fontFamily: 'JetBrains Mono, monospace', maxWidth: 1400 }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', letterSpacing: 1 }}>{'💼'} GERÇEK PORTFÖY</span>
        <span style={{ fontSize: 9, color: 'var(--t3)' }}>ABD + BIST · gerçek pozisyonlar (sadece bu cihazda saklanır)</span>
        <div style={{ flex: 1 }} />
        {usdTry && <span style={{ fontSize: 10, color: 'var(--cyan)' }}>USD/TRY {usdTry.toFixed(2)}</span>}
        {lastUpdate && <span style={{ fontSize: 9, color: 'var(--t3)' }}>{new Date(lastUpdate).toLocaleTimeString('tr-TR')}</span>}
        <button onClick={refresh} disabled={loading} style={{
          padding: '5px 12px', borderRadius: 5, cursor: loading ? 'default' : 'pointer', fontSize: 10, fontWeight: 700,
          background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.35)', color: 'var(--cyan)',
        }}>{loading ? '↻ Yenileniyor...' : '↻ Fiyatları Yenile'}</button>
        <button onClick={openEditor} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 700,
          background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.35)', color: '#a78bfa',
        }}>✎ Pozisyonları Düzenle</button>
      </div>

      {/* EDITOR */}
      {editing && (
        <div className="trade-box" style={{ marginBottom: 12 }}>
          <div className="trade-title" style={{ color: '#a78bfa' }}>Pozisyonlar (JSON)</div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 6 }}>
            Alanlar: ticker, market (US|BIST), quantity, avgCost (veya avg_cost), currency. Python
            projesindeki portfolio.json içeriğini doğrudan yapıştırabilirsin.
          </div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} style={{
            width: '100%', minHeight: 220, background: 'var(--bg2)', color: 'var(--t1)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: 10,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
          }} />
          {err && <div style={{ color: 'var(--red)', fontSize: 10, marginTop: 6 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={save} style={{
              padding: '6px 14px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              background: 'rgba(16,232,122,0.15)', border: '1px solid rgba(16,232,122,0.4)', color: 'var(--green)',
            }}>Kaydet & Yenile</button>
            <button onClick={() => setEditing(false)} style={{
              padding: '6px 14px', borderRadius: 5, cursor: 'pointer', fontSize: 11,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--t2)',
            }}>İptal</button>
          </div>
        </div>
      )}

      {/* EMPTY STATE */}
      {positions.length === 0 && !editing && (
        <div className="trade-box" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: 26, marginBottom: 10 }}>{'💼'}</div>
          <div style={{ color: 'var(--t2)', fontSize: 12, marginBottom: 6 }}>Henüz gerçek pozisyon eklenmedi.</div>
          <div style={{ color: 'var(--t3)', fontSize: 10, maxWidth: 520, margin: '0 auto 12px' }}>
            &ldquo;Pozisyonları Düzenle&rdquo; ile ABD ve BIST hisselerini ekle. Veriler yalnızca bu
            cihazın tarayıcısında saklanır — hiçbir yere gönderilmez.
          </div>
          <button onClick={openEditor} style={{
            padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
            background: 'linear-gradient(135deg, var(--cyan), var(--blue))', color: '#fff', border: 'none',
          }}>Pozisyon Ekle</button>
        </div>
      )}

      {/* TOTALS */}
      {positions.length > 0 && (
        <div className="trade-box" style={{ marginBottom: 12 }}>
          <div className="trade-title" style={{ color: 'var(--purple)' }}>TOPLAM (TRY bazında)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, fontSize: 11 }}>
            <div className="tr-row"><span className="tr-l">Toplam Değer</span><span className="tr-v" style={{ color: 'var(--t1)', fontWeight: 800 }}>{money(totals.totalValueTRY, 'TRY')}</span></div>
            <div className="tr-row"><span className="tr-l">Maliyet</span><span className="tr-v" style={{ color: 'var(--t2)' }}>{money(totals.totalCostTRY, 'TRY')}</span></div>
            <div className="tr-row"><span className="tr-l">Kâr / Zarar</span><span className="tr-v" style={{ color: pnlColor(totals.totalReturnTRY), fontWeight: 800 }}>{money(totals.totalReturnTRY, 'TRY')}</span></div>
            <div className="tr-row"><span className="tr-l">Getiri</span><span className="tr-v" style={{ color: pnlColor(totals.totalReturnTRY), fontWeight: 800 }}>{pct(totals.totalReturnPct)}</span></div>
          </div>
          {totals.usConversionMissing && (
            <div style={{ fontSize: 9, color: 'var(--orange)', marginTop: 6 }}>
              USD/TRY kuru alınamadı — ABD pozisyonları TRY toplamına dahil edilmedi.
            </div>
          )}
        </div>
      )}

      {/* ALERTS */}
      {alerts.length > 0 && (
        <div className="trade-box" style={{ marginBottom: 12 }}>
          <div className="trade-title" style={{ color: 'var(--orange)' }}>{'⚠'} ALARMLAR ({alerts.length})</div>
          {alerts.map(a => (
            <div key={a.ticker + a.kind} style={{ fontSize: 10, padding: '3px 0', color: a.kind === 'loss' ? 'var(--red)' : 'var(--green)' }}>
              {a.kind === 'loss' ? '▼' : '▲'} {a.message}
            </div>
          ))}
        </div>
      )}

      <GroupBlock title="🇺🇸 ABD" positions={us} currency="USD" />
      <GroupBlock title="🇹🇷 BIST" positions={bist} currency="TRY" />
    </div>
  );
}
