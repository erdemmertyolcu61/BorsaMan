import { useState, useMemo } from 'react';

function MetricBox({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg3)', padding: '8px 10px', borderRadius: 5, textAlign: 'center' }}>
      <div style={{ fontSize: 8, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function TradingInsights({ stats }) {
  const tips = [];
  if (stats.winRate < 40) {
    tips.push({ type: 'warn', msg: 'Kazanma oraniniz dusuk — giriş kriterlerinizi sıkılaştırın ve sadece yuksek olasılıklı setuplara girin.' });
  }
  if (stats.avgRR < 1) {
    tips.push({ type: 'err', msg: 'Ortalama R/R < 1 — kayiplar kazanclardan buyuk. Stop mesafenizi daraltın veya hedeflerinizi yükseltin.' });
  }
  if (stats.profitFactor < 1) {
    tips.push({ type: 'err', msg: 'Kar faktoru < 1 — sistem negatif beklentili. Strateji gozden gecirilmeli.' });
  } else if (stats.profitFactor >= 2) {
    tips.push({ type: 'ok', msg: 'Kar faktoru guclu (>2) — mevcut strateji basarılı, pozisyon boyutunu artirmayi dusunebilirsiniz.' });
  }
  if (stats.maxDDPct > 20) {
    tips.push({ type: 'err', msg: `Maks drawdown %${stats.maxDDPct.toFixed(1)} — cok yuksek. Pozisyon boyutlarini kucultun.` });
  }
  if (stats.maxLossStreak >= 4) {
    tips.push({ type: 'warn', msg: `Ust uste ${stats.maxLossStreak} kayıp yasanmis — boyle serilerde mola verin ve psikolojinizi kontrol edin.` });
  }
  if (stats.stopOuts > stats.targetHits && stats.totalTrades >= 5) {
    tips.push({ type: 'warn', msg: 'Stop-out sayisi hedef sayisindan fazla — stop seviyelerini ATR bazli optimize edin.' });
  }
  if (tips.length === 0) return null;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--purple)', marginBottom: 4, fontWeight: 700 }}>
        AI Trade Onerileri
      </div>
      {tips.map((tip, i) => (
        <div
          key={i}
          style={{
            fontSize: 10, padding: '4px 8px', marginBottom: 3, borderRadius: 4,
            background:
              tip.type === 'err' ? 'rgba(255,23,68,0.08)' :
              tip.type === 'warn' ? 'rgba(255,214,0,0.06)' :
              'rgba(0,230,118,0.08)',
            color:
              tip.type === 'err' ? 'var(--red)' :
              tip.type === 'warn' ? 'var(--yellow)' :
              'var(--green)',
            borderLeft: `2px solid ${
              tip.type === 'err' ? 'var(--red)' :
              tip.type === 'warn' ? 'var(--yellow)' :
              'var(--green)'
            }`,
          }}
        >
          {tip.msg}
        </div>
      ))}
    </div>
  );
}

const MONTH_NAMES = ['Oca', 'Sub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Agu', 'Eyl', 'Eki', 'Kas', 'Ara'];

export default function PerformanceAnalytics({ portfolio }) {
  const [expanded, setExpanded] = useState(true);

  const stats = useMemo(() => {
    const closed = (portfolio?.positions || []).filter(p => p.status === 'closed' && p.pnl != null);
    if (closed.length === 0) return null;

    const wins = closed.filter(p => p.pnl > 0);
    const losses = closed.filter(p => p.pnl < 0);
    const breakeven = closed.filter(p => p.pnl === 0);
    const totalPnl = closed.reduce((s, p) => s + p.pnl, 0);
    const winPnl = wins.reduce((s, p) => s + p.pnl, 0);
    const lossPnl = losses.reduce((s, p) => s + Math.abs(p.pnl), 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const avgWin = wins.length > 0 ? winPnl / wins.length : 0;
    const avgLoss = losses.length > 0 ? lossPnl / losses.length : 0;
    const profitFactor = lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? Infinity : 0);
    const expectancy = closed.length > 0 ? totalPnl / closed.length : 0;
    const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;
    const avgWinPct = wins.length > 0 ? wins.reduce((s, p) => s + (p.pnlPct || 0), 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? losses.reduce((s, p) => s + Math.abs(p.pnlPct || 0), 0) / losses.length : 0;
    const bestTrade = closed.reduce((acc, p) => p.pnl > (acc?.pnl ?? -Infinity) ? p : acc, null);
    const worstTrade = closed.reduce((acc, p) => p.pnl < (acc?.pnl ?? Infinity) ? p : acc, null);

    // Drawdown from history
    let peak = 10000, maxDD = 0, maxDDPct = 0, equity = 10000;
    for (const h of (portfolio?.history || [])) {
      if (h.action === 'BUY') equity -= h.shares * h.price;
      else if (h.action === 'SELL') equity += h.shares * h.price;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDD) { maxDD = dd; maxDDPct = ddPct; }
    }

    // Streaks
    let currentStreak = 0, maxWinStreak = 0, maxLossStreak = 0, streak = 0;
    for (const p of closed) {
      if (p.pnl > 0) {
        streak = streak > 0 ? streak + 1 : 1;
        maxWinStreak = Math.max(maxWinStreak, streak);
      } else if (p.pnl < 0) {
        streak = streak < 0 ? streak - 1 : -1;
        maxLossStreak = Math.max(maxLossStreak, Math.abs(streak));
      } else {
        streak = 0;
      }
    }
    currentStreak = streak;

    const stopOuts = closed.filter(p => p.closeReason === 'STOP').length;
    const targetHits = closed.filter(p => p.closeReason === 'TARGET').length;
    const manual = closed.length - stopOuts - targetHits;

    // Monthly PnL
    const monthlyPnl = {};
    for (const p of closed) {
      if (!p.closedAt) continue;
      const d = new Date(p.closedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyPnl[key] = (monthlyPnl[key] || 0) + p.pnl;
    }

    // Sharpe
    const pcts = closed.map(p => p.pnlPct || 0);
    const mean = pcts.reduce((s, v) => s + v, 0) / pcts.length;
    const variance = pcts.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / pcts.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? mean / stdDev : 0;

    return {
      totalTrades: closed.length,
      wins: wins.length, losses: losses.length, breakeven: breakeven.length,
      winRate, totalPnl, avgWin, avgLoss, profitFactor, expectancy, avgRR,
      avgWinPct, avgLossPct, bestTrade, worstTrade,
      maxDD, maxDDPct, currentStreak, maxWinStreak, maxLossStreak,
      stopOuts, targetHits, manual, monthlyPnl, sharpe, stdDev,
    };
  }, [portfolio]);

  if (!stats) return null;

  const pfColor = stats.profitFactor >= 2 ? 'var(--green)'
    : stats.profitFactor >= 1.5 ? 'var(--cyan)'
    : stats.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)';
  const winRateColor = stats.winRate >= 60 ? 'var(--green)'
    : stats.winRate >= 45 ? 'var(--yellow)' : 'var(--red)';
  const monthly = Object.entries(stats.monthlyPnl).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ marginTop: 16, border: '1px solid var(--cyan)', borderRadius: 8, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
          background: 'linear-gradient(135deg, rgba(0,229,255,0.08), rgba(0,230,118,0.05))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 13, fontWeight: 700, color: 'var(--cyan)' }}>
            Performans Analitigi
          </span>
          <span style={{ fontSize: 9, color: 'var(--t3)' }}>{stats.totalTrades} islem</span>
        </div>
        <span style={{
          color: 'var(--t3)', fontSize: 12,
          transition: 'transform .2s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
        }}>▼</span>
      </div>

      {expanded && (
        <div style={{ padding: '12px 14px', background: 'var(--bg2)' }}>
          {/* Metric grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 6, marginBottom: 12 }}>
            <MetricBox label="Kazanma Orani" value={`%${stats.winRate.toFixed(1)}`} color={winRateColor} />
            <MetricBox label="Kar Faktoru" value={stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)} color={pfColor} />
            <MetricBox label="Beklenen Deger" value={`${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(0)} TL`} color={stats.expectancy >= 0 ? 'var(--green)' : 'var(--red)'} />
            <MetricBox label="Ort. R/R" value={stats.avgRR.toFixed(2)} color={stats.avgRR >= 1.5 ? 'var(--green)' : stats.avgRR >= 1 ? 'var(--yellow)' : 'var(--red)'} />
            <MetricBox label="Sharpe Orani" value={stats.sharpe.toFixed(2)} color={stats.sharpe >= 1 ? 'var(--green)' : stats.sharpe >= 0.5 ? 'var(--yellow)' : 'var(--red)'} />
            <MetricBox label="Maks Drawdown" value={`%${stats.maxDDPct.toFixed(1)}`} color={stats.maxDDPct > 15 ? 'var(--red)' : stats.maxDDPct > 8 ? 'var(--yellow)' : 'var(--green)'} />
          </div>

          {/* Win vs Loss side-by-side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontSize: 9, color: 'var(--green)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>Kazanc</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10 }}>
                <span style={{ color: 'var(--t3)' }}>Adet:</span>
                <span style={{ color: 'var(--green)', fontWeight: 600 }}>{stats.wins}</span>
                <span style={{ color: 'var(--t3)' }}>Ort. Kar:</span>
                <span style={{ color: 'var(--green)' }}>{stats.avgWin.toFixed(0)} TL</span>
                <span style={{ color: 'var(--t3)' }}>Ort. %:</span>
                <span style={{ color: 'var(--green)' }}>+{stats.avgWinPct.toFixed(1)}%</span>
                <span style={{ color: 'var(--t3)' }}>Maks Seri:</span>
                <span style={{ color: 'var(--green)' }}>{stats.maxWinStreak}</span>
              </div>
              {stats.bestTrade && (
                <div style={{ fontSize: 9, marginTop: 6, padding: '4px 6px', background: 'rgba(0,230,118,0.08)', borderRadius: 3, color: 'var(--green)' }}>
                  En iyi: {stats.bestTrade.symbol} +{stats.bestTrade.pnl.toFixed(0)} TL (+{(stats.bestTrade.pnlPct || 0).toFixed(1)}%)
                </div>
              )}
            </div>
            <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontSize: 9, color: 'var(--red)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>Kayip</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10 }}>
                <span style={{ color: 'var(--t3)' }}>Adet:</span>
                <span style={{ color: 'var(--red)', fontWeight: 600 }}>{stats.losses}</span>
                <span style={{ color: 'var(--t3)' }}>Ort. Zarar:</span>
                <span style={{ color: 'var(--red)' }}>-{stats.avgLoss.toFixed(0)} TL</span>
                <span style={{ color: 'var(--t3)' }}>Ort. %:</span>
                <span style={{ color: 'var(--red)' }}>-{stats.avgLossPct.toFixed(1)}%</span>
                <span style={{ color: 'var(--t3)' }}>Maks Seri:</span>
                <span style={{ color: 'var(--red)' }}>{stats.maxLossStreak}</span>
              </div>
              {stats.worstTrade && (
                <div style={{ fontSize: 9, marginTop: 6, padding: '4px 6px', background: 'rgba(255,23,68,0.08)', borderRadius: 3, color: 'var(--red)' }}>
                  En kotu: {stats.worstTrade.symbol} {stats.worstTrade.pnl.toFixed(0)} TL ({(stats.worstTrade.pnlPct || 0).toFixed(1)}%)
                </div>
              )}
            </div>
          </div>

          {/* Win/Loss bar */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)', marginBottom: 3 }}>
              <span style={{ color: 'var(--green)' }}>{stats.wins} Kazanc</span>
              <span>{stats.breakeven} Basabas</span>
              <span style={{ color: 'var(--red)' }}>{stats.losses} Kayip</span>
            </div>
            <div style={{ display: 'flex', height: 12, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <div style={{ width: `${(stats.wins / stats.totalTrades) * 100}%`, background: 'var(--green)', transition: 'width 0.5s' }} />
              <div style={{ width: `${(stats.breakeven / stats.totalTrades) * 100}%`, background: 'var(--yellow)', transition: 'width 0.5s' }} />
              <div style={{ flex: 1, background: 'var(--red)', opacity: 0.7 }} />
            </div>
          </div>

          {/* Target/Stop/Manual counts + current streak */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--green)' }} />
              <span style={{ color: 'var(--t2)' }}>Hedef: {stats.targetHits}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--red)' }} />
              <span style={{ color: 'var(--t2)' }}>Stop: {stats.stopOuts}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--t3)' }} />
              <span style={{ color: 'var(--t2)' }}>Manuel: {stats.manual}</span>
            </div>
            {stats.currentStreak !== 0 && (
              <span style={{ color: stats.currentStreak > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                Guncel Seri: {stats.currentStreak > 0 ? '+' : ''}{stats.currentStreak}
              </span>
            )}
          </div>

          {/* Monthly PnL */}
          {monthly.length > 0 && (
            <div>
              <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--t3)', marginBottom: 6, fontWeight: 700 }}>
                Aylik K/Z
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {monthly.map(([key, val]) => {
                  const [year, month] = key.split('-');
                  return (
                    <div
                      key={key}
                      style={{
                        background: val >= 0 ? 'rgba(0,230,118,0.1)' : 'rgba(255,23,68,0.1)',
                        border: `1px solid ${val >= 0 ? 'rgba(0,230,118,0.2)' : 'rgba(255,23,68,0.2)'}`,
                        borderRadius: 4, padding: '4px 8px', textAlign: 'center', minWidth: 60,
                      }}
                    >
                      <div style={{ fontSize: 8, color: 'var(--t3)' }}>
                        {MONTH_NAMES[parseInt(month) - 1]} {year.slice(2)}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {val >= 0 ? '+' : ''}{val.toFixed(0)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <TradingInsights stats={stats} />
        </div>
      )}
    </div>
  );
}
