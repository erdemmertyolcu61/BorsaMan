import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { BIST30, getStockList, SECTORS } from '../../utils/constants.js';
import { fetchSingle } from '../../utils/fetchEngine.js';
import { calcAll } from '../../utils/indicators.js';
import { genSignal, calcPosition } from '../../utils/signals.js';
import { fetchIsYatirimFinancials, scoreIsYatirimFundamentals } from '../../utils/isyatirimEngine.js';
import { getFundamentalGrade } from '../../utils/fundamentalEngine.js';
import {
  getSessionPhase,
  isMarketOpen,
  computeVWAP,
  computeORB,
  computeRS,
  intradayMomentumScore,
  volumeRate,
  calcIntradayStructureLevels,
  classifyIntradayPlay,
  PLAY_TYPE_META,
} from '../../utils/IntradayEngine.js';

// ── Session context banner ───────────────────────────────────────────────────
const SESSION_TIPS = {
  PRE:       { icon: '\u{1F319}', bg: 'rgba(139,92,246,.06)',  tip: 'Piyasa acilmadi. Watchlist hazirla, gap adaylarini belirle.' },
  OPEN:      { icon: '⚡',    bg: 'rgba(255,214,0,.07)',   tip: 'Acilis 30 dk — fake-out yuksek. ORB olusmadan islem acma. Hacim onay iste.' },
  MORNING:   { icon: '☀️', bg: 'rgba(0,229,255,.05)', tip: 'En iyi kurumsal islem saati. Hacim teyitli ORB kirilimi ve VWAP ust bandini takip et.' },
  LUNCH:     { icon: '\u{1F550}', bg: 'rgba(100,100,100,.05)', tip: 'Hacim dusiyor — manipulasyon riski artar. Mevcut pozisyon yonet, yeni acma.' },
  AFTERNOON: { icon: '\u{1F324}️', bg: 'rgba(0,229,255,.04)', tip: 'Ikinci momentum dalgasi. VWAP toparlanma ve trend devami en guclu burada.' },
  CLOSE:     { icon: '\u{1F6A8}', bg: 'rgba(255,99,71,.07)',   tip: 'Son 30 dk — kapanis pozisyonlamasi. Gece riski tasimayin, kar al veya stop koy.' },
  POST:      { icon: '\u{1F512}', bg: 'rgba(0,0,0,.1)',        tip: 'Piyasa kapali. Yarinin ORB adaylarini ve haber akisini analiz et.' },
  WEEKEND:   { icon: '\u{1F3D6}️', bg: 'rgba(0,0,0,.1)', tip: 'Hafta sonu. Pazartesi sabahi gap adaylarini ve haftalik trend degisimlerini hazirla.' },
};

// ── Professional strategy notes per play type + signals ─────────────────────
function buildStrategyNote(r, phase) {
  const notes = [];
  const playMeta = PLAY_TYPE_META[r.playType] || PLAY_TYPE_META.none;

  // Play-type specific note
  if (r.playType === 'momentum') {
    notes.push(`MOMENTUM TAKIP: Piyasayi ${r.rsData?.outperformance?.toFixed(1) ?? '?'}% geciyor. VWAP ${r.intVwapZone === 'above_1s' ? '+1s bandinda' : 'ustunde'}, trend devam ediyor. Hedef VWAP+2s bandi.`);
  } else if (r.playType === 'orb_breakout') {
    notes.push(`ORB KIRILIMI: Acilis araligi (${r.orbData?.low?.toFixed(2) ?? '?'}-${r.orbData?.high?.toFixed(2) ?? '?'}) ustune cikti. Kirilima hacim teyiti gelirse devam hamlesi guclenir.`);
  } else if (r.playType === 'vwap_reclaim') {
    notes.push(`VWAP TOPARLANMA: VWAP seviyesine yaklasip geri kazaniyor. ${r.intVwapZone === 'above' ? 'VWAP ustune gecti' : 'VWAP testinde'}, alici kontrolde.`);
  } else if (r.playType === 'dip_bounce') {
    notes.push(`DIP ALIS: VWAP altinda kurumsal birikim var (OBV: ${r.obvTrend}). Gunluk RSI: ${r.rsi?.toFixed(0) ?? '?'} — asiri satimdan geri donus potansiyeli.`);
  } else if (r.playType === 'squeeze') {
    notes.push(`SQUEEZE PATLAMA: TTM Squeeze bandi sikismasini birakiyor, momentum pozitif. Sert kisa vadeli hareket basliyor olabilir.`);
  }

  // Additional signal notes
  if (r.volSurge) notes.push('HACIM PATLAMASI: Normal gunden cok daha fazla hacim akiyor — kurumsal hareket isareti.');
  if (r.obvDivergence === 'bullish_div') notes.push('OBV DIVERJANS: Fiyat dusus yaparken kurumsal birikim artiyordu — guclu tersine donus sinyali.');
  if (r.wyckoffSpring === 'spring') notes.push('WYCKOFF SPRING: Kurumsal tuzak tamamlandi, zayif saticilar silkelendi. Yukari atis bekleniyor.');
  if (r.rsiDivergence === 'bullish') notes.push('RSI DIVERJANS: Fiyat yeniden dip yaparken RSI yukseliyordu — dipten donus onayliyor.');

  // Session-specific warning
  if (phase?.code === 'OPEN' && notes.length > 0) {
    notes.push('UYARI: Acilis saatinde fake-out riski yuksek. ORB olusmadan ve hacim teyiti olmadan islem acmayin.');
  }
  if (phase?.code === 'LUNCH') {
    notes.push('UYARI: Ogle molasi — dusuk hacim manipulasyona zemin hazirlar. Bu sette risk/odul dustur.');
  }

  if (notes.length === 0) {
    if (r.cls === 'buy') notes.push('STANDART ALIS: Teknik gorunum olumlu. Hacim ve VWAP teyidi ile giris yapin, stop mutlaka koyun.');
    else notes.push('IZLEME: Net bir setup olusana kadar bekleyin. Para kaybetmemek de kazanmaktir.');
  }

  return notes;
}

