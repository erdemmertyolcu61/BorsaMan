import { useState, useCallback } from 'react';
import { fetchSingle } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal, calcPosition } from '../../utils/signals.js';
import { SECTORS } from '../../utils/constants.js';
import TradeJournal from './TradeJournal.jsx';
import PerformanceAnalytics from './PerformanceAnalytics.jsx';
import BrokerSettings from './BrokerSettings.jsx';

function PositionCard({ p, idx, livePrice, closePosition, isInvestment }) {
  const lp = livePrice?.livePrices?.[p.symbol];
  const currentPrice = (lp && lp.price > 0) ? lp.price : p.currentPrice;
  const pnl = (currentPrice - p.entryPrice) * p.shares;
  const pnlPct = (currentPrice - p.entryPrice) / p.entryPrice * 100;
  const stopDist = p.stopLoss ? ((currentPrice - p.stopLoss) / currentPrice * 100) : null;
  const targetDist = p.target ? ((p.target - currentPrice) / currentPrice * 100) : null;
  const isLive = lp && (Date.now() - lp.ts < 120000);

  const borderCol = isInvestment ? 'var(--purple)' : (pnl >= 0 ? 'var(--green)' : 'var(--red)');

  return (
    <div style={{ background: 'var(--bg3)', borderLeft: '3px solid ' + borderCol, borderRadius: 5, padding: 10, marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{p.symbol}</span>
            {isLive && <span style={{ fontSize: 6, color: 'var(--green)', fontWeight: 700, padding: '1px 4px', background: 'rgba(0,200,83,0.15)', borderRadius: 3 }}>CANLI</span>}
            {isInvestment && <span style={{ fontSize: 6, color: 'var(--purple)', fontWeight: 700, padding: '1px 4px', background: 'rgba(139,92,246,0.15)', borderRadius: 3 }}>YATIRIM</span>}
          </div>
          <div style={{ fontSize: 9, color: 'var(--t3)' }}>{p.shares} lot @ {p.entryPrice.toFixed(2)} TL</div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
            {p.stopLoss != null && <span style={{ color: 'var(--red)' }}>Stop: {p.stopLoss.toFixed(2)} ({stopDist != null ? stopDist.toFixed(1) : '?'}%)</span>}
            {p.target != null && <span style={{ color: 'var(--green)', marginLeft: 8 }}>Hedef: {p.target.toFixed(2)} (+{targetDist != null ? targetDist.toFixed(1) : '?'}%)</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(0)} TL ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</div>
          <div style={{ fontSize: 9, color: 'var(--t3)' }}>Maliyet: {(p.shares * p.entryPrice).toFixed(0)} TL</div>
          <button onClick={() => closePosition(idx)} style={{ fontSize: 9, padding: '2px 8px', background: 'var(--red2)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}>KAPAT</button>
        </div>
      </div>
    </div>
  );
}

export default function PortfolioTab({ portfolio, updatePortfolio, brokerConfig, setBrokerConfig, livePrice, alertLog, watchlist: propWatchlist, setWatchlist: propSetWatchlist }) {
  // Use prop watchlist if provided (synced with App), fallback to local state
  const [localWatchlist, setLocalWatchlist] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('bist_watchlist') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  const watchlist = propWatchlist || localWatchlist;
  const setWatchlist = (newList) => {
    if (propSetWatchlist) propSetWatchlist(newList);
    else setLocalWatchlist(newList);
    localStorage.setItem('bist_watchlist', JSON.stringify(newList));
  };
  const [wlSymbol, setWlSymbol] = useState('');
  const [wlUp, setWlUp] = useState('');
  const [wlDown, setWlDown] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeLog, setOptimizeLog] = useState([]);
  const [wlPrices, setWlPrices] = useState({});

  const addLog = useCallback((msg, cls = 'info') => {
    setOptimizeLog(prev => [...prev.slice(-30), { msg, cls, time: new Date().toLocaleTimeString('tr-TR') }]);
  }, []);

  const closePosition = (idx) => {
    updatePortfolio(prev => {
      const pos = prev.positions[idx];
      if (!pos || pos.status !== 'open') return prev;
      const pnl = (pos.currentPrice - pos.entryPrice) * pos.shares;
      const pnlPct = (pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100;
      const newPositions = [...prev.positions];
      newPositions[idx] = { ...pos, status: 'closed', pnl, pnlPct, closedAt: new Date().toISOString() };
      return {
        ...prev,
        positions: newPositions,
        cash: prev.cash + pos.shares * pos.currentPrice,
        history: [...prev.history, { date: new Date().toISOString(), action: 'SELL', symbol: pos.symbol, shares: pos.shares, price: pos.currentPrice }],
      };
    });
  };

  const resetPortfolio = () => updatePortfolio({ positions: [], cash: 10000, history: [] });

  const addToWatchlist = () => {
    const sym = wlSymbol.trim().toUpperCase();
    if (!sym) return;
    const newList = [...watchlist];
    const exists = newList.find(w => w.symbol === sym);
    if (exists) { exists.targetUp = parseFloat(wlUp) || null; exists.targetDown = parseFloat(wlDown) || null; }
    else newList.push({ symbol: sym, targetUp: parseFloat(wlUp) || null, targetDown: parseFloat(wlDown) || null, addedAt: Date.now() });
    setWatchlist(newList);
    setWlSymbol(''); setWlUp(''); setWlDown('');
  };

  const removeFromWatchlist = (idx) => {
    const newList = watchlist.filter((_, i) => i !== idx);
    setWatchlist(newList);
  };

  // ========== AUTO OPTIMIZE ==========
  const runOptimize = useCallback(async () => {
    setOptimizing(true);
    setOptimizeLog([]);
    addLog('Optimizasyon başlıyor...', 'info');
    const delay = ms => new Promise(r => setTimeout(r, ms));

    // 1. Update open position prices
    const openPositions = portfolio.positions.filter(p => p.status === 'open');
    if (openPositions.length > 0) {
      addLog(`${openPositions.length} açık pozisyon güncelleniyor...`, 'info');
      for (const pos of openPositions) {
        try {
          const data = await fetchSingle(pos.symbol, '1mo', '1d', true);
          if (data && data.prices.length > 10) {
            const ind = calcAll(data.prices);
            const sig = genSignal(ind, data.prices);
            const currentPrice = ind.lastClose;
            const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;

            updatePortfolio(prev => {
              const newPositions = prev.positions.map(p => {
                if (p.symbol !== pos.symbol || p.status !== 'open') return p;
                const updated = { ...p, currentPrice };

                // For 'investment' positions, don't auto-stop or auto-target close, just alert
                if (p.positionType === 'investment') {
                  if (currentPrice <= p.stopLoss) {
                    addLog(`${p.symbol}: (YATIRIM) Fiyat stop seviyesine geriledi @ ${currentPrice.toFixed(2)} — Uzun vade için manuel değerlendirin.`, 'warn');
                  } else if (p.target && currentPrice >= p.target) {
                    addLog(`${p.symbol}: (YATIRIM) Hedef fiyata ulaşıldı @ ${currentPrice.toFixed(2)} — Şişmiş olabilir, kararları gözden geçirin.`, 'ok');
                  }
                } else {
                  // Trailing stop: update stop if price moved up
                  if (ind.chandelier?.longStop && ind.chandelier.longStop > p.stopLoss) {
                    updated.stopLoss = ind.chandelier.longStop;
                    addLog(`${p.symbol}: Trailing stop yukarıya çekti → ${ind.chandelier.longStop.toFixed(2)} TL`, 'ok');
                  }

                  // Auto-close: hit stop
                  if (currentPrice <= p.stopLoss) {
                    addLog(`${p.symbol}: STOP-LOSS TETİKLENDİ @ ${currentPrice.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`, 'err');
                    return {
                      ...updated, status: 'closed', currentPrice,
                      pnl: (currentPrice - p.entryPrice) * p.shares,
                      pnlPct, closedAt: new Date().toISOString(), closeReason: 'STOP',
                    };
                  }

                  // Auto-close: hit target
                  if (p.target && currentPrice >= p.target) {
                    addLog(`${p.symbol}: HEDEF ULAŞILDI @ ${currentPrice.toFixed(2)} (+${pnlPct.toFixed(1)}%)`, 'ok');
                    return {
                      ...updated, status: 'closed', currentPrice,
                      pnl: (currentPrice - p.entryPrice) * p.shares,
                      pnlPct, closedAt: new Date().toISOString(), closeReason: 'TARGET',
                    };
                  }
                }

                // Signal degradation: if signal turned strong sell
                if (sig.score <= -5) {
                  addLog(`${p.symbol}: GÜÇLÜ SAT sinyali (skor: ${sig.score.toFixed(1)}) — Manuel kontrol önerisi`, 'warn');
                }

                addLog(`${p.symbol}: ${currentPrice.toFixed(2)} TL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) | RSI:${ind.lastRSI ? ind.lastRSI.toFixed(0) : '-'} | ADX:${ind.adx ? ind.adx.toFixed(0) : '-'}`, pnlPct >= 0 ? 'ok' : 'warn');
                return updated;
              });

              // Calculate updated cash for closed positions
              let cashDelta = 0;
              const historyAdd = [];
              for (let i = 0; i < newPositions.length; i++) {
                const np = newPositions[i];
                const op = prev.positions[i];
                if (np.status === 'closed' && op.status === 'open') {
                  cashDelta += np.shares * np.currentPrice;
                  historyAdd.push({ date: new Date().toISOString(), action: 'SELL', symbol: np.symbol, shares: np.shares, price: np.currentPrice });
                }
              }
              return { ...prev, positions: newPositions, cash: prev.cash + cashDelta, history: [...prev.history, ...historyAdd] };
            });
          }
          await delay(500);
        } catch (e) { addLog(`${pos.symbol}: Veri çekilemedi`, 'err'); }
      }
    }

    // 2. Portfolio heat check
    const totalRisk = openPositions.reduce((sum, p) => {
      return sum + Math.abs(p.entryPrice - p.stopLoss) * p.shares;
    }, 0);
    const heatPct = totalRisk / (portfolio.cash + openPositions.reduce((s, p) => s + p.shares * p.currentPrice, 0)) * 100;
    if (heatPct > 8) {
      addLog(`PORTFÖY ISI: %${heatPct.toFixed(1)} — Limit aşıldı (%8 max)! Pozisyon küçültmeyi düşünün.`, 'err');
    } else if (heatPct > 5) {
      addLog(`Portföy Isı: %${heatPct.toFixed(1)} — Dikkatli olun.`, 'warn');
    } else {
      addLog(`Portföy Isı: %${heatPct.toFixed(1)} — Güvenli aralıkta.`, 'ok');
    }

    // 3. Sector concentration + correlation risk check
    if (openPositions.length > 1) {
      const sectorCount = {};
      const sectorValue = {};
      const totalOpenValue = openPositions.reduce((s, p) => s + p.shares * p.currentPrice, 0);
      for (const p of openPositions) {
        const sec = SECTORS[p.symbol] || 'Diger';
        sectorCount[sec] = (sectorCount[sec] || 0) + 1;
        sectorValue[sec] = (sectorValue[sec] || 0) + p.shares * p.currentPrice;
      }
      // Warn if any sector has >50% of portfolio value or 3+ positions
      for (const [sec, count] of Object.entries(sectorCount)) {
        const pct = totalOpenValue > 0 ? (sectorValue[sec] / totalOpenValue * 100) : 0;
        if (count >= 3) {
          addLog(`KORELASYON RİSKİ: ${sec} sektöründe ${count} pozisyon — çok yoğun!`, 'err');
        } else if (pct > 50) {
          addLog(`SEKTÖR YOĞUNLUĞU: ${sec} portföyün %${pct.toFixed(0)}'i — diversifikasyon zayıf.`, 'warn');
        }
      }
      // Check for same-stock duplicates
      const symCount = {};
      for (const p of openPositions) { symCount[p.symbol] = (symCount[p.symbol] || 0) + 1; }
      for (const [sym, count] of Object.entries(symCount)) {
        if (count > 1) addLog(`${sym}: Aynı hissede ${count} açık pozisyon — birleştirmeyi düşünün.`, 'warn');
      }
      // Bank sector correlation warning (BIST banks move together)
      const bankCount = sectorCount['Banka'] || 0;
      if (bankCount >= 2) {
        addLog(`Banka sektöründe ${bankCount} pozisyon — BIST bankaları yüksek korelasyonlu, tek bir banka tercih edin.`, 'warn');
      }
    }

    // 4. Watchlist price check
    if (watchlist.length > 0) {
      addLog(`Watchlist kontrol ediliyor (${watchlist.length} hisse)...`, 'info');
      const newPrices = { ...wlPrices };
      for (const w of watchlist) {
        try {
          const data = await fetchSingle(w.symbol, '5d', '1d', true);
          if (data && data.prices.length > 0) {
            const last = data.prices[data.prices.length - 1].close;
            newPrices[w.symbol] = last;
            if (w.targetUp && last >= w.targetUp) {
              addLog(`ALARM: ${w.symbol} hedef fiyata ulaştı! ${last.toFixed(2)} >= ${w.targetUp.toFixed(2)} TL`, 'ok');
            }
            if (w.targetDown && last <= w.targetDown) {
              addLog(`ALARM: ${w.symbol} stop seviyesine düştü! ${last.toFixed(2)} <= ${w.targetDown.toFixed(2)} TL`, 'err');
            }
          }
          await delay(400);
        } catch {}
      }
      setWlPrices(newPrices);
    }

    addLog('Optimizasyon tamamlandı.', 'ok');
    setOptimizing(false);
  }, [portfolio, updatePortfolio, watchlist, wlPrices, addLog]);

  const openPos = portfolio.positions.filter(p => p.status === 'open');
  const closedPos = portfolio.positions.filter(p => p.status === 'closed');
  let totalValue = portfolio.cash, totalPnl = 0;
  for (const p of openPos) {
    const lp = livePrice?.livePrices?.[p.symbol];
    const cp = (lp && lp.price > 0) ? lp.price : p.currentPrice;
    totalValue += p.shares * cp;
    totalPnl += (cp - p.entryPrice) * p.shares;
  }
  const closedPnl = closedPos.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const totalReturn = ((totalValue - 10000) / 10000 * 100);
  const totalRisk = openPos.reduce((sum, p) => sum + Math.abs(p.entryPrice - p.stopLoss) * p.shares, 0);
  const heatPct = totalValue > 0 ? totalRisk / totalValue * 100 : 0;

  return (
    <div className="scanner-wrap">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 18, fontWeight: 700, color: 'var(--cyan)' }}>Sanal Portföy Takipçi</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="scan-btn ai" onClick={runOptimize} disabled={optimizing} style={{ fontSize: 10, padding: '8px 16px' }}>
            {optimizing ? 'OPTİMİZE EDİLİYOR...' : 'OPTİMİZE ET'}
          </button>
          <button className="scan-btn go" onClick={resetPortfolio} style={{ background: 'var(--bg3)', color: 'var(--t2)', border: '1px solid var(--border)', fontSize: 10, padding: '6px 12px' }}>Sıfırla (10K)</button>
        </div>
      </div>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 8, marginBottom: 12 }}>
        <div style={{ background: 'var(--bg3)', padding: 10, borderRadius: 5, textAlign: 'center' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Toplam Değer</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--cyan)' }}>{totalValue.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} TL</div>
        </div>
        <div style={{ background: 'var(--bg3)', padding: 10, borderRadius: 5, textAlign: 'center' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Nakit</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{portfolio.cash.toLocaleString('tr-TR', { maximumFractionDigits: 0 })} TL</div>
        </div>
        <div style={{ background: 'var(--bg3)', padding: 10, borderRadius: 5, textAlign: 'center' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Toplam Getiri</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: totalReturn >= 0 ? 'var(--green)' : 'var(--red)' }}>%{totalReturn.toFixed(1)}</div>
        </div>
        <div style={{ background: 'var(--bg3)', padding: 10, borderRadius: 5, textAlign: 'center', border: heatPct > 8 ? '1px solid var(--red)' : heatPct > 5 ? '1px solid var(--yellow)' : '1px solid var(--border)' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Portföy Isı</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: heatPct > 8 ? 'var(--red)' : heatPct > 5 ? 'var(--yellow)' : 'var(--green)' }}>%{heatPct.toFixed(1)}</div>
        </div>
        <div style={{ background: 'var(--bg3)', padding: 10, borderRadius: 5, textAlign: 'center' }}>
          <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)' }}>Broker</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)', marginTop: 4, textTransform: 'uppercase' }}>{brokerConfig.type.replace('_', ' ')}</div>
        </div>
      </div>

      {/* Position Filters / Tabs */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', borderBottom: '2px solid var(--cyan)', padding: '4px 8px' }}>AKTİF POZİSYONLAR ({openPos.length})</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', padding: '4px 8px' }}>KAPATILAN ({closedPos.length})</div>
      </div>

      {/* ══════ LIVE PRICE GUARD PANEL ══════ */}
      {livePrice && openPos.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(0,200,83,0.04))',
          border: '1px solid var(--purple)', borderRadius: 8, padding: 12, marginBottom: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: livePrice.isMarketOpen ? 'var(--green)' : 'var(--red)',
                boxShadow: livePrice.isMarketOpen ? '0 0 6px var(--green)' : 'none',
                animation: livePrice.polling ? 'monPulse 1s infinite' : 'none',
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--purple)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Canli Fiyat Takibi
              </span>
              <span style={{ fontSize: 8, color: 'var(--t3)' }}>
                {livePrice.isMarketOpen ? 'BORSA ACIK' : 'BORSA KAPALI'} | 30sn aralikla
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {livePrice.lastPollTime && (
                <span style={{ fontSize: 8, color: 'var(--t3)' }}>
                  Son: {new Date(livePrice.lastPollTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
              <button onClick={livePrice.pollNow} disabled={livePrice.polling} style={{
                fontSize: 8, padding: '3px 8px', background: 'var(--bg3)', color: 'var(--cyan)',
                border: '1px solid var(--cyan)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>
                {livePrice.polling ? '...' : 'GUNCELLE'}
              </button>
            </div>
          </div>

          {/* Live position prices */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }}>
            {openPos.map(p => {
              const lp = livePrice.livePrices[p.symbol];
              const currentPrice = lp ? lp.price : p.currentPrice;
              const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice * 100);
              const stopDist = p.stopLoss ? ((currentPrice - p.stopLoss) / currentPrice * 100) : null;
              const isStale = lp ? (Date.now() - lp.ts > 120000) : true;
              return (
                <div key={p.symbol + '_' + p.entryPrice} style={{
                  background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px',
                  borderLeft: '3px solid ' + (pnlPct >= 0 ? 'var(--green)' : pnlPct > -3 ? 'var(--yellow)' : 'var(--red)'),
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{p.symbol}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)',
                    }}>
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--t2)', marginTop: 2 }}>
                    <span style={{ color: isStale ? 'var(--t3)' : 'var(--cyan)' }}>{currentPrice.toFixed(2)} TL</span>
                    {lp && <span style={{ marginLeft: 4, color: lp.change >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 8 }}>
                      {lp.change >= 0 ? '+' : ''}{lp.change.toFixed(2)}%
                    </span>}
                  </div>
                  {stopDist != null && (
                    <div style={{
                      fontSize: 8, marginTop: 2,
                      color: stopDist < 2 ? 'var(--red)' : stopDist < 5 ? 'var(--yellow)' : 'var(--t3)',
                    }}>
                      Stop mesafesi: %{stopDist.toFixed(1)}
                      {stopDist < 2 && ' — TEHLIKE!'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════ RISK GUARD ══════ */}
      {(() => {
        const riskIssues = [];
        const MAX_PORTFOLIO_RISK = 8; // %
        const MAX_SINGLE_POSITION = 30; // % of portfolio
        const MAX_SECTOR_CONCENTRATION = 40; // % of portfolio
        const MAX_DAILY_LOSS = 3; // % of portfolio value

        // 1. Total portfolio heat
        if (heatPct > MAX_PORTFOLIO_RISK) {
          riskIssues.push({ level: 'err', msg: `Toplam risk %${heatPct.toFixed(1)} — Limit %${MAX_PORTFOLIO_RISK} asildi! Pozisyon kucultun.` });
        } else if (heatPct > MAX_PORTFOLIO_RISK * 0.7) {
          riskIssues.push({ level: 'warn', msg: `Toplam risk %${heatPct.toFixed(1)} — Limite yaklasiyor (%${MAX_PORTFOLIO_RISK}).` });
        }

        // 2. Single position concentration
        for (const p of openPos) {
          const posValue = p.shares * p.currentPrice;
          const posPct = totalValue > 0 ? (posValue / totalValue * 100) : 0;
          if (posPct > MAX_SINGLE_POSITION) {
            riskIssues.push({ level: 'err', msg: `${p.symbol} portfoyun %${posPct.toFixed(0)}'i — Max %${MAX_SINGLE_POSITION}. Pozisyon buyuk.` });
          }
        }

        // 3. Sector concentration
        if (openPos.length > 1) {
          const sectorValue = {};
          const openValue = openPos.reduce((s, p) => s + p.shares * p.currentPrice, 0);
          for (const p of openPos) {
            const sec = SECTORS[p.symbol] || 'Diger';
            sectorValue[sec] = (sectorValue[sec] || 0) + p.shares * p.currentPrice;
          }
          for (const [sec, val] of Object.entries(sectorValue)) {
            const pct = openValue > 0 ? (val / openValue * 100) : 0;
            if (pct > MAX_SECTOR_CONCENTRATION && Object.keys(sectorValue).length > 1) {
              riskIssues.push({ level: 'warn', msg: `${sec} sektoru %${pct.toFixed(0)} yogunluk — Diversifikasyon zayif.` });
            }
          }
        }

        // 4. Daily loss check
        const todayTrades = portfolio.history.filter(h => {
          const d = new Date(h.date);
          const today = new Date();
          return d.toDateString() === today.toDateString() && h.action === 'SELL';
        });
        if (todayTrades.length > 0) {
          // Check closed positions for today's P&L
          const todayClosed = portfolio.positions.filter(p =>
            p.status === 'closed' && p.closedAt && new Date(p.closedAt).toDateString() === new Date().toDateString()
          );
          const todayPnl = todayClosed.reduce((s, p) => s + (p.pnl || 0), 0);
          const todayPnlPct = totalValue > 0 ? (todayPnl / totalValue * 100) : 0;
          if (todayPnlPct < -MAX_DAILY_LOSS) {
            riskIssues.push({ level: 'err', msg: `Bugun %${todayPnlPct.toFixed(1)} kayip — Gunluk limit %${MAX_DAILY_LOSS} asildi! ISLEM YAPMAYIN.` });
          }
        }

        // 5. Losing positions without stop
        for (const p of openPos) {
          if (!p.stopLoss || p.stopLoss <= 0) {
            riskIssues.push({ level: 'warn', msg: `${p.symbol}: Stop-loss tanimlanmamis! Risk kontrolsuz.` });
          }
        }

        if (riskIssues.length === 0) return null;

        return (
          <div style={{
            background: 'rgba(255,23,68,0.05)', border: '1px solid var(--red)',
            borderRadius: 8, padding: 10, marginBottom: 12,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>&#9888;</span> Risk Guard
            </div>
            {riskIssues.map((r, i) => (
              <div key={i} style={{
                fontSize: 9, padding: '3px 0',
                color: r.level === 'err' ? 'var(--red)' : 'var(--yellow)',
                display: 'flex', alignItems: 'flex-start', gap: 4,
              }}>
                <span style={{ fontSize: 7, marginTop: 2 }}>{r.level === 'err' ? '●' : '▲'}</span>
                {r.msg}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Portfolio Equity Curve */}
      {portfolio.history.length >= 2 && (() => {
        // Build equity points from history
        let eq = 10000;
        const points = [{ val: eq, label: 'Başlangıç' }];
        for (const h of portfolio.history) {
          if (h.action === 'BUY') eq -= h.shares * h.price;
          else if (h.action === 'SELL') eq += h.shares * h.price;
          points.push({ val: eq, label: h.symbol });
        }
        // Add current open positions value
        const openVal = openPos.reduce((s, p) => s + p.shares * p.currentPrice, 0);
        points.push({ val: eq + openVal, label: 'Güncel' });
        if (points.length < 3) return null;
        const cw = 500, ch = 60;
        const vals = points.map(p => p.val);
        const minV = Math.min(...vals), maxV = Math.max(...vals);
        const range = maxV - minV || 1;
        const polyline = points.map((p, i) => `${(i / (points.length - 1) * cw).toFixed(1)},${(ch - 4 - ((p.val - minV) / range) * (ch - 8)).toFixed(1)}`).join(' ');
        const baseY = ch - 4 - ((10000 - minV) / range) * (ch - 8);
        const lastVal = points[points.length - 1].val;
        const isProfit = lastVal >= 10000;
        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--t3)', marginBottom: 6 }}>Portföy Equity Curve</div>
            <svg width="100%" viewBox={`0 0 ${cw} ${ch}`} preserveAspectRatio="none" style={{ display: 'block', background: 'var(--bg3)', borderRadius: 4, border: '1px solid var(--border)' }}>
              <defs>
                <linearGradient id="pEqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isProfit ? '#00e676' : '#ff1744'} stopOpacity="0.25" />
                  <stop offset="100%" stopColor={isProfit ? '#00e676' : '#ff1744'} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <polygon fill="url(#pEqGrad)" points={polyline + ` ${cw},${ch} 0,${ch}`} />
              <line x1="0" y1={baseY} x2={cw} y2={baseY} stroke="#ffd600" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
              <polyline fill="none" stroke={isProfit ? '#00e676' : '#ff1744'} strokeWidth="1.5" points={polyline} />
              <text x="4" y={baseY - 3} fill="#ffd600" fontSize="7" fontFamily="JetBrains Mono">10K</text>
              <text x={cw - 4} y={ch - 4 - ((lastVal - minV) / range) * (ch - 8) - 3} fill={isProfit ? '#00e676' : '#ff1744'} fontSize="7" fontFamily="JetBrains Mono" textAnchor="end">{(lastVal / 1000).toFixed(1)}K</text>
            </svg>
          </div>
        );
      })()}

      {/* Optimize Log */}
      {optimizeLog.length > 0 && (
        <div style={{ background: 'var(--bg3)', border: '1px solid var(--purple)', borderRadius: 6, padding: 10, marginBottom: 12, maxHeight: 200, overflowY: 'auto' }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--purple)', marginBottom: 6, fontWeight: 700, letterSpacing: 1 }}>Optimizasyon Raporu</div>
          {optimizeLog.map((l, i) => (
            <div key={i} style={{ fontSize: 9, padding: '2px 0', color: l.cls === 'ok' ? 'var(--green)' : l.cls === 'err' ? 'var(--red)' : l.cls === 'warn' ? 'var(--yellow)' : 'var(--t2)' }}>
              <span style={{ color: 'var(--t3)', marginRight: 4 }}>[{l.time}]</span>{l.msg}
            </div>
          ))}
          {optimizing && <div style={{ marginTop: 4 }}><div className="load-bar"><div className="load-fill" /></div></div>}
        </div>
      )}

      {/* Trade Positions Section */}
      {openPos.filter(p => !p.positionType || p.positionType === 'trade').length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--cyan)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cyan)' }} />
            Trade Pozisyonları (Kısa Vade)
          </div>
          {portfolio.positions.map((p, i) => {
            if (p.status !== 'open' || (p.positionType && p.positionType !== 'trade')) return null;
            return <PositionCard key={i} p={p} idx={i} livePrice={livePrice} closePosition={closePosition} />;
          })}
        </div>
      )}

      {/* Investment Positions Section */}
      {openPos.filter(p => p.positionType === 'investment').length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--purple)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--purple)', boxShadow: '0 0 8px var(--purple)' }} />
            Uzun Vadeli Yatırımlar
          </div>
          {portfolio.positions.map((p, i) => {
            if (p.status !== 'open' || p.positionType !== 'investment') return null;
            return <PositionCard key={i} p={p} idx={i} livePrice={livePrice} closePosition={closePosition} isInvestment />;
          })}
        </div>
      )}

      {openPos.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--t3)', fontSize: 12 }}>Portföy boş. Analiz veya İntraday sekmesinden hisse ekleyebilirsiniz.</div>
      )}

      {/* Closed Positions */}
      {closedPos.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--t3)', marginBottom: 6 }}>Kapatılan Pozisyonlar (Realize K/Z: <span style={{ color: closedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{closedPnl >= 0 ? '+' : ''}{closedPnl.toFixed(0)} TL</span>)</div>
          {closedPos.slice(-10).reverse().map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px', fontSize: 10, borderBottom: '1px solid var(--border)', opacity: 0.7 }}>
              <span>{p.symbol} ({p.shares} lot) {p.closeReason ? <span style={{ fontSize: 8, color: p.closeReason === 'TARGET' ? 'var(--green)' : 'var(--red)', marginLeft: 4 }}>[{p.closeReason}]</span> : null}</span>
              <span style={{ color: (p.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{(p.pnl || 0) >= 0 ? '+' : ''}{(p.pnl || 0).toFixed(0)} TL ({(p.pnlPct || 0).toFixed(1)}%)</span>
            </div>
          ))}
        </div>
      )}

      {/* History */}
      {portfolio.history.length > 0 && (
        <div>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--t3)', margin: '12px 0 6px' }}>İşlem Geçmişi</div>
          {portfolio.history.slice(-10).reverse().map((h, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 10, borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: h.action === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{h.action} {h.symbol}</span>
              <span style={{ color: 'var(--t2)' }}>{h.shares} @ {h.price.toFixed(2)} TL</span>
            </div>
          ))}
        </div>
      )}

      {/* Watchlist with Live Price Alarms */}
      <div style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>Watchlist & Fiyat Alarmları</div>
          {livePrice && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: livePrice.isMarketOpen ? 'var(--green)' : 'var(--red)', boxShadow: livePrice.isMarketOpen ? '0 0 4px var(--green)' : 'none' }} />
              <span style={{ color: 'var(--t3)' }}>{livePrice.isMarketOpen ? 'Aktif Polling (30s)' : 'Piyasa Kapali'}</span>
              {livePrice.lastPollTime && <span style={{ color: 'var(--t3)' }}>| Son: {new Date(livePrice.lastPollTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
            </div>
          )}
        </div>
        {watchlist.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--t3)', fontSize: 11 }}>Watchlist bos — asagidan hisse ekleyin ve fiyat alarmi kurun.</div>
        ) : (
          watchlist.map((w, i) => {
            // Use live price from polling if available, then optimize prices, then nothing
            const lp = livePrice?.livePrices?.[w.symbol];
            const price = lp?.price || wlPrices[w.symbol] || null;
            const isLive = lp && (Date.now() - lp.ts < 120000);
            const upHit = w.targetUp && price && price >= w.targetUp;
            const downHit = w.targetDown && price && price <= w.targetDown;
            const changePct = lp?.change != null ? lp.change : null;

            return (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px',
                background: upHit ? 'rgba(0,200,83,0.06)' : downHit ? 'rgba(255,23,68,0.06)' : 'var(--bg3)',
                borderLeft: upHit ? '3px solid var(--green)' : downHit ? '3px solid var(--red)' : '3px solid transparent',
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
                    {changePct != null && <span style={{ fontSize: 9, color: changePct >= 0 ? 'var(--green)' : 'var(--red)' }}>{changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%</span>}
                    {w.targetUp && <span style={{ fontSize: 8, color: upHit ? 'var(--green)' : 'var(--t3)', marginLeft: 4 }}>▲ {w.targetUp.toFixed(2)}{price ? ' (' + ((w.targetUp - price) / price * 100).toFixed(1) + '%)' : ''}</span>}
                    {w.targetDown && <span style={{ fontSize: 8, color: downHit ? 'var(--red)' : 'var(--t3)', marginLeft: 4 }}>▼ {w.targetDown.toFixed(2)}{price ? ' (' + ((w.targetDown - price) / price * 100).toFixed(1) + '%)' : ''}</span>}
                  </div>
                </div>
                <button onClick={() => removeFromWatchlist(i)} style={{ fontSize: 9, padding: '2px 6px', background: 'none', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' }}>X</button>
              </div>
            );
          })
        )}
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="inp" value={wlSymbol} onChange={e => setWlSymbol(e.target.value.toUpperCase())} placeholder="Hisse" style={{ width: 80, fontSize: 10, padding: 6 }} onKeyDown={e => e.key === 'Enter' && addToWatchlist()} />
          <input className="inp" type="number" value={wlUp} onChange={e => setWlUp(e.target.value)} placeholder="Hedef ₺" style={{ width: 90, fontSize: 10, padding: 6 }} />
          <input className="inp" type="number" value={wlDown} onChange={e => setWlDown(e.target.value)} placeholder="Stop ₺" style={{ width: 90, fontSize: 10, padding: 6 }} />
          <button className="btn btn-go" onClick={addToWatchlist} style={{ fontSize: 9, padding: '6px 10px', width: 'auto' }}>EKLE</button>
        </div>
        <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 6 }}>
          Hedef/Stop fiyatları canlı polling ile otomatik kontrol edilir (piyasa saatlerinde 30 saniyede bir).
        </div>
    </div>

      {/* Broker Settings Integration */}
      <BrokerSettings 
        brokerConfig={brokerConfig} 
        setBrokerConfig={setBrokerConfig} 
      />

      {/* Performance Analytics */}
      <PerformanceAnalytics portfolio={portfolio} />

      {/* Trade Journal */}
      <TradeJournal portfolio={portfolio} />

      <div className="disc" style={{ marginTop: 12, border: 'none' }}>Sanal portföy — gerçek para kullanılmaz.</div>
    </div>
  );
}
