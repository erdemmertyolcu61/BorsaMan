import { useState } from 'react';

export default function MonitorPanel({ monitor, addToPortfolio, portfolio }) {
  const [expanded, setExpanded] = useState(false);
  const { monitoring, scanning, alerts, lastScan, stats, scanList, setScanList, startMonitor, stopMonitor, clearAlerts, scanMarket, elitePicks } = monitor;

  const lastScanTime = lastScan ? new Date(lastScan).toLocaleTimeString('tr-TR') : '--:--';
  const buyAlerts = alerts.filter(a => a.type === 'buy');
  const sellAlerts = alerts.filter(a => a.type === 'sell');
  const alertCount = buyAlerts.length + sellAlerts.length;
  const scanPct = stats.stocksTotal > 0 ? Math.round(stats.stocksDone / stats.stocksTotal * 100) : 0;

  return (
    <div>
      {/* Floating badge */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          position: 'fixed', bottom: 70, right: 16, zIndex: 1000,
          background: monitoring ? (scanning ? 'linear-gradient(135deg,#1a237e,#4a148c)' : 'linear-gradient(135deg,#1b5e20,#2e7d32)') : 'var(--bg3)',
          border: '1px solid ' + (monitoring ? (scanning ? 'var(--purple)' : 'var(--green)') : 'var(--border)'),
          borderRadius: 30, padding: '8px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)', transition: 'all 0.3s ease',
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: monitoring ? (scanning ? 'var(--yellow)' : 'var(--green)') : 'var(--t3)',
          animation: scanning ? 'monPulse 1s infinite' : monitoring ? 'monPulse 2s infinite' : 'none',
        }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: monitoring ? '#fff' : 'var(--t2)', fontFamily: 'Space Grotesk,sans-serif' }}>
          {scanning ? `TARANIYOR ${scanPct}%` : monitoring ? 'MONİTÖR AKTİF' : 'MONİTÖR'}
        </span>
        {alertCount > 0 && (
          <span style={{
            background: 'var(--red)', color: '#fff', fontSize: 9, fontWeight: 700,
            borderRadius: 10, padding: '1px 6px', minWidth: 16, textAlign: 'center',
          }}>{alertCount}</span>
        )}
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{
          position: 'fixed', bottom: 110, right: 16, zIndex: 999,
          width: 460, maxWidth: 'calc(100vw - 32px)',
          background: 'var(--bg1)', border: '1px solid var(--border2)', borderRadius: 10,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', maxHeight: 520, display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 14, fontWeight: 700, color: 'var(--cyan)' }}>
                Piyasa Monitörü
              </div>
              <div style={{ fontSize: 9, color: 'var(--t3)' }}>
                Son: {lastScanTime} | {stats.scanned} hisse | {stats.opportunities} fırsat
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <select value={scanList} onChange={e => setScanList(e.target.value)} style={{
                fontSize: 9, padding: '4px 6px', background: 'var(--bg3)', color: 'var(--t1)',
                border: '1px solid var(--border)', borderRadius: 3, fontFamily: 'inherit', cursor: 'pointer',
              }}>
                <option value="bistall">Tüm BIST</option>
                <option value="bist30">BIST 30</option>
                <option value="bist50">BIST 50</option>
                <option value="bist100">BIST 100</option>
              </select>
              {!monitoring ? (
                <button onClick={startMonitor} style={btnStyle('var(--green)', '#000')}>BAŞLAT</button>
              ) : (
                <button onClick={stopMonitor} style={btnStyle('var(--red)', '#fff')}>DURDUR</button>
              )}
              <button onClick={() => scanMarket()} disabled={scanning} style={btnStyle('var(--bg3)', 'var(--t1)', true)}>
                {scanning ? `${scanPct}%` : 'TARA'}
              </button>
              <button onClick={clearAlerts} style={btnStyle('transparent', 'var(--t3)', true)}>X</button>
            </div>
          </div>

          {/* Status bar */}
          <div style={{ padding: '6px 16px', background: 'var(--bg0)', display: 'flex', gap: 12, fontSize: 9, color: 'var(--t3)', flexWrap: 'wrap' }}>
            <span>Mod: <b style={{ color: monitoring ? 'var(--green)' : 'var(--red)' }}>{monitoring ? 'AKTIF (15dk)' : 'KAPALI'}</b></span>
            <span>Bildirim: <b style={{ color: notifColor() }}>{notifText()}</b></span>
            <span>Piyasa: <b style={{ color: isMarketOpen() ? 'var(--green)' : 'var(--yellow)' }}>{isMarketOpen() ? 'ACIK' : 'KAPALI'}</b></span>
            <span>AL: <b style={{ color: 'var(--green)' }}>{buyAlerts.length}</b> | SAT: <b style={{ color: 'var(--red)' }}>{sellAlerts.length}</b></span>
          </div>

          {/* Progress bar during scan */}
          {scanning && (
            <div style={{ height: 3, background: 'var(--bg0)' }}>
              <div style={{ height: '100%', width: scanPct + '%', background: 'linear-gradient(90deg,var(--blue),var(--purple))', transition: 'width 0.3s' }} />
            </div>
          )}

          {/* Elite Picks Section - Premium Horizontal Scroll */}
          {elitePicks && elitePicks.length > 0 && (
            <div style={{ padding: '10px 16px', background: 'rgba(99,102,241,0.06)', borderBottom: '1px solid rgba(99,102,241,0.15)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--purple)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, letterSpacing: '0.5px' }}>
                <span style={{ fontSize: 14 }}>★</span> ELİTE FIRSATLAR (GÜÇLÜ SİNYAL)
              </div>
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 8, scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                {elitePicks.map((p, i) => (
                  <div key={i} 
                    onClick={() => onAnalyze && onAnalyze(p.symbol)}
                    style={{
                      minWidth: 155, background: 'var(--bg2)', border: '1px solid var(--border)', 
                      borderRadius: 8, padding: '10px 12px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                      borderTop: '2px solid var(--purple)', position: 'relative', overflow: 'hidden',
                      cursor: 'pointer'
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <b style={{ color: 'var(--t1)', fontSize: 13, letterSpacing: '0.5px' }}>{p.symbol}</b>
                      <span style={{ 
                        fontSize: 9, background: 'var(--green)', color: '#000', 
                        padding: '1px 5px', borderRadius: 4, fontWeight: 800 
                      }}>%{p.confidence}</span>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.sector}</div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--cyan)', marginBottom: 6 }}>{p.price.toFixed(2)} ₺</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                      <span>R/O: <b style={{ color: 'var(--yellow)' }}>1:{p.rr.toFixed(1)}</b></span>
                      <span style={{ color: 'var(--purple)' }}>Sqr: {p.score.toFixed(1)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Elite Intraday Radar — Master Confluence Signals (EMİN) */}
          {monitor.eliteAlerts && monitor.eliteAlerts.length > 0 && (
            <div style={{ padding: '0 12px 10px', background: 'rgba(255,107,0,0.03)', borderBottom: '1px solid rgba(255,107,0,0.1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 4px 6px', fontSize: 10, fontWeight: 900, color: 'var(--orange)', letterSpacing: '1px' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--orange)', animation: 'monPulse 1s infinite' }} />
                MASTER RADAR: GÜN İÇİ EMİN FIRSATLAR
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {monitor.eliteAlerts.map((ea, i) => (
                  <div key={i} onClick={() => ea.symbol && onAnalyze && onAnalyze(ea.symbol)} style={{
                    padding: '8px 12px', background: 'var(--bg2)', border: '1px solid rgba(255,107,0,0.2)', 
                    borderRadius: 6, cursor: 'pointer', borderLeft: '4px solid var(--orange)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 900, color: 'var(--t1)', letterSpacing: '0.5px' }}>{ea.symbol}</span>
                        <span style={{ fontSize: 9, background: 'var(--orange)', color: '#000', padding: '1px 5px', borderRadius: 4, fontWeight: 900 }}>EMİN %{ea.confidence}</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--t2)', fontWeight: 500 }}>{ea.msg.split(': ')[1]}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 8, color: 'var(--t3)' }}>{ea.time}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alert list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', maxHeight: 350 }}>
            {alerts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--t3)', fontSize: 11 }}>
                <div style={{ fontSize: 22, marginBottom: 8 }}>◎</div>
                Henuz alarm yok.<br />
                <span style={{ fontSize: 9 }}>BASLAT ile otomatik tarama veya TARA ile tek sefer tarayin.</span>
              </div>
            ) : (
              [...alerts].reverse().map((a, i) => (
                <div key={i} 
                  onClick={() => a.symbol && onAnalyze && onAnalyze(a.symbol)}
                  style={{
                    padding: '8px 10px', marginBottom: 4, borderRadius: 5,
                    background: alertBg(a.type), borderLeft: '3px solid ' + alertColor(a.type),
                    cursor: a.symbol ? 'pointer' : 'default'
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontSize: 10, color: alertColor(a.type), lineHeight: 1.5, flex: 1 }}>
                      {/* Confidence badge for buy/sell */}
                      {(a.type === 'buy' || a.type === 'sell') && a.confidence && (
                        <span style={{
                          display: 'inline-block', fontSize: 8, fontWeight: 700,
                          background: a.confidence >= 85 ? 'var(--green)' : a.confidence >= 75 ? 'var(--yellow)' : 'var(--orange)',
                          color: '#000', borderRadius: 3, padding: '1px 5px', marginRight: 6,
                        }}>
                          %{a.confidence}{a.confluenceCount >= 3 ? ' ★' : ''}
                        </span>
                      )}
                      {a.msg}
                    </div>
                    <span style={{ fontSize: 8, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{a.time}</span>
                  </div>
                  {/* Quick portfolio action for buy alerts */}
                  {a.type === 'buy' && a.symbol && addToPortfolio && (() => {
                    const alreadyOpen = portfolio?.positions?.some(p => p.symbol === a.symbol && p.status === 'open');
                    if (alreadyOpen) return <span style={{ fontSize: 8, color: 'var(--yellow)', marginTop: 4, display: 'block' }}>Portföyde acik</span>;
                    if (!a.stop || !a.target) return null;
                    return (
                      <button onClick={() => {
                        const cash = portfolio?.cash || 10000;
                        const riskPerShare = Math.abs(a.price - a.stop);
                        const maxRisk = cash * 0.02;
                        let shares = riskPerShare > 0 ? Math.floor(maxRisk / riskPerShare) : 0;
                        const maxByBudget = Math.floor(cash / a.price);
                        if (shares > maxByBudget) shares = maxByBudget;
                        if (shares > 0) addToPortfolio(a.symbol, a.price, a.stop, a.target, shares);
                      }} style={{
                        fontSize: 8, padding: '3px 8px', marginTop: 4,
                        background: 'var(--green)', color: '#000', border: 'none',
                        borderRadius: 3, cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit',
                      }}>+ PORTFOYE EKLE</button>
                    );
                  })()}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 8, color: 'var(--t3)', textAlign: 'center' }}>
            5 katmanli analiz: Sinyal + Kirilma + Pattern + Momentum + Akilli Para. Sadece %80+ guven + 2 teyit + R/O{'>'}1.3 + hacim dogrulama bildirilir. Yatirim tavsiyesi degildir.
          </div>
        </div>
      )}

      <style>{`@keyframes monPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}

function btnStyle(bg, color, border) {
  return {
    fontSize: 9, padding: '5px 10px', background: bg, color,
    border: border ? '1px solid var(--border)' : 'none',
    borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit',
  };
}
function alertBg(type) {
  return type === 'buy' ? 'rgba(0,200,83,0.08)' : type === 'sell' ? 'rgba(255,23,68,0.08)' : type === 'warn' ? 'rgba(255,214,0,0.06)' : type === 'target' ? 'rgba(0,176,255,0.08)' : 'var(--bg3)';
}
function alertColor(type) {
  return type === 'buy' ? 'var(--green)' : type === 'sell' ? 'var(--red)' : type === 'warn' ? 'var(--yellow)' : type === 'target' ? 'var(--cyan)' : 'var(--t2)';
}
function isMarketOpen() {
  const now = new Date();
  return now.getDay() > 0 && now.getDay() < 6 && now.getHours() >= 10 && now.getHours() < 18;
}
function notifColor() {
  if (typeof Notification === 'undefined') return 'var(--red)';
  return Notification.permission === 'granted' ? 'var(--green)' : Notification.permission === 'denied' ? 'var(--red)' : 'var(--yellow)';
}
function notifText() {
  if (typeof Notification === 'undefined') return 'YOK';
  return Notification.permission === 'granted' ? 'IZINLI' : Notification.permission === 'denied' ? 'ENGELLI' : 'BEKLEMEDE';
}