// ── Main scoring engine (intraday-focused) ───────────────────────────────────
function scoreIntradayOpportunity(r, marketInfo, session) {
  let s = 0;
  const tags = [];

  // ── A. Intraday Momentum (15m) — max 12 pts ──────────────────────────────
  if (r.intMomentumScore != null) {
    if (r.intMomentumScore >= 80) { s += 12; tags.push('15dk Guclu Momentum'); }
    else if (r.intMomentumScore >= 65) { s += 8; tags.push('15dk Pozitif Momentum'); }
    else if (r.intMomentumScore >= 50) { s += 4; }
    else if (r.intMomentumScore < 35) { s -= 6; }
    else if (r.intMomentumScore < 45) { s -= 3; }
  }

  // 15m MACD direction bonus
  if (r.int15mMacdBull && r.int15mMacdAccel) { s += 4; tags.push('MACD 15dk Ivmesi'); }
  else if (r.int15mMacdBull) s += 2;
  else if (!r.int15mMacdBull && !r.int15mMacdAccel) s -= 3;

  // ── B. VWAP Position — max 8 pts ─────────────────────────────────────────
  if (r.intVwapZone === 'above_1s') { s += 8; tags.push('VWAP Momentum Bandi'); }
  else if (r.intVwapZone === 'above') { s += 5; tags.push('VWAP Ustunde'); }
  else if (r.intVwapZone === 'at') { s += 3; }
  else if (r.intVwapZone === 'above_2s') { s += 2; tags.push('VWAP Asiri Uzaklik'); }
  else if (r.intVwapZone === 'below') { s -= 4; }
  else if (r.intVwapZone === 'below_1s') { s -= 7; }
  else if (r.intVwapZone === 'below_2s') { s -= 4; tags.push('VWAP-2s Bantic'); } // oversold bounce

  // ── C. ORB Status — max 7 pts ────────────────────────────────────────────
  if (r.orbData?.breakoutUp) { s += 7; tags.push('ORB Kirdiktan Yukari'); }
  else if (r.orbData?.nearBreakoutUp) { s += 4; tags.push('ORB Test Ediyor'); }
  else if (r.orbData?.formed && !r.orbData?.breakoutDown) { s += 1; } // above ORB low
  else if (r.orbData?.breakoutDown) { s -= 5; }

  // ── D. Relative Strength vs BIST100 — max 6 pts ──────────────────────────
  if (r.rsData?.strongLeader) { s += 6; tags.push('Guclu RS Lideri'); }
  else if (r.rsData?.leading) { s += 4; tags.push('Piyasayi Geciyor'); }
  else if (!r.rsData?.lagging) s += 1;
  else if (r.rsData?.lagging) s -= 4; // lagging the market

  // ── E. Volume Rate — max 5 pts ───────────────────────────────────────────
  if (r.volRate?.surge) { s += 5; tags.push('Hacim Patlamasi'); }
  else if (r.volRate?.onPace) { s += 3; tags.push('Hacim Onay'); }
  else if (r.volRate?.rate > 0.8) s += 1;
  else if (r.volRate?.rate < 0.4) s -= 2;

  // ── F. Daily Volatility (minimum range check) — max 3 pts ────────────────
  if (r.dailyRange > 3.5) { s += 3; }
  else if (r.dailyRange > 2.5) { s += 2; }
  else if (r.dailyRange > 1.5) { s += 1; }
  else if (r.dailyRange < 1.0) s -= 3; // too low — can't hit +5% target

  // ── G. Daily Smart Money / Institutional — max 5 pts ─────────────────────
  if (r.obvTrend === 'accumulation') { s += 3; tags.push('Kurumsal Birikim'); }
  else if (r.obvTrend === 'distribution') s -= 2;

  if (r.cmf > 0.15) { s += 2; tags.push('Para Akisi Pozitif'); }
  else if (r.cmf < -0.15) s -= 1;

  // ── H. Daily RSI Zone — max 4 pts ────────────────────────────────────────
  if (r.rsi < 30) { s += 4; tags.push('RSI Asiri Satim'); }
  else if (r.rsi < 40 && r.change > 0) { s += 3; tags.push('Dipten Donus'); }
  else if (r.rsi > 40 && r.rsi < 65) s += 1;
  else if (r.rsi > 78) s -= 2;

  // ── I. Advanced Pattern Signals — max 8 pts ──────────────────────────────
  if (r.obvDivergence === 'bullish_div') { s += 3; tags.push('OBV Bullish Div'); }
  else if (r.obvDivergence === 'bearish_div') s -= 3;

  if (r.rsiDivergence === 'bullish') { s += 2; tags.push('RSI Diverjans'); }
  else if (r.rsiDivergence === 'bearish') s -= 2;

  if (r.wyckoffSpring === 'spring') { s += 3; tags.push('Wyckoff Spring'); }
  else if (r.wyckoffSpring === 'utad') s -= 3;

  if (r.volumeClimax === 'selling_climax') { s += 2; tags.push('Satis Klimaksi'); }
  else if (r.volumeClimax === 'buying_climax') s -= 2;

  if (r.ttmSqueeze?.firing && r.ttmSqueeze?.momentum > 0) { s += 2; tags.push('Squeeze Atis'); }

  // ── J. Market Alignment — max 2 pts ─────────────────────────────────────
  if (marketInfo.trend === 'bullish' && r.cls === 'buy') { s += 2; tags.push('Piyasa Uyumlu'); }
  if (marketInfo.trend === 'bearish' && r.cls !== 'sell') s -= 2;

  // ── K. Session quality modifier ──────────────────────────────────────────
  if (session?.code === 'MORNING' || session?.code === 'AFTERNOON') {
    if (r.volRate?.onPace || r.int15mMacdBull) s += 1;
  }
  if (session?.code === 'OPEN') {
    // Opening: only trust very strong setups
    if (!r.orbData?.formed) s -= 2;
  }
  if (session?.code === 'LUNCH') s -= 1;

  // ── L. R/R Quality ────────────────────────────────────────────────────────
  const rr = r.intRR || r.rr || 0;
  if (rr >= 2.5) { s += 3; tags.push('Mukemmel R/O'); }
  else if (rr >= 1.8) { s += 2; tags.push('Iyi R/O'); }
  else if (rr >= 1.2) s += 1;
  else s -= 2;

  // Confidence calc: normalize to 0-100
  const maxPossible = 65;
  const confidence = Math.min(97, Math.max(5, Math.round(50 + (s / maxPossible) * 50)));

  return { intScore: s, confidence, tags };
}

