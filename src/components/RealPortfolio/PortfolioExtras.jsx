/**
 * PortfolioExtras — features rescued from the deleted virtual PortfolioTab (v31.22).
 *
 * The Pano and (virtual) Portfoy tabs were removed, but three things living inside
 * PortfolioTab were still wired into the rest of the app and would have died with it:
 *   1. Watchlist CRUD — `watchlist` feeds useLivePrices' price alarms.
 *   2. Manual close   — without it, virtual positions could only close on stop/target.
 *   3. BrokerSettings — AnalyzeTab reads brokerConfig for its order flow.
 * They are mounted inside RealPortfolioTab instead. Portfolio state itself stays
 * headless in useAppState (risk alerts, trailing stop, position sizing all still run).
 */
import { useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile.js';

const pnlColor = (v) => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t3)');

export function WatchlistPanel({ watchlist = [], setWatchlist, livePrice }) {
  const [wlSymbol, setWlSymbol] = useState('');
  const [wlUp, setWlUp] = useState('');
  const [wlDown, setWlDown] = useState('');

  const addToWatchlist = () => {
    const sym = wlSymbol.trim().toUpperCase();
    if (!sym) return;
    const targetUp = parseFloat(wlUp) || null;
    const targetDown = parseFloat(wlDown) || null;
    const idx = watchlist.findIndex(w => w.symbol === sym);
    const newList = idx >= 0
      ? watchlist.map((w, i) => (i === idx ? { ...w, targetUp, targetDown } : w))
      : [...watchlist, { symbol: sym, targetUp, targetDown, addedAt: Date.now() }];
    setWatchlist?.(newList);
    setWlSymbol(''); setWlUp(''); setWlDown('');
  };

  const removeFromWatchlist = (i) => setWatchlist?.(watchlist.filter((_, j) => j !== i));

  return (
    <div className="trade-box" style={{ marginBottom: 12 }}>
      <div className="trade-title" style={{ color: 'var(--yellow)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{'\u{1F441}'} IZLEME LISTESI &amp; FIYAT ALARMLARI</span>
        <div style={{ flex: 1 }} />
        {livePrice && (
          <span style={{ fontSize: 8, fontWeight: 400, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: livePrice.isMarketOpen ? 'var(--green)' : 'var(--red)' }} />
            {livePrice.isMarketOpen ? 'Canli takip aktif' : 'Piyasa kapali'}
          </span>
        )}
      </div>

      {watchlist.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 16, color: 'var(--t3)', fontSize: 10 }}>
          Liste bos — asagidan hisse ekleyip hedef/stop alarmi kurabilirsin.
        </div>
      ) : watchlist.map((w, i) => {
        const lp = livePrice?.livePrices?.[w.symbol];
        const price = lp?.price || null;
        const isLive = lp && (Date.now() - lp.ts < 120000);
        const upHit = w.targetUp && price && price >= w.targetUp;
        const downHit = w.targetDown && price && price <= w.targetDown;
        return (
          <div key={w.symbol + i} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px',
            background: upHit ? 'rgba(0,200,83,0.06)' : downHit ? 'rgba(255,23,68,0.06)' : 'var(--bg3)',
            borderLeft: `3px solid ${upHit ? 'var(--green)' : downHit ? 'var(--red)' : 'transparent'}`,
            borderRadius: 5, marginBottom: 4,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 12 }}>{w.symbol}</span>
                {isLive && <span style={{ fontSize: 6, color: 'var(--green)', fontWeight: 700, padding: '1px 4px', background: 'rgba(0,200,83,0.15)', borderRadius: 3 }}>CANLI</span>}
                {upHit && <span style={{ fontSize: 7, color: '#000', fontWeight: 700, padding: '1px 6px', background: 'var(--green)', borderRadius: 3 }}>HEDEF!</span>}
                {downHit && <span style={{ fontSize: 7, color: '#fff', fontWeight: 700, padding: '1px 6px', background: 'var(--red)', borderRadius: 3 }}>STOP!</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 3, alignItems: 'center' }}>
                {price != null && <span style={{ fontSize: 11, color: 'var(--cyan)', fontWeight: 600 }}>{price.toFixed(2)} TL</span>}
                {lp?.change != null && <span style={{ fontSize: 9, color: pnlColor(lp.change) }}>{lp.change >= 0 ? '+' : ''}{lp.change.toFixed(2)}%</span>}
                {w.targetUp && <span style={{ fontSize: 8, color: upHit ? 'var(--green)' : 'var(--t3)', marginLeft: 4 }}>{'▲'} {w.targetUp.toFixed(2)}</span>}
                {w.targetDown && <span style={{ fontSize: 8, color: downHit ? 'var(--red)' : 'var(--t3)', marginLeft: 4 }}>{'▼'} {w.targetDown.toFixed(2)}</span>}
              </div>
            </div>
            <button onClick={() => removeFromWatchlist(i)} style={{
              fontSize: 9, padding: '2px 6px', background: 'none', color: 'var(--red)',
              border: '1px solid var(--red)', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
            }}>X</button>
          </div>
        );
      })}

      <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="inp" value={wlSymbol} onChange={e => setWlSymbol(e.target.value.toUpperCase())}
          placeholder="Hisse" style={{ width: 80, fontSize: 10, padding: 6 }}
          onKeyDown={e => e.key === 'Enter' && addToWatchlist()} />
        <input className="inp" type="number" value={wlUp} onChange={e => setWlUp(e.target.value)} placeholder="Hedef TL" style={{ width: 90, fontSize: 10, padding: 6 }} />
        <input className="inp" type="number" value={wlDown} onChange={e => setWlDown(e.target.value)} placeholder="Stop TL" style={{ width: 90, fontSize: 10, padding: 6 }} />
        <button className="btn btn-go" onClick={addToWatchlist} style={{ fontSize: 9, padding: '6px 10px', width: 'auto' }}>EKLE</button>
      </div>
      <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 6 }}>
        Hedef/stop seviyeleri piyasa saatlerinde canli fiyat takibiyle otomatik kontrol edilir.
      </div>
    </div>
  );
}

