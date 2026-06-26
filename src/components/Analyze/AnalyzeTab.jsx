import { useState, useCallback, useEffect } from 'react';
import { QUICK_STOCKS } from '../../utils/constants.js';
import { fetchData, fetchFundamentals, fetchBigParaBatchPrices } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal, calcPosition, getUnifiedAnalysis } from '../../utils/signals.js';
import { getUnifiedDecision } from '../../utils/unifiedDecision.js';
import { setApiKey, buildExpertPrompt } from '../../utils/claude.js';
import { analyzeDetailedFinancials, getFundamentalGrade, analyzeComprehensiveFinancials } from '../../utils/fundamentalEngine.js';
import { fetchIsYatirimFinancials } from '../../utils/isyatirimEngine.js';
import { fetchKAPDisclosures, calcKAPSentiment, fetchKAPSummaryFinancials } from '../../utils/kapEngine.js';
import { getSector } from '../../utils/sectorEngine.js';
import { runMonteCarlo } from '../../utils/monteCarlo.js';
import Chart from '../Chart/Chart.jsx';
import BacktestPanel from '../Backtest/BacktestPanel.jsx';
import KAPPanel from './KAPPanel.jsx';
import ChatPanel from './ChatPanel.jsx';
import MacroPanel from './MacroPanel.jsx';
import MultiTimeframe from './MultiTimeframe.jsx';
import OrderModal from '../Common/OrderModal.jsx';
import { createBrokerAdapter, BROKER_TYPES } from '../../utils/brokerEngine.js';
import { useSMCEngine } from '../../hooks/useSMCEngine.js';

