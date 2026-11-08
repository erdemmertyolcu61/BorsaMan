import { useState, useEffect, useRef } from 'react';
import SectorHeatmap from '../Heatmap/SectorHeatmap.jsx';
import { isMarketOpen, isMarketClosedForDay } from '../../hooks/useAIAdvisor.js';
import { getMetrics, isTelemetryEnabled, getAllDataFreshness, setFetchTimestamp } from '../../utils/telemetry.js';
import { getSourceHealth, recordSourceSuccess, recordSourceFailure, fetchBigParaBatchPrices, fetchBigParaQuote } from '../../utils/fetchEngine.js';
import { getForeignFlowStatus } from '../../utils/foreignFlowEngine.js';
import { NEWS_CATEGORY_LABELS } from '../../utils/marketNewsEngine.js';
import { NEWS_UNSCORED_CATEGORIES } from '../../utils/newsConfidence.js';
import { deriveDisplayPicks } from '../../utils/displayPicks.js';
import { buildPickChips, splitChips } from '../../utils/pickChips.js';
import { suggestPosition, sizeMultOf, getTradingCapital } from '../../utils/positionSizing.js';
import { fmtPct } from '../Signals/ScanScorecardPanel.jsx';

// v31.47: tek rozet stili — 11 px, kucuk harf, emoji/gradyan/parlama yok.
const CHIP_TONES = {
  danger:  { fg: '#fca5a5', bg: 'rgba(239,68,68,0.14)' },
  warn:    { fg: '#fcd34d', bg: 'rgba(245,158,11,0.14)' },
  good:    { fg: '#86efac', bg: 'rgba(34,197,94,0.14)' },
  info:    { fg: '#93c5fd', bg: 'rgba(59,130,246,0.14)' },
  neutral: { fg: 'var(--t2)', bg: 'var(--bg3)' },
};
function chipStyle(tone) {
  const t = CHIP_TONES[tone] || CHIP_TONES.neutral;
  return {
    fontSize: 11, fontWeight: 500, color: t.fg, background: t.bg,
    borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap', lineHeight: 1.5,
  };
}

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
      } catch { }
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
      } catch { }
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

