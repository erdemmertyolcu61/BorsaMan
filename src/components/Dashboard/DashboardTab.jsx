import { useMemo } from 'react';
import { classifyRegime } from '../../utils/regimeEngine.js';
import { computeGovernor } from '../../utils/profitGovernor.js';
import { loadJournal } from '../../utils/forwardTestJournal.js';

function relTime(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() - ts) / 60000);
  if (diff < 1) return 'az önce';
  if (diff < 60) return `${diff}dk önce`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}s önce`;
  return `${Math.floor(h / 24)}g önce`;
}

function pct(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function tl(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₺';
}

const REGIME_COLORS = {
  BULL: 'var(--green, #10b981)',
  BEAR: 'var(--red, #ef4444)',
  RANGE: 'var(--yellow, #eab308)',
  VOLATILE: 'var(--orange, #f97316)',
};

const cardStyle = {
  background: 'var(--bg2, #111827)',
  border: '1px solid var(--border, #1f2937)',
  borderRadius: 6,
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const kpiValue = {
  fontSize: 22,
  fontWeight: 800,
  fontFamily: 'Space Grotesk, monospace',
  lineHeight: 1.1,
};

const kpiLabel = {
  fontSize: 10,
  color: 'var(--t3, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const kpiRow = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 12,
  color: 'var(--t2, #9ca3af)',
};

export default function DashboardTab({
  portfolio,
  advisor,
  signalTracker,
  forwardJournal,
  livePrice,
  alertLog,
  onAnalyze,
  onTabChange,
}) {
  const positions = useMemo(
    () => (portfolio?.positions || []).filter(p => p.status === 'open'),
    [portfolio]
  );

  const livePrices = livePrice?.livePrices || {};

  const portfolioMetrics = useMemo(() => {
    const cash = portfolio?.cash ?? 10000;
    let holdingValue = 0;
    let dailyPnl = 0;

    for (const pos of positions) {
      const lp = livePrices[pos.symbol];
      const curPrice = lp?.price || pos.currentPrice || pos.entryPrice || 0;
      const shares = pos.shares || pos.lot || 0;
      holdingValue += curPrice * shares;
      dailyPnl += (curPrice - (pos.entryPrice || curPrice)) * shares;
    }

    const totalValue = cash + holdingValue;
    const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;

    return { cash, holdingValue, totalValue, dailyPnl, dailyPnlPct, openCount: positions.length };
  }, [portfolio, positions, livePrices]);

  const regime = useMemo(() => {
    const ctx = advisor?.marketSentiment || {};
    return classifyRegime({
      pctBull: ctx.pctBull ?? ctx.bullPct,
      avgRSI: ctx.avgRSI,
      scanned: ctx.scanned ?? advisor?.scanResults?.length,
      sectorStrengthAvg: ctx.sectorStrengthAvg,
    });
  }, [advisor]);

  const signalStats = useMemo(
    () => (signalTracker?.calcStats ? signalTracker.calcStats() : null),
    [signalTracker]
  );

  // Profit Governor — prefer the scan's own decision; fall back to a fresh
  // computation from the journal so the card renders before the first scan.
  const governor = useMemo(() => {
    const fromScan = advisor?.marketSentiment?.governor;
    if (fromScan) return fromScan;
    try { return computeGovernor(loadJournal(), regime.regime); }
    catch { return { mode: 'NORMAL', positionMult: 1, maxPicksMult: 1, scoreCutoffDelta: 0, reasons: [] }; }
  }, [advisor, regime]);

  const GOV_COLORS = {
    NORMAL: 'var(--green, #10b981)',
    CAUTION: 'var(--yellow, #eab308)',
    DEFENSE: 'var(--red, #ef4444)',
  };

  const journalData = useMemo(
    () => forwardJournal?.stats || {},
    [forwardJournal]
  );

  const riskMetrics = useMemo(() => {
    if (!positions.length) return { maxConc: 0, maxConcSym: '—', stopClose: [] };

    const total = portfolioMetrics.totalValue || 1;
    let maxConc = 0;
    let maxConcSym = '—';
    const stopClose = [];

    for (const pos of positions) {
      const lp = livePrices[pos.symbol];
      const curPrice = lp?.price || pos.currentPrice || pos.entryPrice || 0;
      const shares = pos.shares || pos.lot || 0;
      const posValue = curPrice * shares;
      const conc = (posValue / total) * 100;

      if (conc > maxConc) {
        maxConc = conc;
        maxConcSym = pos.symbol;
      }

      if (pos.stopLoss && curPrice > 0) {
        const distToStop = ((curPrice - pos.stopLoss) / curPrice) * 100;
        if (distToStop < 2 && distToStop > 0) {
          stopClose.push({ symbol: pos.symbol, dist: distToStop });
        }
      }
    }

    return { maxConc, maxConcSym, stopClose };
  }, [positions, livePrices, portfolioMetrics.totalValue]);

  const topPicks = useMemo(
    () => (advisor?.topPicks || []).filter(p => p.cls !== 'sell').slice(0, 3),
    [advisor]
  );

  const recentAlerts = useMemo(
    () => (alertLog?.alerts || []).slice(0, 5),
    [alertLog]
  );

  const recentHistory = useMemo(
    () => (portfolio?.history || []).slice(-3).reverse(),
    [portfolio]
  );

  return (
    <div className="sec" style={{ padding: '16px 20px' }}>
      {/* KPI Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        {/* Card 1: Portföy */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Portföy Durumu</div>
          <div style={{ ...kpiValue, color: 'var(--cyan, #06b6d4)' }}>
            {tl(portfolioMetrics.totalValue)}
          </div>
          <div style={kpiRow}>
            <span>Günlük P&L</span>
            <span style={{
              fontWeight: 700,
              color: portfolioMetrics.dailyPnl >= 0 ? 'var(--green, #10b981)' : 'var(--red, #ef4444)',
            }}>
              {tl(portfolioMetrics.dailyPnl)} ({pct(portfolioMetrics.dailyPnlPct)})
            </span>
          </div>
          <div style={kpiRow}>
            <span>Açık Pozisyon</span>
            <span style={{ fontWeight: 700, color: '#fff' }}>{portfolioMetrics.openCount}</span>
          </div>
          <div style={kpiRow}>
            <span>Nakit</span>
            <span>{tl(portfolioMetrics.cash)}</span>
          </div>
        </div>

        {/* Card 2: Sistem */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Sistem Sağlığı</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: advisor?.scanning ? 'var(--orange, #f97316)' : 'var(--green, #10b981)',
              boxShadow: advisor?.scanning
                ? '0 0 8px var(--orange, #f97316)'
                : '0 0 6px var(--green, #10b981)',
              display: 'inline-block',
              animation: advisor?.scanning ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
              {advisor?.scanning ? 'Taranıyor...' : 'Hazır'}
            </span>
          </div>
          <div style={kpiRow}>
            <span>Son Tarama</span>
            <span style={{ fontWeight: 600 }}>{relTime(advisor?.lastUpdate)}</span>
          </div>
          <div style={kpiRow}>
            <span>Rejim</span>
            <span style={{
              fontWeight: 800,
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              background: `${REGIME_COLORS[regime.regime] || 'var(--t3)'}22`,
              color: REGIME_COLORS[regime.regime] || 'var(--t3)',
              border: `1px solid ${REGIME_COLORS[regime.regime] || 'var(--t3)'}55`,
            }}>
              {regime.label} ({regime.confidence}%)
            </span>
          </div>
          <div style={kpiRow}>
            <span>Live Polling</span>
            <span>
              {livePrice?.tierStats
                ? `${livePrice.tierStats.fast || 0}F / ${livePrice.tierStats.normal || 0}N / ${livePrice.tierStats.slow || 0}S`
                : '—'}
            </span>
          </div>
        </div>

        {/* Card 3: Performans */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Sinyal Performansı</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div>
              <div style={{ ...kpiValue, color: journalData.directionalAccuracy >= 55 ? 'var(--green)' : journalData.directionalAccuracy >= 45 ? 'var(--yellow)' : 'var(--red, #ef4444)' }}>
                {journalData.evaluated > 0 ? `${journalData.directionalAccuracy?.toFixed(0)}%` : '—'}
              </div>
              <div style={{ fontSize: 9, color: 'var(--t3)' }}>Forward Hit</div>
            </div>
            <div>
              <div style={{ ...kpiValue, fontSize: 18, color: signalStats?.winRate >= 55 ? 'var(--green)' : signalStats?.winRate >= 45 ? 'var(--yellow)' : 'var(--red, #ef4444)' }}>
                {signalStats?.total > 0 ? `${signalStats.winRate?.toFixed(0)}%` : '—'}
              </div>
              <div style={{ fontSize: 9, color: 'var(--t3)' }}>Tracker WR</div>
            </div>
          </div>
          <div style={kpiRow}>
            <span>Beklenti</span>
            <span style={{
              fontWeight: 700,
              color: (journalData.expectancy || 0) >= 0 ? 'var(--green)' : 'var(--red)',
            }}>
              {journalData.evaluated > 0 ? pct(journalData.expectancy, 2) : '—'}
            </span>
          </div>
          <div style={kpiRow}>
            <span>Açık / Kapanmış</span>
            <span>{signalStats?.active || 0} / {signalStats?.total || 0}</span>
          </div>
          <div style={kpiRow}>
            <span>Güven</span>
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: journalData.sampleConfidence === 'high' ? 'var(--green)'
                : journalData.sampleConfidence === 'medium' ? 'var(--yellow)'
                : 'var(--t3)',
            }}>
              {journalData.sampleConfidence === 'high' ? 'YÜKSEK'
                : journalData.sampleConfidence === 'medium' ? 'ORTA'
                : journalData.sampleConfidence === 'low' ? 'DÜŞÜK'
                : 'YETERSİZ'}
              {journalData.evaluated > 0 ? ` (${journalData.evaluated} örnek)` : ''}
            </span>
          </div>
        </div>

        {/* Card 4: Risk */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Risk Özeti</div>
          {positions.length > 0 ? (
            <>
              <div style={kpiRow}>
                <span>Max Konsantrasyon</span>
                <span style={{
                  fontWeight: 700,
                  color: riskMetrics.maxConc > 30 ? 'var(--red)' : riskMetrics.maxConc > 20 ? 'var(--yellow)' : 'var(--green)',
                }}>
                  {riskMetrics.maxConcSym} %{riskMetrics.maxConc.toFixed(0)}
                </span>
              </div>
              <div style={kpiRow}>
                <span>Risk Çarpanı (Rejim)</span>
                <span style={{
                  fontWeight: 700,
                  color: regime.riskMult < 0.7 ? 'var(--red)' : regime.riskMult < 1 ? 'var(--yellow)' : 'var(--green)',
                }}>
                  ×{regime.riskMult.toFixed(1)}
                </span>
              </div>
              {riskMetrics.stopClose.length > 0 ? (
                <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700 }}>
                  ⚠ Stop Yakın: {riskMetrics.stopClose.map(s => `${s.symbol} (%${s.dist.toFixed(1)})`).join(', ')}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--green)' }}>✓ Stop yakınlığı yok</div>
              )}
              <div style={kpiRow}>
                <span>Sektör Sayısı</span>
                <span>{new Set(positions.map(p => p.sector).filter(Boolean)).size || '—'}</span>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: '12px 0' }}>
              Açık pozisyon yok
            </div>
          )}
        </div>

        {/* Card 5: Profit Engine (journal-driven governor) */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Profit Engine</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 12, fontWeight: 800, padding: '2px 10px', borderRadius: 4,
              background: `${GOV_COLORS[governor.mode] || 'var(--t3)'}22`,
              color: GOV_COLORS[governor.mode] || 'var(--t3)',
              border: `1px solid ${GOV_COLORS[governor.mode] || 'var(--t3)'}55`,
            }}>
              {governor.mode}
            </span>
            {governor.positionMult < 1 && (
              <span style={{ fontSize: 11, color: 'var(--orange)', fontWeight: 700 }}>
                pozisyon ×{governor.positionMult}
              </span>
            )}
            {governor.scoreCutoffDelta > 0 && (
              <span style={{ fontSize: 11, color: 'var(--yellow)', fontWeight: 700 }}>
                eşik +{governor.scoreCutoffDelta}
              </span>
            )}
          </div>
          <div style={kpiRow}>
            <span>Son 20 Net Beklenti</span>
            <span style={{
              fontWeight: 700,
              color: (journalData.rolling20?.netExpectancy ?? 0) >= 0 ? 'var(--green)' : 'var(--red)',
            }}>
              {journalData.rolling20?.samples
                ? pct(journalData.rolling20.netExpectancy, 2)
                : '—'}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--t3)', lineHeight: 1.5 }}>
            {(governor.reasons || []).slice(0, 2).map((r, i) => <div key={i}>• {r}</div>)}
          </div>
        </div>
      </div>

      {/* Detail Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
        gap: 10,
      }}>
        {/* Son AI Picks */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={kpiLabel}>Son AI Picks</div>
            {onTabChange && (
              <button
                onClick={() => onTabChange('signals')}
                style={{
                  background: 'none', border: 'none', color: 'var(--cyan)', cursor: 'pointer',
                  fontSize: 10, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                Tümünü Gör →
              </button>
            )}
          </div>
          {advisor?.scanning && !topPicks.length ? (
            <div style={{ color: 'var(--orange)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--orange)',
                boxShadow: '0 0 6px var(--orange)', display: 'inline-block',
                animation: 'pulse 1.5s ease-in-out infinite',
              }} />
              Taranıyor...
            </div>
          ) : topPicks.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topPicks.map((p, i) => {
                const gradeColor = p.grade === 'A' ? 'var(--green)' : p.grade === 'B' ? 'var(--cyan)' : p.grade === 'C' ? 'var(--yellow)' : 'var(--orange)';
                return (
                  <div
                    key={p.symbol}
                    onClick={() => onAnalyze?.(p.symbol)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
                      background: i === 0 ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 800, fontSize: 13, color: '#fff' }}>{p.symbol}</span>
                      <span style={{
                        fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 2,
                        background: gradeColor, color: '#000',
                      }}>{p.grade}</span>
                      {p.tier && (
                        <span style={{ fontSize: 9, color: 'var(--t3)' }}>{p.tier}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
                      <span style={{ color: 'var(--t2)' }}>{p.signal?.split(' ')[0] || '—'}</span>
                      <span style={{ fontWeight: 700, color: 'var(--cyan)' }}>
                        {p.confidence ? `${p.confidence}` : p.score?.toFixed(1) || '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: '10px 0' }}>
              Henüz tarama yapılmadı
            </div>
          )}
        </div>

        {/* Günlük Aktivite */}
        <div style={cardStyle}>
          <div style={kpiLabel}>Günlük Aktivite</div>
          {recentAlerts.length > 0 || recentHistory.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recentAlerts.map((a, i) => (
                <div key={i} style={{
                  fontSize: 11, color: 'var(--t2)', padding: '3px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.symbol && <span style={{ fontWeight: 700, color: '#fff', marginRight: 6 }}>{a.symbol}</span>}
                    {a.message || a.signal || a.type || '—'}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--t3)', marginLeft: 8, whiteSpace: 'nowrap' }}>
                    {relTime(a.timestamp || a.ts)}
                  </span>
                </div>
              ))}
              {recentHistory.length > 0 && (
                <>
                  <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 4 }}>Son İşlemler</div>
                  {recentHistory.map((h, i) => (
                    <div key={i} style={{
                      fontSize: 11, color: 'var(--t2)', padding: '3px 0',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>
                        <span style={{ fontWeight: 700, color: '#fff' }}>{h.symbol || '—'}</span>
                        {' '}{h.action || h.type || '—'}
                      </span>
                      <span style={{
                        fontWeight: 600,
                        color: (h.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)',
                      }}>
                        {h.pnl != null ? pct(h.pnl) : ''}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : (
            <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: '10px 0' }}>
              Bugün henüz aktivite yok
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