export function VirtualPositionsPanel({ portfolio, updatePortfolio }) {
  const isMobile = useIsMobile();
  const open = (portfolio?.positions || []).filter(p => p.status === 'open');

  const closePosition = (symbol, openedAt) => {
    updatePortfolio?.(prev => {
      const idx = prev.positions.findIndex(p => p.symbol === symbol && p.openedAt === openedAt && p.status === 'open');
      if (idx < 0) return prev;
      const pos = prev.positions[idx];
      const exit = pos.currentPrice || pos.entryPrice;
      const pnl = (exit - pos.entryPrice) * pos.shares;
      const pnlPct = ((exit - pos.entryPrice) / pos.entryPrice) * 100;
      const newPositions = [...prev.positions];
      newPositions[idx] = { ...pos, status: 'closed', pnl, pnlPct, closedAt: new Date().toISOString() };
      return {
        ...prev,
        positions: newPositions,
        cash: prev.cash + pos.shares * exit,
        history: [...(prev.history || []), { date: new Date().toISOString(), action: 'SELL', symbol: pos.symbol, shares: pos.shares, price: exit }],
      };
    });
  };

  if (!open.length) return null;

  // v31.23: MEASURED at 375px the 8-column table is 498px wide inside a 305px
  // container - it scrolls, but the KAPAT button (the only reason to open this
  // panel on a phone) sits off-screen. Cards put every field in view instead.
  if (isMobile) {
    return (
      <div className="trade-box" style={{ marginBottom: 12 }}>
        <div className="trade-title" style={{ color: 'var(--purple)' }}>
          {'\u{1F4C4}'} SANAL POZISYONLAR ({open.length})
        </div>
        {open.map((p, i) => {
          const cur = p.currentPrice || p.entryPrice;
          const pnlPct = ((cur - p.entryPrice) / p.entryPrice) * 100;
          return (
            <div key={p.symbol + i} style={{
              background: 'var(--bg3)', borderRadius: 6, padding: 10, marginBottom: 6,
              borderLeft: `3px solid ${pnlColor(pnlPct)}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{p.symbol}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: pnlColor(pnlPct) }}>
                  {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                </span>
                <div style={{ flex: 1 }} />
                <button onClick={() => closePosition(p.symbol, p.openedAt)} style={{
                  fontSize: 10, padding: '6px 14px', background: 'none', color: 'var(--orange)',
                  border: '1px solid var(--orange)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                }}>KAPAT</button>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--t3)' }}>
                <span>{p.shares} adet</span>
                <span>Giris <b style={{ color: 'var(--t1)' }}>{p.entryPrice?.toFixed(2)}</b></span>
                <span>Guncel <b style={{ color: 'var(--cyan)' }}>{cur?.toFixed(2)}</b></span>
                <span>Stop <b style={{ color: 'var(--red)' }}>{p.stopLoss != null ? p.stopLoss.toFixed(2) : '-'}</b></span>
                <span>Hedef <b style={{ color: 'var(--green)' }}>{p.target != null ? p.target.toFixed(2) : '-'}</b></span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="trade-box" style={{ marginBottom: 12 }}>
      <div className="trade-title" style={{ color: 'var(--purple)' }}>
        {'\u{1F4C4}'} SANAL POZISYONLAR ({open.length})
        <span style={{ fontSize: 8, fontWeight: 400, color: 'var(--t3)', marginLeft: 8 }}>
          kagit hesap · stop/hedef otomatik, buradan elle de kapatabilirsin
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--t3)' }}>
              {['Hisse', 'Adet', 'Giris', 'Guncel', 'K/Z %', 'Stop', 'Hedef', ''].map(h => (
                <th key={h} style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {open.map((p, i) => {
              const cur = p.currentPrice || p.entryPrice;
              const pnlPct = ((cur - p.entryPrice) / p.entryPrice) * 100;
              return (
                <tr key={p.symbol + i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '5px 8px', fontWeight: 700 }}>{p.symbol}</td>
                  <td style={{ padding: '5px 8px' }}>{p.shares}</td>
                  <td style={{ padding: '5px 8px' }}>{p.entryPrice?.toFixed(2)}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--cyan)' }}>{cur?.toFixed(2)}</td>
                  <td style={{ padding: '5px 8px', color: pnlColor(pnlPct), fontWeight: 700 }}>
                    {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                  </td>
                  <td style={{ padding: '5px 8px', color: 'var(--red)' }}>{p.stopLoss != null ? p.stopLoss.toFixed(2) : '-'}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--green)' }}>{p.target != null ? p.target.toFixed(2) : '-'}</td>
                  <td style={{ padding: '5px 8px' }}>
                    <button onClick={() => closePosition(p.symbol, p.openedAt)} style={{
                      fontSize: 9, padding: '2px 8px', background: 'none', color: 'var(--orange)',
                      border: '1px solid var(--orange)', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                    }}>KAPAT</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