// ── Main component ─────────────────────────────────────────────────────────
export default function TradesTab({ addToPortfolio, portfolio, signalTracker, advisorData, onScanComplete }) {
  const [results, setResults] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: 'Bekleniyor...' });
  const [listType, setListType] = useState('bist30');
  const [marketCondition, setMarketCondition] = useState(null);
  const [scanComplete, setScanComplete] = useState(false);
  const [expandedCard, setExpandedCard] = useState(null);
  const [useAdvisorCache, setUseAdvisorCache] = useState(true);
  const [filterTab, setFilterTab] = useState('all');
  const [autoScanPending, setAutoScanPending] = useState(false);
  const generateRef = useRef(null);

  const phase = getSessionPhase();
  const sessionMeta = SESSION_TIPS[phase.code] || SESSION_TIPS.POST;

  // Auto-scan when AI Advisor completes
  useEffect(() => {
    const handler = () => {
      if (scanComplete && !loading && useAdvisorCache) setAutoScanPending(true);
    };
    window.addEventListener('advisor-scan-complete', handler);
    return () => window.removeEventListener('advisor-scan-complete', handler);
  }, [scanComplete, loading, useAdvisorCache]);

  useEffect(() => {
    if (autoScanPending && !loading && generateRef.current) {
      setAutoScanPending(false);
      generateRef.current();
    }
  }, [autoScanPending, loading]);

  const generate = useCallback(async () => {
    setLoading(true);
    setResults([]); setRejected([]); setScanComplete(false); setMarketCondition(null); setExpandedCard(null);

    // ── Phase 1: Market context (BIST100 daily + weekly) ──────────────────
    let marketOk = true;
    let marketInfo = { trend: 'neutral', rsi: 50, change: 0 };
    let htfContext = null;
    let marketBars15m = null; // for Relative Strength calculation

    try {
      setProgress({ pct: 2, label: 'BIST100 piyasa durumu analiz ediliyor...' });
      const [xu100Daily, xu100Weekly, xu100_15m] = await Promise.all([
        fetchSingle('XU100', '1mo', '1d', true),
        fetchSingle('XU100', '2y', '1wk', true).catch(() => null),
        fetchSingle('XU100', '5d', '15m', true).catch(() => null),
      ]);

      if (xu100Daily?.prices?.length >= 10) {
        const mInd = calcAll(xu100Daily.prices);
        marketInfo.trend = mInd.lastClose > mInd.lastMA20 ? 'bullish' : mInd.lastClose < mInd.lastMA50 ? 'bearish' : 'neutral';
        marketInfo.rsi = mInd.lastRSI || 50;
        marketInfo.change = mInd.changePct || 0;
        marketInfo.adx = mInd.adx;
        marketInfo.obvTrend = mInd.obvTrend;
        marketInfo.ma200Above = mInd.lastMA200 ? mInd.lastClose > mInd.lastMA200 : null;
      }

      if (xu100Weekly?.prices?.length >= 20) {
        const wInd = calcAll(xu100Weekly.prices);
        marketInfo.weeklyTrend = wInd.lastClose > wInd.lastMA20 ? 'bull' : wInd.lastClose < wInd.lastMA50 ? 'bear' : 'neutral';
        marketInfo.weeklyRsi = wInd.lastRSI;
        htfContext = {
          trend: marketInfo.trend === 'bullish' ? 'bull' : marketInfo.trend === 'bearish' ? 'bear' : 'neutral',
          rsi: marketInfo.rsi, adx: marketInfo.adx, ma200Above: marketInfo.ma200Above,
          weeklyTrend: marketInfo.weeklyTrend, weeklyRsi: marketInfo.weeklyRsi,
        };
      }

      // Keep market 15m bars for RS calculation
      if (xu100_15m?.prices?.length >= 10) marketBars15m = xu100_15m.prices;

      // Market gate
      if (marketInfo.trend === 'bearish' && marketInfo.rsi < 35 && marketInfo.change < -2) marketOk = false;
      if (marketInfo.weeklyTrend === 'bear' && marketInfo.trend === 'bearish' && (marketInfo.weeklyRsi ?? 50) < 40) marketOk = false;
    } catch {}
    setMarketCondition(marketInfo);

    // ── Phase 2: Daily scan of all stocks ─────────────────────────────────
    const stocks = getStockList(listType);
    const total = stocks.length;
    const all = [];
    const CHUNK = 12;

    for (let i = 0; i < stocks.length; i += CHUNK) {
      const chunk = stocks.slice(i, i + CHUNK);
      const chunkRes = await Promise.all(chunk.map(async (sym) => {
        try {
          const daily = await fetchSingle(sym, '3mo', '1d', true);
          if (!daily?.prices || daily.prices.length < 20) return null;

          const ind = calcAll(daily.prices);
          const sig = genSignal(ind, daily.prices, { htfContext });
          const macdHist = ind.macd?.histogram?.slice(-1)[0] ?? 0;
          const prevMacdHist = ind.macd?.histogram?.slice(-2, -1)[0] ?? 0;

          // Daily average volume for volume rate calculation
          const avgDailyVol = daily.prices.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;

          return {
            symbol: sym,
            price: ind.lastClose, change: ind.changePct,
            signal: sig.signal, cls: sig.cls, score: sig.score, conf: sig.conf,
            rsi: ind.lastRSI, rr: sig.rr, entry: sig.entry, stop: sig.stop,
            target: sig.t1, t2: sig.t2,
            mfi: ind.mfi, obvTrend: ind.obvTrend, cmf: ind.cmf,
            volRatio: ind.volRatio, sector: SECTORS[sym] || 'Diger',
            dailyRange: sig.dailyRange || 0,
            adx: ind.adx, wyckoff: ind.wyckoffPhase,
            macdHist, prevMacdHist, macdAccel: macdHist > 0 && macdHist > prevMacdHist,
            bollPct: sig.bollPct,
            stochK: ind.stochRSI?.k?.slice(-1)[0] ?? null,
            ttmSqueeze: ind.ttmSqueeze, candlePatterns: ind.candlePatterns,
            reasons: sig.reasons,
            obvDivergence: ind.obvDivergence, rsiDivergence: ind.rsiDivergence,
            wyckoffSpring: ind.wyckoffSpring, volumeClimax: ind.volumeClimax,
            diConvergence: ind.diConvergence,
            nearSupport: ind.sr?.filter(s => s.type === 'support' && s.price < ind.lastClose).sort((a, b) => b.price - a.price)[0]?.price,
            nearResistance: ind.sr?.filter(s => s.type === 'resistance' && s.price > ind.lastClose).sort((a, b) => a.price - b.price)[0]?.price,
            longTermView: sig.longTermView, rrQuality: sig.rrQuality,
            advisorScore: advisorData?.scanResults?.find(r => r.symbol === sym)?.score ?? 0,
            avgDailyVol,
            // Intraday fields — filled in Phase 3
            intMomentumScore: null, intVwapZone: null, int15mRsi: null,
            int15mMacdBull: null, int15mMacdAccel: null,
            orbData: null, rsData: null, volRate: null,
            intStop: null, intTarget: null, intRR: 0,
            intVwap: null, intVwap1sH: null, intVwap1sL: null,
            playType: 'none', intraday15mLoaded: false,
          };
        } catch { return null; }
      }));
      chunkRes.forEach(r => { if (r) all.push(r); });
      setProgress({
        pct: 5 + Math.floor(((i + CHUNK) / stocks.length) * 50),
        label: `Gunluk tarama (${Math.min(i + CHUNK, stocks.length)}/${stocks.length})...`,
      });
      await new Promise(r => setTimeout(r, 200));
    }

    // ── Phase 3: Pre-score with daily to find top 15 candidates ───────────
    setProgress({ pct: 58, label: '15 dakikalik intraday veri yukleniyor...' });

    const preScored = all
      .filter(r => r.cls !== 'sell' && r.dailyRange > 0.8)
      .map(r => {
        let ps = 0;
        if (r.cls === 'buy' && r.score >= 60) ps += 8;
        else if (r.cls === 'buy') ps += 3;
        if (r.obvTrend === 'accumulation') ps += 4;
        if (r.rsi < 40) ps += 3;
        if (r.volRatio > 1.5) ps += 3;
        if (r.cmf > 0.1) ps += 2;
        if (r.wyckoffSpring === 'spring') ps += 4;
        if (r.ttmSqueeze?.firing && r.ttmSqueeze?.momentum > 0) ps += 3;
        if (r.obvDivergence === 'bullish_div') ps += 3;
        if (r.dailyRange > 2.5) ps += 2;
        return { ...r, _preScore: ps };
      })
      .sort((a, b) => b._preScore - a._preScore);

    // Top 16 get 15m data; rest get daily-only analysis
    const top16 = preScored.slice(0, 16);
    const rest = preScored.slice(16);

    // ── Phase 4: Fetch 15m bars for top candidates in parallel ────────────
    const enhanced = await Promise.all(top16.map(async (r) => {
      try {
        const data15m = await fetchSingle(r.symbol, '5d', '15m', true);
        if (!data15m?.prices || data15m.prices.length < 10) return r;

        const bars = data15m.prices;
        const vwap = computeVWAP(bars);
        const orb = computeORB(bars, 30);
        const momentum = intradayMomentumScore(bars, vwap);
        const rs = marketBars15m ? computeRS(bars, marketBars15m) : null;
        const volR = volumeRate(bars, r.avgDailyVol);
        const levels = calcIntradayStructureLevels(bars, vwap, orb, r.cls === 'buy' ? 'buy' : 'sell');

        return {
          ...r,
          intMomentumScore: momentum.score,
          intVwapZone: momentum.vwapZone,
          int15mRsi: momentum.rsi,
          int15mMacdBull: momentum.macdBull,
          int15mMacdAccel: momentum.macdAccel,
          int15mTrend: momentum.trend,
          int15mVwapDist: momentum.vwapDistance,
          orbData: orb,
          rsData: rs,
          volRate: volR,
          volSurge: volR?.surge || false,
          intStop: levels.stop,
          intTarget: levels.target,
          intRR: levels.rr,
          intVwap: levels.vwap,
          intVwap1sH: levels.vwap1sHigh,
          intVwap1sL: levels.vwap1sLow,
          intraday15mLoaded: true,
        };
      } catch { return r; }
    }));

    setProgress({ pct: 82, label: 'Intraday skorlama hesaplaniyor...' });

    // ── Phase 5: Full scoring ─────────────────────────────────────────────
    const allCandidates = [...enhanced, ...rest];
    const scored = allCandidates.map(r => {
      // Classify play type after intraday data
      const playType = classifyIntradayPlay(
        { momentum: { vwapZone: r.intVwapZone, trend: r.int15mTrend, rsi: r.int15mRsi, macdBull: r.int15mMacdBull, macdAccel: r.int15mMacdAccel },
          orb: r.orbData, rs: r.rsData },
        r
      );
      const rWithPlay = { ...r, playType };
      const { intScore, confidence, tags } = scoreIntradayOpportunity(rWithPlay, marketInfo, phase);
      const strategyNotes = buildStrategyNote({ ...rWithPlay, intScore, tags }, phase);

      // Use intraday levels if available, fall back to daily signal levels
      const stopFinal = rWithPlay.intStop || rWithPlay.stop;
      const targetFinal = rWithPlay.intTarget || rWithPlay.target;
      const rrFinal = rWithPlay.intRR || rWithPlay.rr || 0;

      return { ...rWithPlay, intScore, confidence, tags, strategyNotes, playType, stopFinal, targetFinal, rrFinal };
    }).sort((a, b) => b.intScore - a.intScore);

    // ── Phase 6: Filter and enrich top winners ─────────────────────────────
    setProgress({ pct: 88, label: 'Bilanco verisi yukleniyor...' });

    const MIN_SCORE = 7;
    const winners = scored.filter(r => r.intScore >= MIN_SCORE && r.cls !== 'sell');
    const nearMiss = scored.filter(r => r.intScore >= 3 && r.intScore < MIN_SCORE && r.cls !== 'sell').slice(0, 6);

    const topWinners = marketOk ? winners.slice(0, 10) : [];
    const enriched = await Promise.all(topWinners.map(async (r) => {
      try {
        const finData = await fetchIsYatirimFinancials(r.symbol);
        if (finData?.ratios) {
          const fundScore = scoreIsYatirimFundamentals(finData);
          const grade = fundScore ? getFundamentalGrade(fundScore.score) : null;
          return { ...r, fundScore: fundScore?.score ?? null, fundGrade: grade?.label ?? null,
            fundGradeColor: grade?.color ?? null, fundPoints: fundScore?.points ?? [], fundRatios: finData.ratios };
        }
      } catch {}
      return { ...r, fundScore: null, fundGrade: null };
    }));

    setProgress({ pct: 98, label: 'Sonuclar hazirlanıyor...' });

    if (!marketOk) {
      setResults([]);
      setRejected(nearMiss);
    } else {
      setResults(enriched);
      setRejected(nearMiss);

      // Record to signal tracker
      if (signalTracker?.recordSignal) {
        for (const r of enriched) {
          signalTracker.recordSignal({
            symbol: r.symbol, cls: r.cls || 'buy', signal: r.signal,
            score: r.intScore, conf: r.confidence, price: r.price,
            entry: r.price, stop: r.stopFinal, target: r.targetFinal, rr: r.rrFinal,
            source: 'intraday', sector: r.sector,
          });
        }
      }
    }

    setScanComplete(true);
    setLoading(false);

    const scanData = {
      results: marketOk ? enriched : [],
      rejected: nearMiss,
      marketCondition: marketInfo,
      listType,
      timestamp: new Date().toISOString(),
      isEod: !isMarketOpen(),
    };
    window.dispatchEvent(new CustomEvent('trades-scan-complete', { detail: scanData }));
    if (onScanComplete) onScanComplete(scanData);
  }, [listType, phase, advisorData, useAdvisorCache, onScanComplete]);

  useEffect(() => { generateRef.current = generate; }, [generate]);

  // Filter results by play type tab
  const filteredResults = results.filter(r => {
    if (filterTab === 'all') return true;
    if (filterTab === 'momentum') return r.playType === 'momentum';
    if (filterTab === 'orb') return r.playType === 'orb_breakout';
    if (filterTab === 'vwap') return r.playType === 'vwap_reclaim' || r.playType === 'dip_bounce';
    if (filterTab === 'squeeze') return r.playType === 'squeeze';
    return true;
  });

  // Count plays
  const playCounts = results.reduce((acc, r) => {
    acc[r.playType] = (acc[r.playType] || 0) + 1;
    return acc;
  }, {});

  const today = new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="scanner-wrap">
      {/* Session Banner */}
      <div style={{
        padding: '12px 18px', borderRadius: 12, marginBottom: 14,
        background: sessionMeta.bg,
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <span style={{ fontSize: 22 }}>{sessionMeta.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {phase.label}
            <span style={{
              fontSize: 8, padding: '1px 6px', borderRadius: 10, fontWeight: 700,
              background: phase.edge === 'high' ? 'var(--cyan)' : phase.edge === 'normal' ? 'var(--green)' : phase.edge === 'low' ? 'var(--orange)' : 'var(--bg3)',
              color: phase.edge !== 'none' ? '#000' : 'var(--t3)',
            }}>
              {phase.edge === 'high' ? 'YUKSEK EDGE' : phase.edge === 'normal' ? 'NORMAL EDGE' : phase.edge === 'low' ? 'DUSUK EDGE' : 'KAPALI'}
            </span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--t3)', lineHeight: 1.4, marginTop: 2 }}>{sessionMeta.tip}</div>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--cyan)', fontFamily: 'Space Grotesk,sans-serif' }}>
          {new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          className="scan-btn go"
          onClick={generate}
          disabled={loading}
          style={{ background: 'linear-gradient(135deg, var(--blue), var(--purple))', color: '#fff' }}
        >
          {loading ? '★ TARANIYOR...' : '★ PROFESYONEL INTRADAY ANALIZ'}
        </button>
        <select className="inp" value={listType} onChange={e => setListType(e.target.value)} style={{ width: 'auto', padding: '8px 28px 8px 10px' }}>
          <option value="bist30">BIST 30</option>
          <option value="bist50">BIST 50</option>
          <option value="bist100">BIST 100</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)', cursor: 'pointer' }}>
          <input type="checkbox" checked={useAdvisorCache} onChange={e => setUseAdvisorCache(e.target.checked)} style={{ accentColor: 'var(--cyan)' }} />
          AI Advisor Senkron
          {advisorData?.scanResults?.length > 0 && (
            <span style={{ color: 'var(--green)', fontSize: 8, fontWeight: 700 }}>({advisorData.scanResults.length})</span>
          )}
        </label>
      </div>

      {/* AI Advisor banner */}
      {advisorData?.marketSentiment && !scanComplete && !loading && (
        <div style={{ padding: '7px 14px', borderRadius: 6, marginBottom: 12, background: 'rgba(0,229,255,.04)', border: '1px solid rgba(0,229,255,.1)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cyan)', boxShadow: '0 0 4px var(--cyan)' }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--cyan)' }}>AI ADVISOR AKTIF</span>
          <span style={{ fontSize: 9, color: advisorData.marketSentiment.color, fontWeight: 600 }}>{advisorData.marketSentiment.sentiment}</span>
          <span style={{ fontSize: 9, color: 'var(--t3)', marginLeft: 'auto' }}>
            {advisorData.marketSentiment.buys} AL / {advisorData.marketSentiment.sells} SAT &nbsp;
            {advisorData.topPicks?.length > 0 && <span style={{ color: 'var(--yellow)' }}>Top: {advisorData.topPicks.slice(0, 3).map(p => p.symbol).join(', ')}</span>}
          </span>
        </div>
      )}

      {/* Progress */}
      {loading && (
        <div className="scan-progress visible" style={{ marginBottom: 12 }}>
          <div className="sp-text"><span>{progress.label}</span><span>{progress.pct}%</span></div>
          <div className="sp-bar"><div className="sp-fill" style={{ width: progress.pct + '%' }} /></div>
        </div>
      )}

      {/* Empty state */}
      {!scanComplete && !loading && (
        <div className="scan-empty">
          <div style={{ fontSize: 14, color: 'var(--yellow)', marginBottom: 6 }}>
            {isMarketOpen() ? 'Profesyonel Intraday Tarama' : 'EOD — Yarinin Firsatlari'}
          </div>
          <div>Cok katmanli analiz: 15dk VWAP + ORB Kirilimlari + Relative Strength + Kurumsal Akis</div>
          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 6 }}>
            Sistem: VWAP Bantlari · Acilis Araligi · 15dk Momentum · RS vs BIST100 · Hacim Hizi · Wyckoff · Diverjans
          </div>
        </div>
      )}

      {/* Results */}
      {scanComplete && !loading && (
        <div>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: 20, fontWeight: 700, color: 'var(--yellow)' }}>
              {'★'} {isMarketOpen() ? 'Gunluk Trade Firsatlari (Intraday)' : 'Yarinin Firsatlari (EOD)'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 3 }}>{today}</div>
          </div>

          {/* Market condition banner */}
          {marketCondition && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 14,
              background: 'var(--bg1)',
              borderLeft: '3px solid ' + (marketCondition.trend === 'bullish' ? 'var(--green)' : marketCondition.trend === 'bearish' ? 'var(--red)' : 'var(--yellow)'),
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{marketCondition.trend === 'bullish' ? '\u{1F7E2}' : marketCondition.trend === 'bearish' ? '\u{1F534}' : '\u{1F7E1}'}</span>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t1)' }}>
                    BIST100: {marketCondition.trend === 'bullish' ? 'Yukselis' : marketCondition.trend === 'bearish' ? 'Dusus — Dikkatli' : 'Yatay'}
                    {' '}&nbsp;
                    <span style={{ fontWeight: 400, color: 'var(--t3)' }}>RSI {marketCondition.rsi?.toFixed(0)} | {marketCondition.change >= 0 ? '+' : ''}{marketCondition.change?.toFixed(2)}%</span>
                  </div>
                  {marketCondition.weeklyTrend && (
                    <div style={{ fontSize: 9, color: marketCondition.weeklyTrend === 'bull' ? 'var(--green)' : marketCondition.weeklyTrend === 'bear' ? 'var(--red)' : 'var(--yellow)', fontWeight: 600, marginTop: 1 }}>
                      Haftalik: {marketCondition.weeklyTrend === 'bull' ? 'YUKSELIS' : marketCondition.weeklyTrend === 'bear' ? 'DUSUS' : 'YATAY'}
                      {marketCondition.weeklyRsi ? ` (RSI ${marketCondition.weeklyRsi.toFixed(0)})` : ''}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Play-type filter tabs */}
          {results.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {[
                { key: 'all', label: `Tumu (${results.length})`, color: 'var(--cyan)' },
                { key: 'momentum', label: `Momentum (${playCounts.momentum || 0})`, color: 'var(--cyan)' },
                { key: 'orb', label: `ORB (${playCounts.orb_breakout || 0})`, color: 'var(--yellow)' },
                { key: 'vwap', label: `VWAP (${(playCounts.vwap_reclaim || 0) + (playCounts.dip_bounce || 0)})`, color: 'var(--green)' },
                { key: 'squeeze', label: `Squeeze (${playCounts.squeeze || 0})`, color: 'var(--orange)' },
              ].map(({ key, label, color }) => (
                <button key={key} onClick={() => setFilterTab(key)} style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 9, fontWeight: 700, cursor: 'pointer',
                  background: filterTab === key ? color : 'var(--bg3)',
                  color: filterTab === key ? '#000' : 'var(--t3)',
                  border: `1px solid ${filterTab === key ? color : 'var(--border)'}`,
                  fontFamily: 'inherit',
                }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* No results */}
          {results.length === 0 && (
            <div style={{ padding: '30px 20px', textAlign: 'center', borderRadius: 10, background: 'linear-gradient(135deg,rgba(139,92,246,.06),rgba(59,130,246,.04))', border: '1px solid rgba(139,92,246,.15)', marginBottom: 16 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>{'\u{1F6E1}️'}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>
                {marketCondition?.trend === 'bearish' ? 'Piyasa Kosullari Uygun Degil' : 'Yuksek Guvenli Firsat Yok'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.6, maxWidth: 440, margin: '0 auto' }}>
                {marketCondition?.trend === 'bearish'
                  ? 'Piyasa guclu dusus trendinde. Sermayeni koru — kaybet­memek, kazanmanin ilk adimidir.'
                  : 'Multi-faktor sistem bugun yeterli guven esigini asan firsat bul­amadi. Dusuk guvenle girmek uzun vadede zarar.'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 12, fontWeight: 600 }}>
                &ldquo;Para kazanmanin en onemli kurali: para kaybetmemektir.&rdquo; — Warren Buffett
              </div>
            </div>
          )}

          {/* Winner cards */}
          {filteredResults.map((r, i) => (
            <TradeResultCard
              key={r.symbol}
              r={r}
              index={i}
              isExpanded={expandedCard === r.symbol}
              onToggle={() => setExpandedCard(expandedCard === r.symbol ? null : r.symbol)}
              addToPortfolio={addToPortfolio}
              portfolio={portfolio}
            />
          ))}

          {/* Near-miss */}
          {rejected.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                Esik Alti — Izleme
              </div>
              {rejected.map(r => (
                <div key={r.symbol} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '7px 12px', background: 'var(--bg3)', borderRadius: 6, marginBottom: 5,
                  border: '1px solid ' + (r.obvDivergence === 'bullish_div' ? 'rgba(171,71,188,.3)' : 'var(--border)'),
                  opacity: 0.75,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{r.symbol}</span>
                    <span style={{ fontSize: 8, color: 'var(--t3)' }}>{r.sector}</span>
                    {r.intVwapZone && r.intVwapZone !== 'unknown' && (
                      <span style={{ fontSize: 7, background: 'rgba(0,229,255,.12)', color: 'var(--cyan)', padding: '1px 4px', borderRadius: 2 }}>
                        VWAP:{r.intVwapZone.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, fontSize: 9, color: 'var(--t2)' }}>
                    <span>{r.price?.toFixed(2)} TL</span>
                    <span style={{ color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>{r.change >= 0 ? '+' : ''}{r.change?.toFixed(2)}%</span>
                    <span style={{ color: 'var(--orange)', fontWeight: 600 }}>Skor {r.intScore}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="disc" style={{ marginTop: 12, border: 'none' }}>Bu analiz yatirim tavsiyesi degildir.</div>
    </div>
  );
}

// ── Trade Result Card (memoized) ────────────────────────────────────────────
const indBox = { background: 'var(--bg0)', padding: '5px 8px', borderRadius: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const indLabel = { fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' };
const indVal = { fontSize: 11, fontWeight: 700 };

const TradeResultCard = memo(({ r, index, isExpanded, onToggle, addToPortfolio, portfolio }) => {
  const stopFinal = r.stopFinal || r.stop;
  const targetFinal = r.targetFinal || r.target;
  const rrFinal = r.rrFinal || r.rr || 0;

  const gain = targetFinal ? ((targetFinal - r.price) / r.price * 100) : 0;
  const loss = stopFinal ? ((stopFinal - r.price) / r.price * 100) : 0;
  const pos = calcPosition(10000, 1, r.price, stopFinal, { regimeMult: r._positionSizeMult ?? 1 });
  const confColor = r.confidence >= 75 ? 'var(--green)' : r.confidence >= 55 ? 'var(--yellow)' : 'var(--orange)';

  const playMeta = PLAY_TYPE_META[r.playType] || PLAY_TYPE_META.none;
  const hasDivergence = r.obvDivergence === 'bullish_div' || r.rsiDivergence === 'bullish';
  const hasSpring = r.wyckoffSpring === 'spring';
  const isLeader = r.rsData?.strongLeader;
  const orbBroke = r.orbData?.breakoutUp;

  return (
    <div style={{
      background: 'var(--bg1)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 18, marginBottom: 14,
      boxShadow: 'var(--shadow)',
      borderTop: r.playType !== 'none' ? `2px solid ${playMeta.color}` : '1px solid var(--border)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            background: confColor, color: '#000',
            fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 700,
            width: 34, height: 34, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>{index + 1}</div>
          <div>
            <div style={{ fontFamily: 'Space Grotesk', fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {r.symbol}
              {/* Play type badge */}
              {r.playType !== 'none' && (
                <span style={{ fontSize: 8, background: playMeta.color, color: '#000', padding: '1px 6px', borderRadius: 3, fontWeight: 800 }}>
                  {playMeta.icon} {playMeta.label}
                </span>
              )}
              {hasDivergence && <span style={{ fontSize: 7, background: 'var(--purple)', color: '#fff', padding: '1px 5px', borderRadius: 3 }}>DIV</span>}
              {hasSpring && <span style={{ fontSize: 7, background: '#ff6b00', color: '#fff', padding: '1px 5px', borderRadius: 3 }}>SPRING</span>}
              {isLeader && <span style={{ fontSize: 7, background: 'var(--cyan)', color: '#000', padding: '1px 5px', borderRadius: 3 }}>RS LIDER</span>}
              {orbBroke && <span style={{ fontSize: 7, background: 'var(--yellow)', color: '#000', padding: '1px 5px', borderRadius: 3 }}>ORB{'↗'}</span>}
              {r.intraday15mLoaded && <span style={{ fontSize: 7, background: 'rgba(0,229,255,.15)', color: 'var(--cyan)', padding: '1px 4px', borderRadius: 2 }}>15dk</span>}
            </div>
            <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
              {r.sector} | Vol: %{r.dailyRange.toFixed(1)}
              {r.fundGrade && <span style={{ marginLeft: 5, color: r.fundScore >= 7 ? 'var(--green)' : r.fundScore >= 5 ? 'var(--yellow)' : 'var(--orange)', fontWeight: 600 }}>| {r.fundGrade}</span>}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{r.price.toFixed(2)} TL</div>
          <div style={{ fontSize: 11, color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {r.change >= 0 ? '+' : ''}{r.change.toFixed(2)}%
          </div>
          {r.rsData?.outperformance != null && (
            <div style={{ fontSize: 9, color: r.rsData.leading ? 'var(--cyan)' : 'var(--t3)', marginTop: 2 }}>
              RS: {r.rsData.outperformance >= 0 ? '+' : ''}{r.rsData.outperformance.toFixed(1)}%
            </div>
          )}
        </div>
      </div>

      {/* Confidence bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Sistem Guveni</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: confColor }}>{r.confidence}%</span>
        </div>
        <div style={{ height: 4, background: 'var(--bg0)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: r.confidence + '%', background: confColor, borderRadius: 2, transition: 'width .5s' }} />
        </div>
      </div>

      {/* Intraday mini-metrics row */}
      {r.intraday15mLoaded && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {/* VWAP zone pill */}
          {r.intVwapZone && r.intVwapZone !== 'unknown' && (() => {
            const vz = r.intVwapZone;
            const vzColor = vz === 'above_1s' ? 'var(--cyan)' : vz === 'above' ? 'var(--green)' : vz === 'above_2s' ? 'var(--yellow)' : vz === 'below_1s' ? 'var(--purple)' : 'var(--red)';
            const vzLabel = vz === 'above_2s' ? 'VWAP+2s' : vz === 'above_1s' ? 'VWAP+1s' : vz === 'above' ? 'VWAP Ustu' : vz === 'at' ? 'VWAP At' : vz === 'below' ? 'VWAP Alti' : vz === 'below_1s' ? 'VWAP-1s' : 'VWAP-2s';
            return (
              <span style={{ fontSize: 8, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,0,0,.2)', color: vzColor, fontWeight: 700, border: `1px solid ${vzColor}44` }}>
                {vzLabel}
              </span>
            );
          })()}

          {/* ORB status pill */}
          {r.orbData?.formed && (
            <span style={{ fontSize: 8, padding: '2px 8px', borderRadius: 10,
              background: r.orbData.breakoutUp ? 'rgba(255,214,0,.15)' : r.orbData.nearBreakoutUp ? 'rgba(255,214,0,.08)' : 'rgba(0,0,0,.15)',
              color: r.orbData.breakoutUp ? 'var(--yellow)' : r.orbData.nearBreakoutUp ? 'var(--yellow)' : 'var(--t3)',
              fontWeight: 700, border: '1px solid ' + (r.orbData.breakoutUp ? 'var(--yellow)' : 'var(--border)'),
            }}>
              ORB {r.orbData.breakoutUp ? '↗ KIRILDI' : r.orbData.nearBreakoutUp ? '→ YAKLASIYOR' : `${r.orbData.low?.toFixed(2)}-${r.orbData.high?.toFixed(2)}`}
            </span>
          )}

          {/* 15m momentum pill */}
          {r.intMomentumScore != null && (
            <span style={{ fontSize: 8, padding: '2px 8px', borderRadius: 10,
              background: r.intMomentumScore >= 65 ? 'rgba(0,229,255,.1)' : r.intMomentumScore <= 35 ? 'rgba(255,80,80,.1)' : 'rgba(255,255,255,.05)',
              color: r.intMomentumScore >= 65 ? 'var(--cyan)' : r.intMomentumScore <= 35 ? 'var(--red)' : 'var(--t3)',
              fontWeight: 700, border: '1px solid transparent',
            }}>
              15dk Mom {r.intMomentumScore}
            </span>
          )}

          {/* Volume rate */}
          {r.volRate?.rate != null && r.volRate.rate !== 1 && (
            <span style={{ fontSize: 8, padding: '2px 8px', borderRadius: 10,
              background: r.volRate.surge ? 'rgba(255,165,0,.15)' : r.volRate.onPace ? 'rgba(0,229,255,.08)' : 'rgba(0,0,0,.1)',
              color: r.volRate.surge ? 'var(--orange)' : r.volRate.onPace ? 'var(--cyan)' : 'var(--t3)',
              fontWeight: 700, border: '1px solid transparent',
            }}>
              Hacim {r.volRate.rate.toFixed(1)}x
            </span>
          )}
        </div>
      )}

      {/* Tags */}
      {r.tags?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
          {r.tags.slice(0, 7).map((tag, ti) => {
            const isAdv = tag.includes('Div') || tag.includes('Spring') || tag.includes('Klimaks') || tag.includes('Lider') || tag.includes('ORB');
            return (
              <span key={ti} style={{
                fontSize: 8, padding: '2px 9px', borderRadius: 14,
                background: isAdv ? 'var(--purple2)' : 'var(--blue2)',
                color: isAdv ? 'var(--purple)' : 'var(--blue)', fontWeight: 600,
              }}>{tag}</span>
            );
          })}
        </div>
      )}

      {/* Play type description */}
      {r.playType !== 'none' && playMeta.desc && (
        <div style={{ padding: '6px 10px', marginBottom: 10, borderRadius: 5, background: 'rgba(0,0,0,.15)', border: `1px solid ${playMeta.color}22`, fontSize: 9, color: 'var(--t2)' }}>
          <span style={{ fontWeight: 700, color: playMeta.color }}>Play: </span>{playMeta.desc}
        </div>
      )}

      {/* Strategy notes */}
      {r.strategyNotes?.length > 0 && (
        <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 6, background: 'rgba(255,214,0,.04)', border: '1px solid rgba(255,214,0,.12)' }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--yellow)', marginBottom: 4 }}>STRATEJI NOTU</div>
          {r.strategyNotes.map((n, ni) => (
            <div key={ni} style={{ fontSize: 9, color: 'var(--t2)', lineHeight: 1.5 }}>{n}</div>
          ))}
        </div>
      )}

      {/* Price levels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(90px,1fr))', gap: 7, marginBottom: 10 }}>
        <div style={{ background: 'var(--bg0)', padding: 9, borderRadius: 5, borderLeft: '3px solid var(--blue)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' }}>Giris</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--blue)' }}>{r.price.toFixed(2)}</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 9, borderRadius: 5, borderLeft: '3px solid var(--red)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' }}>Stop</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>{stopFinal?.toFixed(2) || '-'}</div>
          <div style={{ fontSize: 8, color: 'var(--red)' }}>{loss.toFixed(2)}%</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 9, borderRadius: 5, borderLeft: '3px solid var(--green)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' }}>Hedef</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>{targetFinal?.toFixed(2) || '-'}</div>
          <div style={{ fontSize: 8, color: 'var(--green)' }}>+{gain.toFixed(2)}%</div>
        </div>
        <div style={{ background: 'var(--bg0)', padding: 9, borderRadius: 5, borderLeft: '3px solid var(--yellow)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', textTransform: 'uppercase' }}>R/O</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>1:{rrFinal > 0 ? rrFinal.toFixed(1) : '—'}</div>
        </div>
      </div>

      {/* VWAP levels row */}
      {r.intVwap != null && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 9, fontSize: 9, color: 'var(--t3)', flexWrap: 'wrap' }}>
          <span>VWAP: <b style={{ color: 'var(--cyan)' }}>{r.intVwap?.toFixed(2)}</b></span>
          {r.intVwap1sH && <span>VWAP+1s: <b style={{ color: 'var(--green)' }}>{r.intVwap1sH.toFixed(2)}</b></span>}
          {r.intVwap1sL && <span>VWAP-1s: <b style={{ color: 'var(--red)' }}>{r.intVwap1sL.toFixed(2)}</b></span>}
          {r.nearSupport && <span>Destek: <b style={{ color: 'var(--green)' }}>{r.nearSupport.toFixed(2)}</b></span>}
          {r.nearResistance && <span>Direnc: <b style={{ color: 'var(--red)' }}>{r.nearResistance.toFixed(2)}</b></span>}
        </div>
      )}

      {/* Expand/collapse */}
      <button onClick={onToggle} style={{
        width: '100%', padding: '5px 0', background: 'none',
        border: '1px solid var(--border)', borderRadius: 4,
        color: 'var(--t3)', fontSize: 9, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8,
      }}>
        {isExpanded ? 'Detaylari Gizle ▲' : 'Detaylari Goster ▼'}
      </button>

      {/* Expanded section */}
      {isExpanded && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {/* Indicator grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(105px,1fr))', gap: 5, marginBottom: 10 }}>
            <div style={indBox}><span style={indLabel}>RSI (gunluk)</span><span style={{ ...indVal, color: r.rsi > 70 ? 'var(--red)' : r.rsi < 30 ? 'var(--green)' : 'var(--t1)' }}>{r.rsi?.toFixed(0) || '-'}</span></div>
            {r.int15mRsi && <div style={indBox}><span style={indLabel}>RSI (15dk)</span><span style={{ ...indVal, color: r.int15mRsi > 70 ? 'var(--red)' : r.int15mRsi < 35 ? 'var(--green)' : 'var(--cyan)' }}>{r.int15mRsi}</span></div>}
            <div style={indBox}><span style={indLabel}>ADX</span><span style={{ ...indVal, color: r.adx > 25 ? 'var(--cyan)' : 'var(--t3)' }}>{r.adx?.toFixed(0) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>MFI</span><span style={{ ...indVal, color: r.mfi < 20 ? 'var(--green)' : r.mfi > 80 ? 'var(--red)' : 'var(--t1)' }}>{r.mfi?.toFixed(0) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>Hacim</span><span style={{ ...indVal, color: r.volRatio > 1.5 ? 'var(--cyan)' : 'var(--t1)' }}>{r.volRatio?.toFixed(1) || '-'}x</span></div>
            <div style={indBox}><span style={indLabel}>CMF</span><span style={{ ...indVal, color: r.cmf > 0.05 ? 'var(--green)' : r.cmf < -0.05 ? 'var(--red)' : 'var(--t1)' }}>{r.cmf?.toFixed(3) || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>OBV</span><span style={{ ...indVal, color: r.obvTrend === 'accumulation' ? 'var(--green)' : r.obvTrend === 'distribution' ? 'var(--red)' : 'var(--t3)' }}>{r.obvTrend === 'accumulation' ? 'BIRIKIM' : r.obvTrend === 'distribution' ? 'DAGITIM' : 'NOTR'}</span></div>
            <div style={indBox}><span style={indLabel}>Wyckoff</span><span style={{ ...indVal, fontSize: 9, color: r.wyckoff === 'accumulation' ? 'var(--green)' : r.wyckoff === 'distribution' ? 'var(--red)' : 'var(--t3)' }}>{r.wyckoff?.toUpperCase() || '-'}</span></div>
            <div style={indBox}><span style={indLabel}>Squeeze</span><span style={{ ...indVal, color: r.ttmSqueeze?.firing ? 'var(--yellow)' : 'var(--t3)' }}>{r.ttmSqueeze?.squeezeOn ? 'AKTIF' : r.ttmSqueeze?.firing ? 'ATIS!' : 'Pasif'}</span></div>
            {r.rsData && <div style={indBox}><span style={indLabel}>RS</span><span style={{ ...indVal, color: r.rsData.leading ? 'var(--cyan)' : r.rsData.lagging ? 'var(--red)' : 'var(--t1)' }}>{r.rsData.strongLeader ? 'GUCLU LIDER' : r.rsData.leading ? 'LIDER' : r.rsData.lagging ? 'GERİDE' : 'NOTR'}</span></div>}
          </div>

          {/* Advanced signals */}
          {(r.obvDivergence || r.rsiDivergence || r.wyckoffSpring || r.volumeClimax) && (
            <div style={{ padding: '7px 10px', background: 'rgba(171,71,188,.05)', borderRadius: 5, marginBottom: 10, border: '1px solid rgba(171,71,188,.12)' }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--purple)', marginBottom: 3 }}>ILERI SINYALLER</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 9 }}>
                {r.obvDivergence && <span style={{ color: r.obvDivergence.includes('bullish') ? 'var(--green)' : 'var(--red)' }}>OBV: {r.obvDivergence}</span>}
                {r.rsiDivergence && <span style={{ color: r.rsiDivergence === 'bullish' ? 'var(--green)' : 'var(--red)' }}>RSI div: {r.rsiDivergence}</span>}
                {r.wyckoffSpring && <span style={{ color: r.wyckoffSpring === 'spring' ? 'var(--green)' : 'var(--red)' }}>Wyckoff: {r.wyckoffSpring}</span>}
                {r.volumeClimax && <span style={{ color: r.volumeClimax.includes('selling') ? 'var(--green)' : 'var(--red)' }}>Hacim: {r.volumeClimax}</span>}
              </div>
            </div>
          )}

          {/* Fundamentals */}
          {r.fundScore != null && (
            <div style={{ padding: '8px 10px', background: 'rgba(0,229,255,.04)', borderRadius: 5, marginBottom: 10, border: '1px solid rgba(0,229,255,.1)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--cyan)' }}>BILANCO</span>
                <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 3, background: r.fundScore >= 7 ? 'var(--green)' : r.fundScore >= 5 ? 'var(--yellow)' : 'var(--red)', color: '#000' }}>
                  {r.fundGrade} ({r.fundScore?.toFixed(1)}/10)
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 4 }}>
                {r.fundRatios && Object.entries({
                  'ROE': { v: r.fundRatios.roe, u: '%', c: v => v > 15 ? 'var(--green)' : v < 5 ? 'var(--red)' : 'var(--t1)' },
                  'Net Marj': { v: r.fundRatios.netMargin, u: '%', c: v => v > 10 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--t1)' },
                  'Cari': { v: r.fundRatios.currentRatio, u: '', c: v => v >= 1.5 ? 'var(--green)' : v < 1 ? 'var(--red)' : 'var(--yellow)' },
                  'Borc/Oz': { v: r.fundRatios.debtToEquity, u: '', c: v => v < 1 ? 'var(--green)' : v > 2 ? 'var(--red)' : 'var(--yellow)' },
                }).map(([lbl, cfg]) => cfg.v != null && (
                  <div key={lbl} style={indBox}><span style={indLabel}>{lbl}</span><span style={{ ...indVal, fontSize: 10, color: cfg.c(cfg.v) }}>{cfg.v.toFixed(cfg.u ? 1 : 2)}{cfg.u}</span></div>
                ))}
              </div>
            </div>
          )}

          {/* Signal details */}
          <div style={{ fontSize: 9, color: 'var(--t3)', lineHeight: 1.6 }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--t2)', marginBottom: 3 }}>SINYAL DETAY (Skor: {r.score?.toFixed(0)}/100)</div>
            {r.reasons?.slice(0, 8).map((reason, ri) => (
              <div key={ri} style={{ color: reason.c === 'bullish' ? 'var(--green)' : reason.c === 'bearish' ? 'var(--red)' : 'var(--t3)' }}>
                {reason.c === 'bullish' ? '▲' : reason.c === 'bearish' ? '▼' : '─'} {reason.t}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Position sizing + portfolio button */}
      {pos.shares > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--t2)', marginTop: 10 }}>
          <span>10K: <b style={{ color: 'var(--cyan)' }}>{pos.shares} lot</b> | Maks kayip: <b style={{ color: 'var(--red)' }}>{pos.maxLoss.toFixed(0)} TL</b></span>
          {addToPortfolio && (() => {
            const alreadyOpen = portfolio?.positions?.some(p => p.symbol === r.symbol && p.status === 'open');
            const pfPos = calcPosition(portfolio?.cash || 10000, 2, r.price, stopFinal, { regimeMult: r._positionSizeMult ?? 1 });
            if (alreadyOpen) return <span style={{ color: 'var(--yellow)', fontSize: 9 }}>Portfoyde acik</span>;
            if (pfPos.shares <= 0) return <span style={{ color: 'var(--red)', fontSize: 9 }}>Yetersiz nakit</span>;
            return (
              <button className="scan-btn go" style={{ fontSize: 9, padding: '3px 10px' }}
                onClick={() => addToPortfolio(r.symbol, r.price, stopFinal, targetFinal, pfPos.shares)}>
                + PORTFOYE EKLE
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
});
