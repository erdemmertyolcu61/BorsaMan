import { useState, useEffect } from 'react';
import SectorHeatmap from '../Heatmap/SectorHeatmap.jsx';
import { isMarketOpen, isMarketClosedForDay } from '../../hooks/useAIAdvisor.js';
import { getMetrics, isTelemetryEnabled, getAllDataFreshness, setFetchTimestamp } from '../../utils/telemetry.js';
import { getSourceHealth, recordSourceSuccess, recordSourceFailure, fetchBigParaBatchPrices } from '../../utils/fetchEngine.js';

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
        if (d?.picks?.length > 0) {
          // Wall Street filter (v20) — mutlak tehlikeli olanlar at, akilli tavan izin ver
          const safe = d.picks.filter(p => {
            const tp = Math.max(p.todayPumpReal || 0, p.recentPump || 0, p.change || 0);
            if (tp >= 12) return false;                      // Gap-up mutlak red
            if ((p.rsi || 50) > 88) return false;            // RSI 88+ red
            if ((p.mfi || 50) > 88) return false;            // MFI 88+ red
            if ((p.cumulativePump || 0) >= 22) return false; // 2 gun kumulatif tavan red
            // Tavan range (7-12%): continuationProbability >= 38% ise izin ver
            if (tp >= 7) {
              return (p.continuationProbability || 0) >= 38;
            }
            return true;
          });
          return safe;
        }
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

  // ── SCAN COMPLETE → FRESH displayPicks (v19) ──
  // lastUpdate degistigi anda (yeni scan bitti) displayPicks'i DAIMA taze veriyle doldur.
  // Eski davranis: topPicks bosken stale localStorage kalmaya devam ediyordu.
  // Yeni davranis:
  //   - topPicks varsa → dogrudan kullan
  //   - topPicks yoksa (tavan gunu gibi all-filtered) → scanResults'tan best-effort fallback
  //   - Her iki durumda da eski localStorage cache'i devirip TAZE veri goster
  useEffect(() => {
    if (lastUpdate === null) return; // Hic scan olmamis — localStorage cache'i koru

    // ── PANEL-SIDE WALL STREET FILTER (v20 — akilli tavan) ──
    // Tum displayPicks'leri buradan geciren tek nokta.
    // v20: tp >= 7% artik MUTLAK red degil — continuationProbability >= 38% ise izin verilir.
    // (OZATD/OZSUB/HURGZ tipi: guclu kataliz + OBV birikim → dogru tahmin edilmisti)
    const isUnsafe = (r) => {
      const tp = Math.max(r.todayPumpReal || 0, r.recentPump || 0, r.change || 0);
      // Mutlak redler — kataliz bile kurtaramaz
      if (tp >= 12) return true;                       // Gap-up / devre kesici bolge
      if ((r.rsi || 50) > 88) return true;             // RSI 88+ tehlikeli asiri alim
      if ((r.mfi || 50) > 88) return true;             // MFI 88+ asiri overbought
      if ((r.cumulativePump || 0) >= 22) return true;  // 2 gun kumulatif tavan → yorgun
      // Akilli tavan (7-12%): backend'in calcContinuationProbability değerini kullan
      if (tp >= 7) {
        const prob = r.continuationProbability;
        // Backend hesaplamis → guven: >= 38% = GOSTER, < 38% = RED
        // Backend hesaplamamis (eski cache) → konservatiF: red
        if (prob == null || prob < 38) return true;
        return false; // Guclu devam sinyali (OZATD/OZSUB/HURGZ tipi)
      }
      // Kumulatif yorgunluk (tp < 7% ama 3 gunde +%18+) — kataliz yoksa red
      if ((r.cumulativePump || 0) >= 18) {
        const hasCatalyst = r.newsCategories?.some(c =>
          ['insider_buy', 'buyback', 'fund_inflow', 'contract'].includes(c));
        if (!hasCatalyst) return true;
      }
      return false;
    };

    if (topPicks.length > 0) {
      // topPicks zaten backend'de filtrelendi. Panel-side filter ikinci savunma:
      // tavan picks icin continuationProbability >= 38% kontrolu yapar,
      // mutlak tehlikeli senaryolar (RSI>88, gap-up) bloklanir.
      // Non-tavan + yuksek-confidence tavan picks gecer.
      const safe = [...topPicks]
        .filter(p => !isUnsafe(p))
        .sort((a, b) => {
          // Non-tavan daima tavan'in onunde
          const aPump = Math.max(a.todayPumpReal || 0, a.recentPump || 0);
          const bPump = Math.max(b.todayPumpReal || 0, b.recentPump || 0);
          if (aPump >= 7 && bPump < 7) return 1;
          if (bPump >= 7 && aPump < 7) return -1;
          if (aPump >= 7 && bPump >= 7) {
            return (b.continuationProbability || 0) - (a.continuationProbability || 0);
          }
          return (b.confidence || b.score || 0) - (a.confidence || a.score || 0);
        });
      setDisplayPicks(safe);
    } else if (scanResults.length > 0) {
      // Scan calisti ama topPicks bos (strict filtreler her seyi reddetti).
      // scanResults'tan KALITELI low-pump setup'lari sec — TAVAN ASLA YOK.
      const freshFallback = scanResults
        .filter(r => !isUnsafe(r))                    // Wall Street filter
        .filter(r => (r.score || 0) >= 45)
        .filter(r => (r.avgVolumeTL || 0) >= 1_000_000) // 1M TL min likidite
        .sort((a, b) => {
          // Quality-first: erken birikim varsa once, sonra confidence/score
          if (a._earlyPick && !b._earlyPick) return -1;
          if (b._earlyPick && !a._earlyPick) return 1;
          return (b.confidence || b.score || 0) - (a.confidence || a.score || 0);
        })
        .slice(0, 8)
        .map(r => ({
          symbol: r.symbol, sector: r.sector, price: r.price, change: r.change,
          signal: r.signal, cls: r.cls, score: r.score, rr: r.rr,
          stop: r.stop, target: r.target, stopPct: r.stopPct, targetPct: r.targetPct,
          holdText: r.holdText, atrPct: r.atrPct,
          recentPump: r.recentPump, cumulativePump: r.cumulativePump,
          todayPumpReal: r.todayPumpReal, continuationProbability: r.continuationProbability,
          confidence: r.confidence, grade: r.grade, tier: r.tier,
          _earlyPick: r._earlyPick, _earlyCount: r._earlyCount,
          _fallback: true, _warningPick: true,
          // ML Engine data (preserve if scanResults were ML-scored)
          mlConfidenceBoost: r.mlConfidenceBoost, mlBestRule: r.mlBestRule,
          mlMatchedCount: r.mlMatchedCount,
        }));
      setDisplayPicks(freshFallback);
    } else {
      setDisplayPicks([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdate]); // Sadece scan bitisinde calis — topPicks/scanResults bunu takip etmesin

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

  // isFromCache = panel showing saved localStorage data, not from current session scan.
  // After a scan (lastUpdate set), data is always fresh — never show OTOMATİK YEDEK badge.
  const isFromCache = lastUpdate === null && displayPicks.length > 0;
  const meta = cachedMeta;
  const picks = displayPicks.slice(0, 10);
  const hasPicks = picks.length > 0;

  // ── Veri yasi her dakika yenilensin ki "5dk once" → "6dk once" guncellensin.
  // (NOT: tum hook'lar early return ONCESI cagrilmali — React kurali)
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── STALE CACHE OTOMATIK YENILEME — DEVRE DISI ──
  // Otomatik tarama kaldirildi. Kullanici "↻ TARA" butonuna basarak manuel tarama yapar.

  // ── CANLI FIYAT GUNCELLEME (v20) ──
  // HEM cache HEM fresh-scan kartlari icin calisir.
  // Fresh scan: tarama ani fiyat → piyasa hareket edince kart guncel olmalidir.
  // Cache: localStorage'dan gelen eski fiyat → daha cok sapma olabilir.
  //
  // - _livePrice: anlık BigPara fiyatı → kartta PRIMARY gösterim
  // - _divergencePct: tarama fiyatından sapma yüzdesi
  // - _isStaleAdverse: AL önerisi -%3+ düştü → kırmızı uyarı
  // - _divergenceWarn: |sapma| > %6 → turuncu uyarı
  //
  // Interval: anlık bir kez çekilir + her 60s güncellenir (piyasa açıkken aktif)
  useEffect(() => {
    if (!displayPicks.length) return;
    let cancelled = false;

    const doLivePriceUpdate = () => {
      fetchBigParaBatchPrices().then(liveMap => {
        if (cancelled || !liveMap || Object.keys(liveMap).length === 0) return;
        setDisplayPicks(prev => {
          const updated = prev.map(p => {
            const live = liveMap[p.symbol];
            if (!live || !(live.price > 0)) return p;
            const scanPrice = p.price || 0;
            if (scanPrice <= 0) return p;
            const divPct = ((live.price - scanPrice) / scanPrice) * 100;
            const todayChg = live.change || 0;
            const adverseDrop = (p.cls !== 'sell') && (divPct < -3 || todayChg < -2.5);
            const adverseRise = (p.cls === 'sell') && (divPct > 3 || todayChg > 2.5);
            return {
              ...p,
              _livePrice:      live.price,
              _liveChange:     todayChg,
              _divergencePct:  divPct,
              _isStaleAdverse: adverseDrop || adverseRise,
              _divergenceWarn: Math.abs(divPct) > 6,
            };
          });
          // Cache picks: adverse olanlar sona (fresh scan siralama bozmasin)
          if (!isFromCache) return updated;
          return updated.sort((a, b) => {
            if (a._isStaleAdverse && !b._isStaleAdverse) return 1;
            if (b._isStaleAdverse && !a._isStaleAdverse) return -1;
            return (b.confidence || b.score || 0) - (a.confidence || a.score || 0);
          });
        });
      }).catch(() => {});
    };

    doLivePriceUpdate();                              // hemen bir kez
    const iv = setInterval(doLivePriceUpdate, 60_000); // sonra her 60s
    return () => { cancelled = true; clearInterval(iv); };
  }, [displayPicks.length, isFromCache]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ADVERSE COUNT — OTOMATIK TARAMA DEVRE DISI ──
  // Onceden: kartlarin yarisi adverse oldugunda otomatik manualScan() tetikleniyordu.
  // Kullanici talepte bulundu: otomatik tarama yok, sadece manuel buton.

  // ── TEKIL ANALIZ SYNC ──
  // Kullanici Tekil Analiz'de bir hisse analiz ettiginde, sonucu ile picks'i guncelle.
  // Tekil Analiz sonucu picks'tekiyle celisiyorsa cardi gerceklikle hizala.
  useEffect(() => {
    const handler = (e) => {
      const { symbol, signal, cls, score, price, change } = e.detail || {};
      if (!symbol) return;
      setDisplayPicks(prev => prev.map(p => {
        if (p.symbol !== symbol) return p;
        const conflicts = (p.cls !== cls) || Math.abs((p.score || 0) - (score || 0)) > 12;
        return {
          ...p,
          _liveSignal: signal,
          _liveCls: cls,
          _liveScore: score,
          _liveAnalysisPrice: price,
          _liveAnalysisChange: change,
          _conflictsWithLive: conflicts,
        };
      }));
    };
    window.addEventListener('analyze-result', handler);
    return () => window.removeEventListener('analyze-result', handler);
  }, []);

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

  // Cache yasli mi (>20 dk)? Kullaniciya isaret veriliyor.
  const isStale = meta?.ts && (Date.now() - meta.ts) > 20 * 60 * 1000;

  const buyCount = picks.filter(p => p.cls !== 'sell').length;
  const sellCount = picks.filter(p => p.cls === 'sell').length;

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
      background: 'linear-gradient(180deg, #0d1320 0%, #0a0e17 100%)',
      borderTop: '2px solid transparent',
      borderImage: 'linear-gradient(90deg, #06b6d4, #8b5cf6, #06b6d4) 1',
      transition: 'max-height 0.28s ease',
      maxHeight: open ? 235 : 40, overflow: 'hidden',
      boxShadow: '0 -8px 32px rgba(0, 230, 230, 0.12), 0 -4px 24px rgba(0,0,0,0.6)',
    }}>
      {/* Animated top accent line */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: 'linear-gradient(90deg, transparent, #06b6d4 30%, #8b5cf6 50%, #06b6d4 70%, transparent)',
        opacity: 0.6,
        animation: 'aiShimmer 4s linear infinite',
      }} />
      <style>{`
        @keyframes aiShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.3); }
        }
        .ai-pick-card { transition: transform .18s ease, box-shadow .18s ease, background .18s ease; }
        .ai-pick-card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0, 230, 230, 0.18); }
        .ai-pick-top1 { box-shadow: 0 0 0 1px #ffd60044, 0 0 14px #ffd60022 inset; }
        .ai-pick-top2 { box-shadow: 0 0 0 1px #06b6d433, 0 0 12px #06b6d422 inset; }
        .ai-pick-top3 { box-shadow: 0 0 0 1px #8b5cf633, 0 0 10px #8b5cf622 inset; }
      `}</style>
      {/* ── Header bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 14px', height: 40,
        background: 'linear-gradient(90deg, rgba(6,182,212,0.06), rgba(139,92,246,0.04))',
        borderBottom: open ? '1px solid var(--border)' : 'none',
        userSelect: 'none', boxSizing: 'border-box',
        backdropFilter: 'blur(10px)',
      }}>
        {/* Left: title + badge */}
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flex: 1 }}
        >
          <span style={{
            fontWeight: 800, fontSize: 11, letterSpacing: 0.6,
            background: 'linear-gradient(90deg, #06b6d4, #8b5cf6)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            textShadow: '0 0 12px rgba(6,182,212,0.3)',
          }}>
            ★ AI EN İYİ FIRSATLAR{hasPicks ? ` (${picks.length})` : ''}
          </span>
          {scanning && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--green)', boxShadow: '0 0 8px var(--green)',
              animation: 'pulseDot 1.4s ease-in-out infinite',
            }} />
          )}
          {isFromCache && (
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 10,
              background: isStale ? 'rgba(244,63,94,0.2)' : 'rgba(255,214,0,0.18)',
              color: isStale ? '#ff5470' : '#ffd600',
              border: `1px solid ${isStale ? 'rgba(244,63,94,0.5)' : 'rgba(255,214,0,0.45)'}`,
              letterSpacing: 0.4,
            }}>
              {isStale ? '⚠ ESKİ VERİ' : 'OTOMATİK YEDEK'} {cacheAge ? `• ${cacheAge}` : ''}
            </span>
          )}
          {scanning && (
            <span style={{ fontSize: 11, color: '#ff9a3c', fontWeight: 700 }}>● Taranıyor...</span>
          )}
          {/* AL / SAT counts */}
          <span style={{ fontSize: 12, color: '#a8b3c7', fontWeight: 600 }}>
            <span style={{ color: '#10e87a', fontWeight: 800 }}>{buyCount} AL</span>
            {sellCount > 0 && <span style={{ color: '#ff5470', fontWeight: 800 }}> · {sellCount} SAT</span>}
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
        {/* Right: refresh + chevron + X */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {advisor.manualScan && !scanning && (
            <button
              onClick={(e) => { e.stopPropagation(); advisor.manualScan(); }}
              title="Yeniden tara — tum cache temizlenir"
              style={{
                background: isStale ? '#ff5470' : 'rgba(6,182,212,0.12)',
                color: '#ffffff',
                border: `1px solid ${isStale ? '#ff5470' : 'rgba(6,182,212,0.55)'}`,
                borderRadius: 4, padding: '4px 12px', fontSize: 11,
                cursor: 'pointer', fontWeight: 800, fontFamily: 'inherit',
                letterSpacing: 0.4,
                boxShadow: isStale ? '0 0 12px rgba(244,63,94,0.4)' : '0 0 8px rgba(6,182,212,0.2)',
              }}
            >
              ↻ {isStale ? 'YENİLE' : 'TARA'}
            </button>
          )}
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

      {/* v26: YARIN UMUT BANDI — tüm picks emergency ise */}
      {hasPicks && displayPicks.every(p => p._emergencyPick) && (
        <div style={{
          padding: '6px 12px', fontSize: 11, color: '#fbbf24',
          background: 'linear-gradient(90deg, rgba(249,115,22,0.12), rgba(234,179,8,0.06))',
          borderTop: '1px solid rgba(249,115,22,0.3)',
          borderBottom: '1px solid rgba(249,115,22,0.2)',
          display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600,
        }}>
          <span>⚡</span>
          <span>Bugün kaliteli AL setup'ı yok ama yarın %4-5 artma potansiyeli olan hisseler var. Sistem onları gösteriyor — risk daha yüksek, dikkatli işlem yap.</span>
        </div>
      )}

      {/* ── Card strip ── */}
      <div style={{
        display: 'flex', gap: 0, overflowX: 'auto', overflowY: 'hidden',
        height: 185, alignItems: 'stretch', padding: '8px 12px', boxSizing: 'border-box',
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
            ) : lastUpdate !== null ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: 'column', textAlign: 'center' }}>
                  <span style={{ fontSize: 22 }}>🚫</span>
                  <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 13 }}>
                    Bugün kaliteli AL setup'ı bulunamadı
                  </span>
                  <span style={{ fontSize: 11, color: '#a8b3c7', maxWidth: 480, lineHeight: 1.5 }}>
                    Tavan yapan hisseler ertesi gün ~%55-60 ihtimalle geri çekilir. Sistem
                    BUGÜN tavan yapanları değil, YARIN tavan yapacakları arıyor.
                    Bu oturumda piyasa çoğunlukla pump'larla doldu — kaliteli giriş yok.
                  </span>
                  {advisor.manualScan && (
                    <button
                      onClick={() => advisor.manualScan()}
                      style={{
                        background: 'linear-gradient(135deg, var(--cyan), var(--blue))',
                        color: '#fff', border: 'none', borderRadius: 4,
                        padding: '4px 14px', fontSize: 11, cursor: 'pointer',
                        marginTop: 6, fontWeight: 700,
                      }}>
                      ↻ Yeniden Tara
                    </button>
                  )}
                </div>
              </>
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

          // Guven kirilimi tooltip metni — kullanici hover ile gorebilsin
          const breakdown = p.confidenceBreakdown;
          const tooltipLines = [];
          if (p.hasRecentInsiderBuy) {
            tooltipLines.push(`👔 İÇERİDEN ALIM — skor: ${p.insiderScore || 0}, net: ${p.insiderNetBuys || 0} alım`);
          }
          if (p.hasRecentInsiderSell && !p.hasRecentInsiderBuy) {
            tooltipLines.push(`👔 İÇERİDEN SATIM — skor: ${p.insiderScore || 0}`);
          }
          if (p._nearBreakoutPick) {
            tooltipLines.push(`🚀 PATLAMA YAKIN (${p._nearBreakoutCount || 0}/10 sinyal)`);
            if (p._nearBreakoutSignals?.length) {
              tooltipLines.push('  ' + p._nearBreakoutSignals.join(' · '));
            }
          }
          if (p._earlyPick) {
            tooltipLines.push(`🔍 ERKEN BIRIKIM (${p._earlyCount || 0}/10 sinyal)`);
            if (p._earlySignals?.length) {
              tooltipLines.push('  ' + p._earlySignals.join(' · '));
            }
            tooltipLines.push('  Düşük likit ama akıllı para giriyor — patlama öncesi');
            tooltipLines.push('');
          }
          if (p.confidence != null) tooltipLines.push(`Güven: ${p.confidence}/100 (${p.tier || p.grade || '-'})`);
          if (breakdown) {
            tooltipLines.push(`  • Teknik: ${breakdown.technical}`);
            tooltipLines.push(`  • Potansiyel: ${breakdown.potential}`);
            tooltipLines.push(`  • Sektör: ${breakdown.sector}`);
            tooltipLines.push(`  • Haber: ${breakdown.news}`);
            tooltipLines.push(`  • Giriş kalitesi: ${breakdown.entry}`);
            tooltipLines.push(`  • Likidite: ${breakdown.liquidity}`);
          }
          // ML Engine data
          if (p.mlBestRule && (p.mlMatchedCount || 0) > 0) {
            tooltipLines.push(`🎯 ML: ${p.mlBestRule.setupName} (%${(p.mlBestRule.winRate || 0).toFixed(1)} win rate)`);
            tooltipLines.push(`  Güven boost: +${(p.mlConfidenceBoost || 0).toFixed(1)}, ROI ort.: %${(p.mlBestRule.avgRoi || 0).toFixed(2)}`);
            if (p.mlMatchedCount > 1) tooltipLines.push(`  ${p.mlMatchedCount} kural eşleşti (konfluens bonusu)`);
          }
          if (p.avgVolumeTL) {
            const volM = (p.avgVolumeTL / 1_000_000).toFixed(1);
            tooltipLines.push(`Ort. günlük hacim: ${volM}M TL`);
          }
          if (p.distFromMA20 != null) {
            tooltipLines.push(`MA20'ye uzaklık: ${p.distFromMA20 > 0 ? '+' : ''}${p.distFromMA20.toFixed(1)}%`);
          }
          // HTF bağlamı
          if (p.htfTrend || p.htfWeeklyTrend) {
            const trendTr = (t) => ({ bull: '📈 YUKARI', weak_bull: '↗ zayıf yukari', neutral: '→ nötr', neutral_bull: '→ nötr/yukari', neutral_bear: '→ nötr/asagi', weak_bear: '↘ zayıf asagi', bear: '📉 ASAGI' })[t] || t;
            tooltipLines.push(`Günlük trend: ${trendTr(p.htfTrend)} | Haftalık: ${trendTr(p.htfWeeklyTrend)}`);
          }
          // Giriş zamanlaması
          if (p.entryTimingScore != null && p.cls === 'buy') {
            tooltipLines.push(`Giriş zamanlaması: ${p.entryTimingLabel} (${p.entryTimingScore > 0 ? '+' : ''}${p.entryTimingScore})`);
            if (p.entryTimingReasons?.length) {
              tooltipLines.push('  ' + p.entryTimingReasons.join(' | '));
            }
          }
          // Pump uyarisi — kullanici tavan/yorgun hisseyi gormeden almasin
          const rp = p.recentPump || 0;
          const cp = p.cumulativePump || 0;
          if (rp >= 9) {
            const devamPct = p.continuationProbability;
            const devamStr = devamPct != null
              ? `Tahmini devam: %${devamPct} (BIST base ~%30-35)`
              : `ertesi gün ~%55-60 geri çekilir`;
            tooltipLines.push(`⚡ TAVAN BÖLGESİ — +${rp.toFixed(1)}% — ${devamStr}`);
          } else if (rp >= 7) {
            const devamPct = p.continuationProbability;
            tooltipLines.push(`⚡ Yüksek pump +${rp.toFixed(1)}%${devamPct != null ? ` — devam tahmini: %${devamPct}` : ''}`);
          }
          if (cp >= 15) {
            tooltipLines.push(`⚠ 3 günde +${cp.toFixed(1)}% — kümülatif momentum yorgun`);
          }
          if (p._dataSource) tooltipLines.push(`Veri kaynağı: ${p._dataSource}`);

          // Veri yasi (her pick icin ayri — _scanTs varsa)
          const pickAge = p._scanTs ? (() => {
            const mins = Math.floor((Date.now() - p._scanTs) / 60000);
            if (mins < 1) return null;
            if (mins < 60) return `${mins}dk`;
            return `${Math.floor(mins / 60)}s`;
          })() : null;

          // Top 3 cards get a subtle glow accent
          const topClass = idx === 0 ? 'ai-pick-top1' : idx === 1 ? 'ai-pick-top2' : idx === 2 ? 'ai-pick-top3' : '';
          // Premium gradient background based on signal type
          const cardBg = p._fallback
            ? 'linear-gradient(180deg, #14192410 0%, #0d111c 100%)'
            : isSell
              ? 'linear-gradient(180deg, rgba(244,63,94,0.06) 0%, #0d111c 100%)'
              : 'linear-gradient(180deg, rgba(16,185,129,0.06) 0%, #0d111c 100%)';

          return (
            <div
              key={p.symbol}
              className={`ai-pick-card ${topClass}`}
              onClick={() => onAnalyze && onAnalyze(p.symbol)}
              title={tooltipLines.join('\n')}
              style={{
                flexShrink: 0, width: 235,
                background: cardBg,
                borderLeft: `4px solid ${accent}`,
                borderRight: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 5,
                padding: '11px 13px',
                marginRight: 7,
                cursor: 'pointer',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                opacity: p._fallback ? 0.82 : 1,
                position: 'relative',
              }}
            >
              {/* Row 1: symbol + sector + signal + grade + early */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 15, color: '#ffffff', letterSpacing: 0.3 }}>{p.symbol}</span>
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
                  {/* ERKEN BIRIKIM rozeti — patlama oncesi dusuk likit hisseler */}
                  {p._earlyPick && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'linear-gradient(90deg, #a855f7, #ec4899)',
                      color: '#fff', letterSpacing: 0.3,
                    }} title={`Erken birikim — ${p._earlyCount || 0}/10 sinyal: ${(p._earlySignals || []).join(', ')}`}>
                      🔍 ERKEN
                    </span>
                  )}
                  {/* v25: ACIL YEDEK rozeti — kaliteli setup yok ama "en iyi alternatif" */}
                  {p._emergencyPick && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'linear-gradient(90deg, #f97316, #eab308)',
                      color: '#fff', letterSpacing: 0.3,
                    }} title="Bugün kaliteli setup yok — ama bu hisse yarın %4-5 artma potansiyeli taşıyor. Sistem taramadan seçtiği en iyi seçenek.">
                      ⚡ YARIN UMUT
                    </span>
                  )}
                  {/* v25: NEAR-BREAKOUT rozeti — coil + breakout-ready (yarinki patlama) */}
                  {p._nearBreakoutPick && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
                      color: '#fff', letterSpacing: 0.3,
                      animation: 'pulse 2s ease-in-out infinite',
                    }} title={`Patlama hazirligi — ${p._nearBreakoutCount || 0}/10 sinyal: ${(p._nearBreakoutSignals || []).join(', ')}`}>
                      🚀 PATLAMA YAKIN
                    </span>
                  )}
                  {/* v25: TAVAN AMA DEVAM ROZETI — yuksek devam ihtimali (>=50%) */}
                  {p.cls === 'buy' && (p.todayPumpReal || p.recentPump || 0) >= 7 &&
                   p.continuationProbability != null && p.continuationProbability >= 50 && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'linear-gradient(90deg, #10b981, #059669)',
                      color: '#fff', letterSpacing: 0.3,
                    }} title={`Tavan/yüksek pump ama devam ihtimali yüksek (%${p.continuationProbability})`}>
                      ⚡ DEVAM %{p.continuationProbability}
                    </span>
                  )}
                  {/* INSIDER BUY rozeti — yonetici/ortak alimi tespit edildi */}
                  {p.hasRecentInsiderBuy && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'linear-gradient(90deg, #059669, #10b981)',
                      color: '#fff', letterSpacing: 0.3,
                    }} title={`İçeriden alım: skor ${p.insiderScore || 0}, net ${p.insiderNetBuys || 0} alım (30 gün)`}>
                      👔 İÇERİDEN ALIM
                    </span>
                  )}
                  {/* INSIDER SELL rozeti — yonetici/ortak satisi */}
                  {p.hasRecentInsiderSell && !p.hasRecentInsiderBuy && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef4444',
                      letterSpacing: 0.3,
                    }} title={`İçeriden satım: skor ${p.insiderScore || 0}`}>
                      👔 İÇERİDEN SATIM
                    </span>
                  )}
                  {/* ML ENGINE MATCH rozeti — self-learning rule discovery match */}
                  {(p.mlMatchedCount || 0) > 0 && p.mlBestRule && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: p.mlBestRule.winRate >= 75
                        ? 'linear-gradient(90deg, #ffd700, #ff9d00)'  // Gold — yuksek win rate
                        : p.mlBestRule.winRate >= 60
                          ? 'linear-gradient(90deg, #06b6d4, #3b82f6)' // Cyan — orta
                          : 'linear-gradient(90deg, #6366f1, #8b5cf6)', // Purple — standart
                      color: p.mlBestRule.winRate >= 75 ? '#000' : '#fff',
                      letterSpacing: 0.3,
                      boxShadow: p.mlBestRule.winRate >= 75
                        ? '0 0 6px rgba(255,215,0,0.4)' : 'none',
                    }} title={[
                      `🎯 ML Match: ${p.mlBestRule.setupName}`,
                      `Win Rate: %${(p.mlBestRule.winRate || 0).toFixed(1)}`,
                      `Ort. ROI: %${(p.mlBestRule.avgRoi || 0).toFixed(2)}`,
                      `Güven Boost: +${(p.mlConfidenceBoost || 0).toFixed(1)}`,
                      p.mlMatchedCount > 1 ? `${p.mlMatchedCount} kural eşleşti (konfluens)` : '',
                    ].filter(Boolean).join('\n')}>
                      🎯 %{(p.mlBestRule.winRate || 0).toFixed(0)}
                    </span>
                  )}
                  {/* TAVAN UYARI + DEVAM OLASILIGI rozeti — son bar +%9 uzeri */}
                  {Math.max(p.todayPumpReal || 0, p.recentPump || 0) >= 9 && (() => {
                    const cp = p.continuationProbability;
                    // Devam rengi: > 38% yesil, 27-38% sari, < 27% kirmizi
                    const cpColor = cp == null ? '#fff'
                      : cp >= 38 ? '#10e87a'
                      : cp >= 27 ? '#fbbf24'
                      : '#ff5470';
                    const cpBg = cp == null ? 'rgba(244,63,94,0.25)'
                      : cp >= 38 ? 'rgba(16,232,122,0.15)'
                      : cp >= 27 ? 'rgba(251,191,36,0.15)'
                      : 'rgba(244,63,94,0.25)';
                    const cpBorder = cp == null ? 'rgba(244,63,94,0.5)'
                      : cp >= 38 ? 'rgba(16,232,122,0.5)'
                      : cp >= 27 ? 'rgba(251,191,36,0.5)'
                      : 'rgba(244,63,94,0.5)';
                    return (
                      <span style={{
                        fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                        background: cpBg, color: cpColor,
                        border: `1px solid ${cpBorder}`, letterSpacing: 0.3,
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                      }} title={
                        cp != null
                          ? `Tavan bölgesi (+${(p.recentPump || 0).toFixed(1)}%) — tahmini devam olasılığı: %${cp} (BIST base: ~%30-35)`
                          : `Tavan bölgesi (+${(p.recentPump || 0).toFixed(1)}%) — ertesi gün ~%55-60 ihtimalle geri çekilir`
                      }>
                        ⚡{cp != null ? ` %${cp} DEVAM` : ' TAVAN'}
                      </span>
                    );
                  })()}
                  {/* ORTA PUMP rozeti — %7-9 arasi, tavan degil ama yuksek */}
                  {Math.max(p.todayPumpReal || 0, p.recentPump || 0) >= 7 && Math.max(p.todayPumpReal || 0, p.recentPump || 0) < 9 && p.continuationProbability != null && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                      border: '1px solid rgba(245,158,11,0.4)', letterSpacing: 0.3,
                    }} title={`Yüksek pump +${(p.recentPump || 0).toFixed(1)}% — devam tahmini: %${p.continuationProbability}`}>
                      ⚡ %{p.continuationProbability} DEVAM
                    </span>
                  )}
                  {/* YORGUN rozeti — 3 gun kumulatif +%15 ustu (tavan degil) */}
                  {(p.cumulativePump || 0) >= 15 && (p.recentPump || 0) < 9 && p.continuationProbability == null && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                      background: 'rgba(249,115,22,0.15)', color: '#f97316',
                      border: '1px solid rgba(249,115,22,0.4)', letterSpacing: 0.3,
                    }} title={`3 günde +${(p.cumulativePump || 0).toFixed(1)}% — momentum yorgun`}>
                      ⚠ YORGUN
                    </span>
                  )}
                  {/* TARİHİ PUMP badge: recentPump (son 4 gün max) > todayPumpReal'den belirgin yüksekse
                      "bu hisse son günlerde büyük hareket yaptı, bu yüzden sıralamada geride kalabilir" uyarısı */}
                  {(() => {
                    const todayP = p.todayPumpReal || 0;
                    const histP  = p.recentPump    || 0;
                    // Sadece bugün düz/az (+%3 alti) ama tarihsel max belirgin yüksekse göster
                    if (histP > todayP + 4 && histP >= 6 && todayP < 3) {
                      return (
                        <span style={{
                          fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                          background: 'rgba(139,92,246,0.12)', color: '#a78bfa',
                          border: '1px solid rgba(139,92,246,0.3)', letterSpacing: 0.3,
                        }} title={`Son 4 günde max +${histP.toFixed(1)}% yaptı (bugün +${todayP.toFixed(1)}%) — geçmiş yüksek hareket sıralamayı etkiliyor`}>
                          📊 +{histP.toFixed(1)}% geçmiş
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {/* GİRİŞ ZAMANLAMA rozeti — doğru hisse + doğru an */}
                  {p.entryTimingScore != null && p.cls === 'buy' && (() => {
                    const ts = p.entryTimingScore;
                    const lbl = p.entryTimingLabel;
                    if (ts >= 55) return (
                      <span style={{
                        fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 2,
                        background: 'rgba(16,185,129,0.18)', color: '#10b981',
                        border: '1px solid rgba(16,185,129,0.4)', letterSpacing: 0.3,
                      }} title={(p.entryTimingReasons || []).join(' | ')}>
                        ✅ {lbl}
                      </span>
                    );
                    if (ts >= 30) return (
                      <span style={{
                        fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                        background: 'rgba(6,182,212,0.12)', color: '#06b6d4',
                        border: '1px solid rgba(6,182,212,0.3)', letterSpacing: 0.3,
                      }} title={(p.entryTimingReasons || []).join(' | ')}>
                        🕐 {lbl}
                      </span>
                    );
                    if (ts <= -30) return (
                      <span style={{
                        fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                        background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                        border: '1px solid rgba(239,68,68,0.3)', letterSpacing: 0.3,
                      }} title={(p.entryTimingReasons || []).join(' | ')}>
                        ⏳ BEKLE
                      </span>
                    );
                    return null;
                  })()}
                  {/* HTF TREND UYARISI — haftalık düşüş var ama günlük AL diyor */}
                  {p.htfWeeklyTrend === 'bear' && p.cls === 'buy' && (
                    <span style={{
                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                      background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
                      border: '1px solid rgba(245,158,11,0.3)', letterSpacing: 0.3,
                    }} title="Haftalık trend hala düşüş yönünde — günlük sinyale ek dikkat">
                      📉 HAFTALIKtan dikkat
                    </span>
                  )}
                  {p.htfWeeklyTrend === 'bull' && p.htfTrend === 'bull' && p.cls === 'buy' && (
                    <span style={{
                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 2,
                      background: 'rgba(16,185,129,0.1)', color: '#6ee7b7',
                      border: '1px solid rgba(16,185,129,0.25)', letterSpacing: 0.3,
                    }} title="Haftalık + günlük trend uyumlu — güçlü confluens">
                      📈 HTF UYUM
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: '#a8b3c7', fontWeight: 600, marginLeft: 2 }}>{p.sector}</span>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 800, padding: '3px 7px', borderRadius: 3,
                  background: accentDim, color: accent, border: `1px solid ${accent}66`,
                  whiteSpace: 'nowrap', letterSpacing: 0.4,
                  textShadow: `0 0 8px ${accent}33`,
                }}>
                  {signalLabel}
                </span>
              </div>

              {/* Row 2: price (CANLI PRIMARY) + change + R/R + score */}
              {(() => {
                // _livePrice her zaman primary — scan fiyatı sadece referans
                const displayPrice = p._livePrice || p.price || 0;
                const scanPrice    = p.price || 0;
                const hasLive      = p._livePrice != null && p._livePrice > 0;
                const priceDrifted = hasLive && Math.abs(p._livePrice - scanPrice) / (scanPrice || 1) > 0.002;
                const liveChg      = p._liveChange ?? p.change ?? 0;
                return (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 6 }}>
                    {/* Ana fiyat: live fiyat (bold beyaz) */}
                    <span style={{ fontWeight: 800, color: '#ffffff', letterSpacing: 0.2 }}>
                      {displayPrice.toFixed(2)} TL
                    </span>
                    {/* Scan fiyatı küçük referans — sadece fark varsa göster */}
                    {priceDrifted && (
                      <span style={{
                        fontSize: 9, color: '#6b7280', fontWeight: 600,
                        textDecoration: 'line-through',
                      }} title={`Tarama anı: ${scanPrice.toFixed(2)} TL`}>
                        {scanPrice.toFixed(2)}
                      </span>
                    )}
                    {/* Canlı güncelleme indikatörü — live fiyat var ama scan ile aynı */}
                    {hasLive && !priceDrifted && (
                      <span style={{ fontSize: 8, color: '#10e87a', fontWeight: 700 }} title="Fiyat güncel">●</span>
                    )}
                    <span style={{
                      color: liveChg >= 0 ? '#10e87a' : '#ff5470',
                      fontWeight: 800, fontSize: 12,
                    }}>
                      {liveChg >= 0 ? '+' : ''}{liveChg.toFixed(1)}%
                    </span>
                    <span style={{ color: '#b0bccd', fontSize: 11, fontWeight: 600 }}>R/O 1:{(p.rr || 0).toFixed(1)}</span>
                    <span style={{
                      color: '#06d6f0', fontWeight: 800, fontSize: 12, marginLeft: 'auto',
                      textShadow: '0 0 6px rgba(6,214,240,0.4)',
                    }}>
                      Skor: {(p.score || 0).toFixed(1)}
                    </span>
                  </div>
                );
              })()}
              {/* STALE / CONFLICT WARNING — hisse cache'tekiyle celisiyor */}
              {(p._isStaleAdverse || p._conflictsWithLive) && (
                <div style={{
                  fontSize: 10, color: '#ff5470', fontWeight: 800,
                  marginTop: 4, padding: '3px 6px',
                  background: 'rgba(244,63,94,0.18)', borderRadius: 3,
                  border: '1px solid rgba(244,63,94,0.45)',
                  letterSpacing: 0.3,
                }} title="Cache'deki sinyal canli fiyatla uyumsuz — yeniden tarama oneriliyor">
                  ⚠ {p._isStaleAdverse ? `BAYAT (${p._divergencePct?.toFixed(1)}%)` : `ÇELİŞKİ: ${p._liveSignal || 'TUT'}`}
                </div>
              )}
              {p._divergenceWarn && !p._isStaleAdverse && !p._conflictsWithLive && (
                <div style={{
                  fontSize: 10, color: '#ff9a3c', fontWeight: 800,
                  marginTop: 4, padding: '3px 6px',
                  background: 'rgba(255,145,0,0.18)', borderRadius: 3,
                  border: '1px solid rgba(255,145,0,0.4)',
                  letterSpacing: 0.3,
                }} title="Cache fiyati canli fiyattan farkli — yeniden tara">
                  ⚠ FİYAT KAYDI (Δ{p._divergencePct?.toFixed(1)}%)
                </div>
              )}

              {/* Row 3: stop + target */}
              <div style={{ display: 'flex', gap: 10, fontSize: 11, marginTop: 6 }}>
                <span>
                  <span style={{ color: '#ff5470', fontWeight: 700 }}>
                    Stop: {p.stop ? p.stop.toFixed(2) : '-'}
                  </span>
                  {stopPctAbs > 0 && <span style={{ color: '#b0bccd', fontWeight: 600 }}> ({stopPctAbs.toFixed(1)}%)</span>}
                </span>
                <span>
                  <span style={{ color: accent, fontWeight: 700 }}>
                    Hedef: {p.target ? p.target.toFixed(2) : '-'}
                  </span>
                  {targetPctAbs > 0 && <span style={{ color: '#b0bccd', fontWeight: 600 }}> ({isSell ? '-' : '+'}{targetPctAbs.toFixed(1)}%)</span>}
                </span>
              </div>

              {/* Row 3.5: ML Engine Match — discovered rule display */}
              {p.mlBestRule && (p.mlMatchedCount || 0) > 0 && (
                <div style={{
                  fontSize: 10, fontWeight: 700, marginTop: 4, padding: '3px 6px',
                  background: p.mlBestRule.winRate >= 75
                    ? 'rgba(255,215,0,0.08)' : 'rgba(6,182,212,0.08)',
                  borderRadius: 3,
                  border: `1px solid ${p.mlBestRule.winRate >= 75 ? 'rgba(255,215,0,0.25)' : 'rgba(6,182,212,0.25)'}`,
                  color: p.mlBestRule.winRate >= 75 ? '#ffd700' : '#06d6f0',
                  display: 'flex', alignItems: 'center', gap: 4,
                  letterSpacing: 0.2,
                }}>
                  <span>🎯</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.mlBestRule.setupName}
                  </span>
                  <span style={{
                    fontWeight: 900, fontSize: 11,
                    color: p.mlBestRule.winRate >= 75 ? '#ffd700' : p.mlBestRule.winRate >= 60 ? '#10e87a' : '#06d6f0',
                  }}>
                    %{(p.mlBestRule.winRate || 0).toFixed(0)}
                  </span>
                  {p.mlMatchedCount > 1 && (
                    <span style={{
                      fontSize: 8, fontWeight: 800, padding: '0 3px',
                      background: 'rgba(255,255,255,0.08)', borderRadius: 2,
                      color: '#a8b3c7',
                    }}>
                      +{p.mlMatchedCount - 1}
                    </span>
                  )}
                </div>
              )}

              {/* Row 4: hold text */}
              <div style={{ fontSize: 10, color: '#a8b3c7', fontWeight: 600, marginTop: 5, letterSpacing: 0.2 }}>
                {p.holdText || (isSell ? 'Kısa pozisyon' : '1-3 gün (kısa vade)')}
                {p._alreadyHolding && <span style={{ color: '#ff9a3c', marginLeft: 5, fontWeight: 800 }}>●portföy</span>}
              </div>

              {/* Rank + veri yasi pill */}
              <div style={{
                position: 'absolute', top: 4, right: 4,
                display: 'flex', gap: 3, alignItems: 'center',
              }}>
                {pickAge && (
                  <span style={{
                    fontSize: 9, color: pickAge.includes('s') ? '#ff9a3c' : '#b0bccd',
                    fontWeight: 700, background: 'rgba(0,0,0,0.55)',
                    padding: '2px 5px', borderRadius: 3,
                    border: '1px solid rgba(255,255,255,0.08)',
                  }} title={`${pickAge} önce taranmış`}>
                    {pickAge}
                  </span>
                )}
                <span style={{
                  fontSize: 10, fontWeight: 900,
                  background: idx === 0 ? 'linear-gradient(135deg, #ffd700, #ff9d00)'
                    : idx === 1 ? 'linear-gradient(135deg, #c0c0c0, #808080)'
                    : idx === 2 ? 'linear-gradient(135deg, #cd7f32, #8b4513)'
                    : 'rgba(0,0,0,0.4)',
                  color: idx <= 2 ? '#000' : 'var(--t3)',
                  padding: '1px 5px', borderRadius: 3,
                  border: idx <= 2 ? 'none' : '1px solid rgba(255,255,255,0.05)',
                  boxShadow: idx <= 2 ? '0 1px 3px rgba(0,0,0,0.4)' : 'none',
                }}>#{idx + 1}</span>
              </div>
            </div>
          );
        })}

        {/* Trailing info card */}
        {hasPicks && meta && (
          <div style={{
            flexShrink: 0, width: 165,
            background: 'linear-gradient(180deg, rgba(6,182,212,0.04), rgba(13,17,28,1))',
            borderLeft: '1px solid rgba(6,182,212,0.2)',
            padding: '11px 13px', display: 'flex', flexDirection: 'column',
            justifyContent: 'center', gap: 7, color: '#b0bccd', fontSize: 11,
            borderRadius: 5,
          }}>
            <div style={{ color: '#06d6f0', fontWeight: 800, fontSize: 12, letterSpacing: 0.4 }}>{meta.sentiment}</div>
            <div style={{ fontSize: 11, fontWeight: 700 }}>
              <span style={{ color: '#10e87a' }}>{meta.buys} AL</span>
              <span style={{ color: '#7d8a9e', margin: '0 4px' }}>·</span>
              <span style={{ color: '#ff5470' }}>{meta.sells} SAT</span>
            </div>
            <div style={{ fontSize: 11, color: '#a8b3c7', fontWeight: 600 }}>{meta.scanned} sembol tarandı</div>
            {cacheAge && <div style={{ fontSize: 10, color: '#7d8a9e', fontWeight: 600 }}>⏱ {cacheAge}</div>}
            <div style={{ marginTop: 4, fontSize: 9, color: '#5d6877', fontStyle: 'italic', lineHeight: 1.3 }}>
              * Yeni tarama bittiğinde otomatik güncellenir.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