// v31.40: TARAMA KAPSAMI — "tum hisseleri taradik mi, veriler dogru gunun mu?"
// Sayilar son taramadan (useAIAdvisor.coverage). Eskiden yalniz log'daydi.
function CoveragePill({ coverage }) {
  if (!coverage || !(coverage.total > 0)) return null;
  const ratio = coverage.scanned / coverage.total;
  const lagging = coverage.laggingDay?.length || 0;
  const color = ratio >= 0.98 && !lagging ? 'var(--green)' : ratio >= 0.9 ? 'var(--yellow)' : 'var(--red)';
  const fmtDay = (k) => (k ? `${k.slice(8, 10)}.${k.slice(5, 7)}` : '?');
  const title = [
    `Taranan: ${coverage.scanned}/${coverage.total} hisse`,
    coverage.verified
      ? `Evren doğrulandı: yeni listelenen ${coverage.added?.length || 0}, işlem görmeyen ${coverage.dropped?.length || 0}`
      : 'Evren doğrulanamadı (fiyat listesi alınamadı) — sabit liste kullanıldı',
    coverage.added?.length ? `Yeni: ${coverage.added.slice(0, 20).join(', ')}` : '',
    coverage.dropped?.length ? `Çıkarılan: ${coverage.dropped.slice(0, 20).join(', ')}` : '',
    `Veri günü: ${fmtDay(coverage.sessionDay)}`,
    lagging ? `Günü geride kalan (${lagging}): ${coverage.laggingDay.slice(0, 20).join(', ')}` : '',
    coverage.missing?.length ? `Veri vermeyen (${coverage.missing.length}): ${coverage.missing.slice(0, 20).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'center', gap: 4, borderLeft: '1px solid var(--border)', paddingLeft: 10, cursor: 'help' }}>
      <span style={{ fontSize: 10, color: 'var(--t3)' }}>Kapsama:</span>
      <span style={{ fontSize: 10, fontWeight: 600, color }}>{coverage.scanned}/{coverage.total}</span>
      <span style={{ fontSize: 9, color: 'var(--t3)' }}>{fmtDay(coverage.sessionDay)}</span>
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
    marketRegime = null,
    coverage = null,
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
        <span style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 13 }}>AI Advisor</span>
        {/* Market Mode Badge */}
        {!scanning && (
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
            padding: '2px 8px', borderRadius: 10,
            background: isMarketOpen() ? 'var(--green)' : 'var(--cyan)',
            color: '#000',
          }}>
            {isMarketOpen() ? 'Canlı' : 'Yarın için'}
          </span>
        )}
        {scanning && (
          <span style={{ color: 'var(--yellow)' }}>
            Taranıyor... {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : ''}
            {/* v31.32: sayaç 612/612'ye ulaştıktan SONRA hâlâ dakikalarca son-işlem
                var (yeniden deneme, haber, temel, zenginleştirme, Claude). Faz adı
                olmayınca bu "donmuş" görünüyordu. */}
            {scanProgress.phase
              ? <span style={{ color: 'var(--t3)' }}> · {scanProgress.phase}</span>
              : null}
          </span>
        )}
        {!scanning && lastUpdate && <span style={{ color: 'var(--t3)' }}>{new Date(lastUpdate).toLocaleTimeString('tr-TR')}</span>}
        <DataFreshnessBadge />
        <SourceHealthBadge />
        {!scanning && <CoveragePill coverage={coverage} />}
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

      {/* Top Pick Quick View — v29: panel ile AYNI deriveDisplayPicks siralamasi.
          Onceki: topPicks score'a gore yeniden siralaniyor + hepsi yesil (TUT'lar
          bile AL gibi gorunuyordu) → alt panelle celiskili. Artik ayni kaynak. */}
      {topPicks.length > 0 && !scanning && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          <span style={{ color: 'var(--t3)', fontSize: 11 }}>En İyi:</span>
          {deriveDisplayPicks(topPicks, scanResults, marketRegime?.regime && marketRegime.regime !== 'BULL', marketRegime?.regime).slice(0, 4).map(p => {
            const isSell = p.cls === 'sell';
            const isHold = p.cls === 'hold' || p.cls === 'neutral';
            // Renk sinyale gore: AL=yesil, SAT=kirmizi, TUT=notr gri (yaniltmasin)
            const c = isSell ? 'var(--red)' : isHold ? 'var(--t2)' : 'var(--green)';
            const bg = isSell ? 'var(--red2)' : isHold ? 'rgba(148,163,184,0.12)' : 'var(--green2)';
            return (
              <button key={p.symbol} onClick={() => onAnalyze && onAnalyze(p.symbol)} style={{
                background: bg, color: c, border: `1px solid ${c}`,
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

// deriveDisplayPicks moved to ../../utils/displayPicks.js (pure + unit-tested).

// ── Collapsible Bottom Strip — "Son Başarılı AI Analizi" ──────────────────
// Shows the top-scored picks from the last scan as a horizontal scrollable
// card strip, exactly like the design in the reference screenshot.
// Persists to / restores from localStorage so it survives page navigation.
export function AIAdvisorDetailPanel({ advisor = {}, addToPortfolio, portfolio, onAnalyze, scorecard = null, onOpenScorecard }) {
  const {
    topPicks = [],
    scanResults = [],
    marketSentiment = null,
    scanning = false,
    lastUpdate = null,
    marketRegime = null, // v26 FIX 2: { regime, bistChangePct }
  } = advisor;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);
  const [open, setOpen] = useState(!isMobile); // start expanded on desktop, collapsed on mobile

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
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
    } catch { }
    return [];
  });
  // Ref to latest displayPicks — read inside async doLivePriceUpdate without stale closure
  const displayPicksRef = useRef([]);
  useEffect(() => { displayPicksRef.current = displayPicks; }, [displayPicks]);

  const [cachedMeta, setCachedMeta] = useState(() => {
    try {
      const saved = localStorage.getItem('bist_last_ai_picks');
      if (saved) {
        const d = JSON.parse(saved);
        return { ts: d.ts, scanned: d.scanned, sentiment: d.sentiment, buys: d.buys, sells: d.sells };
      }
    } catch { }
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
    // v29: SHARED derivation — header strip ve panel AYNI picks'i gosterir.
    // v29.2: DUSUS/YATAY rejiminde emergency filler/fallback kapatilir (regimeRestrict).
    const regimeRestrict = !!(marketRegime?.regime && marketRegime.regime !== 'BULL');
    setDisplayPicks(deriveDisplayPicks(topPicks, scanResults, regimeRestrict, marketRegime?.regime));
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
      } catch { }
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

  // ── CANLI FIYAT GUNCELLEME (v21) ──
  // HEM cache HEM fresh-scan kartlari icin calisir.
  //
  // SORUN (v20): fetchBigParaBatchPrices() batch API'de item.kapanis = DÜNKÜ kapanış.
  // item.son = 0 (piyasa kapalı veya henüz işlem yok) olduğunda eski kod kapanis'i
  // "canlı fiyat" olarak kullanıyordu → AI Advisor dünün fiyatını gösteriyordu
  // (TTRAK 467.25 vs gerçek 476.50 hatası).
  //
  // FIX (v21): Batch son=0 ise price=0 döner (fetchEngine güncellemesiyle).
  // Bu durumda per-symbol fetchBigParaQuote çağrılır — per-symbol endpoint'te
  // kapanis = BUGÜNKÜ canlı fiyat (farklı anlam, doğru değer).
  //
  // - _livePrice: anlık BigPara fiyatı → kartta PRIMARY gösterim
  // - _divergencePct: tarama fiyatından sapma yüzdesi
  // - _isStaleAdverse: AL önerisi -%3+ düştü → kırmızı uyarı
  // - _divergenceWarn: |sapma| > %6 → turuncu uyarı
  useEffect(() => {
    if (!displayPicks.length) return;
    let cancelled = false;

    const applyPriceUpdate = (liveMap) => {
      if (cancelled || !liveMap || Object.keys(liveMap).length === 0) return;
      setDisplayPicks(prev => prev.map(p => {
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
          _livePrice: live.price,
          _liveChange: todayChg,
          _divergencePct: divPct,
          _isStaleAdverse: adverseDrop || adverseRise,
          _divergenceWarn: Math.abs(divPct) > 6,
        };
      })); // Sıralama kilitli — live fiyat güncellemesi sadece veri ekler, sıra değiştirmez
    };

    const doLivePriceUpdate = async () => {
      // 1) Batch update — tek çağrı, tüm semboller (hızlı)
      const batchMap = await fetchBigParaBatchPrices().catch(() => ({}));
      if (cancelled) return;
      applyPriceUpdate(batchMap);

      // 2) Per-symbol fallback — batch'te son=0 olan kartlar için (yani intraday işlem yok)
      //    Per-symbol hisseyuzeysel endpoint'i kapanis'i = BUGÜNKÜ canlı fiyat olarak döner.
      //    displayPicksRef sayesinde stale closure olmadan güncel kartları okuyabiliriz.
      const curPicks = displayPicksRef.current;
      const needsRefresh = curPicks.filter(p => {
        const live = batchMap[p.symbol];
        return !live || !(live.price > 0); // batch'te price=0 → per-symbol gerekli
      });

      if (needsRefresh.length === 0 || cancelled) return;

      const perSymResults = await Promise.allSettled(
        needsRefresh.map(p =>
          fetchBigParaQuote(p.symbol)
            .then(r => ({ sym: p.symbol, r }))
            .catch(() => ({ sym: p.symbol, r: null }))
        )
      );

      if (cancelled) return;
      const perSymMap = {};
      for (const res of perSymResults) {
        if (res.status === 'fulfilled' && res.value?.r?.price > 0) {
          perSymMap[res.value.sym] = res.value.r;
        }
      }
      applyPriceUpdate(perSymMap);
    };

    doLivePriceUpdate();
    const iv = setInterval(doLivePriceUpdate, 30_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [displayPicks.length, isFromCache]);  

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

  // v31.47: tahmin karnesi ozeti — "sabah onerilenler bugun ne yapti".
  const scSummary = scorecard?.featuredSummary || null;
  const showScoreStrip = !!(scSummary && scSummary.measured > 0);
  const tradingCapital = getTradingCapital();

  return (
    <div className="ai-detail-root" style={{
      position: 'fixed', left: 0, right: 0, zIndex: 900,
      bottom: isMobile ? 56 : 0,
      background: 'var(--bg1)',
      borderTop: '1px solid var(--border2)',
      maxHeight: open ? (isMobile ? 560 : 440) : (isMobile ? 44 : 40),
      overflow: 'hidden',
      boxShadow: '0 -8px 24px rgba(0,0,0,0.45)',
    }}>
      <style>{`
        @keyframes pulseDot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        .ai-pick-card { transition: border-color .15s ease, background .15s ease; }
        .ai-pick-card:hover { border-color: var(--border2) !important; background: var(--bg3) !important; }
      `}</style>
      {/* ── Header bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: isMobile ? '0 10px' : '0 14px',
        minHeight: isMobile ? 44 : 40,
        background: 'var(--bg1)',
        borderBottom: open ? '1px solid var(--border)' : 'none',
        userSelect: 'none', boxSizing: 'border-box',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
        onClick={() => setOpen(o => !o)}
      >
        {/* Left: title + badge */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 10, flex: 1, flexWrap: isMobile ? 'nowrap' : 'wrap', overflow: 'hidden' }}
        >
          <span style={{
            fontWeight: 700, fontSize: 13, color: 'var(--t1)',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            {isMobile ? 'AI fırsatlar' : 'AI en iyi fırsatlar'}
            {hasPicks && <span style={{ color: 'var(--t3)', fontWeight: 500 }}> · {picks.length}</span>}
          </span>
          {/* Mobilde: sadece eski veri rozetini ve AL/SAT sayılarını göster, diğer badge'ler gizle */}
          {isMobile && isFromCache && (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
              background: isStale ? 'rgba(239,68,68,0.14)' : 'rgba(234,179,8,0.14)',
              color: isStale ? 'var(--red)' : 'var(--yellow)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              {isStale ? 'Eski' : 'Kayıtlı'}{cacheAge ? ` · ${cacheAge}` : ''}
            </span>
          )}
          {scanning && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--green)',
              animation: 'pulseDot 1.4s ease-in-out infinite',
            }} />
          )}
          {/* v26 FIX 2: Piyasa rejimi rozeti — BULL (8 pick) / NEUTRAL (5) / BEAR (3) */}
          {!isMobile && marketRegime?.regime && (() => {
            const r = marketRegime.regime;
            const c = marketRegime.bistChangePct || 0;
            const cfg = r === 'BULL'
              ? { bg: 'rgba(34,197,94,0.14)', fg: 'var(--green)', label: 'Yükseliş' }
              : r === 'BEAR'
                ? { bg: 'rgba(239,68,68,0.14)', fg: 'var(--red)', label: 'Düşüş' }
                : { bg: 'var(--bg3)', fg: 'var(--t2)', label: 'Yatay' };
            return (
              <span
                title={`BIST100: ${c >= 0 ? '+' : ''}${c.toFixed(2)}% — ${r === 'BULL' ? 'agresif tarama (8 pick)' : r === 'BEAR' ? 'savunma modu (3 pick + sell odakli)' : 'konservatif (5 pick)'}`}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999,
                  background: cfg.bg, color: cfg.fg, flexShrink: 0,
                }}
              >
                {cfg.label} {c >= 0 ? '+' : ''}{c.toFixed(1)}%
              </span>
            );
          })()}
          {!isMobile && isFromCache && (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999,
              background: isStale ? 'rgba(239,68,68,0.14)' : 'rgba(245,158,11,0.14)',
              color: isStale ? 'var(--red)' : 'var(--yellow)', flexShrink: 0,
            }}>
              {isStale ? 'Eski veri' : 'Kayıtlı tarama'} {cacheAge ? `· ${cacheAge}` : ''}
            </span>
          )}
          {/* MAKRO BADGE — risk regime (USDTRY + VIX + TCMB + BIST/USD) */}
          {!isMobile && marketSentiment?.macro && (
            <span
              title={
                `Adjust: ${marketSentiment.macro.scoreAdjust > 0 ? '+' : ''}${marketSentiment.macro.scoreAdjust}\n` +
                (marketSentiment.macro.reasons?.join('\n') || '')
              }
              style={{
                fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999,
                background: `${marketSentiment.macro.badgeColor}22`,
                color: marketSentiment.macro.badgeColor,
                whiteSpace: 'pre-line', flexShrink: 0,
              }}
            >
              {marketSentiment.macro.badge}
            </span>
          )}
          {scanning && (
            <span style={{ fontSize: 12, color: 'var(--yellow)', fontWeight: 500, flexShrink: 0 }}>Taranıyor…</span>
          )}
          {/* AL / SAT counts */}
          {!isMobile && (
            <span style={{ fontSize: 12, color: 'var(--t2)', fontWeight: 500, flexShrink: 0, whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>{buyCount} AL</span>
              {sellCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}> · {sellCount} SAT</span>}
            </span>
          )}
          {/* Sentinel symbols preview (collapsed) */}
          {!open && !isMobile && picks.slice(0, 8).map(p => {
            const isSell = p.cls === 'sell';
            return (
              <span key={p.symbol} style={{
                fontSize: 11, fontWeight: 600,
                color: isSell ? 'var(--red)' : 'var(--t1)',
                background: 'var(--bg3)', padding: '1px 8px', borderRadius: 6,
                flexShrink: 0, whiteSpace: 'nowrap',
              }}>
                {p.symbol}{isSell ? ' ↓' : ''}
              </span>
            );
          })}
        </div>
        {/* Right: refresh + chevron + X */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8, flexShrink: 0 }}>
          {advisor.manualScan && !scanning && (
            <button
              onClick={(e) => { e.stopPropagation(); advisor.manualScan(); }}
              title="Yeniden tara — tum cache temizlenir"
              style={{
                background: isStale ? 'var(--red)' : 'var(--bg3)',
                color: isStale ? '#fff' : 'var(--t1)',
                border: `1px solid ${isStale ? 'var(--red)' : 'var(--border2)'}`,
                borderRadius: 8, padding: isMobile ? '4px 10px' : '4px 12px', fontSize: 12,
                cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {isStale ? 'Yenile' : 'Tara'}
            </button>
          )}
          <span
            onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
            style={{
              color: 'var(--t2)', fontSize: isMobile ? 18 : 12, cursor: 'pointer',
              transform: open ? 'rotate(180deg)' : 'rotate(0)',
              padding: isMobile ? '8px 12px' : 0,
            }}
          >▲</span>
          <span
            onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
            style={{ color: 'var(--t3)', fontSize: isMobile ? 20 : 14, cursor: 'pointer', lineHeight: 1, padding: isMobile ? '8px 8px' : '0 2px' }}
            title="Kapat"
          >✕</span>
        </div>
      </div>

      {open && (
        <>
          {/* v31.47: TAHMIN KARNESI — "sabah onerdiklerim bugun ne yapti". Ayrinti Sinyal sekmesinde. */}
          {showScoreStrip && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenScorecard && onOpenScorecard(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '7px 12px', background: 'var(--bg2)', border: 'none',
                borderBottom: '1px solid var(--border)', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12, color: 'var(--t2)', textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap' }}>
                {scSummary.status === 'live' ? 'Bugünkü öneriler (anlık)' : 'Öneriler kapanışta'}
              </span>
              <span style={{ whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--green)' }}>{scSummary.up}↑</span>{' '}
                <span style={{ color: 'var(--red)' }}>{scSummary.down}↓</span>
              </span>
              <span style={{ whiteSpace: 'nowrap', color: (scSummary.avgPct || 0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                ort. {fmtPct(scSummary.avgPct)}
              </span>
              {Number.isFinite(scSummary.benchPct) && (
                <span style={{ whiteSpace: 'nowrap', color: 'var(--t3)' }}>BIST100 {fmtPct(scSummary.benchPct)}</span>
              )}
              <span style={{ marginLeft: 'auto', color: 'var(--blue)', whiteSpace: 'nowrap' }}>Karne ›</span>
            </button>
          )}
          {/* v29.3: REJIM + EDGE BANNER — "trend yok = islem yok" urun merkezinde.
              Olcum: AL pick'leri SADECE YUKSELIS'te pozitif (+1.14%); YATAY -1.7%,
              DUSUS -3.4%. Banner her zaman gorunur (mobil dahil), dogru beklenti kurar. */}
          {/* v31.47: yalniz bu oturumda tarama yapildiysa — kayitli kartlarda state'in
              varsayilan NEUTRAL'i "Yatay rejim · BIST100 +0.0%" diye yanlis bir bant basiyordu. */}
          {hasPicks && lastUpdate !== null && marketRegime?.regime && (() => {
            const r = marketRegime.regime;
            const c = marketRegime.bistChangePct || 0;
            const sniperCount = displayPicks.filter(p => p.convictionTier === 'sniper').length;
            const cfg = r === 'BULL'
              ? {
                  fg: 'var(--green)',
                  title: 'Yükseliş rejimi — AL için uygun ortam',
                  sub: sniperCount > 0
                    ? `${sniperCount} nokta atışı (skor ≥75) öne çıkarıldı — en yüksek beklentili kademe.`
                    : 'Nokta atışı (skor ≥75) yok — gösterilenler daha düşük konviksiyon, küçük pozisyon.',
                }
              : r === 'BEAR'
                ? (() => {
                    const cr = displayPicks.filter(p => p._counterRegime || p.cls === 'buy').length;
                    return {
                      fg: 'var(--red)',
                      title: 'Düşüş rejimi — AL önerilmez',
                      sub: cr > 0
                        ? `Ölçüm: düşüşte AL'lar tarihsel −%3,4 (%18,8 kazanma). En güçlü ${cr} isim izlemek için gösteriliyor.`
                        : "Ölçüm: düşüşte AL'lar tarihsel −%3,4 (%18,8 kazanma). Nakitte kalmak en iyi işlem.",
                    };
                  })()
                : {
                    fg: 'var(--t1)',
                    title: "Yatay rejim — yalnız en güçlü setup'lar",
                    sub: "Ölçüm: yatayda zayıf AL'lar ort. −%1,7. Yalnız skor ≥75, en fazla 4 öneri ve yarım pozisyon.",
                  };
            return (
              <div style={{
                padding: '7px 12px', background: 'var(--bg1)',
                borderBottom: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', gap: 1,
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: cfg.fg }}>
                  {cfg.title} <span style={{ color: 'var(--t3)', fontWeight: 500 }}>· BIST100 {c >= 0 ? '+' : ''}{c.toFixed(1)}%</span>
                </span>
                <span style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.4 }}>{cfg.sub}</span>
              </div>
            );
          })()}

          {/* v31.6: "YARIN UMUT" bandı kaldırıldı — hayal-katmanı gösterilmiyor.
              Görünürlük garantisi tek gerçek pick ile (⭐ GÜNÜN EN İYİSİ). */}

          {/* v29: Yabanci akis veri kaynagi dormant — kullaniciyi bilgilendir (sessiz degil) */}
      {hasPicks && getForeignFlowStatus().reason === 'no_source' && (
        <div style={{
          padding: '4px 12px', fontSize: 10, color: 'var(--t3)',
          background: 'rgba(148,163,184,0.06)',
          borderTop: '1px solid rgba(148,163,184,0.12)',
          display: 'flex', alignItems: 'center', gap: 6,
        }} title="BigPara ve İş Yatırım yabancı takas oranı verisini artık ücretsiz sunmuyor (kaynak kaldırıldı). Sistem periyodik olarak yeniden deniyor; kaynak dönerse otomatik aktifleşir.">
          <span style={{ opacity: 0.7 }}>🌍</span>
          <span>Yabancı akış verisi şu an kaynak yok (dormant) — skorlamaya dahil edilmiyor, kaynak dönerse otomatik aktifleşir.</span>
        </div>
      )}

      {/* ── Card strip ── */}
      {/* v29: mobil minHeight 120→210 — kart icerigi (sembol + saran rozetler +
          fiyat/RR + skor + stop/hedef ~200px) 120px'e sigmayip alt kesiliyordu. */}
      <div style={{
        display: 'flex', gap: 0, overflowX: 'auto', overflowY: 'hidden',
        minHeight: isMobile ? 210 : 165,
        height: 'auto', alignItems: 'stretch',
        padding: isMobile ? '4px 6px' : '6px 12px',
        boxSizing: 'border-box',
        scrollbarWidth: 'thin',
        WebkitOverflowScrolling: 'touch',
        scrollSnapType: 'x mandatory',
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
                  <span style={{ fontSize: 22 }}>{marketRegime?.regime === 'BEAR' ? '🐻' : '🚫'}</span>
                  <span style={{ color: marketRegime?.regime === 'BEAR' ? '#f87171' : '#fbbf24', fontWeight: 700, fontSize: 13 }}>
                    {marketRegime?.regime === 'BEAR'
                      ? 'DÜŞÜŞ REJİMİ — bugün AL önerisi yok'
                      : marketRegime?.regime === 'NEUTRAL'
                        ? 'YATAY REJİM — sadece en güçlü setup\'lar gösterilir'
                        : 'Bugün kaliteli AL setup\'ı bulunamadı'}
                  </span>
                  <span style={{ fontSize: 11, color: '#a8b3c7', maxWidth: 480, lineHeight: 1.5 }}>
                    {marketRegime?.regime === 'BEAR'
                      ? 'BIST100 düşüş trendinde. Ölçüm: düşüş rejiminde AL pick\'leri tarihsel olarak ortalama -3.4% getirmiş (%18.8 kazanma). Sistem düşen bıçağı tutmuyor — bugün nakitte kalmak en iyi "işlem". Rejim dönünce AL önerileri geri gelir.'
                      : marketRegime?.regime === 'NEUTRAL'
                        ? 'BIST100 yatay. Yatay piyasada zayıf kademe AL\'lar ortalama -1.7% getirmiş — bu yüzden sadece score≥75 nokta-atışı setup\'lar gösterilir. Bugün o barı geçen yok.'
                        : 'Tavan yapan hisseler ertesi gün ~%55-60 ihtimalle geri çekilir. Sistem BUGÜN tavan yapanları değil, YARIN tavan yapacakları arıyor.'}
                  </span>
                  {advisor.manualScan && (
                    <button
                      onClick={(e) => { e.stopPropagation(); advisor.manualScan(); }}
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
                      onClick={(e) => { e.stopPropagation(); advisor.manualScan(); }}
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
                  Tarama tamamlandığında en yüksek skorlu 8+ hisse otomatik olarak burada görünecek.
                </div>
              </>
            )}
          </div>
        )}

        {hasPicks && [...picks].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8).map((p, idx) => {
          const isSell = p.cls === 'sell';
          // v29.3: sniper (NOKTA ATISI, score>=75) = kahraman kart (v31.47: ince altin cerceve, parlama yok).
          const isSniper = !isSell && p.convictionTier === 'sniper';
          // Stop/Target yüzdeleri ARTIK LIVE FİYATTAN hesaplanır.
          // Önceden p.stopPct/targetPct scan anındaki fiyata göreydi → fiyat hareket
          // edince yüzdeler stale gözüküyordu (örn. TTRAK 1.7% görünürken aslında 3.6%).
          // Stop/target mutlak TL seviyeleri sabit; sadece "kaçta" değişir.
          const livePriceForPct = (p._livePrice && p._livePrice > 0) ? p._livePrice : (p.price || 0);
          const stopPctAbs = (p.stop && livePriceForPct > 0)
            ? Math.abs((p.stop - livePriceForPct) / livePriceForPct * 100)
            : Math.abs(p.stopPct || 0);
          const targetPctAbs = (p.target && livePriceForPct > 0)
            ? Math.abs((p.target - livePriceForPct) / livePriceForPct * 100)
            : Math.abs(p.targetPct || 0);
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
            if (breakdown.foreignFlow) tooltipLines.push(`  • Yabancı akış: ${breakdown.foreignFlow > 0 ? '+' : ''}${breakdown.foreignFlow}`);
            if (breakdown.kapBuyback) tooltipLines.push(`  • KAP geri alım: +${breakdown.kapBuyback}`);
          }
          // v31.41: haber kartta görünür kalsın; sözleşme / olay haberi güvene artı vermez.
          if (p.newsCount > 0 && Array.isArray(p.newsCategories)) {
            const newsCats = p.newsCategories.slice(0, 3).map(c => NEWS_CATEGORY_LABELS[c] || c).join(', ');
            tooltipLines.push(`📰 Haber (${p.newsCount})${newsCats ? ` [${newsCats}]` : ''}${p.newsHeadline ? `: ${String(p.newsHeadline).slice(0, 60)}` : ''}`);
            if (p.newsCategories.some(c => NEWS_UNSCORED_CATEGORIES.includes(c))) {
              tooltipLines.push('  Sözleşme / olay haberi güveni artırmaz (KAP ölçümü: alınabildiğinde fiyatlanmış)');
            }
          }
          // Yabancı yatırımcı detayı
          if (p.foreignRatio != null) {
            const cw = p.foreignChangeWeek || 0;
            const cm = p.foreignChangeMonth || 0;
            const cd = p.foreignChangeDay || 0;
            tooltipLines.push(`🌍 Yabancı: %${p.foreignRatio.toFixed(1)} oran | Gün: ${cd > 0 ? '+' : ''}${cd.toFixed(2)} | Hafta: ${cw > 0 ? '+' : ''}${cw.toFixed(2)} | Ay: ${cm > 0 ? '+' : ''}${cm.toFixed(2)}`);
            if (p.foreignFlowLabel && p.foreignFlowLabel !== 'NOTR') {
              tooltipLines.push(`  → ${p.foreignFlowLabel} (skor: ${p.foreignFlowScore > 0 ? '+' : ''}${p.foreignFlowScore})`);
            }
          }
          // ML Override — standart filtreyi atladı
          if (p._mlOverride) {
            tooltipLines.push('');
            tooltipLines.push('🤖 ML KAPI AÇTI — bu hisse standart likit/skor filtrelerini geçemedi');
            tooltipLines.push(`  Ama ML motoru %${(p._mlConfidence || p.mlBestRule?.winRate || 0).toFixed(0)} win-rate kuralına eşleşti`);
            tooltipLines.push(`  Hacim: ${p.avgVolumeTL ? (p.avgVolumeTL / 1_000_000).toFixed(2) + 'M TL/gün' : '—'} (standart eşik: 2M TL)`);
            tooltipLines.push('  Dikkat: küçük-cap slipaj riski — küçük pozisyon önerilir');
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

          // Veri yasi (her pick icin ayri — _scanTs varsa). v31.47: emoji'li renkli
          // hap yerine duz metin; renk yalniz eskidikce uyarir.
          const pickAge = p._scanTs ? (() => {
            const mins = Math.floor((Date.now() - p._scanTs) / 60000);
            if (mins < 5) return { label: 'taze', color: 'var(--t3)' };
            if (mins < 60) return { label: `${mins} dk önce`, color: mins < 15 ? 'var(--t3)' : 'var(--yellow)' };
            return { label: `${Math.floor(mins / 60)} sa önce`, color: 'var(--red)' };
          })() : null;

          // v31.47: rozetler oncelik sirasina gore tek listede (pickChips.js).
          const { visible: chipsShown, hidden: chipsHidden } = splitChips(buildPickChips(p));
          // v31.47: lot onerisi — paper motoruyla ayni kural (positionSizing.suggestPosition).
          const sizing = isSell ? null : suggestPosition({
            capital: tradingCapital ?? undefined,
            entry: livePriceForPct || p.price,
            stop: p.stop,
            mult: sizeMultOf(p._regime || lastUpdate === null ? p : { ...p, _regime: marketRegime?.regime }),
          });
          const displayPrice = p._livePrice || p.price || 0;
          const hasLive = p._livePrice != null && p._livePrice > 0;
          const liveChg = p._liveChange ?? p.change ?? 0;
          const pill = isSell
            ? { fg: 'var(--red)', bg: 'rgba(239,68,68,0.14)' }
            : { fg: 'var(--green)', bg: 'rgba(34,197,94,0.14)' };

          return (
            <div
              key={p.symbol}
              className="ai-pick-card"
              onClick={(e) => { e.stopPropagation(); onAnalyze && onAnalyze(p.symbol); }}
              title={tooltipLines.join('\n')}
              style={{
                flexShrink: 0, width: isMobile ? 'min(300px, 84vw)' : 380,
                background: 'var(--bg2)',
                border: `1px solid ${isSniper ? 'rgba(234,179,8,0.45)' : 'var(--border)'}`,
                borderRadius: 12,
                padding: '10px 12px',
                marginRight: 8,
                cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: 7,
                opacity: p._fallback ? 0.85 : 1,
                position: 'relative',
                scrollSnapAlign: 'start',
                boxSizing: 'border-box',
              }}
            >
              {/* Satir 1: sira · sembol · not · sektor — sinyal sagda */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
                <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--t1)' }}>{p.symbol}</span>
                {p.grade && (
                  <span title={`Güven skoru: ${p.confidence}/100`} style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--t2)',
                    border: '1px solid var(--border2)', borderRadius: 6, padding: '0 5px',
                  }}>{p.grade}</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--t3)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.sector}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: pill.fg, background: pill.bg,
                  borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap',
                }}>{signalLabel}</span>
              </div>

              {/* Satir 2: canli fiyat · gunluk degisim · skor */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{displayPrice.toFixed(2)} TL</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: liveChg >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {liveChg >= 0 ? '+' : ''}{liveChg.toFixed(1)}%
                </span>
                {hasLive && (
                  <span title="Fiyat güncel (canlı)" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', alignSelf: 'center' }} />
                )}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t2)' }}>
                  Skor <b style={{ color: 'var(--t1)' }}>{(p.score || 0).toFixed(0)}</b>
                </span>
              </div>

              {/* Satir 3: stop · hedef · R/O */}
              <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--t2)', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
                <span>Stop <b style={{ color: 'var(--red)', fontWeight: 600 }}>{p.stop ? p.stop.toFixed(2) : '—'}</b>
                  {stopPctAbs > 0 && <span style={{ color: 'var(--t3)' }}> −{stopPctAbs.toFixed(1)}%</span>}
                </span>
                <span>Hedef <b style={{ color: 'var(--green)', fontWeight: 600 }}>{p.target ? p.target.toFixed(2) : '—'}</b>
                  {targetPctAbs > 0 && <span style={{ color: 'var(--t3)' }}> {isSell ? '−' : '+'}{targetPctAbs.toFixed(1)}%</span>}
                </span>
                <span style={{ marginLeft: 'auto' }}>R/O 1:{(p.rr || 0).toFixed(1)}</span>
              </div>

              {/* Satir 4: lot onerisi */}
              {sizing && (
                <div
                  title={[
                    `Sermaye ${Math.round(sizing.capital).toLocaleString('tr-TR')} TL${tradingCapital ? '' : ' (varsayılan — Ayarlar > İşlem sermayesi)'}`,
                    "Kural: sermayenin %2'si stopta riske edilir, pozisyon sermayenin %33'ünü geçmez.",
                    `Konviksiyon/rejim çarpanı ×${sizing.mult}`,
                    sizing.capped ? 'Stop yakın olduğu için %33 tavanına kırpıldı.' : '',
                  ].filter(Boolean).join('\n')}
                  style={{ fontSize: 12, background: 'var(--bg3)', borderRadius: 8, padding: '6px 9px', color: 'var(--t2)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {sizing.ok ? (
                    <>
                      <b style={{ color: 'var(--t1)' }}>{sizing.lots.toLocaleString('tr-TR')} lot</b>
                      {' ≈ '}{Math.round(sizing.costTl).toLocaleString('tr-TR')} TL
                      {' · risk '}{Math.round(sizing.riskTl).toLocaleString('tr-TR')} TL
                      {!tradingCapital && <span style={{ color: 'var(--t3)' }}> · 100 bin TL&apos;ye göre</span>}
                    </>
                  ) : sizing.reason === 'watch_only' ? 'İzle — bugün pozisyon önerilmez'
                    : sizing.reason === 'too_small' ? 'Sermayeye göre pozisyon 3.000 TL altında kalıyor'
                      : 'Stop yok — lot hesaplanamadı'}
                </div>
              )}

              {/* Satir 5: en onemli 3 rozet, gerisi +N */}
              {chipsShown.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {chipsShown.map(c => (
                    <span key={c.key} title={c.title} style={chipStyle(c.tone)}>{c.label}</span>
                  ))}
                  {chipsHidden.length > 0 && (
                    <span
                      title={chipsHidden.map(c => c.label + (c.title ? ` — ${c.title.split('\n')[0]}` : '')).join('\n')}
                      style={chipStyle('neutral')}
                    >+{chipsHidden.length}</span>
                  )}
                </div>
              )}

              {/* Satir 6: tutma suresi · portfoy · veri yasi */}
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--t3)' }}>
                <span>{p.holdText || (isSell ? 'Kısa poz.' : '1-3 gün')}</span>
                {p._alreadyHolding && <span style={{ color: 'var(--orange)' }}>portföyde</span>}
                {pickAge && <span style={{ marginLeft: 'auto', color: pickAge.color }} title="Tarama anından bu yana geçen süre">{pickAge.label}</span>}
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
            <div style={{ color: '#22d3ee', fontWeight: 800, fontSize: 12, letterSpacing: 0.4 }}>{meta.sentiment}</div>
            <div style={{ fontSize: 11, fontWeight: 700 }}>
              <span style={{ color: '#22c55e' }}>{meta.buys} AL</span>
              <span style={{ color: '#7d8a9e', margin: '0 4px' }}>·</span>
              <span style={{ color: '#f87171' }}>{meta.sells} SAT</span>
            </div>
            <div style={{ fontSize: 11, color: '#a8b3c7', fontWeight: 600 }}>{meta.scanned} sembol tarandı</div>
            {cacheAge && <div style={{ fontSize: 10, color: '#7d8a9e', fontWeight: 600 }}>⏱ {cacheAge}</div>}
            <div style={{ marginTop: 4, fontSize: 9, color: '#5d6877', fontStyle: 'italic', lineHeight: 1.3 }}>
              * Yeni tarama bittiğinde otomatik güncellenir.
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
