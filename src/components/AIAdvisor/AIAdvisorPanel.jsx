import { useState, useEffect, useCallback } from 'react';
import SectorHeatmap from '../Heatmap/SectorHeatmap.jsx';
import { isMarketOpen, isMarketClosedForDay } from '../../hooks/useAIAdvisor.js';
import { getMetrics, isTelemetryEnabled, getAllDataFreshness, setFetchTimestamp } from '../../utils/telemetry.js';
import { getSourceHealth, recordSourceSuccess, recordSourceFailure } from '../../utils/fetchEngine.js';
import { 
  initTop10Intelligence, 
  dailyTop10Cycle, 
  predictTomorrowTop10, 
  getSystemPerformance,
  getTopRules 
} from '../../utils/top10Intelligence.js';
import { getRecentTopGainers } from '../../utils/topGainersEngine.js';

function DataFreshnessBadge() {
  const [freshness, setFreshness] = useState(null);

  useEffect(() => {
    if (!isTelemetryEnabled()) return;
    
    const update = () => {
      const m = getMetrics();
      setFreshness(m.lastFetch);
    };
    
    update();
    const interval = setInterval(update, 30000); // Update every 30s
    return () => clearInterval(interval);
  }, []);

  if (!freshness) return null;

  const age = Date.now() - freshness.ts;
  const ageMin = Math.floor(age / 60000);
  const isFresh = ageMin < 5;
  const isStale = ageMin > 15;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderLeft: '1px solid var(--border)', paddingLeft: 10 }}>
      <span style={{ fontSize: 10, color: 'var(--t3)' }}>Veri:</span>
      <span style={{ 
        fontSize: 10, 
        fontWeight: 600,
        color: isFresh ? 'var(--green)' : isStale ? 'var(--red)' : 'var(--yellow)'
      }}>
        {ageMin < 1 ? '<1d' : `${ageMin}d`}
      </span>
      <span style={{ fontSize: 9, color: 'var(--t3)' }}>{freshness.source}</span>
    </div>
  );
}

function SourceHealthBadge() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const update = () => {
      try {
        setHealth(getSourceHealth());
      } catch {}
    };
    
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!health) return null;

  const onlineCount = Object.values(health).filter(h => h.status === 'online').length;
  const totalCount = Object.keys(health).length;
  const hasIssues = onlineCount < totalCount;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderLeft: '1px solid var(--border)', paddingLeft: 10 }}>
      <span style={{ fontSize: 10, color: 'var(--t3)' }}>Kaynak:</span>
      <span style={{ 
        fontSize: 10, 
        fontWeight: 600,
        color: hasIssues ? 'var(--yellow)' : 'var(--green)'
      }}>
        {onlineCount}/{totalCount}
      </span>
    </div>
  );
}

