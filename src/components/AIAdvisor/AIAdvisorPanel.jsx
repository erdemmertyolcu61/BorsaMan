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

// Expandable bottom panel for detailed AI insights
export function AIAdvisorDetailPanel({ advisor = {}, addToPortfolio, portfolio, onAnalyze }) {
  const {
    topPicks = [],
    riskAlerts = [],
    marketSentiment = null,
    advisorLog = [],
    sectorHeatmap = {},
    scanResults = [],
  } = advisor;
  const [open, setOpen] = useState(false);
  const [intradayResults, setIntradayResults] = useState([]);

  // Listen for intraday scan results
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.results) setIntradayResults(e.detail.results);
    };
    window.addEventListener('trades-scan-complete', handler);
    return () => window.removeEventListener('trades-scan-complete', handler);
  }, []);

  if (!marketSentiment && topPicks.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
      background: 'var(--bg1)', borderTop: '2px solid var(--cyan)',
      transition: 'max-height 0.3s ease',
      maxHeight: open ? 420 : 32, overflow: 'hidden',
    }}>
      {/* Toggle header */}
      <div onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px', cursor: 'pointer', userSelect: 'none',
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)', height: 32, boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10 }}>
          <span style={{ fontWeight: 800, color: 'var(--blue)', fontSize: 11, letterSpacing: 0.5 }}>
            ★ EN İYİ 5 FIRSAT
          </span>
          {/* AL / SAT breakdown */}
          {(() => {
            const buyCount = topPicks.filter(p => p.cls !== 'sell').length;
            const sellCount = topPicks.filter(p => p.cls === 'sell').length;
            return (
              <span style={{ fontSize: 10, color: 'var(--t3)' }}>
                <span style={{ color: 'var(--green)', fontWeight: 700 }}>{buyCount} AL</span>
                {sellCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {sellCount} SAT</span>}
              </span>
            );
          })()}
          {marketSentiment && <span style={{ color: marketSentiment.color, fontWeight: 700, background: marketSentiment.color + '18', padding: '2px 8px', borderRadius: 4, fontSize: 9 }}>{marketSentiment.sentiment}</span>}
          {!open && [...topPicks].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5).map(p => {
            const isSell = p.cls === 'sell';
            return (
              <span key={p.symbol} style={{
                color: isSell ? 'var(--red)' : 'var(--green)', fontWeight: 700, fontSize: 10,
                background: 'var(--bg3)', padding: '1px 6px', borderRadius: 3,
                border: `1px solid ${isSell ? 'var(--red)' : 'var(--border)'}`,
              }}>
                {p.symbol} {isSell ? '↓' : ''}
              </span>
            );
          })}
        </div>
        <span style={{ color: 'var(--t2)', fontSize: 12, transition: 'transform 0.3s', transform: open ? 'rotate(180deg)' : 'rotate(0)' }}>▲</span>
      </div>
      {/* Content */}
      <div style={{ padding: '0 16px 10px', display: 'flex', gap: 16, fontSize: 10, overflowY: 'auto', maxHeight: 380, flexWrap: 'wrap' }}>
      {/* Top 5 Picks — sorted by score, AL=green SAT=red */}
      {topPicks.length > 0 && (
        <div style={{ flex: 2, minWidth: 320 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            ★ En İyi 5 Fırsat
            <span style={{ fontSize: 9, color: 'var(--t3)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              ({topPicks.filter(p => p.cls !== 'sell').length} AL · {topPicks.filter(p => p.cls === 'sell').length} SAT)
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
            {[...topPicks].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5).map((p, idx) => {
              const isSell = p.cls === 'sell';
              const accentColor = isSell ? 'var(--red)' : 'var(--green)';
              const accentBg = isSell ? 'var(--red2)' : 'var(--green2)';
              const stopPctAbs = Math.abs(p.stopPct || 0);
              const targetPctAbs = Math.abs(p.targetPct || 0);
              return (
                <div key={p.symbol}
                  onClick={() => onAnalyze && onAnalyze(p.symbol)}
                  style={{
                    background: 'var(--bg3)',
                    borderLeft: `3px solid ${accentColor}`,
                    borderRadius: 4, padding: '7px 10px', cursor: 'pointer',
                    position: 'relative', overflow: 'hidden',
                  }}>
                  {/* Rank badge */}
                  <div style={{
                    position: 'absolute', top: 4, right: 6,
                    fontSize: 8, color: 'var(--t3)', fontWeight: 700,
                  }}>#{idx + 1}</div>

                  {/* Symbol + signal badge */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--t1)' }}>{p.symbol}</span>
                      <span style={{
                        fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                        background: accentBg, color: accentColor, border: `1px solid ${accentColor}`,
                      }}>
                        {isSell ? 'SAT' : 'AL'}
                      </span>
                      {p._alreadyHolding && <span style={{ fontSize: 8, color: 'var(--orange)' }}>●portfoy</span>}
                    </div>
                    <span style={{ fontWeight: 700, color: 'var(--cyan)', fontSize: 11 }}>{(p.score || 0).toFixed(1)}</span>
                  </div>

                  {/* Price + change + sector */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 10, color: 'var(--t2)', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{(p.price || 0).toFixed(2)} TL</span>
                    <span style={{ color: (p.change || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 9 }}>
                      {(p.change || 0) >= 0 ? '+' : ''}{(p.change || 0).toFixed(1)}%
                    </span>
                    <span style={{ color: 'var(--t3)', fontSize: 8 }}>{p.sector}</span>
                  </div>

                  {/* Stop / Target with percentage */}
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 9 }}>
                    <span>
                      <span style={{ color: 'var(--t3)' }}>Stop </span>
                      <span style={{ color: 'var(--red)', fontWeight: 600 }}>
                        {p.stop ? p.stop.toFixed(2) : '-'}
                        {stopPctAbs > 0 && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> ({stopPctAbs.toFixed(1)}%)</span>}
                      </span>
                    </span>
                    <span>
                      <span style={{ color: 'var(--t3)' }}>Hedef </span>
                      <span style={{ color: accentColor, fontWeight: 600 }}>
                        {p.target ? p.target.toFixed(2) : '-'}
                        {targetPctAbs > 0 && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> ({isSell ? '-' : '+'}{targetPctAbs.toFixed(1)}%)</span>}
                      </span>
                    </span>
                    <span style={{ color: 'var(--t3)' }}>R/R 1:{(p.rr || 0).toFixed(1)}</span>
                  </div>

                  {/* Sell-side: sell potential / buy-side: tomorrow potential */}
                  {isSell && p.sellPotential != null && (
                    <div style={{ marginTop: 3, fontSize: 8, color: 'var(--red)' }}>
                      Aşağı potansiyel: <span style={{ fontWeight: 700 }}>{p.sellPotential}</span>/100
                      {(p.rsi || 0) > 65 && <span style={{ color: 'var(--orange)', marginLeft: 4 }}>RSI {(p.rsi || 0).toFixed(0)} ↑aşırı</span>}
                    </div>
                  )}
                  {!isSell && p.tomorrowPotential != null && p.tomorrowPotential > 0 && (
                    <div style={{ marginTop: 3, fontSize: 8, color: 'var(--green)' }}>
                      Potansiyel: <span style={{ fontWeight: 700 }}>{p.tomorrowPotential}</span>/100
                      {p.newsHeadline && <span style={{ color: 'var(--t3)', marginLeft: 4 }} title={p.newsHeadline}>📰</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Risk Alerts + Market Summary + Breadth */}
      <div style={{ flex: 1, minWidth: 200 }}>
        {/* Market Breadth Gauge */}
        {marketSentiment && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--purple)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Piyasa Genisligi</div>
            <div style={{ background: 'var(--bg3)', padding: 8, borderRadius: 4, borderLeft: '3px solid ' + marketSentiment.color }}>
              <div style={{ fontWeight: 700, color: marketSentiment.color, fontSize: 12 }}>{marketSentiment.sentiment}</div>
              {/* Breadth bar: AL vs SAT visual */}
              <div style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--t3)', marginBottom: 2 }}>
                  <span style={{ color: 'var(--green)' }}>{marketSentiment.buys} AL</span>
                  <span>{marketSentiment.scanned - marketSentiment.buys - marketSentiment.sells} TUT</span>
                  <span style={{ color: 'var(--red)' }}>{marketSentiment.sells} SAT</span>
                </div>
                <div style={{ display: 'flex', height: 10, borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                  <div style={{ width: `${marketSentiment.buys / marketSentiment.scanned * 100}%`, background: 'var(--green)', transition: 'width 0.5s' }} />
                  <div style={{ flex: 1, background: 'var(--bg2)' }} />
                  <div style={{ width: `${marketSentiment.sells / marketSentiment.scanned * 100}%`, background: 'var(--red)', transition: 'width 0.5s' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 8, color: 'var(--t3)' }}>
                  <span>A/D: {(marketSentiment.buys / (marketSentiment.sells || 1)).toFixed(2)}</span>
                  <span>RSI: {marketSentiment.avgRSI.toFixed(0)}</span>
                  <span>Birikim: {marketSentiment.accumulations}</span>
                </div>
              </div>
              {/* Sector Rotation */}
              {marketSentiment.sectorRotation && marketSentiment.sectorRotation.length > 0 && (
                <div style={{ marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                  <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.5, marginBottom: 3 }}>Sektor Rotasyonu</div>
                  {marketSentiment.sectorRotation.slice(0, 4).map((s, i) => (
                    <div key={s.sector} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, padding: '1px 0' }}>
                      <span style={{ color: i === 0 ? 'var(--green)' : 'var(--t2)' }}>{i + 1}. {s.sector}</span>
                      <span style={{ color: s.avgScore >= 2 ? 'var(--green)' : s.avgScore >= 0 ? 'var(--yellow)' : 'var(--red)' }}>
                        {s.avgScore >= 0 ? '+' : ''}{s.avgScore.toFixed(1)} ({s.total})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Risk Alerts */}
        {riskAlerts.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--orange)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Uyarılar</div>
            {riskAlerts.slice(0, 5).map((a, i) => (
              <div key={i} style={{
                fontSize: 9, padding: '3px 6px', marginBottom: 2, borderRadius: 3,
                background: a.type === 'err' ? 'var(--red2)' : a.type === 'warn' ? '#ffd60022' : 'var(--green2)',
                color: a.type === 'err' ? 'var(--red)' : a.type === 'warn' ? 'var(--yellow)' : 'var(--green)',
              }}>
                {a.type === 'err' ? '!' : a.type === 'warn' ? '!' : '+'} {a.msg}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Intraday Trade Results Cross-Reference */}
      {intradayResults.length > 0 && (
        <div style={{ flex: '1 1 100%', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--yellow)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            Intraday Firsatlar ({intradayResults.length})
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {intradayResults.slice(0, 6).map(r => (
              <div key={r.symbol} onClick={() => onAnalyze && onAnalyze(r.symbol)} style={{
                background: 'var(--bg3)', borderLeft: '3px solid var(--yellow)', borderRadius: 4,
                padding: '4px 8px', cursor: 'pointer', minWidth: 140,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: 11, color: 'var(--t1)' }}>{r.symbol}</span>
                  <span style={{ fontSize: 9, color: 'var(--yellow)', fontWeight: 600 }}>%{r.confidence}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                  <span>{r.price?.toFixed(2)}</span>
                  <span style={{ color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>{r.change >= 0 ? '+' : ''}{r.change?.toFixed(1)}%</span>
                  <span>R/R 1:{r.intradayRR?.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sector Heatmap */}
      {sectorHeatmap && Object.keys(sectorHeatmap).length > 0 && (
        <div style={{ flex: '1 1 100%', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <SectorHeatmap sectorMetrics={sectorHeatmap} />
        </div>
      )}
      </div>
    </div>
  );
}