function ReasonsGroup({ label, items, color, bg }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 6, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: bg }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color, textAlign: 'left',
        }}
      >
        <span>{label} ({items.length})</span>
        <span style={{ fontSize: 10, transition: 'transform .2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {items.map((r, i) => (
            <div key={i} style={{
              fontSize: 10, lineHeight: 1.5, color: 'var(--t2)', padding: '5px 0',
              borderTop: i > 0 ? '1px solid var(--border)' : 'none',
            }}>
              {r.t}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AnalyzeTab({ gData, setGData, gInd, setGInd, gSig, setGSig, log, setBadge, addToPortfolio, portfolio, goToPortfolio, brokerConfig, advisorData, intradayScan }) {
  const [symbol, setSymbol] = useState('THYAO');
  // Strict cleanup: engine resets on every symbol change, no OB/FVG bleed across assets.
  const smcEngine = useSMCEngine(symbol);
  const [addedMsg, setAddedMsg] = useState(null);
  const [customShares, setCustomShares] = useState('');
  const [positionType, setPositionType] = useState('trade'); // 'trade' or 'investment'
  const [range, setRange] = useState('5y');
  const [interval, setInterval_] = useState('1d');
  const [loading, setLoading] = useState(false);
  const [fundamentals, setFundamentals] = useState(null);
  const [bilanco, setBilanco] = useState(null);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [showJarvisModal, setShowJarvisModal] = useState(false);
  const [pendingOrder, setPendingOrder] = useState(null);
  const [mcData, setMcData] = useState(null);

  const doAnalyze = useCallback(async (sym, overrideRange, overrideInterval) => {
    const s = (sym || symbol).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || s.length > 10) return;
    setSymbol(s);
    setLoading(true); setBadge({ text: 'Yukleniyor', cls: 'load' });
    const effectiveRange = overrideRange || range;
    const effectiveInterval = overrideInterval || interval;
    try {
      // ── BATCH CACHE PRE-WARM ÖNCE (v22 FIX) ──
      // Önceden Promise.all içinde paralel başlatılıyordu, fakat fetchData içindeki
      // applyLiveOverlay batch pre-warm tamamlanmadan tetikleniyordu → race condition:
      //   - 5Y ilk açılış (cold batch): overlay per-symbol fallback'e düşüyor → 3s timeout
      //     fires → bugünkü mum eklenmiyor → "13 Mayıs mumu görünmüyor"
      //   - 2Y ikinci tıklama (warm batch): overlay batch'i bulup anında uyguluyor
      // Fix: batch pre-warm önce await edilir (~1-3s ilk seferinde, cache'den 0ms sonra),
      //      sonra fetchData paralel başlar; overlay her zaman warm batch görür.
      await fetchBigParaBatchPrices().catch(() => {});
      const [data, kapDisclosures] = await Promise.all([
        fetchData(s, effectiveRange, effectiveInterval, log).catch(() => null),
        fetchKAPDisclosures(s).catch(() => []),
      ]);
      if (!data) {
        setBadge({ text: 'Hata', cls: 'err' });
        return;
      }
      // Calculate KAP sentiment for signal integration
      const kapSentiment = calcKAPSentiment(kapDisclosures);
      const extraContext = { kapSentiment };
      const { ind, sig } = getUnifiedAnalysis(s, data, extraContext);

      // ── Foreign Ratio Fetch ──
      try {
        const { fetchForeignRatio } = await import('../../utils/foreignFlowEngine.js');
        const fr = await fetchForeignRatio(s);
        if (fr) {
          sig.foreignRatio = fr.ratio;
          sig.foreignChangeWeek = fr.changeWeek;
        }
      } catch (err) {}

      // ── ML Confluence: STRICTLY INHERIT from AI Advisor first ──
      // Single Analysis must produce IDENTICAL signal to bulk Advisor scan.
      // Priority order:
      //   1. Inherit ML enrichment from advisor cache (bist_last_ai_picks)
      //      — this is the SAME pick the AI Advisor labeled as AL/SAT/TUT
      //   2. Fall back to fresh ML scoring only if no cached enrichment exists
      let mlConfidenceBoost = 0, mlMatchedCount = 0, mlBestRule = null;
      let inheritedFromAdvisor = false;

      // v26: Two-tier advisor inheritance.
      //   1. Detailed pick in `picks[]` (top 10 — full data: stop/target/grade/tier...)
      //   2. Compact verdict in `allVerdicts[symbol]` (HER taranan sembol — minimum)
      // Aynı seans (4 saat) = aynı sinyal. Advisor↔Tekil çelişkisi yok.
      let cachedPick = null;
      try {
        const cached = JSON.parse(localStorage.getItem('bist_last_ai_picks') || '{}');
        const isFresh = cached?.ts && (Date.now() - cached.ts) < 4 * 60 * 60 * 1000;
        if (isFresh) {
          // 1) Detailed top-10 pick (geniş alan seti)
          const detailed = Array.isArray(cached?.picks)
            ? cached.picks.find(p => p?.symbol === s)
            : null;
          // 2) Compact verdict her sembol için
          const verdict = cached?.allVerdicts?.[s] || null;
          cachedPick = detailed || verdict;
          if (cachedPick) {
            mlConfidenceBoost = cachedPick.mlConfidenceBoost || 0;
            mlMatchedCount    = cachedPick.mlMatchedCount    || 0;
            mlBestRule        = cachedPick.mlBestRule         || null;
            inheritedFromAdvisor = true;
            console.log(`[Analyze] Advisor verdict for ${s}:`, {
              cls: cachedPick.cls, signal: cachedPick.signal, score: cachedPick.score,
              boost: mlConfidenceBoost, matched: mlMatchedCount,
              source: detailed ? 'top-pick' : 'compact-verdict',
            });
          }
        }
      } catch { /* cache read best-effort */ }

      // Fresh ML scoring fallback (only if advisor cache didn't provide enrichment)
      if (!inheritedFromAdvisor) {
        try {
          const mlDb = window.electronAPI?.mlDb;
          if (mlDb) {
            let rules = await mlDb.getTopRules(50, 10);
            if (!rules?.length) rules = await mlDb.getTopRules(50, 3);
            if (rules?.length) {
              const { scoreNewSignal } = await import('../../utils/ML_BacktestEngine.js');
              const mlResult = scoreNewSignal(sig, rules);
              mlConfidenceBoost = Math.max(0, mlResult?.boost || 0);
              mlMatchedCount   = mlResult?.matched?.length || 0;
              mlBestRule       = mlResult?.bestRule?.setup_name || null;
              if (mlMatchedCount > 0 && mlConfidenceBoost < 1) mlConfidenceBoost = 1;
            }
          }
        } catch (mlErr) {
          console.debug('[Analyze] ML scoring skipped:', mlErr?.message);
        }
      }

      // ── STRICT inheritance: advisor cache wins ──
      // Advisor panelinde "AL" gosterdiyse, tekil analiz "TUT" diyemez.
      // cachedPick yukarida ayarlandi (4 saatlik fresh window).
      const inheritedCls    = cachedPick?.cls    || null;
      const inheritedSignal = cachedPick?.signal || null;
      // Advisor'in score'unu da tercih et (advisor confluence + boost iceriyor,
      // tekil analizdeki raw score'dan daha guclu sinyal)
      const inheritedScore  = cachedPick?.score != null ? cachedPick.score : null;

      const unified = getUnifiedDecision(
        inheritedScore != null ? inheritedScore : sig.score,
        mlConfidenceBoost,
        {
          mlMatchedCount,
          baseSignal: inheritedSignal || sig.signal,
          baseCls:    inheritedCls    || sig.cls,
        }
      );

      // STRICT priority: advisor cache > unified > raw genSignal
      sig.cls    = inheritedCls    || unified.cls    || sig.cls;
      sig.signal = inheritedSignal || unified.signal || sig.signal;
      if (inheritedScore != null) sig.score = inheritedScore;
      sig.unifiedSource = inheritedFromAdvisor
        ? `⚡ AI Advisor sync: ${cachedPick.signal} (score ${cachedPick.score?.toFixed?.(0) || '-'})`
        : unified.source;
      sig.unifiedOverride = unified.override || inheritedFromAdvisor;
      sig.mlConfidenceBoost = mlConfidenceBoost;
      sig.mlMatchedCount = mlMatchedCount;
      sig.mlBestRule = mlBestRule;
      sig.inheritedFromAdvisor = inheritedFromAdvisor;
      // Stop/target da advisor'dan gelsin (normalizeStopTarget ile uyumlu)
      if (cachedPick?.stop && (!sig.stop || Math.abs(sig.stop - cachedPick.stop) / cachedPick.stop > 0.02)) {
        sig.stop = cachedPick.stop;
      }
      if (cachedPick?.target && (!sig.t1 || Math.abs(sig.t1 - cachedPick.target) / cachedPick.target > 0.02)) {
        sig.t1 = cachedPick.target;
      }

      // ── v30 FIX: SYNC HOLD TEXT AND LONG TERM VIEW WITH FINAL AI DECISION ──
      // Orijinal teknik sinyal "TUT" veya "IZLE" iken, AI Advisor/ML hisseyi "AL" olarak terfi ettirmisse, 
      // kullanicida celiski yaratmamak icin "Tutma Suresi" ve "Uzun Vadeli Gorunum"u de AI karariyla senkronize ediyoruz.
      if (sig.cls === 'buy' && sig.longTermView?.recommendation && 
         (sig.longTermView.recommendation.includes('IZLE') || sig.longTermView.recommendation.includes('UZAK DUR') || sig.longTermView.recommendation.includes('NOTR'))) {
        sig.longTermView = {
          recommendation: 'YUKSELIS POTANSIYELI (AI ONAYLI)',
          color: 'var(--cyan)',
          horizon: '1-3 ay',
          reason: 'Makro uzun vadeli ortalamalar henuz net bir trend gostermese de, AI Uzman ve ML kurallari erken alim veya hacim kirilimi tespit etti.'
        };
        if (sig.holdText && (sig.holdText.includes('1-3 gün') || sig.holdText.includes('Gün İçi'))) {
          sig.holdText = '2-5 hafta (Erken Yakalama / Trend Donusu)';
        }
      } else if (sig.cls === 'sell' && sig.longTermView?.recommendation && 
                (sig.longTermView.recommendation.includes('AL') || sig.longTermView.recommendation.includes('TUT'))) {
        sig.longTermView = {
          recommendation: 'KISA VADELI DUZELTME RISKI',
          color: 'var(--orange)',
          horizon: '1-4 hafta',
          reason: 'Uzun vadeli trend guclu kalsa da, AI Uzman asiri alim, tukenis veya dagilim tuzagi tespit etti. Kar realizasyonu riski yuksek.'
        };
      }
      
      if (cachedPick?._earlyPick) {
         sig.holdText = '3-6 hafta (Erken Birikim Beklentisi)';
         sig.longTermView = {
            recommendation: 'ERKEN BIRIKIM FIRSATI',
            color: 'var(--purple)',
            horizon: '1-3 ay',
            reason: 'Hisse henuz yatay veya dusus bandinda gorunse de, Akilli Para (OBV/CMF) ve hacim birikimi sinyalleri cok guclu. Trend patlamasi oncesi potansiyel firsat.'
         };
      }

      setGData(data); setGInd(ind); setGSig(sig);
      // Picks panel ile sync icin event dispatch — cache picks bayat ise kullanici gorur
      try {
        const lastBar = data.prices[data.prices.length - 1];
        const prevBar = data.prices[data.prices.length - 2] || lastBar;
        const change = prevBar?.close ? ((lastBar.close - prevBar.close) / prevBar.close) * 100 : 0;
        window.dispatchEvent(new CustomEvent('analyze-result', {
          detail: {
            symbol: s,
            signal: sig.signal,
            cls: sig.cls,
            score: Number(sig.score) || 0,
            price: ind.lastClose,
            change,
            ts: Date.now(),
          },
        }));
      } catch { /* event dispatch best-effort */ }
      // Monte Carlo simulation
      if (data.prices.length > 30) {
        try { setMcData(runMonteCarlo(data.prices, 20, 500)); } catch { setMcData(null); }
      } else { setMcData(null); }
      setFundamentals(null);
      setBilanco(null);
      fetchFundamentals(s).then(f => {
        const comprehensive = analyzeComprehensiveFinancials(f.yahoo, f.kap);
        setFundamentals(comprehensive);
      }).catch(() => {});
      // Fetch real bilanco from Is Yatirim
      fetchIsYatirimFinancials(s).then(b => setBilanco(b)).catch(() => {});
      setBadge({ text: 'Tamam', cls: 'ok' });
    } catch (error) {
      log({ type: 'err', msg: 'Analiz hatasi: ' + error.message });
      setBadge({ text: 'Hata', cls: 'err' });
    } finally {
      setLoading(false);
    }
  }, [symbol, range, interval, log, setBadge, setGData, setGInd, setGSig]);

  // Listen for AI Advisor analyze requests
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.symbol) {
        setSymbol(e.detail.symbol);
        doAnalyze(e.detail.symbol);
      }
    };
    window.addEventListener('ai-analyze', handler);
    return () => window.removeEventListener('ai-analyze', handler);
  }, [doAnalyze]);

  const loadDemo = () => {
    const s = symbol.trim().toUpperCase() || 'THYAO';
    setBadge({ text: 'Demo', cls: 'demo' });
    log(s + ' demo veri uretiliyor...', 'info');
    // Fallback removed
    setLoading(false);
    return;
    const { ind, sig } = getUnifiedAnalysis(s, data);
    setGData(data); setGInd(ind); setGSig(sig);
    log(data.prices.length + ' bar demo veri yuklendi', 'ok');
  };

  return (
    <div className="main">
      {/* LEFT PANEL */}
      <div className="pan">
        <div className="pan-h"><div className="dot" />&nbsp;Hisse & Ayarlar</div>
        <div className="sec">
          <div className="ig">
            <label className="lbl">Hisse Kodu</label>
            <input className="inp" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Örn: THYAO"
              onKeyDown={e => e.key === 'Enter' && doAnalyze()} />
          </div>
          <button className="btn btn-go" disabled={loading} onClick={() => doAnalyze()}>
            {loading ? '⟳ ÇEKİLİYOR...' : '▶ ANALİZ ET'}
          </button>
        </div>
        <div className="divider" />
        <div style={{ padding: '0 10px' }}>
          <button 
            className="btn btn-go" 
            style={{ width: '100%', background: 'linear-gradient(135deg, var(--purple), #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            disabled={loading || !gData} 
            onClick={() => setShowJarvisModal(true)}
          >
            <span style={{ fontSize: 16 }}>🤖</span> JARVIS AI ANALİZİ
          </button>
        </div>
        <div className="divider" />
        <MacroPanel />
        <div className="divider" />
        <div className="disc">Bu uygulama yatırım tavsiyesi vermez.</div>
      </div>

      {/* CENTER PANEL */}
      <div className="pan center">
        {gData && gInd && (
          <div className="chart-hdr">
            <div className="si">
              <span className="sn">{(gData.symbol || symbol)}.IS</span>
              <span className="sp">{(gInd.lastClose || 0).toFixed(2)} ₺</span>
              <span className={`sc ${(gInd.change || 0) >= 0 ? 'up' : 'dn'}`}>
                {(gInd.change || 0) >= 0 ? '+' : ''}{(gInd.change || 0).toFixed(2)} ({(gInd.changePct || 0) >= 0 ? '+' : ''}{(gInd.changePct || 0).toFixed(2)}%)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 9, color: 'var(--t3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{gData.source}</span>
              {fundamentals?.source && <span style={{ background: fundamentals.source.includes('KAP') ? 'var(--purple)' : 'var(--bg2)', padding: '1px 4px', borderRadius: 3, color: '#fff', fontSize: 7 }}>{fundamentals.source}</span>}
              {gData.prices.length > 0 && (() => {
                const lastBar = gData.prices[gData.prices.length - 1];
                const vol = lastBar.volume || 0;
                const volStr = vol >= 1e9 ? (vol / 1e9).toFixed(1) + 'B' : vol >= 1e6 ? (vol / 1e6).toFixed(1) + 'M' : vol >= 1e3 ? (vol / 1e3).toFixed(0) + 'K' : vol;
                return <span>Hacim: <b style={{ color: 'var(--cyan)' }}>{volStr}</b></span>;
              })()}
              {(gInd.volRatio != null) && <span>Ort. Hacim: <b style={{ color: gInd.volRatio > 1.5 ? 'var(--green)' : gInd.volRatio < 0.5 ? 'var(--red)' : 'var(--t1)' }}>{(gInd.volRatio || 0).toFixed(1)}x</b></span>}
              {fundamentals?.marketCap && <span>PD: <b style={{ color: 'var(--yellow)' }}>{fundamentals.marketCap >= 1e9 ? (fundamentals.marketCap / 1e9).toFixed(1) + 'B TL' : (fundamentals.marketCap / 1e6).toFixed(0) + 'M TL'}</b></span>}
              {fundamentals?.pe && <span>F/K: <b style={{ color: fundamentals.pe < 10 ? 'var(--green)' : fundamentals.pe > 25 ? 'var(--red)' : 'var(--t1)' }}>{(fundamentals.pe || 0).toFixed(1)}</b></span>}
              {fundamentals?.pb && <span>PD/DD: <b>{(fundamentals.pb || 0).toFixed(1)}</b></span>}
              {fundamentals?.divYield && <span>Temettu: <b style={{ color: 'var(--green)' }}>%{(fundamentals.divYield || 0).toFixed(1)}</b></span>}
              {fundamentals?.roe && <span>ROE: <b style={{ color: fundamentals.roe > 15 ? 'var(--green)' : 'var(--t1)' }}>%{(fundamentals.roe || 0).toFixed(0)}</b></span>}
            </div>
          </div>
        )}
        {gData?.isDemo && (
          <div style={{ background: 'var(--red2)', border: '1px solid var(--red)', borderRadius: 10, padding: '12px 18px', margin: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: 'var(--shadow)' }}>
            <span style={{ fontSize: 24 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 800, color: 'var(--red)', fontSize: 13 }}>DEMO VERİ — GERÇEK DEĞİL!</div>
              <div style={{ fontSize: 10, color: 'var(--t2)' }}>Gerçek piyasa verisi alınamadı. Bu sentetik veridir, işlem kararı için KULLANMAYIN.</div>
            </div>
          </div>
        )}

        {/* Inline Timeframe Buttons */}
        {gData && (
          <div style={{ display: 'flex', gap: 4, padding: '0 14px 6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              { label: '1G', range: '5d', interval: '30m' },
              { label: '5G', range: '5d', interval: '1h' },
              { label: '1A', range: '1mo', interval: '1d' },
              { label: '3A', range: '3mo', interval: '1d' },
              { label: '6A', range: '6mo', interval: '1d' },
              { label: '1Y', range: '1y', interval: '1d' },
              { label: '2Y', range: '2y', interval: '1d' },
              { label: '5Y', range: '5y', interval: '1d' },
            ].map(tf => (
              <button key={tf.label} onClick={() => { setRange(tf.range); setInterval_(tf.interval); doAnalyze(symbol, tf.range, tf.interval); }}
                style={{
                  padding: '4px 10px', fontSize: 9, fontWeight: range === tf.range ? 700 : 500, cursor: 'pointer',
                  background: range === tf.range ? 'var(--cyan)' : 'var(--bg3)',
                  color: range === tf.range ? '#000' : 'var(--t2)',
                  border: '1px solid ' + (range === tf.range ? 'var(--cyan)' : 'var(--border)'),
                  borderRadius: 4, transition: 'all 0.15s',
                }}>{tf.label}</button>
            ))}
          </div>
        )}

        <Chart prices={gData?.prices} ind={gInd} mcData={mcData} />
        
        {gInd && (
          <div className="ind-bar">
            <div className="ind-c"><div className="ind-n">RSI (14)</div><div className="ind-v" style={{ color: gInd.lastRSI < 30 ? 'var(--green)' : gInd.lastRSI > 70 ? 'var(--red)' : 'var(--t1)' }}>{gInd.lastRSI != null ? gInd.lastRSI.toFixed(1) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">MACD</div><div className="ind-v" style={{ color: gInd.lastMACD > 0 ? 'var(--green)' : 'var(--red)' }}>{gInd.lastMACD != null ? gInd.lastMACD.toFixed(2) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">MA-20</div><div className="ind-v">{gInd.lastMA20 != null ? gInd.lastMA20.toFixed(2) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">MA-50</div><div className="ind-v">{gInd.lastMA50 != null ? gInd.lastMA50.toFixed(2) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">MFI</div><div className="ind-v" style={{ color: gInd.mfi < 20 ? 'var(--green)' : gInd.mfi > 80 ? 'var(--red)' : 'var(--t1)' }}>{gInd.mfi != null ? gInd.mfi.toFixed(0) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">Akıllı Para</div><div className="ind-v" style={{ color: gInd.obvTrend === 'accumulation' ? 'var(--green)' : gInd.obvTrend === 'distribution' ? 'var(--red)' : 'var(--t1)' }}>{gInd.obvTrend === 'accumulation' ? 'BİRİKİM' : gInd.obvTrend === 'distribution' ? 'DAĞILIM' : 'NÖTR'}</div></div>
            <div className="ind-c"><div className="ind-n">VWAP</div><div className="ind-v">{gInd.vwap != null ? gInd.vwap.toFixed(2) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">Hacim</div><div className="ind-v">{gInd.volRatio != null ? gInd.volRatio.toFixed(1) + 'x' : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">CMF</div><div className="ind-v" style={{ color: gInd.cmf > 0.05 ? 'var(--green)' : gInd.cmf < -0.05 ? 'var(--red)' : 'var(--t1)' }}>{gInd.cmf != null ? gInd.cmf.toFixed(2) : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">Wyckoff</div><div className="ind-v" style={{ color: gInd.wyckoffPhase === 'accumulation' || gInd.wyckoffPhase === 'markup' ? 'var(--green)' : gInd.wyckoffPhase === 'distribution' || gInd.wyckoffPhase === 'markdown' ? 'var(--red)' : 'var(--yellow)' }}>{gInd.wyckoffPhase === 'accumulation' ? 'BİRİKİM' : gInd.wyckoffPhase === 'markup' ? 'YÜKSELİŞ' : gInd.wyckoffPhase === 'distribution' ? 'DAĞILIM' : gInd.wyckoffPhase === 'markdown' ? 'DÜŞÜŞ' : gInd.wyckoffPhase === 'ranging' ? 'YATAY' : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">ADX</div><div className="ind-v" style={{ color: gInd.adx > 25 ? 'var(--green)' : gInd.adx < 20 ? 'var(--red)' : 'var(--yellow)' }}>{gInd.adx != null ? gInd.adx.toFixed(0) : '—'}<span style={{ fontSize: 8, marginLeft: 3, color: 'var(--t3)' }}>{gInd.adx > 25 ? 'TREND' : gInd.adx < 20 ? 'YATAY' : 'ZAYIF'}</span></div></div>
            <div className="ind-c"><div className="ind-n">+DI / -DI</div><div className="ind-v">{gInd.plusDI != null ? <><span style={{ color: 'var(--green)' }}>{gInd.plusDI.toFixed(0)}</span><span style={{ color: 'var(--t3)', margin: '0 3px' }}>/</span><span style={{ color: 'var(--red)' }}>{gInd.minusDI.toFixed(0)}</span></> : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">TTM Squeeze</div><div className="ind-v" style={{ color: gInd.ttmSqueeze?.firing ? (gInd.ttmSqueeze.momentum > 0 ? 'var(--green)' : 'var(--red)') : gInd.ttmSqueeze?.squeezeOn ? 'var(--yellow)' : 'var(--t3)' }}>{gInd.ttmSqueeze?.firing ? (gInd.ttmSqueeze.momentum > 0 ? 'ATIŞ ↑' : 'ATIŞ ↓') : gInd.ttmSqueeze?.squeezeOn ? 'SIKIŞMA' : 'KAPALI'}</div></div>
            <div className="ind-c"><div className="ind-n">StochRSI</div><div className="ind-v" style={{ color: gInd.lastStochK != null && gInd.lastStochK < 20 ? 'var(--green)' : gInd.lastStochK != null && gInd.lastStochK > 80 ? 'var(--red)' : 'var(--t1)' }}>{gInd.lastStochK != null ? gInd.lastStochK.toFixed(0) + '/' + (gInd.lastStochD != null ? gInd.lastStochD.toFixed(0) : '—') : '—'}</div></div>
            <div className="ind-c"><div className="ind-n">Chandelier</div><div className="ind-v" style={{ color: 'var(--cyan)' }}>{gInd.chandelier?.longStop ? gInd.chandelier.longStop.toFixed(2) : '—'}</div></div>
          </div>
        )}
        {/* Risk & Monte Carlo Summary */}
        {gSig && gInd && (
          <div style={{ padding: 14 }}>
            <div className="trade-box">
              <div className="trade-title" style={{ color: 'var(--purple)' }}>Risk & Momentum Özeti {mcData ? '| MC ' + mcData.days + 'G' : ''}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10 }}>
                <div className="tr-row"><span className="tr-l">R/Ö Kalitesi</span><span className="tr-v" style={{ color: gSig.rrQuality === 'excellent' ? 'var(--green)' : gSig.rrQuality === 'good' ? 'var(--yellow)' : gSig.rrQuality === 'fair' ? 'var(--orange)' : 'var(--red)' }}>{gSig.rrQuality === 'excellent' ? 'MÜKEMMEL' : gSig.rrQuality === 'good' ? 'İYİ' : gSig.rrQuality === 'fair' ? 'ORTA' : 'ZAYIF'} (1:{(gSig.rr || 0).toFixed(1)})</span></div>
                <div className="tr-row"><span className="tr-l">Trend Gücü</span><span className="tr-v" style={{ color: (gInd.adx || 0) > 25 ? 'var(--green)' : (gInd.adx || 0) > 20 ? 'var(--yellow)' : 'var(--red)' }}>{(gInd.adx || 0) > 25 ? 'GÜÇLÜ' : (gInd.adx || 0) > 20 ? 'ORTA' : 'ZAYIF'} (ADX {gInd.adx != null ? gInd.adx.toFixed(0) : '—'})</span></div>
                <div className="tr-row"><span className="tr-l">Volatilite</span><span className="tr-v" style={{ color: 'var(--cyan)' }}>{gSig.dailyRange ? '%' + (gSig.dailyRange || 0).toFixed(1) + ' günlük' : '—'}</span></div>
                <div className="tr-row"><span className="tr-l">Para Akışı</span><span className="tr-v" style={{ color: (gInd.cmf || 0) > 0.05 ? 'var(--green)' : (gInd.cmf || 0) < -0.05 ? 'var(--red)' : 'var(--yellow)' }}>{(gInd.cmf || 0) > 0.1 ? 'GÜÇLÜ GİRİŞ' : (gInd.cmf || 0) > 0.05 ? 'GİRİŞ' : (gInd.cmf || 0) < -0.1 ? 'GÜÇLÜ ÇIKIŞ' : (gInd.cmf || 0) < -0.05 ? 'ÇIKIŞ' : 'NÖTR'}</span></div>
                {gInd.lastStochK != null && <div className="tr-row"><span className="tr-l">StochRSI</span><span className="tr-v" style={{ color: gInd.lastStochK < 20 ? 'var(--green)' : gInd.lastStochK > 80 ? 'var(--red)' : 'var(--t1)' }}>K:{gInd.lastStochK.toFixed(0)} D:{gInd.lastStochD != null ? gInd.lastStochD.toFixed(0) : '—'} {gInd.lastStochK < 20 ? '(AŞIRI SATIM)' : gInd.lastStochK > 80 ? '(AŞIRI ALIM)' : ''}</span></div>}
                <div className="tr-row"><span className="tr-l">Max Risk (%8)</span><span className="tr-v" style={{ color: Math.abs(gSig.stopPct || ((gSig.stop - gSig.entry) / gSig.entry * 100)) > 8 ? 'var(--red)' : 'var(--green)' }}>%{(Math.abs(gSig.stopPct || ((gSig.stop - gSig.entry) / gSig.entry * 100)) || 0).toFixed(1)}</span></div>
                {mcData && <>
                  <div className="tr-row"><span className="tr-l">MC Kar Olasılığı</span><span className="tr-v" style={{ color: mcData.profitProb > 55 ? 'var(--green)' : mcData.profitProb < 45 ? 'var(--red)' : 'var(--yellow)' }}>%{(mcData.profitProb || 0).toFixed(0)}</span></div>
                  <div className="tr-row"><span className="tr-l">MC Medyan ({mcData.days}G)</span><span className="tr-v" style={{ color: mcData.median > mcData.lastPrice ? 'var(--green)' : 'var(--red)' }}>{(mcData.median || 0).toFixed(2)} TL</span></div>
                  <div className="tr-row"><span className="tr-l">En Kötü %5</span><span className="tr-v" style={{ color: 'var(--red)' }}>{(mcData.worst5 || 0).toFixed(2)} TL ({(Math.abs((mcData.worst5 / mcData.lastPrice - 1) * 100) || 0).toFixed(1)}%)</span></div>
                  <div className="tr-row"><span className="tr-l">En İyi %5</span><span className="tr-v" style={{ color: 'var(--green)' }}>{(mcData.best5 || 0).toFixed(2)} TL (+{(Math.abs((mcData.best5 / mcData.lastPrice - 1) * 100) || 0).toFixed(1)}%)</span></div>
                </>}
              </div>
              {/* Compact risk gauge */}
              {(() => {
                const bullish = gSig.reasons.filter(r => r.c === 'bullish').length;
                const bearish = gSig.reasons.filter(r => r.c === 'bearish').length;
                const total = bullish + bearish || 1;
                const ratio = bullish / total * 100;
                return (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 8, color: 'var(--t3)', marginBottom: 4 }}>Yükseliş / Düşüş Oranı: {bullish} yükseliş, {bearish} düşüş</div>
                    <div style={{ height: 6, background: 'var(--bg0)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: ratio + '%', background: 'var(--green)', transition: 'width 0.3s' }} />
                      <div style={{ width: (100 - ratio) + '%', background: 'var(--red)', transition: 'width 0.3s' }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
        {/* Multi-Timeframe Analysis */}
        {gData && gData.symbol && (
          <div style={{ padding: '0 14px 8px' }}>
            <MultiTimeframe symbol={gData.symbol} />
          </div>
        )}
        {/* Backtest — below chart */}
        {gData && gData.prices.length > 25 && (
          <div style={{ padding: '0 14px 14px' }}>
            <BacktestPanel prices={gData.prices} symbol={gData.symbol} />
          </div>
        )}
      </div>

      {/* RIGHT PANEL */}
      <div className="pan">
        <div className="pan-h"><div className="dot" style={{ background: 'var(--yellow)' }} />&nbsp;Analiz & AI Uzman</div>
        {gSig ? (
          <div>
            {/* Redesigned Signal Card */}
            <div className={`sig-card ${gSig.cls} ${gSig.signal?.includes('GUCLU') ? 'strong' : ''} fi`}>
              <div className="sig-header">
                <div className="sig-pulse" />
                <span>Teknik Sinyal</span>
              </div>
              <div className="sig-val">{gSig.signal || 'NÖTR'}</div>
              <div className="progress-container">
                <div className="progress-fill" style={{ width: (gSig.conf || 0) + '%' }} />
              </div>
              <div className="conf-txt">Güven: %{gSig.conf || 0} · Skor: {(gSig.score || 0).toFixed(0)}/100</div>
              {(gSig.mlMatchedCount || 0) > 0 && (
                <div style={{
                  marginTop: 6, padding: '4px 8px', borderRadius: 4,
                  background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.25)',
                  fontSize: 9, color: '#ffd700',
                }}>
                  🎯 ML +{(gSig.mlConfidenceBoost || 0).toFixed(1)} · {gSig.mlMatchedCount} kural eşleşti
                  {gSig.mlBestRule && <div style={{ fontSize: 8, color: '#fbbf24', marginTop: 1 }}>{typeof gSig.mlBestRule === 'string' ? gSig.mlBestRule : gSig.mlBestRule.setupName || JSON.stringify(gSig.mlBestRule)}</div>}
                </div>
              )}
              {gSig.unifiedSource && (
                <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 4, fontStyle: 'italic' }}>
                  {gSig.unifiedOverride ? '⚡ ML Override · ' : ''}{gSig.unifiedSource}
                </div>
              )}
            </div>

            {/* Trade Setup */}
            <div className="trade-box fi">
              <div className="trade-title" style={{ color: 'var(--cyan)' }}>İşlem Kurulumu</div>
              <div className="tr-row"><span className="tr-l">Giriş</span><span className="tr-v b">{(gSig.entry || 0).toFixed(2)} TL</span></div>
              <div className="tr-row"><span className="tr-l">Stop-Loss</span><span className="tr-v r">{(gSig.stop || 0).toFixed(2)} TL ({(((gSig.stop - gSig.entry) / gSig.entry) * 100 || 0).toFixed(1)}%)</span></div>
              <div className="tr-row"><span className="tr-l">Hedef 1</span><span className="tr-v g">{(gSig.t1 || 0).toFixed(2)} TL (+{(((gSig.t1 - gSig.entry) / gSig.entry) * 100 || 0).toFixed(1)}%)</span></div>
              <div className="tr-row"><span className="tr-l">Hedef 2</span><span className="tr-v g">{(gSig.t2 || 0).toFixed(2)} TL (+{(((gSig.t2 - gSig.entry) / gSig.entry) * 100 || 0).toFixed(1)}%)</span></div>
              <div className="tr-row"><span className="tr-l">R/O</span><span className="tr-v y">1:{(gSig.rr || 0).toFixed(1)}</span></div>
              {gSig.atr && <div className="tr-row"><span className="tr-l">ATR(14)</span><span className="tr-v" style={{ color: 'var(--cyan)' }}>{(gSig.atr || 0).toFixed(2)}</span></div>}
              {gInd?.chandelier?.longStop && <div className="tr-row"><span className="tr-l">Chandelier Stop</span><span className="tr-v" style={{ color: 'var(--orange)' }}>{(gInd.chandelier.longStop || 0).toFixed(2)} TL</span></div>}
              <div className="tr-row"><span className="tr-l">Tutma Süresi</span><span className="tr-v" style={{ color: 'var(--purple)' }}>{gSig.holdText || '—'}</span></div>
              {gInd?.adx != null && <div className="tr-row"><span className="tr-l">Piyasa Modu</span><span className="tr-v" style={{ color: gInd.adx > 25 ? 'var(--green)' : 'var(--yellow)' }}>{gInd.adx > 25 ? 'TREND (ADX ' + (gInd.adx || 0).toFixed(0) + ')' : 'YATAY (ADX ' + (gInd.adx || 0).toFixed(0) + ')'}</span></div>}
              {/* Long-term investment view */}
              {gSig.longTermView && (
                <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 5, background: 'var(--bg0)', borderLeft: '3px solid ' + gSig.longTermView.color }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: gSig.longTermView.color, marginBottom: 3 }}>
                    {gSig.longTermView.recommendation} {gSig.longTermView.horizon !== '-' ? '(' + gSig.longTermView.horizon + ')' : ''}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--t2)', lineHeight: 1.4 }}>{gSig.longTermView.reason}</div>
                </div>
              )}
              {/* Add to Portfolio Button */}
              {addToPortfolio && gData && (() => {
                const pos = calcPosition(portfolio?.cash || 10000, 2, gSig.entry, gSig.stop);
                const alreadyOpen = portfolio?.positions?.some(p => p.symbol === gData.symbol && p.status === 'open');
                const shares = customShares ? parseInt(customShares, 10) : pos.shares;
                const maxShares = Math.floor((portfolio?.cash || 10000) / gSig.entry);
                const validShares = shares > 0 && shares <= maxShares;
                const cost = shares * gSig.entry;
                const risk = shares * Math.abs(gSig.entry - gSig.stop);
                return (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                    <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 6 }}>Kelly Önerisi: {pos.shares} lot (%2 risk) | Max: {maxShares} lot | Nakit: {(portfolio?.cash || 0).toFixed(0)} TL</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <button onClick={() => setPositionType('trade')} style={{ flex: 1, padding: 6, fontSize: 10, background: positionType === 'trade' ? 'var(--cyan)' : 'var(--bg3)', color: positionType === 'trade' ? '#000' : 'var(--t2)', border: 'none', borderRadius: 4, fontWeight: positionType === 'trade' ? 700 : 400, cursor: 'pointer' }}>KISA VADE (TRADE)</button>
                      <button onClick={() => setPositionType('investment')} style={{ flex: 1, padding: 6, fontSize: 10, background: positionType === 'investment' ? 'var(--purple)' : 'var(--bg3)', color: positionType === 'investment' ? '#fff' : 'var(--t2)', border: 'none', borderRadius: 4, fontWeight: positionType === 'investment' ? 700 : 400, cursor: 'pointer' }}>UZUN VADE (YATIRIM)</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                      <input className="inp" type="number" min="1" max={maxShares} value={customShares || pos.shares} onChange={e => setCustomShares(e.target.value)} style={{ width: 80, fontSize: 11, padding: 6, textAlign: 'center' }} />
                      <span style={{ fontSize: 10, color: 'var(--t2)' }}>lot</span>
                      <span style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 'auto' }}>Maliyet: <b style={{ color: 'var(--cyan)' }}>{cost.toFixed(0)} TL</b> | Risk: {positionType === 'trade' ? <b style={{ color: 'var(--red)' }}>{risk.toFixed(0)} TL</b> : <span style={{color: 'var(--t2)'}}>Stopsiz (Uzun Vade)</span>}</span>
                    </div>
                    {alreadyOpen ? (
                      <div style={{ fontSize: 10, color: 'var(--yellow)', textAlign: 'center', padding: 6 }}>Bu hisse zaten portföyde açık.</div>
                    ) : addedMsg ? (
                      <div style={{ fontSize: 10, color: 'var(--green)', textAlign: 'center', padding: 6 }}>{addedMsg}</div>
                    ) : validShares ? (
                      <button className="btn btn-go" style={{ width: '100%', fontSize: 11, padding: 8 }} onClick={() => {
                        const order = { symbol: gData.symbol, price: gSig.entry, stop: gSig.stop, target: gSig.t1, shares, positionType };
                        setPendingOrder(order);
                        setIsOrderModalOpen(true);
                      }}>
                        {brokerConfig.type === BROKER_TYPES.MIDAS_MANUAL ? '📱 MIDAS\'TA İŞLEM YAP' : '+ PORTFÖYE EKLE'} ({shares} lot @ {gSig.entry.toFixed(2)} TL)
                      </button>
                    ) : (
                      <div style={{ fontSize: 10, color: 'var(--red)', textAlign: 'center', padding: 6 }}>
                        {shares <= 0 ? 'Lot sayısı geçersiz' : 'Yetersiz nakit (' + (portfolio?.cash || 0).toFixed(0) + ' TL)'}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            <OrderModal 
              isOpen={isOrderModalOpen} 
              onClose={() => setIsOrderModalOpen(false)}
              order={pendingOrder}
              brokerType={brokerConfig.type}
              onConfirm={async () => {
                const adapter = createBrokerAdapter(brokerConfig.type, brokerConfig.config);
                const result = await adapter.execute(pendingOrder, addToPortfolio);
                if (result.success) {
                  setAddedMsg(gData.symbol + ' portföye eklendi!');
                  setCustomShares('');
                  setTimeout(() => setAddedMsg(null), 4000);
                }
              }}
            />

            {/* KAP Panel */}
            <KAPPanel symbol={gData.symbol} />

            {/* Bilanco Panel */}
            {bilanco && bilanco.ratios && (
              <div className="trade-box fi" style={{ marginTop: 14 }}>
                <div className="trade-title" style={{ color: 'var(--purple)' }}>Bilanco & Gelir Tablosu ({bilanco.latest?.period || 'Son Donem'})</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 6, marginTop: 8 }}>
                  {[
                    { label: 'Hasilat', val: bilanco.latest?.revenue, fmt: 'money' },
                    { label: 'Net Kar', val: bilanco.latest?.netIncome, fmt: 'money' },
                    { label: 'Brut Marj', val: bilanco.ratios?.grossMargin, fmt: 'pct' },
                    { label: 'Net Marj', val: bilanco.ratios?.netMargin, fmt: 'pct' },
                    { label: 'ROE', val: bilanco.ratios?.roe, fmt: 'pct' },
                    { label: 'Cari Oran', val: bilanco.ratios?.currentRatio, fmt: 'ratio' },
                    { label: 'Borc/Ozkaynak', val: bilanco.ratios?.debtToEquity, fmt: 'ratio' },
                    { label: 'Ciro Buyume', val: bilanco.ratios?.revenueGrowth, fmt: 'pct' },
                  ].map((m, i) => {
                    let display = 'N/A', color = 'var(--t2)';
                    if (m.val != null) {
                      if (m.fmt === 'money') {
                        display = Math.abs(m.val) >= 1e9 ? (m.val / 1e9).toFixed(1) + 'B' : (m.val / 1e6).toFixed(0) + 'M';
                        color = m.val >= 0 ? 'var(--green)' : 'var(--red)';
                      } else if (m.fmt === 'pct') {
                        display = m.val.toFixed(1) + '%';
                        color = m.val >= 10 ? 'var(--green)' : m.val >= 0 ? 'var(--cyan)' : 'var(--red)';
                      } else {
                        display = m.val.toFixed(2);
                        color = m.label === 'Cari Oran' ? (m.val >= 1.5 ? 'var(--green)' : m.val >= 1 ? 'var(--yellow)' : 'var(--red)') : (m.val < 1 ? 'var(--green)' : m.val < 2 ? 'var(--yellow)' : 'var(--red)');
                      }
                    }
                    return (
                      <div key={i} style={{ background: 'var(--bg2)', padding: '6px 8px', borderRadius: 4, textAlign: 'center' }}>
                        <div style={{ fontSize: 7, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 0.3 }}>{m.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color, marginTop: 2 }}>{display}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 8, color: 'var(--t3)', marginTop: 6 }}>Kaynak: Is Yatirim Mali Tablolar | TL</div>
              </div>
            )}

            {/* Reasons — Collapsible */}
            {(() => {
              const bullish = gSig.reasons.filter(r => r.c === 'bullish');
              const bearish = gSig.reasons.filter(r => r.c === 'bearish');
              const neutral = gSig.reasons.filter(r => r.c !== 'bullish' && r.c !== 'bearish');
              const groups = [
                { key: 'bullish', label: '▲ Yükseliş Sinyalleri', items: bullish, color: 'var(--green)', bg: 'var(--green2)' },
                { key: 'bearish', label: '▼ Düşüş Sinyalleri', items: bearish, color: 'var(--red)', bg: 'var(--red2)' },
                { key: 'neutral', label: '◆ Nötr Göstergeler', items: neutral, color: 'var(--yellow)', bg: 'var(--yellow2)' },
              ].filter(g => g.items.length > 0);

              return (
                <div className="fi" style={{ marginTop: 14 }}>
                  <div className="trade-title">Gerekçeler ({gSig.reasons.length})</div>
                  {groups.map(g => (
                    <ReasonsGroup key={g.key} label={g.label} items={g.items} color={g.color} bg={g.bg} />
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--t3)', fontSize: 11 }}>Henuz analiz yapilmadi.</div>
        )}
        <div className="disc">Teknik analiz gecmis veriye dayanir.</div>
      </div>

      {/* JARVIS MODAL */}
      {showJarvisModal && (
        <div className="modal-overlay" onClick={() => setShowJarvisModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: '90%', maxWidth: 800, height: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 12, padding: 0, position: 'relative', background: 'var(--bg0)' }}>
            <button 
              onClick={() => setShowJarvisModal(false)} 
              style={{ position: 'absolute', top: 12, right: 12, zIndex: 100, background: 'rgba(255,255,255,0.1)', border: '1px solid var(--border)', color: 'var(--t1)', fontSize: 18, cursor: 'pointer', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}
            >
              ✕
            </button>
            <div style={{ flex: 1, padding: 14, overflowY: 'auto' }}>
              <ChatPanel
                symbol={gData?.symbol}
                ind={gInd}
                sig={gSig}
                fundamentals={fundamentals}
                bilanco={bilanco}
                log={log}
                advisorData={advisorData}
                intradayScan={intradayScan}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