function StaleWarningBadge() {
  const [freshness, setFreshness] = useState({});

  useEffect(() => {
    const update = () => {
      try {
        setFreshness(getAllDataFreshness());
      } catch {}
    };
    
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, []);

  const staleSources = Object.entries(freshness).filter(([_, f]) => f.stale);
  
  if (staleSources.length === 0) return null;

  return (
    <div style={{ 
      display: 'flex', alignItems: 'center', gap: 4, 
      borderLeft: '1px solid var(--red)', paddingLeft: 10,
      background: 'rgba(255,0,0,0.1)', borderRadius: 4, padding: '2px 8px'
    }}>
      <span style={{ fontSize: 10, color: 'var(--red)' }}>⚠️ Eski Veri</span>
      <span style={{ fontSize: 9, color: 'var(--t3)' }}>
        {staleSources.map(([s, _]) => s).join(', ')}
      </span>
    </div>
  );
}

export default function AIAdvisorPanel({ advisor = {}, addToPortfolio, portfolio, onAnalyze }) {
  const {
    globalMarket = [],
    topPicks = [],
    riskAlerts = [],
    marketSentiment = null,
    scanning = false,
    lastUpdate = null,
    scanProgress = { done: 0, total: 0 },
    manualScan = null,
    scanResults = [],
  } = advisor;
  const [intradayCount, setIntradayCount] = useState(0);
  
  // Top10 Intelligence State
  const [top10Open, setTop10Open] = useState(false);
  const [top10Loading, setTop10Loading] = useState(false);
  const [todayTop10, setTodayTop10] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [top10Stats, setTop10Stats] = useState(null);
  const [dbInitialized, setDbInitialized] = useState(false);
  const [processLog, setProcessLog] = useState([]); // For UI feedback
  
  const addLog = (msg, type = 'info') => {
    setProcessLog(prev => [{ msg, type, ts: new Date() }, ...prev].slice(0, 10));
  };
  
  const loadTop10Data = useCallback(async () => {
    if (!dbInitialized) {
      await initTop10Intelligence();
      setDbInitialized(true);
      addLog('Veritabanı başlatıldı', 'ok');
    }
    
    setTop10Loading(true);
    addLog('Veri yükleniyor...', 'loading');
    try {
      const [recent, preds, stats] = await Promise.all([
        getRecentTopGainers(5),
        predictTomorrowTop10(),
        getSystemPerformance()
      ]);
      
      if (recent.length > 0) {
        setTodayTop10(recent[0].stocks || []);
        addLog(`${recent[0].stocks?.length || 0} hisse yüklendi`, 'ok');
      }
      setPredictions(preds.slice(0, 5));
      setTop10Stats(stats);
      addLog('Tahminler hazır', 'ok');
    } catch (e) {
      console.warn('[Top10Panel] Load failed:', e);
      addLog(`Hata: ${e.message}`, 'error');
    } finally {
      setTop10Loading(false);
    }
  }, [dbInitialized]);
  
  const runDailyCycle = useCallback(async () => {
    if (!dbInitialized) {
      await initTop10Intelligence();
      setDbInitialized(true);
      addLog('Veritabanı başlatıldı', 'ok');
    }
    
    setTop10Loading(true);
    try {
      // Step 1: Fetch Top10
      addLog('1/4: Top10 verileri çekiliyor...', 'loading');
      const top10Result = await dailyTop10Cycle();
      
      if (!top10Result) {
        addLog('Top10 verisi çekilemedi - tekrar deniyorum', 'warn');
        // Retry once
        await new Promise(r => setTimeout(r, 2000));
        const retryResult = await dailyTop10Cycle();
        if (!retryResult) {
          throw new Error('Top10 verisi çekilemedi');
        }
      } else {
        addLog(`Top10 kaydedildi: ${top10Result.top10?.stocks?.length || 0} hisse`, 'ok');
      }
      
      // Step 2: Load data
      await loadTop10Data();
      
      // Success
      addLog('Güncelleme tamamlandı!', 'ok');
    } catch (e) {
      console.warn('[Top10Panel] Daily cycle failed:', e);
      addLog(`Hata: ${e.message}`, 'error');
    } finally {
      setTop10Loading(false);
    }
  }, [dbInitialized, loadTop10Data]);

  // Listen for TradesTab scan completion
  useEffect(() => {
    const handler = (e) => {
      setIntradayCount(e.detail?.results?.length || 0);
    };
    window.addEventListener('trades-scan-complete', handler);
    return () => window.removeEventListener('trades-scan-complete', handler);
  }, []);

  return (
    <div style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)', padding: '10px 20px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
      {/* AI Status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: scanning ? 'var(--orange)' : 'var(--green)', boxShadow: scanning ? '0 0 8px var(--orange)' : '0 0 8px var(--green)' }} />
        <span style={{ fontWeight: 800, color: 'var(--blue)', fontSize: 13, letterSpacing: 0.5 }}>AI ADVISOR</span>
        {/* Market Mode Badge */}
        {!scanning && (
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
            padding: '2px 8px', borderRadius: 10,
            background: isMarketOpen() ? 'var(--green)' : 'var(--cyan)',
            color: '#000',
          }}>
            {isMarketOpen() ? 'CANLI' : 'YARIN İÇİN'}
          </span>
        )}
        {scanning && <span style={{ color: 'var(--yellow)' }}>Taranıyor... {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : ''}</span>}
        {!scanning && lastUpdate && <span style={{ color: 'var(--t3)' }}>{new Date(lastUpdate).toLocaleTimeString('tr-TR')}</span>}
        <DataFreshnessBadge />
        <SourceHealthBadge />
        <StaleWarningBadge />
      </div>

      {/* Global Market Ticker */}
      {globalMarket.length > 0 && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          {globalMarket.map(g => (
            <div key={g.symbol} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <span style={{ color: 'var(--t3)', fontSize: 11 }}>{g.label}</span>
              <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{g.price >= 1000 ? g.price.toFixed(0) : g.price >= 10 ? g.price.toFixed(2) : g.price.toFixed(4)}</span>
              <span style={{ color: g.change >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 11, fontWeight: 600 }}>
                {g.change >= 0 ? '+' : ''}{g.change.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Market Sentiment */}
      {marketSentiment && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          <span style={{ fontWeight: 700, color: marketSentiment.color, fontSize: 13 }}>{marketSentiment.sentiment}</span>
          <span style={{ color: 'var(--green)', fontSize: 11, fontWeight: 500 }}>{marketSentiment.buys} AL</span>
          <span style={{ color: 'var(--yellow)', fontSize: 11, fontWeight: 500 }}>{marketSentiment.scanned - marketSentiment.buys - marketSentiment.sells} TUT</span>
          <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 500 }}>{marketSentiment.sells} SAT</span>
        </div>
      )}

      {/* Risk Alerts Badge */}
      {riskAlerts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          <span style={{ color: riskAlerts.some(a => a.type === 'err') ? 'var(--red)' : 'var(--yellow)', fontWeight: 700, fontSize: 12 }}>
            {riskAlerts.filter(a => a.type === 'err' || a.type === 'warn').length} Uyarı
          </span>
        </div>
      )}

      {/* Top Pick Quick View */}
      {topPicks.length > 0 && !scanning && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          <span style={{ color: 'var(--t3)', fontSize: 11 }}>En İyi:</span>
          {[...topPicks].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 4).map(p => {
            const isSell = p.cls === 'sell';
            return (
              <button key={p.symbol} onClick={() => onAnalyze && onAnalyze(p.symbol)} style={{
                background: isSell ? 'var(--red2)' : 'var(--green2)',
                color: isSell ? 'var(--red)' : 'var(--green)',
                border: `1px solid ${isSell ? 'var(--red)' : 'var(--green)'}`,
                borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600
              }}>
                {isSell ? '↓' : ''}{p.symbol} ({(p.score || 0).toFixed(1)})
              </button>
            );
          })}
        </div>
      )}

      {/* System Integration Status */}
      {!scanning && (scanResults?.length > 0 || intradayCount > 0) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          {scanResults?.length > 0 && (
            <span style={{ fontSize: 9, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)' }} />
              {scanResults.length} taranmis
            </span>
          )}
          {intradayCount > 0 && (
            <span style={{ fontSize: 9, color: 'var(--yellow)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--yellow)' }} />
              {intradayCount} intraday
            </span>
          )}
        </div>
      )}

      {/* Manual Scan Button */}
      <button onClick={manualScan} disabled={scanning} style={{
        background: scanning ? 'var(--bg3)' : 'linear-gradient(135deg, var(--cyan), var(--blue))',
        color: '#fff', border: 'none', borderRadius: 5, padding: '6px 16px', fontSize: 12, cursor: scanning ? 'default' : 'pointer',
        fontFamily: 'inherit', fontWeight: 600, opacity: scanning ? 0.5 : 1, letterSpacing: 0.5
      }}>
        {scanning ? 'TARANIYOR...' : 'TARA'}
      </button>
      
      {/* Top10 Intelligence Button */}
      <div style={{ position: 'relative' }}>
        <button onClick={() => { if (!top10Open) loadTop10Data(); setTop10Open(!top10Open); }} style={{
          background: top10Open ? 'var(--green)' : 'var(--bg3)',
          color: top10Open ? '#fff' : 'var(--green)', border: '1px solid var(--green)', borderRadius: 5,
          padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
          marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4
        }}>
          <span>📈</span>
          <span>TAHMİN TOP10</span>
          {top10Stats && top10Stats.validRules > 0 && (
            <span style={{ background: 'var(--green)', color: '#000', borderRadius: 10, padding: '1px 6px', fontSize: 9 }}>
              {top10Stats.validRules}
            </span>
          )}
        </button>
        
        {/* Top10 Dropdown Panel */}
        {top10Open && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 380, maxHeight: 450,
            background: 'var(--bg1)', border: '1px solid var(--green)', borderRadius: 8, 
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 1000, overflow: 'hidden'
          }}>
            {/* Header */}
            <div style={{ 
              padding: '10px 14px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{ fontWeight: 700, color: 'var(--green)', fontSize: 12 }}>📈 TOP10 TAHMİN SİSTEMİ</span>
              <button onClick={runDailyCycle} disabled={top10Loading} style={{
                background: top10Loading ? 'var(--bg3)' : 'var(--green)', color: top10Loading ? 'var(--t3)' : '#000',
                border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 10, cursor: top10Loading ? 'default' : 'pointer',
                fontWeight: 600
              }}>
                {top10Loading ? 'YÜKLENİYOR...' : 'GÜNCELLE'}
              </button>
            </div>
            
            {/* Stats Bar */}
            {top10Stats && (
              <div style={{ 
                padding: '8px 14px', background: 'var(--bg3)', borderBottom: '1px solid var(--border)',
                display: 'flex', gap: 16, fontSize: 10
              }}>
                <span><span style={{ color: 'var(--t3)' }}>Gün:</span> <span style={{ color: 'var(--green)', fontWeight: 600 }}>{top10Stats.top10Days}</span></span>
                <span><span style={{ color: 'var(--t3)' }}>Kural:</span> <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>{top10Stats.validRules}</span></span>
                <span><span style={{ color: 'var(--t3)' }}>Ort. %:</span> <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>{top10Stats.avgTop10Change}%</span></span>
                {top10Stats.bestRule && (
                  <span><span style={{ color: 'var(--t3)' }}>En İyi:</span> <span style={{ color: 'var(--green)', fontWeight: 600 }}>{top10Stats.bestRule.name}</span></span>
                )}
              </div>
            )}
            
            {/* Process Log Bar */}
            {processLog.length > 0 && (
              <div style={{ 
                padding: '8px 14px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, maxHeight: 80, overflow: 'auto'
              }}>
                {processLog.map((log, i) => (
                  <div key={i} style={{ 
                    display: 'flex', alignItems: 'center', gap: 8,
                    color: log.type === 'error' ? 'var(--red)' : log.type === 'ok' ? 'var(--green)' : log.type === 'warn' ? 'var(--yellow)' : log.type === 'loading' ? 'var(--cyan)' : 'var(--t3)'
                  }}>
                    <span style={{ fontSize: 9 }}>{log.ts?.toLocaleTimeString('tr-TR')}</span>
                    <span>{log.msg}</span>
                  </div>
                ))}
              </div>
            )}
            
            {/* Today's Top 10 */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', marginBottom: 8, textTransform: 'uppercase' }}>
                {isMarketClosedForDay() ? 'Bugünün BIST Top 10 (Kesinleşen)' : 'Dünün BIST Top 10'}
              </div>
              {top10Loading ? (
                <div style={{ color: 'var(--t3)', fontSize: 11 }}>Yükleniyor...</div>
              ) : todayTop10.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {todayTop10.map((s, i) => (
                    <button key={s.symbol} onClick={() => onAnalyze && onAnalyze(s.symbol)} style={{
                      background: 'var(--bg2)', color: s.change > 0 ? 'var(--green)' : 'var(--red)',
                      border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', 
                      fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600
                    }}>
                      {i+1}. {s.symbol} {s.change > 0 ? '+' : ''}{s.change?.toFixed(1)}%
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ color: 'var(--t3)', fontSize: 11 }}>Veri yok. "Güncelle" butonuna basın.</div>
              )}
            </div>
            
            {/* Predictions for Tomorrow */}
            <div style={{ padding: '10px 14px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', marginBottom: 8, textTransform: 'uppercase' }}>
                Yarın İçin Tahmin (Sistem Önerisi)
              </div>
              {top10Loading ? (
                <div style={{ color: 'var(--t3)', fontSize: 11 }}>Yükleniyor...</div>
              ) : predictions.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {predictions.map((p, i) => (
                    <div key={p.symbol} style={{ 
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      background: 'var(--bg2)', padding: '6px 10px', borderRadius: 4,
                      border: parseInt(p.confidence) > 60 ? '1px solid var(--green)' : '1px solid var(--border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: 'var(--t3)', fontSize: 10 }}>#{i+1}</span>
                        <button onClick={() => onAnalyze && onAnalyze(p.symbol)} style={{
                          background: 'transparent', color: 'var(--green)', border: 'none', 
                          cursor: 'pointer', fontWeight: 700, fontSize: 12, fontFamily: 'inherit'
                        }}>
                          {p.symbol}
                        </button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: 'var(--cyan)', fontSize: 10 }}>Skor: {p.score}</span>
                        <span style={{ 
                          background: parseInt(p.confidence) > 60 ? 'var(--green)' : 'var(--yellow)',
                          color: parseInt(p.confidence) > 60 ? '#000' : '#000',
                          borderRadius: 10, padding: '2px 8px', fontSize: 9, fontWeight: 600
                        }}>
                          %{p.confidence}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: 'var(--t3)', fontSize: 11 }}>
                  Tahmin yok. Önce "Güncelle" butonuna basarak veri çekin.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Collapsible Bottom Strip — "Son Başarılı AI Analizi" ──────────────────
// Shows the top-scored picks from the last scan as a horizontal scrollable
// card strip, exactly like the design in the reference screenshot.
// Persists to / restores from localStorage so it survives page navigation.
export function AIAdvisorDetailPanel({ advisor = {}, addToPortfolio, portfolio, onAnalyze }) {
  const {
    topPicks = [],
    scanResults = [],
    marketSentiment = null,
    scanning = false,
    lastUpdate = null,
  } = advisor;

  const [open, setOpen] = useState(true); // start expanded so user always sees it
  const [dismissed, setDismissed] = useState(false);

  // ── Cached picks: use live if available, fall back to localStorage ──
  const [displayPicks, setDisplayPicks] = useState(() => {
    try {
      const saved = localStorage.getItem('bist_last_ai_picks');
      if (saved) {
        const d = JSON.parse(saved);
        if (d?.picks?.length > 0) return d.picks;
      }
    } catch {}
    return [];
  });
  const [cachedMeta, setCachedMeta] = useState(() => {
    try {
      const saved = localStorage.getItem('bist_last_ai_picks');
      if (saved) {
        const d = JSON.parse(saved);
        return { ts: d.ts, scanned: d.scanned, sentiment: d.sentiment, buys: d.buys, sells: d.sells };
      }
    } catch {}
    return null;
  });

  // Update display picks when live scan completes (top picks mode)
  useEffect(() => {
    if (topPicks.length > 0) {
      setDisplayPicks([...topPicks].sort((a, b) => (b.score || 0) - (a.score || 0)));
    }
  }, [topPicks]);

  // ULTIMATE FALLBACK: if both topPicks AND cache are empty, but a raw scan
  // exists, derive top-5 buy candidates from scanResults sorted by score.
  // This guarantees the panel is never blank after a scan completes.
  useEffect(() => {
    if (topPicks.length === 0 && displayPicks.length === 0 && scanResults.length > 0) {
      const fallback = scanResults
        .filter(r => r.cls === 'buy' || (r.score || 0) >= 50)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 8)
        .map(r => ({
          symbol: r.symbol, sector: r.sector, price: r.price, change: r.change,
          signal: r.signal, cls: r.cls, score: r.score, rr: r.rr,
          stop: r.stop, target: r.target, stopPct: r.stopPct, targetPct: r.targetPct,
          holdText: r.holdText, _fallback: true,
        }));
      if (fallback.length > 0) setDisplayPicks(fallback);
    }
  }, [scanResults, topPicks.length, displayPicks.length]);

  // Load fresh meta from localStorage when scan updates it
  useEffect(() => {
    const handler = () => {
      try {
        const saved = localStorage.getItem('bist_last_ai_picks');
        if (saved) {
          const d = JSON.parse(saved);
          if (d?.ts) setCachedMeta({ ts: d.ts, scanned: d.scanned, sentiment: d.sentiment, buys: d.buys, sells: d.sells });
        }
      } catch {}
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, []);

  const isFromCache = topPicks.length === 0 && displayPicks.length > 0;
  const meta = cachedMeta;
  const picks = displayPicks.slice(0, 10);
  const hasPicks = picks.length > 0;

  // Render even when empty — show placeholder/empty state so user sees the panel.
  // Only hide if explicitly dismissed by clicking the X.
  if (dismissed) return null;

  // Format age string for the cache badge
  const cacheAge = meta?.ts ? (() => {
    const mins = Math.floor((Date.now() - meta.ts) / 60000);
    if (mins < 1) return 'az önce';
    if (mins < 60) return `${mins}dk önce`;
    return `${Math.floor(mins / 60)}s önce`;
  })() : null;

  const buyCount = picks.filter(p => p.cls !== 'sell').length;
  const sellCount = picks.filter(p => p.cls === 'sell').length;

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
      background: 'var(--bg1)', borderTop: '2px solid var(--cyan)',
      transition: 'max-height 0.28s ease',
      maxHeight: open ? 200 : 40, overflow: 'hidden',
      boxShadow: '0 -4px 24px rgba(0,0,0,0.5)',
    }}>
      {/* ── Header bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px', height: 40, background: 'var(--bg2)',
        borderBottom: open ? '1px solid var(--border)' : 'none',
        userSelect: 'none', boxSizing: 'border-box',
      }}>
        {/* Left: title + badge */}
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
        >
          <span style={{ fontWeight: 800, color: 'var(--cyan)', fontSize: 11, letterSpacing: 0.5 }}>
            ★ AI EN İYİ FIRSATLAR{hasPicks ? ` (${picks.length})` : ''}
          </span>
          {isFromCache && (
            <span style={{
              fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: '#ffd60022', color: 'var(--yellow)', border: '1px solid #ffd60044',
            }}>
              OTOMATİK YEDEK {cacheAge ? `• ${cacheAge}` : ''}
            </span>
          )}
          {scanning && (
            <span style={{ fontSize: 9, color: 'var(--orange)', fontWeight: 600 }}>● Taranıyor...</span>
          )}
          {/* AL / SAT counts */}
          <span style={{ fontSize: 10, color: 'var(--t3)' }}>
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>{buyCount} AL</span>
            {sellCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {sellCount} SAT</span>}
          </span>
          {/* Sentinel symbols preview (collapsed) */}
          {!open && picks.slice(0, 5).map(p => {
            const isSell = p.cls === 'sell';
            return (
              <span key={p.symbol} style={{
                fontSize: 10, fontWeight: 700,
                color: isSell ? 'var(--red)' : 'var(--green)',
                background: 'var(--bg3)', padding: '1px 7px', borderRadius: 3,
                border: `1px solid ${isSell ? '#ff444433' : 'var(--border)'}`,
              }}>
                {p.symbol}{isSell ? ' ↓' : ''}
              </span>
            );
          })}
        </div>
        {/* Right: chevron + X */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            onClick={() => setOpen(o => !o)}
            style={{ color: 'var(--t2)', fontSize: 12, cursor: 'pointer',
              transition: 'transform 0.28s', transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
          >▲</span>
          <span
            onClick={() => setDismissed(true)}
            style={{ color: 'var(--t3)', fontSize: 14, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
            title="Kapat"
          >✕</span>
        </div>
      </div>

      {/* ── Card strip ── */}
      <div style={{
        display: 'flex', gap: 0, overflowX: 'auto', overflowY: 'hidden',
        height: 160, alignItems: 'stretch', padding: '8px 12px', boxSizing: 'border-box',
        scrollbarWidth: 'thin',
      }}>
        {/* Empty / loading state */}
        {!hasPicks && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--t3)', fontSize: 12, gap: 12, flexDirection: 'column',
          }}>
            {scanning ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--orange)', boxShadow: '0 0 8px var(--orange)' }} />
                <span>Sistem taranıyor — ilk sonuçlar birazdan görünecek...</span>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18 }}>📊</span>
                  <span>Henüz tarama tamamlanmadı.</span>
                  {advisor.manualScan && (
                    <button
                      onClick={() => advisor.manualScan()}
                      style={{
                        background: 'linear-gradient(135deg, var(--cyan), var(--blue))',
                        color: '#fff', border: 'none', borderRadius: 4,
                        padding: '4px 12px', fontSize: 11, cursor: 'pointer',
                        fontFamily: 'inherit', fontWeight: 700, letterSpacing: 0.5,
                      }}
                    >
                      ŞİMDİ TARA
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 9, color: 'var(--t3)' }}>
                  Tarama tamamlandığında en yüksek skorlu 5+ hisse otomatik olarak burada görünecek.
                </div>
              </>
            )}
          </div>
        )}

        {hasPicks && picks.map((p, idx) => {
          const isSell = p.cls === 'sell';
          const accent = isSell ? 'var(--red)' : 'var(--green)';
          const accentDim = isSell ? '#ff444418' : '#00e68618';
          const stopPctAbs = Math.abs(p.stopPct || 0);
          const targetPctAbs = Math.abs(p.targetPct || 0);
          const signalLabel = isSell
            ? 'GÜÇLÜ SAT'
            : p.signal?.includes('GÜÇLÜ') ? 'GÜÇLÜ AL'
            : p.signal?.includes('SAT') ? 'SAT'
            : 'AL';

          return (
            <div
              key={p.symbol}
              onClick={() => onAnalyze && onAnalyze(p.symbol)}
              title={p._fallback ? 'Bu hisse katı filtreden geçemedi; en yüksek skorlu alternatif.' : ''}
              style={{
                flexShrink: 0, width: 210,
                background: p._fallback ? 'var(--bg2)' : 'var(--bg3)',
                borderLeft: `3px solid ${accent}`,
                borderRight: '1px solid var(--border)',
                padding: '8px 12px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                opacity: p._fallback ? 0.78 : 1,
                position: 'relative',
              }}
            >
              {/* Row 1: symbol + sector + signal + grade */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--t1)' }}>{p.symbol}</span>
                  {/* Grade badge — A/B/C/D */}
                  {p.grade && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 2,
                      background: p.grade === 'A' ? 'var(--green)' : p.grade === 'B' ? 'var(--cyan)' : p.grade === 'C' ? 'var(--yellow)' : 'var(--orange)',
                      color: '#000',
                    }} title={`Güven skoru: ${p.confidence}/100`}>
                      {p.grade}
                    </span>
                  )}
                  <span style={{ fontSize: 8, color: 'var(--t3)', marginLeft: 2 }}>{p.sector}</span>
                </div>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: accentDim, color: accent, border: `1px solid ${accent}44`,
                  whiteSpace: 'nowrap',
                }}>
                  {signalLabel}
                </span>
              </div>

              {/* Row 2: price + change + R/R + score */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, marginTop: 5 }}>
                <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{(p.price || 0).toFixed(2)} TL</span>
                <span style={{ color: (p.change || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                  {(p.change || 0) >= 0 ? '+' : ''}{(p.change || 0).toFixed(1)}%
                </span>
                <span style={{ color: 'var(--t3)', fontSize: 9 }}>R/O 1:{(p.rr || 0).toFixed(1)}</span>
                <span style={{ color: 'var(--cyan)', fontWeight: 700, fontSize: 10, marginLeft: 'auto' }}>
                  Skor: {(p.score || 0).toFixed(1)}
                </span>
              </div>

              {/* Row 3: stop + target */}
              <div style={{ display: 'flex', gap: 8, fontSize: 9, marginTop: 4 }}>
                <span>
                  <span style={{ color: 'var(--red)', fontWeight: 600 }}>
                    Stop: {p.stop ? p.stop.toFixed(2) : '-'}
                  </span>
                  {stopPctAbs > 0 && <span style={{ color: 'var(--t3)' }}> ({stopPctAbs.toFixed(1)}%)</span>}
                </span>
                <span>
                  <span style={{ color: accent, fontWeight: 600 }}>
                    Hedef: {p.target ? p.target.toFixed(2) : '-'}
                  </span>
                  {targetPctAbs > 0 && <span style={{ color: 'var(--t3)' }}> ({isSell ? '-' : '+'}{targetPctAbs.toFixed(1)}%)</span>}
                </span>
              </div>

              {/* Row 4: hold text */}
              <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 3 }}>
                {p.holdText || (isSell ? 'Kısa pozisyon' : '1-3 gün (kısa vade)')}
                {p._alreadyHolding && <span style={{ color: 'var(--orange)', marginLeft: 4 }}>●portföy</span>}
              </div>

              {/* Rank pill */}
              <div style={{
                position: 'absolute', top: 4, right: 4,
                fontSize: 7, color: 'var(--t3)', fontWeight: 700,
                background: 'var(--bg1)', padding: '1px 4px', borderRadius: 3,
              }}>#{idx + 1}</div>
            </div>
          );
        })}

        {/* Trailing info card */}
        {hasPicks && meta && (
          <div style={{
            flexShrink: 0, width: 140,
            background: 'var(--bg2)', borderLeft: '1px solid var(--border)',
            padding: '8px 12px', display: 'flex', flexDirection: 'column',
            justifyContent: 'center', gap: 5, color: 'var(--t3)', fontSize: 9,
          }}>
            <div style={{ color: 'var(--cyan)', fontWeight: 700, fontSize: 10 }}>{meta.sentiment}</div>
            <div><span style={{ color: 'var(--green)' }}>{meta.buys} AL</span> · <span style={{ color: 'var(--red)' }}>{meta.sells} SAT</span></div>
            <div>{meta.scanned} tarandı</div>
            {cacheAge && <div>{cacheAge}</div>}
            <div style={{ marginTop: 4, fontSize: 8, color: '#ffffff22' }}>
              * Bu veriler yeni bir tarama tamamlanana kadar güncel kalır. Yeni tarama bittiğinde otomatik güncellenir.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
