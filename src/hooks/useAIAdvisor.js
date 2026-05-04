import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle, fetchBigParaBatchPrices, clearCache as clearFetchCache } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal, extractFiredSignals } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList, SECTORS } from '../utils/constants.js';
import { calcSectorMetrics, rankSectors } from '../utils/sectorEngine.js';
import { fetchMarketNews, indexBySymbol } from '../utils/marketNewsEngine.js';
import { fetchInsiderBatch } from '../utils/insiderEngine.js';
import { scoreNewSignal } from '../utils/ML_BacktestEngine.js';

/**
 * isMarketOpen - Check if BIST market is currently open
 */
export function isMarketOpen() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const day = now.getDay();
  const timeMinutes = hour * 60 + minute;
  const isWeekday = day >= 1 && day <= 5;
  // BIST: 09:30-12:30 (morning session) + 14:00-17:30 (afternoon session)
  const isMorningSession = timeMinutes >= 570 && timeMinutes < 750;  // 09:30 - 12:30
  const isAfternoonSession = timeMinutes >= 840 && timeMinutes < 1050; // 14:00 - 17:30
  return isWeekday && (isMorningSession || isAfternoonSession);
}

/**
 * isMarketClosedForDay — returns true after 17:30 on a weekday,
 * meaning the session has ended and end-of-day data is final.
 */
export function isMarketClosedForDay() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return true; // weekend
  const timeMinutes = now.getHours() * 60 + now.getMinutes();
  return timeMinutes >= 1050; // past 17:30
}

const AUTO_SCAN_INTERVAL_MS = 1000 * 60 * 15; // 15-minute auto scan when market open
const SCAN_CONCURRENCY = 20;                    // parallel workers per chunk (701/20=36 chunk, was 14→51 chunk)
const CHUNK_DELAY_MS = 60;                      // 60ms inter-chunk delay (was 150ms — 51×90ms=4.6s tasarruf)
const SCAN_UNIVERSE = 'bistall';                // full universe ~648 symbols

// ── Tomorrow Potential Score: rank stocks by next-day opportunity ──
// Pure function — no React state dependency, safe to define at module level
// ══════════════════════════════════════════════════════════════════════
// calcTomorrowPotential — kapanis sonrasi "yarin +5%" olasiligini olcer.
// 3 ana setup tipi:
//   A) DIP BOUNCE: oversold (RSI<35, BB alt, Williams<-80) + hacim artisi
//   B) COIL BREAK: TTM Squeeze + daralan ATR + kirilim oncesi birikim
//   C) CATALYST: fund_inflow/buyback/insider_buy haberi + teknik destek
// Anti-pump: son 2 gunde >+7% yapmis hisseler agir ceza alir.
// Gunluk aralik kucukse (<2.5%) skor kucuktulur — %5 cikamaz zaten.
// ══════════════════════════════════════════════════════════════════════

/**
 * calcContinuationProbability — Tavan (+%10) veya yuksek pump yapan hissenin
 * ertesi gun devam etme olasiligi (%).
 *
 * BIST base rate: ~%30-35 devam, ~%55-60 geri cekilme, ~%10 yatay.
 * Kataliz sinyaller bu tabanı yukari/asagi iter.
 * Donus degeri: null (tavan degil) | 5-55 (yuzde olasılık).
 *
 * Kullanim:
 *   - UI'da kart rozeti: "⚡%37 DEVAM" (> 35% yesil, 25-35% sari, < 25% kirmizi)
 *   - Siralama: tavan hisseler bu olasilikla kendi icinde sort edilir
 *   - Non-tavan picks her zaman tavan picks'in ONUNDE gelir
 */
function calcContinuationProbability(r) {
  if (!r) return null;
  // Ground truth: BigPara live'a dayanan todayPumpReal en guvenilir
  const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
  if (rp < 7) return null; // Sadece yuksek pump (>%7) icin hesapla

  let prob = 30; // BIST tavan sonrasi devam base rate

  // ── HABER KATALİZİ — en guclu devam sinyali ──
  const strongCatalyst = r.newsCategories?.some(c =>
    ['insider_buy', 'buyback', 'fund_inflow', 'contract'].includes(c));
  const weakCatalyst = r.newsCategories?.some(c =>
    ['upgrade', 'dividend', 'sector_bull', 'fundamental_rank'].includes(c));
  if (strongCatalyst) prob += 18;      // Iceriden alim / geri alim / kontrat = devam guclu
  else if (weakCatalyst && (r.newsScore || 0) > 2) prob += 8;
  else if (!r.newsCategories?.length) prob -= 5; // Haber yok = FOMO pump riski

  // ── OBV — akilli para iceride mi? ──
  if (r.obvTrend === 'accumulation') prob += 12;
  else if (r.obvTrend === 'distribution') prob -= 14; // Akilli para cikiyor = kisa sure devam eder sonra duser

  // ── CMF — para akisi guclu mu? ──
  const cmf = r.cmf || 0;
  if (cmf > 0.20) prob += 9;
  else if (cmf > 0.12) prob += 5;
  else if (cmf < -0.05) prob -= 9;

  // ── WYCKOFF FAZ ──
  if (r.wyckoffPhase === 'Markup') prob += 7;       // Markup fazdaysa devam
  else if (r.wyckoffPhase === 'Distribution') prob -= 11;
  if (r.wyckoffSpring) prob += 4;

  // ── TTM SQUEEZE RELEASE — kirilim enerjisi hala aktif ──
  if (r.ttmSqueeze?.squeezeRelease) prob += 7;
  if (r.ttmSqueeze?.squeezeOn) prob += 3;

  // ── MFI — asiri alim seviyesi ──
  const mfi = r.mfi || 50;
  if (mfi < 60) prob += 5;    // Asiri alim yok — devam edebilir
  else if (mfi > 82) prob -= 12; // Asiri alim = satici baskisi artar
  else if (mfi > 72) prob -= 5;

  // ── RSI — cok yuksekse BIST'te sert dusus goruluyor ──
  const rsi = r.rsi || 50;
  if (rsi > 90) prob -= 14;  // RSI 90+ = asiri uzamis momentum
  else if (rsi > 82) prob -= 6;
  else if (rsi < 68 && rp >= 9) prob += 6; // Tavan ama RSI makul = "gizli guc"

  // ── SUPERTREND & ICHIMOKU — trend konfirmasyonu ──
  if (r.supertrend?.trend === 'UP') prob += 5;
  else if (r.supertrend?.trend === 'DOWN') prob -= 9;
  if (r.ichimoku?.cloudPosition === 'above') prob += 4;

  // ── SERİ TAVAN: kumulatif pump ──
  // 2+ gun arka arkaya tavan = 3. gun ihtimali duser
  const cp = r.cumulativePump || rp;
  if (cp >= 22) prob -= 18;  // 2 gun ust uste tavan = geri cekilme neredeyse kesin
  else if (cp >= 16) prob -= 9;
  else if (cp >= 12) prob -= 4;

  // ── SEKTOR MOMENTUMU — sektor geneli yukselmede mi? ──
  const ss = r.sectorStrength || 0;
  if (ss > 2) prob += 7;    // Guclu sektor = rotasyon devam
  else if (ss < -1) prob -= 5;

  // [5, 55] araligina kilitle — BIST gercekleriyle uyumlu:
  // Max ~%55 devam olasiligi (base %30 + kataliz + teknik kombinasyonu)
  return Math.max(5, Math.min(55, Math.round(prob)));
}

function calcTomorrowPotential(result) {
  if (!result) return 0;
  let tpScore = 0;

  // ── PUMP DEĞERLENDİRMESİ — TAVAN-AWARE (v17) ──
  // BIST tavan = +%10. Tavan ertesi gun istatistik:
  //   ~%30-35 devam, ~%55-60 geri cekilme, ~%10 yatay.
  // Bu yuzden tavan bolgesinde haber katalizi VE 3+ teknik teyit zorunlu.
  // Aksi halde sistem her gun "+%10 yapan" hisseleri en ust skor olarak gosterir.
  const recentPump = result.recentPump || 0;
  const cumulativePump = result.cumulativePump || recentPump;
  const isTavan = recentPump >= 9;            // Tavan bolgesi (~+%10)
  const isExhausted = cumulativePump >= 15;   // 3 gunde +%15 = momentum yorgun

  // Guc sinyalleri (tavan bolgesinde sigir koruma kontrolu)
  const strongSignals = [
    result.obvTrend === 'accumulation',
    (result.cmf || 0) > 0.12,                       // 0.10 → 0.12 sıkılastirildi
    result.wyckoffSpring === true,
    result.ttmSqueeze?.squeezeRelease === true,
    result.newsCategories?.some(c =>
      ['fund_inflow','buyback','insider_buy','contract'].includes(c)),
  ].filter(Boolean).length;

  const hasNewsCatalyst = result.newsCategories?.some(c =>
    ['fund_inflow','buyback','insider_buy','contract'].includes(c));
  const mfiOk = (result.mfi || 50) < 65;

  if (isTavan) {
    // TAVAN BOLGESI — kataliz + 3+ teknik VE MFI sinirinda ise hafif gec
    if (strongSignals >= 3 && hasNewsCatalyst && mfiOk) tpScore -= 12;
    else if (strongSignals >= 2 && hasNewsCatalyst)     tpScore -= 25;
    else if (strongSignals >= 3)                        tpScore -= 30;
    else                                                tpScore -= 50;
  } else if (recentPump > 7) {
    // Yuksek pump (+%7 - +%9) — esik 4 sinyale sıkılastirildi
    if (strongSignals >= 4)      tpScore -= 8;
    else if (strongSignals >= 2) tpScore -= 22;
    else                         tpScore -= 35;
  } else if (recentPump > 5) {
    tpScore -= 10;
  } else if (recentPump > 3) {
    tpScore -= 3;
  }

  // Kumulatif yorgunluk: 3 gunde +%15 ustu + haber yoksa ekstra -15
  if (isExhausted && !hasNewsCatalyst) tpScore -= 15;

  // ── PRE-PUMP COIL BONUS (v18) ──
  // Patlamadan ONCE yakalamak icin: dusuk pump + akilli para birikimi +
  // dusuk volatilite (sikisma) → patlamak uzere olan hisseler.
  // Bu sayede "dun onerilseydi" senaryosu calisir.
  const isCoiling = (
    recentPump <= 2 &&                          // Henuz hareket etmemis
    cumulativePump <= 5 &&                      // 3 gun de sakin
    result.obvTrend === 'accumulation' &&       // OBV birikim
    (result.cmf || 0) > 0.05                    // Para girisi pozitif
  );
  if (isCoiling) {
    tpScore += 25;                              // BUYUK bonus — patlamak uzere
    // TTM Squeeze ek konfirmasyon
    if (result.ttmSqueeze?.squeezeOn) tpScore += 10;
    // Dar bant + birikim = en guclu coil
    if ((result.atrPct || 5) < 3) tpScore += 8;
  }
  // Volume buildup: hacim sessizce 1.3-2x kademeli artiyorsa = akilli para giriyor
  if (recentPump <= 3 && result.volRatio >= 1.3 && result.volRatio <= 2.0
      && result.obvTrend === 'accumulation') {
    tpScore += 12;
  }

  // ── GUNLUK ARALIK GATI: ATR/price < %2 ise hisse yeterince hareket etmez ──
  const atrPct = result.atrPct || 0;           // ATR / price * 100
  if (atrPct < 1.5) tpScore -= 20;            // cok dar bant
  else if (atrPct < 2.5) tpScore -= 5;
  else if (atrPct >= 3) tpScore += 8;         // genis aralik — 5% mumkun
  else if (atrPct >= 5) tpScore += 15;

  // ── DISTRIBUTION TRAP CEZASI (v21) ──
  // Fiyat yukselirken OBV dagilim + CMF negatif → yarın dusus olasiligi cok yuksek
  if (result.obvTrend === 'distribution' && (result.change || 0) > 0) {
    tpScore -= 18;
    if ((result.cmf || 0) < -0.05) tpScore -= 8; // Ek CMF negatif cezasi
  }

  // ── EXHAUSTION CEZASI (v21) ──
  // RSI yuksek + MFI yuksek + yukselis = kar realizasyonu yakın
  if ((result.rsi || 50) > 70 && (result.mfi || 50) > 65 && (result.change || 0) > 1) {
    tpScore -= 15;
  }

  // ── ZAYIF HACIM RALLISI (v21) ──
  // Yukselis + hacim dusuk = gercek talep yok
  if ((result.change || 0) > 2 && (result.volRatio || 1) < 0.9 && result.obvTrend !== 'accumulation') {
    tpScore -= 12;
  }

  // ── SETUP A — DIP BOUNCE (ortalamayi geri donusu) ──
  if (result.bollPct != null) {
    if (result.bollPct < 15) tpScore += 20;   // alt bant altinda — en guclu dip
    else if (result.bollPct < 25) tpScore += 14;
    else if (result.bollPct < 35) tpScore += 7;
    else if (result.bollPct > 85) tpScore -= 15; // ust bantta — yukari yer az (sertlestirildi)
    else if (result.bollPct > 75) tpScore -= 8;
  }
  if (result.rsi != null) {
    if (result.rsi < 25) tpScore += 18;       // asiri satim extremum
    else if (result.rsi < 32) tpScore += 12;
    else if (result.rsi < 40) tpScore += 5;
    else if (result.rsi > 80) tpScore -= 22;  // v21: sertlestirildi
    else if (result.rsi > 70) tpScore -= 12;  // v21: sertlestirildi
    else if (result.rsi > 62) tpScore -= 5;   // v21: yeni — orta-yuksek RSI de ceza
  }
  if (result.williamsR != null && result.williamsR < -80) tpScore += 8;
  if (result.mfi != null) {
    if (result.mfi < 25) tpScore += 10;       // oversold + MFI = para girisi bekle
    else if (result.mfi < 35) tpScore += 5;
    else if (result.mfi > 75) tpScore -= 8;
  }

  // ── SETUP B — COIL/SQUEEZE BREAK (kirilim oncesi birikim) ──
  if (result.ttmSqueeze?.squeezeOn) tpScore += 15; // aktif sikisma
  if (result.ttmSqueeze?.squeezeRelease) tpScore += 20; // sikismadan yeni cikis
  if (result.obvTrend === 'accumulation') tpScore += 12;
  if (result.cmf != null) {
    if (result.cmf > 0.15) tpScore += 10;
    else if (result.cmf > 0.05) tpScore += 5;
    else if (result.cmf < -0.1) tpScore -= 8;
  }
  if (result.volRatio != null) {
    if (result.volRatio > 2.5) tpScore += 10;  // hacim patlamasi
    else if (result.volRatio > 1.8) tpScore += 6;
    else if (result.volRatio > 1.3) tpScore += 3;
    else if (result.volRatio < 0.6) tpScore -= 5; // hacim kuruyor
  }

  // ── SETUP C — CATALYST BOOST (haber destekli) ──
  // Haber enricment'tan gelen veri (useAIAdvisor'da ekleniyor)
  if (result.newsScore != null) {
    const HIGH_VALUE_CATS = ['fund_inflow', 'buyback', 'insider_buy', 'contract'];
    const hasCatalyst = result.newsCategories?.some(c => HIGH_VALUE_CATS.includes(c));
    if (hasCatalyst && result.newsScore > 3) tpScore += 20; // guclu kataliz
    else if (hasCatalyst) tpScore += 10;
    else if (result.newsScore > 2) tpScore += 5;            // genel pozitif haber
    else if (result.newsScore < -3) tpScore -= 15;          // negatif haber
    if (result.newsCategories?.includes('risk')) tpScore -= 20;
    if (result.newsHighImpact > 0) tpScore += 8;
  }

  // ── INSIDER TRADING BOOST (v22) ──
  // KAP iceriden islem verisi: yonetici/ortak alimi en guclu kataliz sinyali
  if (result.insiderScore != null) {
    if (result.insiderScore >= 5) tpScore += 18;       // Coklu insider buy = cok guclu
    else if (result.insiderScore >= 3) tpScore += 10;  // Tek insider buy = guclu
    else if (result.insiderScore <= -5) tpScore -= 12; // Insider satisi = dikkat
    else if (result.insiderScore <= -3) tpScore -= 6;
  }
  if (result.hasRecentInsiderBuy) tpScore += 5; // Son 14 gunde herhangi bir insider buy
  // KAP sentiment da hesaba kat
  if (result.kapSentiment != null) {
    if (result.kapSentiment > 5) tpScore += 10;
    else if (result.kapSentiment > 2) tpScore += 5;
    else if (result.kapSentiment < -3) tpScore -= 10;
  }

  // ── TEKNIK TEYITLER ──
  if (result.ichimoku?.tkCross === 'bullish') tpScore += 10;
  if (result.ichimoku?.kumoBreakout === 'bullish') tpScore += 12;
  if (result.ichimoku?.cloudPosition === 'above') tpScore += 4;
  if (result.supertrend?.flip === 'bullish') tpScore += 12;
  if (result.supertrend?.trend === 'UP') tpScore += 4;
  if (result.wyckoffSpring) tpScore += 15;  // Wyckoff spring = en guclu dip sinyali

  // ── R/R KALITESI ──
  if (result.rr >= 3) tpScore += 12;
  else if (result.rr >= 2.5) tpScore += 8;
  else if (result.rr >= 2) tpScore += 5;
  else if (result.rr < 1.2) tpScore -= 10;

  // ── ENTRY QUALITY: MA20 yakinligi (extended trend cezasi) ──
  // Pump'tan farkli — kapanis fiyati MA20'den ne kadar uzak?
  if (result.distFromMA20 != null) {
    const dist = Math.abs(result.distFromMA20);
    if (dist < 1.5) tpScore += 8;        // MA20 etrafinda — dengeli giris
    else if (dist < 3) tpScore += 3;
    else if (dist > 7) tpScore -= 12;    // cok uzakta — chasing riski
    else if (dist > 5) tpScore -= 5;
  }

  // ── MULTI-SOURCE KONFLUENS BONUSU ──
  // Teknik + haber + akilli para hepsi ayni yone bakiyorsa ekstra guven puani
  let confluenceCount = 0;
  if (result.obvTrend === 'accumulation') confluenceCount++;
  if ((result.cmf || 0) > 0.05) confluenceCount++;
  if (result.newsScore != null && result.newsScore > 2) confluenceCount++;
  if (result.supertrend?.trend === 'UP') confluenceCount++;
  if ((result.rsi || 50) < 50 && (result.rsi || 50) > 35) confluenceCount++; // sweet spot
  if (confluenceCount >= 4) tpScore += 12;
  else if (confluenceCount >= 3) tpScore += 6;

  // NOT: result.score'u BURAYA EKLEMIYORUZ — dairesel bagimlilik olusturur.
  // Composite confidence (enhancePick) zaten genSignal skoru + tpScore'u harmanliyor.

  return Math.max(0, Math.min(100, Math.round(tpScore)));
}

// ── Sell Potential Score: rank stocks by next-day downside opportunity ──
// Mirrors calcTomorrowPotential but for bearish/short setups.
// High score = strong sell candidate (overbought + distribution + bearish tech).
function calcSellPotential(result) {
  if (!result) return 0;
  let spScore = 0;

  // ── PUMP EXHAUSTION: recent surge without fundamentals = sell setup ──
  const recentPump = result.recentPump || 0;
  if (recentPump > 7) spScore += 22;
  else if (recentPump > 5) spScore += 14;
  else if (recentPump > 3) spScore += 6;

  // ── ATR gate: need enough daily range to profit on short side ──
  const atrPct = result.atrPct || 0;
  if (atrPct < 1.5) spScore -= 20;
  else if (atrPct < 2.5) spScore -= 5;
  else if (atrPct >= 3) spScore += 8;
  else if (atrPct >= 5) spScore += 14;

  // ── OVERBOUGHT indicators ──
  if (result.rsi != null) {
    if (result.rsi > 82) spScore += 24;
    else if (result.rsi > 77) spScore += 18;
    else if (result.rsi > 72) spScore += 12;
    else if (result.rsi > 65) spScore += 6;
    else if (result.rsi < 50) spScore -= 18;
  }
  if (result.bollPct != null) {
    if (result.bollPct > 90) spScore += 20;
    else if (result.bollPct > 80) spScore += 12;
    else if (result.bollPct > 70) spScore += 5;
    else if (result.bollPct < 40) spScore -= 14;
  }
  if (result.mfi != null) {
    if (result.mfi > 80) spScore += 14;
    else if (result.mfi > 72) spScore += 8;
    else if (result.mfi < 40) spScore -= 10;
  }
  if (result.williamsR != null && result.williamsR > -15) spScore += 8; // overbought

  // ── DISTRIBUTION signals ──
  if (result.obvTrend === 'distribution') spScore += 16;
  else if (result.obvTrend === 'accumulation') spScore -= 16;
  if (result.cmf != null) {
    if (result.cmf < -0.12) spScore += 12;
    else if (result.cmf < -0.05) spScore += 6;
    else if (result.cmf > 0.1) spScore -= 10;
  }
  if (result.volRatio != null) {
    if (result.volRatio > 2.5) spScore += 6;  // high volume on down day
    else if (result.volRatio < 0.5) spScore -= 6;
  }

  // ── BEARISH technicals ──
  if (result.supertrend?.flip === 'bearish') spScore += 16;
  if (result.supertrend?.trend === 'DOWN') spScore += 10;
  if (result.ichimoku?.cloudPosition === 'below') spScore += 10;
  if (result.ichimoku?.tkCross === 'bearish') spScore += 10;
  if (result.ichimoku?.kumoBreakout === 'bearish') spScore += 12;

  // ── NEGATIVE NEWS / CATALYST ──
  if (result.newsScore != null) {
    if (result.newsCategories?.includes('risk')) spScore += 20;
    if (result.newsCategories?.includes('downgrade')) spScore += 12;
    if (result.newsScore < -3) spScore += 14;
    else if (result.newsScore < -1) spScore += 6;
    else if (result.newsScore > 3) spScore -= 14;
  }

  // ── R/R quality ──
  if (result.rr >= 3) spScore += 12;
  else if (result.rr >= 2.5) spScore += 8;
  else if (result.rr >= 2) spScore += 4;
  else if (result.rr < 1.2) spScore -= 12;

  // ── BEARISH KONFLUENS BONUSU (multi-source agreement) ──
  let bearishConfluence = 0;
  if (result.obvTrend === 'distribution') bearishConfluence++;
  if ((result.cmf || 0) < -0.05) bearishConfluence++;
  if (result.supertrend?.trend === 'DOWN') bearishConfluence++;
  if ((result.rsi || 50) > 70) bearishConfluence++;
  if (result.newsScore != null && result.newsScore < -2) bearishConfluence++;
  if (bearishConfluence >= 4) spScore += 12;
  else if (bearishConfluence >= 3) spScore += 6;

  // NOT: result.score'u burada eklemiyoruz (dairesel bagimlilik onlenir).

  return Math.max(0, Math.min(100, Math.round(spScore)));
}

/**
 * useAIAdvisor - manages AI scanning, top picks, sector rotation, risk alerts.
 * Dispatches window 'advisor-scan-complete' on each full scan.
 */
export function useAIAdvisor(portfolio) {
  const [topPicks, setTopPicks] = useState([]);
  const [scanResults, setScanResults] = useState([]);
  const [riskAlerts, setRiskAlerts] = useState([]);
  const [marketSentiment, setMarketSentiment] = useState(null);
  const [globalMarket, setGlobalMarket] = useState([]);
  const [advisorLog, setAdvisorLog] = useState([]);
  const [sectorHeatmap, setSectorHeatmap] = useState({});
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [lastUpdate, setLastUpdate] = useState(null);
  const runningRef = useRef(false);

  const pushLog = useCallback((entry) => {
    setAdvisorLog(prev => [{ time: new Date(), ...entry }, ...prev].slice(0, 100));
  }, []);

  // ── Portfolio-level risk alerts ──
  useEffect(() => {
    if (!portfolio?.positions) { setRiskAlerts([]); return; }
    const alerts = [];
    const open = portfolio.positions.filter(p => p.status === 'open');
    const totalValue = open.reduce((s, p) => s + (p.entryPrice || 0) * (p.quantity || 0), 0);

    // Single-position concentration
    for (const p of open) {
      const val = (p.entryPrice || 0) * (p.quantity || 0);
      if (totalValue > 0 && val / totalValue > 0.3) {
        alerts.push({ type: 'warn', msg: `${p.symbol} portfoyun %${((val / totalValue) * 100).toFixed(0)}'i — asiri yogunluk` });
      }
    }

    // Sector concentration
    const sectorVal = {};
    for (const p of open) {
      const sec = SECTORS[p.symbol] || 'Diger';
      sectorVal[sec] = (sectorVal[sec] || 0) + (p.entryPrice || 0) * (p.quantity || 0);
    }
    for (const [sec, v] of Object.entries(sectorVal)) {
      if (totalValue > 0 && v / totalValue > 0.4) {
        alerts.push({ type: 'warn', msg: `${sec} sektorunde %${((v / totalValue) * 100).toFixed(0)} yogunluk` });
      }
    }

    // Cash-level advice
    if (portfolio.cash != null && portfolio.cash < 0) {
      alerts.push({ type: 'err', msg: 'Nakit bakiye eksi — marjin riski' });
    }
    setRiskAlerts(alerts);
  }, [portfolio]);

  // ── Core scan implementation ──
  const runScan = useCallback(async (opts = {}) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setScanning(true);
    pushLog({ type: 'info', msg: 'AI taramasi baslatildi' });

    try {
      const symbols = getStockList(opts.universe || SCAN_UNIVERSE);
      setScanProgress({ done: 0, total: symbols.length });

      // ── FRESH SCAN GUARD (v18) ──
      // Her tarama tamamen guncel veri ile calismali. L1 cache (memory) + L2 cache
      // (localStorage) bayat veri sunabilir. Manuel scan veya 30 dk uzeri otomatik
      // scan'da cache'i pasla — kullanici "yenile" dediginde 15dk eski veri istemez.
      const forceFresh = opts.forceFresh !== false;  // default true
      if (forceFresh) {
        try { clearFetchCache(); } catch {}
      }

      // ── BATCH LIVE OVERLAY (v18) ──
      // Tek BigPara cagrisinda TUM BIST hisselerinin canli fiyatini al.
      // Eski: 648 sembol × ~400ms per-symbol overlay = ~4 dakika ekstra
      // Yeni: 1 batch call (~1-2s) → tum scan boyunca paylasilir
      // Best-effort: hata olursa scan historical close fiyatlariyla devam eder.
      let livePriceMap = {};
      try {
        livePriceMap = await fetchBigParaBatchPrices();
      } catch { /* non-fatal */ }

      const results = [];
      let done = 0;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Per-sembol hard timeout — tek yavaş sembol tüm chunk'ı bekletmesin.
      // fetchSingle zaten 10s ceiling'e sahip ama timeout kapısı dışarıdan daha güvenli.
      const withSymTimeout = (fn, ms = 11000) =>
        Promise.race([fn(), new Promise(r => setTimeout(() => r(null), ms))]);

      // Chunk-based scanning (matches original .exe behavior)
      for (let i = 0; i < symbols.length; i += SCAN_CONCURRENCY) {
        const chunk = symbols.slice(i, i + SCAN_CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(async (sym) => {
          try {
            const data = await withSymTimeout(() => fetchSingle(sym, '6mo', '1d', true));
            if (data && data.prices && data.prices.length >= 20) {
              // ── BATCH OVERLAY ──
              // Per-sembol applyLiveOverlay() yerine batch'ten gelen canli fiyati uygula.
              // BigPara batch tek cagrida tum BIST'i veriyor, ~4dk scan tasarrufu sagliyor.
              const live = livePriceMap[sym];
              if (live && live.price > 0 && data.prices.length > 0) {
                const lastBar = data.prices[data.prices.length - 1];
                if (lastBar && typeof lastBar.close === 'number') {
                  const today = new Date();
                  const lastDate = lastBar.date instanceof Date ? lastBar.date : new Date(lastBar.date);
                  const sameDay = today.toDateString() === lastDate.toDateString();
                  if (sameDay) {
                    // Same-day update: merge live close into last bar
                    lastBar.close = live.price;
                    if (live.high && live.high > lastBar.high) lastBar.high = live.high;
                    if (live.low && live.low < lastBar.low) lastBar.low = live.low;
                    if (live.volume && live.volume > 0) lastBar.volume = live.volume;
                  } else if (live.high > 0 && live.low > 0 && live.high > live.low && live.open > 0) {
                    // Newer day with real OHLC → append forming bar
                    data.prices.push({
                      date: today,
                      open: live.open,
                      high: live.high,
                      low: live.low,
                      close: live.price,
                      volume: live.volume || 0,
                      _isForming: true,
                    });
                  }
                }
              }

              // ── FORMING BAR GUARD ──
              // If the last bar is still forming (live overlay from BigPara, intraday),
              // strip it from indicator calculation — H/L are not final yet.
              // A forming bar with narrow H-L range distorts ATR and Bollinger Bands,
              // which leads to inflated signals and false buy recommendations.
              // We use the live price for display but complete bars for analysis.
              const lastRaw = data.prices[data.prices.length - 1];
              const isFormingBar = lastRaw?._isForming === true
                || (lastRaw?.high > 0 && lastRaw.high === lastRaw.low); // H=L=C zero-range
              const calcPrices = (isFormingBar && data.prices.length > 20)
                ? data.prices.slice(0, -1)
                : data.prices;

              const ind = calcAll(calcPrices);
              const sig = genSignal(ind, calcPrices);
              const last = lastRaw;
              // ── PREV BAR FIX (v19) ──
              // Forming bar varsa: calcPrices'ın SON elemanı dünkü kapanış (last completed)
              // Forming bar yoksa: calcPrices'ın SONDAN İKİNCİ'si dün
              const prev = isFormingBar
                ? calcPrices[calcPrices.length - 1]
                : calcPrices[calcPrices.length - 2] || calcPrices[calcPrices.length - 1];

              // ── BUGUNKU GERCEK PUMP — BigPara live + dunku kapanis (v19 GROUND TRUTH) ──
              // BigPara live price varsa, dunku kapanisa gore bugunki gercek pump'i hesapla.
              // Bu deger CALCPRICES/FORMING BAR HESAPLARINDAN BAGIMSIZ — direkt ground truth.
              // En guvenilir tavan tespiti: live veriyle.
              let todayPumpReal = 0;
              const yesterdayClose = isFormingBar
                ? (calcPrices[calcPrices.length - 1]?.close || 0)
                : (calcPrices[calcPrices.length - 2]?.close || 0);
              if (live && live.price > 0 && yesterdayClose > 0) {
                todayPumpReal = ((live.price - yesterdayClose) / yesterdayClose) * 100;
              }

              // Local change calculation (display)
              const localChange = prev.close
                ? ((last.close - prev.close) / prev.close) * 100
                : (ind.changePct ?? 0);
              // Display change: prefer todayPumpReal (most accurate), fall back to local
              const change = (live && live.price > 0 && yesterdayClose > 0)
                ? todayPumpReal
                : localChange;

              // ── ANTI-PUMP (v19 RE-ARCHITECTED) ──
              // recentPump = MAX(todayPumpReal, son 4 barin bar-over-bar maksimum yukselisi)
              // Boylece BUGUNKU pump kesinlikle guard'a yansir; gecmis 3 gun de korunur.
              const recentBars = calcPrices.slice(-4);
              let recentPump = todayPumpReal; // Bugunki gercek pump baz
              for (let bi = 1; bi < recentBars.length; bi++) {
                const pc = recentBars[bi - 1].close;
                if (pc > 0) {
                  const barChange = ((recentBars[bi].close - pc) / pc) * 100;
                  if (barChange > recentPump) recentPump = barChange;
                }
              }

              // Cumulative pump: 3-4 GUN ONCEDEN BUGUNE toplam yukselis (live dahil)
              let cumulativePump = todayPumpReal;
              if (calcPrices.length >= 4) {
                const startIdx = calcPrices.length - 4;
                const startBar = calcPrices[startIdx]?.close || 0;
                const endClose = (live && live.price > 0) ? live.price
                  : (isFormingBar && lastRaw ? lastRaw.close : calcPrices[calcPrices.length - 1].close);
                if (startBar > 0) {
                  cumulativePump = ((endClose - startBar) / startBar) * 100;
                }
              }

              // ATR as % of price — for daily-range gate
              const atr = ind.atr ? ind.atr : null;
              const atrPct = atr && ind.lastClose > 0 ? (atr / ind.lastClose) * 100 : 0;

              // ── LIKIDITE METRIKLERI (ranking icin kritik) ──
              // 20 TAMAMLANMIS bar ortalama hacim × kapanis fiyati = ortalama gunluk islem hacmi (TL)
              const liqBars = calcPrices.slice(-20);
              const avgVolume = liqBars.length
                ? liqBars.reduce((s, b) => s + (b.volume || 0), 0) / liqBars.length
                : 0;
              const avgVolumeTL = avgVolume * (ind.lastClose || 0);

              // ── MA20 MESAFESI (entry quality icin) ──
              // Fiyat MA20'den ne kadar uzakta? Yuksek mesafe = chasing riski.
              const distFromMA20 = ind.lastMA20 && ind.lastMA20 > 0
                ? ((ind.lastClose - ind.lastMA20) / ind.lastMA20) * 100
                : null;

              // Use genSignal's normalized score100 directly (no re-mixing)
              const finalScore = Number(sig.score) || 50;

              // ── CANLI FIYAT NORMALIZASYONU (v20) ──
              // live.price = BigPara anlık fiyat — tarama anında batch'ten alındı.
              // ind.lastClose = geçmiş bar kapanışı (Yahoo/IsYatirim, 15-30dk gecikmeli).
              //
              // Fiyat kayması olduğunda (OZSUB: 25.18→26.86 gibi) tüm seviyeleri
              // güncel fiyata göre yeniden hesapla:
              //   entry   → güncel piyasa fiyatı (gerçekçi giriş)
              //   stop    → genSignal'ın yapısal stop'u (ATR/Chandelier bazlı, değişmez)
              //   target  → genSignal'ın hedefi (Fib/direnç bazlı, değişmez)
              //   stopPct / targetPct / rr → güncel entry'den yeniden hesap
              //
              // NOT: stop ve target mutlak TL seviyeleri olduğundan aynı kalır.
              // Sadece "kaçta" olduğu değişir çünkü entry güncellenmiştir.
              const livePrice    = (live?.price && live.price > 0) ? live.price : ind.lastClose;
              const liveEntry    = livePrice; // Anlık piyasa fiyatı = gerçekçi giriş noktası
              const liveStop     = sig.stop;  // Yapısal stop (değişmez)
              const liveTarget   = sig.t1;    // Fibonacci/direnç hedef (değişmez)
              const liveStopPct  = liveStop && liveEntry > 0
                ? ((liveStop - liveEntry) / liveEntry) * 100 : 0;
              const liveTargPct  = liveTarget && liveEntry > 0
                ? ((liveTarget - liveEntry) / liveEntry) * 100 : 0;
              const riskDist     = Math.abs(liveEntry - (liveStop || liveEntry * 0.95));
              const rewardDist   = Math.abs((liveTarget || liveEntry * 1.10) - liveEntry);
              const liveRR       = riskDist > 0 ? rewardDist / riskDist : (sig.rr || 0);

              return {
                symbol: sym,
                sector: SECTORS[sym] || 'Diger',
                price:  livePrice,   // BigPara anlık (tarama anındaki gerçek fiyat)
                change: change,      // todayPumpReal veya local hesap
                volume: last.volume,
                signal: sig.signal,
                cls: sig.cls,
                score: finalScore,
                momentumScore: ind.momentumScore || 0,
                conf: Number(sig.conf) || 0,
                rsi: ind.lastRSI,
                adx: ind.adx,
                mfi: ind.mfi,
                cmf: ind.cmf,
                volRatio: ind.volRatio,
                obvTrend: ind.obvTrend,
                obvDivergence: ind.obvDivergence,
                rsiDivergence: ind.rsiDivergence,
                wyckoff: ind.wyckoffPhase,
                wyckoffSpring: ind.wyckoffSpring,
                volumeClimax: ind.volumeClimax,
                entry:     liveEntry,         // güncel piyasa fiyatı
                stop:      liveStop,           // yapısal stop (değişmez)
                target:    liveTarget,         // Fib/direnç hedef (değişmez)
                targetT2:  sig.t2,
                targetT3:  sig.t3,
                rr:        Math.round(liveRR * 10) / 10,
                rrQuality: sig.rrQuality,
                holdText:  sig.holdText,
                longTermView: sig.longTermView,
                stopPct:   Math.round(liveStopPct * 10) / 10,   // live entry'den %
                targetPct: Math.round(liveTargPct * 10) / 10,   // live entry'den %
                // Intraday momentum fields
                gapPct: ind.gapPct,
                gapUp: ind.gapUp,
                momentumIntraday: ind.momentumIntraday,
                volumeSurge: ind.volumeSurge,
                orBreakout: ind.orBreakout,
                // New world-class indicator fields
                ichimoku: ind.ichimoku ? {
                  tkCross: ind.ichimoku.tkCross,
                  kumoBreakout: ind.ichimoku.kumoBreakout,
                  kumoTwist: ind.ichimoku.kumoTwist,
                  cloudPosition: ind.ichimoku.cloudPosition,
                } : null,
                supertrend: ind.supertrend ? {
                  trend: ind.supertrend.trend,
                  flip: ind.supertrend.flip,
                  value: ind.supertrend.value,
                } : null,
                trixCrossover: ind.trix?.crossover || null,
                williamsR: ind.lastWilliamsR,
                roc10: ind.lastROC10,
                bollPct: ind.lastBU && ind.lastBL ? (ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL) * 100 : null,
                volumeProfilePOC: ind.volumeProfile?.poc || null,
                recentPump,
                cumulativePump,
                todayPumpReal,  // BigPara live'a dayanan kesin bugun pump'i
                atrPct,
                ttmSqueeze: ind.ttmSqueeze || null,
                wyckoffSpring: ind.wyckoffSpring || false,
                // ── Yeni: Ranking icin kritik metrikler ──
                avgVolume,           // 20-bar ortalama lot hacmi
                avgVolumeTL,         // TL bazinda gunluk ortalama islem hacmi
                distFromMA20,        // MA20'den % mesafe (entry quality)
                _scanTs: Date.now(), // Bu kayit ne zaman tarandi (panel yas gostergesi)
                _dataSource: data.source || 'unknown', // hangi kaynaktan geldi
                // ── Signal Attribution ──
                // Hangi teknik sinyaller bu tarama aninda atesleniyordu?
                // Paper trade/sinyal kaydi kapaninca bu liste bySignalType win-rate'ini gunceller.
                firedSignals: sig.firedSignals || extractFiredSignals(ind, calcPrices),
              };
            }
          } catch (e) {
            // swallow individual fetch errors
          }
          return null;
        }));
        chunkResults.forEach(r => { if (r) results.push(r); });
        done = Math.min(i + SCAN_CONCURRENCY, symbols.length);
        setScanProgress({ done, total: symbols.length });
        if (i + SCAN_CONCURRENCY < symbols.length) await sleep(CHUNK_DELAY_MS);
      }

      // ── Market sentiment ──
      const buys = results.filter(r => r.cls === 'buy').length;
      const sells = results.filter(r => r.cls === 'sell').length;
      const accumulations = results.filter(r => r.obvTrend === 'accumulation').length;
      const avgRSI = results.length ? results.reduce((s, r) => s + (r.rsi || 50), 0) / results.length : 50;
      const pctBull = results.length ? buys / results.length : 0.5;

      let sentiment = 'NOTR', color = 'var(--yellow)';
      if (pctBull > 0.55) { sentiment = 'YUKSELIS'; color = 'var(--green)'; }
      else if (pctBull < 0.25) { sentiment = 'DUSUS'; color = 'var(--red)'; }
      else if (pctBull < 0.35) { sentiment = 'TEMKINLI'; color = 'var(--orange)'; }

      // Sector rotation
      const sectorMetrics = calcSectorMetrics(results);
      const sectorRotation = rankSectors(sectorMetrics).slice(0, 8).map(s => ({
        sector: s.sector, avgScore: s.avgScore, total: s.scanned, strength: s.strength, rotation: s.rotation,
      }));

      const sentimentObj = {
        sentiment, color, buys, sells, scanned: results.length, avgRSI, accumulations,
        sectorRotation,
      };

      // ── Top picks — dual mode ──
      const bullishPortfolio = portfolio?.positions?.map(p => p.symbol) || [];
      const isAfterHours = opts.afterHours || !isMarketOpen();

      // Clamp stop/target to realistic daily-range levels (1.8× ATR max)
      // This prevents showing stops 10% away for a next-day trade recommendation.
      const normalizeStopTarget = (r) => {
        const entry = r.entry || r.price || 0;
        if (!entry) return r;
        const atr = entry * (r.atrPct || 2) / 100;
        const MAX_STOP_MULT = 1.8; // max 1.8× ATR stop distance

        let { stop, target } = r;

        if (r.cls !== 'sell') {
          // Buy: stop below entry
          if (stop && stop < entry) {
            const origDist = entry - stop;
            const maxDist = atr * MAX_STOP_MULT;
            if (origDist > maxDist) {
              stop = entry - maxDist;
              const rrUse = Math.max(1.5, r.rr || 1.5);
              target = entry + maxDist * rrUse;
            }
          }
        } else {
          // Sell: stop above entry
          if (stop && stop > entry) {
            const origDist = stop - entry;
            const maxDist = atr * MAX_STOP_MULT;
            if (origDist > maxDist) {
              stop = entry + maxDist;
              const rrUse = Math.max(1.5, r.rr || 1.5);
              target = entry - maxDist * rrUse;
            }
          }
        }

        const stopPct = stop && entry ? ((stop - entry) / entry) * 100 : r.stopPct;
        const targetPct = target && entry ? ((target - entry) / entry) * 100 : r.targetPct;
        const stopDist = Math.abs(entry - (stop || entry));
        const targetDist = Math.abs((target || entry) - entry);
        const computedRR = stopDist > 0 ? +(targetDist / stopDist).toFixed(2) : r.rr;

        return { ...r, stop, target, stopPct, targetPct, rr: computedRR };
      };

      // ══════════════════════════════════════════════════════════════════════
      // isUnsafeForTomorrow — TEK NOKTA TAVAN/EXHAUSTION KAPISI
      // Tum filter path'leri (buyPicks/fallbackBuys/lastResort) AYNI kurallari uygular.
      // Wall Street kurali: bugun tavan = yarinin riskini saticiya verme.
      // ══════════════════════════════════════════════════════════════════════
      const isUnsafeForTomorrow = (r) => {
        // ══════════════════════════════════════════════════════════════════════
        // TAVAN / EXHAUSTION KAPISI (v20 — akilli tavan analizi)
        //
        // v19.1'de "tp >= 7% = her zaman red" uygulandı. Kullanıcı geri bildirimi:
        // OZATD, OZSUB, HURGZ gibi guclu kataliz + OBV birikim sinyalli tavan
        // hisseler dogru tahmin edilmisti — bunlar gosterilmeli.
        //
        // v20 MANTIGI:
        //   MUTLAK REDLER (kataliz bile kurtaramaz):
        //     - tp >= 12%: gap-up / devre kesici bolge
        //     - RSI > 88: tehlikeli aşırı alım
        //     - Kumulatif >= 22% (2 gun ust uste tavan): istisnasiz yorgun
        //     - MFI > 88: aşırı alım
        //
        //   AKILLI TAVAN (tp 7-12%):
        //     calcContinuationProbability hesaplanır:
        //     >= 38% → GOSTER (güçlü devam sinyali, OZATD/OZSUB/HURGZ tipi)
        //     < 38%  → RED   (zayif sinyal, FOMO pump riski)
        //
        //   KUMULATIF YORGUNLUK (cp 18-22%, tp < 7%):
        //     Kataliz haberi varsa gecir, yoksa red.
        // ══════════════════════════════════════════════════════════════════════
        const tp = Math.max(r.todayPumpReal || 0, r.recentPump || 0, r.change || 0);
        const cp = r.cumulativePump || tp;

        // ── MUTLAK REDLER ─────────────────────────────────────────────────────
        if (tp >= 12) return true;             // Gap-up / devre kesici bolge
        if ((r.rsi || 50) > 88) return true;   // RSI 88+ tehlikeli
        if ((r.mfi || 50) > 88) return true;   // MFI 88+ asiri overbought
        if (cp >= 22) return true;             // 2 gun kumulatif tavan → kesinlikle yorgun

        // ── AKILLI TAVAN (7-12%): devam olasılığı belirler ───────────────────
        if (tp >= 7) {
          // calcContinuationProbability module-level fonksiyon — OBV/CMF/haber/Wyckoff/TTM
          // hesaplar; BIST base rate ~%30-35'i kataliz sinyalleriyle yukari/asagi iter.
          const prob = calcContinuationProbability(r);
          // >= 38%: guclu devam sinyali (OZATD/OZSUB/HURGZ tipi — kataliz + akilli para)
          // < 38%: zayif / negatif sinyal — FOMO pump riski, red
          if (prob == null || prob < 38) return true;
          return false; // Yüksek güven → göster (ama sort'ta non-tavan picks önce gelir)
        }

        // ── KUMULATIF YORGUNLUK (tekli gun pump degil ama 3 gunde +%18+) ─────
        if (cp >= 18) {
          const hasCatalyst = r.newsCategories?.some(c =>
            ['insider_buy', 'buyback', 'fund_inflow', 'contract'].includes(c));
          if (!hasCatalyst) return true; // Haber yoksa red
        }

        return false;
      };

      // ══════════════════════════════════════════════════════════════════════
      // ── LIKIDITE KAPISI — IKI KADEMELI ──
      // Yuksek likidite (>= 2M TL/gun): standart filtreler uygulanir
      // Dusuk likidite (500K - 2M TL/gun): SADECE patlama oncesi birikim
      //   sinyalleri varsa onerilir → "ERKEN" rozetiyle isaretlenir
      // Cok dusuk likidite (< 500K TL/gun): tamamen elenir (slipaj cok yuksek)
      // ══════════════════════════════════════════════════════════════════════
      const MIN_DAILY_VOLUME_TL = 2_000_000;       // tam likit esigi
      const EARLY_ENTRY_MIN_VOLUME_TL = 500_000;   // erken alim icin minimum hacim

      // ── PRE-PUMP / ERKEN BIRIKIM TESPITI ──
      // Hisse henuz patlamamis ama akilli para giriyor mu? 8 sinyal kontrol eder.
      // 4+ sinyal varsa "early accumulation" kabul edilir.
      const detectEarlyAccumulation = (r) => {
        // ZORUNLU: fiyat henuz hareket etmemis olmali (chasing'e giremeyiz)
        // Ground truth: BigPara live'a dayanan todayPumpReal
        const recentPump = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
        if (recentPump > 3) return { isEarly: false, count: 0, signals: [] };
        // ZORUNLU: ATR makul (zaten ucmus hisseler dahil edilmesin)
        if ((r.atrPct || 0) > 5) return { isEarly: false, count: 0, signals: [] };

        const signals = [];
        // 1. Akilli para birikiminde
        if (r.obvTrend === 'accumulation') signals.push('OBV birikim');
        // 2. Para akisi pozitif
        if ((r.cmf || 0) > 0.08) signals.push('CMF+ para girisi');
        // 3. Wyckoff Accumulation/Spring fazi
        if (r.wyckoff === 'Accumulation' || r.wyckoffSpring) signals.push('Wyckoff birikim');
        // 4. TTM Squeeze aktif (kirilim oncesi sikisma)
        if (r.ttmSqueeze?.squeezeOn || r.ttmSqueeze?.squeezeRelease) signals.push('Sıkışma');
        // 5. Hacim artis kademeli (1.3x-2.5x — pump degil, gradual)
        const vr = r.volRatio || 0;
        if (vr >= 1.3 && vr <= 2.5) signals.push('Hacim ısınıyor');
        // 6. MA20 etrafinda konsolide (chasing yok)
        const ma20D = r.distFromMA20;
        if (ma20D != null && ma20D >= -3 && ma20D <= 2) signals.push('MA20 konsolidasyon');
        // 7. MFI nötr-pozitif (asiri alim degil, panik degil)
        if (r.mfi != null && r.mfi >= 35 && r.mfi < 55) signals.push('MFI tarafsiz');
        // 8. Bollinger orta band (sikismis)
        if (r.bollPct != null && r.bollPct >= 25 && r.bollPct <= 65) signals.push('Boll orta');
        // 9. Pozitif kataliz haberi (bonus)
        if (r.newsCategories?.some(c =>
          ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c))) {
          signals.push('Kataliz haberi');
        }
        // 10. RSI sweet spot (40-55 — momentum baslamak uzere)
        if (r.rsi != null && r.rsi >= 40 && r.rsi <= 55) signals.push('RSI sweet spot');

        const count = signals.length;
        // Erken giris icin 4+ sinyal sart — daha az → dusuk likit + sinyalsiz = riskli
        return { isEarly: count >= 4, count, signals };
      };

      // ── BUY PICKS ──
      const buyPicks = results
        .filter(r => {
          // v24: atrPct 1.2 → 0.8 — blue-chip hisseler (THYAO, SISE, ASELS) 1.0-1.2 arasi
          // ATR cok dusuk (<0.8) ise gercekten %5 hareket beklenmez
          if ((r.atrPct || 0) < 0.8) return false;
          // v24: cls='sell' kesin ele, ama 'TUT' (hold) hisseleri score>=45 ise kabul et
          // genSignal cogu momentum hisseye 'TUT' veriyor — v24 ZAYIF AL tier'i bile
          // volRatio 0.8 altinda veya 3- type'da TUT kalir; score>=45 makul setup
          if (r.cls === 'sell') return false;
          if (r.cls !== 'buy' && (r.score || 0) < 45) return false;

          const volTL = r.avgVolumeTL || 0;

          // Cok dusuk hacim → tamamen ele (manuel emir bile zor)
          if (volTL < EARLY_ENTRY_MIN_VOLUME_TL) return false;

          // Dusuk-orta hacim (500K-2M): sadece erken birikim sinyali varsa kabul et
          if (volTL < MIN_DAILY_VOLUME_TL) {
            const early = detectEarlyAccumulation(r);
            if (!early.isEarly) return false;
            // Erken birikim sinyali var — kabul et (sonradan _earlyPick rozeti eklenecek)
            r._earlyAccumulation = early;
            return true;
          }

          // LIKIT HISSELER ICIN DE ERKEN TESPIT — ranking'e bonus icin attach et.
          // Pre-pump sinyali olan likit hisseler zaten standart filtreleri gecmeli,
          // ama "erken yakalama" rozetiyle UI'da on plana cikarilirlar.
          {
            const liqEarly = detectEarlyAccumulation(r);
            if (liqEarly.isEarly) r._earlyAccumulation = liqEarly;
          }

          // ── YAPI SAGLIGI KONTROLU (Structural Health Guard) ──
          // Taban yeme riskini minimize etmek icin: onaylanan downtrend'de buy onerme.
          // Her iki yapısal gösterge de ASAGI bakiyorsa + dagıtım gosteriyorsa: BLOKLA.
          // Bu kontrol tek basa downtrend'i degil KONFIRME DOWNTREND'i yakalar.
          const isConfirmedBearish = (
            r.supertrend?.trend === 'DOWN' &&         // Trend asagi
            r.ichimoku?.cloudPosition === 'below' &&  // Cloud altinda
            r.obvTrend === 'distribution'             // Akilli para cikiyor
          );
          if (isConfirmedBearish) return false;

          // Dagıtim (distribution) + henuz oversold degil = satilmaya devam eder
          // RSI>50 = panik yok, devam eden dagıtim = taban riski
          const isActivelyDistributing = (
            r.obvTrend === 'distribution' &&
            (r.cmf || 0) < -0.08 &&           // Para net cikiyor
            (r.rsi || 50) > 50 &&              // Henuz oversold degil
            r.score < 60                        // Skoru yuksek degil
          );
          if (isActivelyDistributing) return false;

          // Cift bearish divergence: hem RSI hem OBV ters donuyor = gizli dusus
          if (r.rsiDivergence === 'bearish' && r.obvDivergence === 'bearish') return false;

          // ── DISTRIBUTION TRAP GUARD (v23 — sertlesti) ──
          // Fiyat yukselirken OBV dagilim + CMF GUCLU negatif = buyuk oyuncular cikiyor
          // v21'de CMF < -0.05 cok hassasti; simdi CMF < -0.12 ile sadece NET dagilim yakalanir
          const isDistTrap = r.obvTrend === 'distribution'
            && (r.cmf || 0) < -0.12
            && (r.change || 0) > 1;
          if (isDistTrap && r.score < 60) return false;

          // ── EXHAUSTION GUARD (v21) ──
          // RSI > 72 + MFI > 70 + son gun yukselis = asiri uzamis, duzeltme gelecek
          const isExhausted = (r.rsi || 50) > 72 && (r.mfi || 50) > 70
            && (r.change || 0) > 1;
          if (isExhausted && r.score < 70) return false;

          // ── WEAK RALLY GUARD (v23 — yumusatildi) ──
          // Yukselis + hacim CIDDIYE dusuk + OBV dagilim = gercekten zayif rally
          // v21'de volRatio<0.9 + OBV!='accumulation' cok genisti; simdi sadece net zayiflik
          const isWeakRally = (r.change || 0) > 3
            && (r.volRatio || 1) < 0.6
            && r.obvTrend === 'distribution';
          if (isWeakRally && r.score < 55) return false;

          // ── TAVAN/EXHAUSTION GUARD (v19.1 — hard reject, allowance yok) ──
          if (isUnsafeForTomorrow(r)) return false;
          // 3 gunde +%15 kumulatif yukselis + haber yoksa ele
          if ((r.cumulativePump || 0) >= 15) {
            const hasCatalystNews = r.newsCategories?.some(c =>
              ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c));
            if (!hasCatalystNews) return false;
          }

          // ── MINIMUM QUALITY GATE (v23 — yumusatildi) ──
          // v22'de CMF<0 ile tum momentum hisseleri bloklaniyordu. Artik sadece
          // GUCLU dagilim (CMF < -0.10 + OBV dist + dusuk skor) eleniyor.
          const hasMinQuality = (() => {
            // Guclu dagilim + dusuk skor = gercekten tehlikeli
            if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.10 && r.score < 55) return false;
            // Supertrend DOWN + ADX < 18 + dusuk skor = trend yok, momentum yok
            if (r.supertrend?.trend === 'DOWN' && (r.adx || 25) < 18 && r.score < 50) return false;
            return true;
          })();
          if (!hasMinQuality) return false;

          // v24: afterHours / intraday filtreler daha akilli
          // ONCEKI SORUN: score>=48 + rr>=0.8 ikisi birden cok siki; genSignal zaten
          // rr<1.0 olanlari TUT'a dusuruyordu (cift cezalandirma).
          // YENI: ana kriter SCORE, R/R bonus ama bloklayici degil.
          if (isAfterHours) {
            const hasSetup = r.score >= 45;
            const hasGoodRR = r.rr >= 0.8;
            const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
            const hasSmartMoney = r.obvTrend === 'accumulation' || (r.cmf || 0) > 0.05;
            const hasCatalyst = r.newsCategories?.some(c =>
              ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c));
            const hasInsider = r.hasRecentInsiderBuy || (r.insiderScore || 0) >= 3;
            // Kataliz/insider = dusuk score bile kabul
            if ((hasCatalyst || hasInsider) && r.score >= 40) return true;
            // Setup: score >= 45 yeterli, RR veya trend veya smart money teyidi
            if (hasSetup && (hasGoodRR || hasTrend || hasSmartMoney)) return true;
            // Yuksek score tek basina yeterli
            if (r.score >= 55) return true;
            return false;
          } else {
            const hasTraditionalSignal = r.score >= 48 && r.rr >= 0.8;
            const hasMomentumBoost = r.momentumScore >= 40 && (r.change || 0) > 0 && r.score >= 42
              && (r.recentPump || 0) < 7;
            const hasTrendSignal = r.score >= 52
              && ((r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP'));
            return hasTraditionalSignal || hasMomentumBoost || hasTrendSignal;
          }
        })
        .map(r => normalizeStopTarget({
          ...r,
          tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
          // Erken birikim isareti — panel "ERKEN" rozeti gosterir
          _earlyPick: r._earlyAccumulation?.isEarly || false,
          _earlySignals: r._earlyAccumulation?.signals || null,
          _earlyCount: r._earlyAccumulation?.count || 0,
        }))
        .sort((a, b) => {
          if (isAfterHours) {
            // Erken birikim picks'lerine BUYUK bonus (14 puan) — pre-pump on plana
            const aBonus = a._earlyPick ? 14 : 0;
            const bBonus = b._earlyPick ? 14 : 0;
            return ((b.tomorrowPotential || 0) + bBonus) - ((a.tomorrowPotential || 0) + aBonus);
          }
          const pumpPenaltyA = Math.min(20, (a.recentPump || 0) * 2);
          const pumpPenaltyB = Math.min(20, (b.recentPump || 0) * 2);
          const earlyBonusA = a._earlyPick ? 12 : 0;
          const earlyBonusB = b._earlyPick ? 12 : 0;
          const scoreA = (a.score || 0) + ((a.momentumScore || 0) * 0.2) - pumpPenaltyA + earlyBonusA;
          const scoreB = (b.score || 0) + ((b.momentumScore || 0) * 0.2) - pumpPenaltyB + earlyBonusB;
          return scoreB - scoreA;
        })
        .slice(0, 8);

      // ── SELL PICKS — short / bearish candidates ──
      // Stocks that are overbought, distributing, or have bearish technicals.
      const sellPicks = results
        .filter(r => {
          if ((r.atrPct || 0) < 1.0) return false;
          if (r.cls !== 'sell') return false;
          if ((r.avgVolumeTL || 0) < MIN_DAILY_VOLUME_TL) return false;
          // Must have bearish score + at least one confirming bearish signal
          if (r.score > 44) return false;
          if ((r.rr || 0) < 1.2) return false;
          const isOverbought = (r.rsi || 50) > 62;
          const hasDistribution = r.obvTrend === 'distribution' || (r.cmf || 0) < -0.05;
          const hasBearishTech = r.supertrend?.trend === 'DOWN' || r.ichimoku?.cloudPosition === 'below';
          const hasNegativeNews = r.newsCategories?.some(c => ['risk', 'downgrade'].includes(c));
          return isOverbought || hasDistribution || hasBearishTech || hasNegativeNews;
        })
        .map(r => normalizeStopTarget({
          ...r,
          sellPotential: calcSellPotential(r),
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
        }))
        .sort((a, b) => (b.sellPotential || 0) - (a.sellPotential || 0))
        .slice(0, 3); // max 3 sell candidates alongside buy picks

      // ── Fallback: always surface at least 5 buy candidates ──
      const minBuyCount = 5;
      let picks = [...buyPicks, ...sellPicks];
      if (buyPicks.length < minBuyCount) {
        const existingSyms = new Set(picks.map(p => p.symbol));
        const fallbackBuys = results
          .filter(r => {
            // v24: fallback da sell eleme, ama TUT kabul (score>=42)
            if (r.cls === 'sell') return false;
            if (r.cls !== 'buy' && (r.score || 0) < 42) return false;
            if ((r.atrPct || 0) < 0.8) return false;
            if (existingSyms.has(r.symbol)) return false;
            const volTL = r.avgVolumeTL || 0;
            if (volTL < EARLY_ENTRY_MIN_VOLUME_TL) return false;
            // TAVAN/EXHAUSTION GUARD — fallbackBuys: hard reject (v19.1)
            if (isUnsafeForTomorrow(r)) return false;
            // Tam likit veya erken birikim ile dusuk likit kabul edilir
            if (volTL >= MIN_DAILY_VOLUME_TL) return true;
            const early = detectEarlyAccumulation(r);
            if (early.isEarly) { r._earlyAccumulation = early; return true; }
            return false;
          })
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, minBuyCount - buyPicks.length)
          .map(r => normalizeStopTarget({
            ...r,
            tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
            _alreadyHolding: bullishPortfolio.includes(r.symbol),
            _scanMode: isAfterHours ? 'afterHours' : 'intraday',
            _fallback: true,
            _earlyPick: r._earlyAccumulation?.isEarly || false,
            _earlySignals: r._earlyAccumulation?.signals || null,
            _earlyCount: r._earlyAccumulation?.count || 0,
          }));
        picks = [...picks, ...fallbackBuys];
      }

      // ── LAST RESORT FALLBACK (v19 — Wall Street katligi) ──
      // Tavan gunu icin asla tavan hissesi onerme. Eger yeterli non-tavan setup yoksa,
      // 4 katmanli oncelik:
      //   1. KALITE SETUP'LARI: pump<3% + score>=50 + (OBV accum VEYA CMF>0.05 VEYA squeeze)
      //   2. ERKEN BIRIKIM: detectEarlyAccumulation isEarly=true (4+ sinyal)
      //   3. HIZ SETUP'LARI: pump 3-7% + score>=55 + uptrend onayi
      //   4. PAS GEC: hicbirini dolduramiyorsak panel YEDI ALTERNATIF gosterir, tavan EKLEMEZ
      // Tavan hisseler (rp>=9) artik lastResort'a DAHIL EDILMEZ — sadece kuvvetli kataliz +
      // 4 teknik teyitle buyPicks/fallbackBuys'tan gelmis olanlar gosterilir.
      if (picks.length < 3) {
        const existingSyms2 = new Set(picks.map(p => p.symbol));
        const need = 5 - picks.length;

        const eligible = results
          .filter(r => {
            if (existingSyms2.has(r.symbol)) return false;
            if ((r.avgVolumeTL || 0) < MIN_DAILY_VOLUME_TL * 0.5) return false; // 1M TL min
            if ((r.atrPct || 0) < 0.8) return false;
            // STRICT: lastResort'ta tavan/exhausted hisselere allowance YOK
            if (isUnsafeForTomorrow(r)) return false;
            // Confirmed bear / active distribution = riskli
            const isBear = r.supertrend?.trend === 'DOWN' && r.ichimoku?.cloudPosition === 'below';
            if (isBear && r.obvTrend === 'distribution') return false;
            return true;
          })
          .map(r => {
            const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
            const obvAccum = r.obvTrend === 'accumulation';
            const cmf = r.cmf || 0;
            const squeezeOn = r.ttmSqueeze?.squeezeOn || r.ttmSqueeze?.squeezeRelease;
            const upTrend = r.supertrend?.trend === 'UP';

            // v24: QUALITY TIER 1 genisletildi — score>=45 + herhangi pozitif teknik sinyal
            // Onceki: score>=50 + (OBV/CMF/squeeze) → cok dar, cogu hisse kalifiyelenmiyordu
            const hasPositiveTech = obvAccum || cmf > 0.05 || squeezeOn || upTrend
              || (r.rsi != null && r.rsi >= 35 && r.rsi <= 55); // RSI sweet spot
            const isQuality = rp < 5 && r.score >= 45 && hasPositiveTech;
            // QUALITY TIER 2: erken birikim (4+ sinyal)
            const earlyData = detectEarlyAccumulation(r);
            const isEarly = earlyData.isEarly;
            // QUALITY TIER 3: hiz/momentum (3-7% + uptrend veya yuksek skor)
            const isMomentum = rp >= 3 && rp < 7 && (upTrend || r.score >= 50);

            // Composite quality score: aliminda hangi tier?
            let qualityRank = 0;
            if (isEarly) qualityRank = 100 + earlyData.count * 5;        // En guclu
            else if (isQuality) qualityRank = 80 + (r.score - 50);
            else if (isMomentum) qualityRank = 60 + (r.score - 55);
            else qualityRank = r.score; // baz skor

            return {
              ...r,
              _qualityRank: qualityRank,
              _isQuality: isQuality, _isEarlyResort: isEarly, _isMomentum: isMomentum,
              _earlyAccumulation: earlyData.isEarly ? earlyData : null,
            };
          })
          .sort((a, b) => b._qualityRank - a._qualityRank)
          .slice(0, need);

        const lastResort = eligible.map(r => normalizeStopTarget({
          ...r,
          tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
          continuationProbability: null, // tavan yok
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
          // v24: DIKKAT rozeti yalnizca hicbir tier'a giremeyen hisseler icin
          // Onceki: quality + early → ok, momentum → warning → ALTERNATİF LİSTE
          _warningPick: !r._isQuality && !r._isEarlyResort && !r._isMomentum,
          _fallback: true,
          _earlyPick: r._earlyAccumulation?.isEarly || false,
          _earlySignals: r._earlyAccumulation?.signals || null,
          _earlyCount: r._earlyAccumulation?.count || 0,
        }));
        picks = [...picks, ...lastResort];
      }

      // ══════════════════════════════════════════════════════════════════════
      //  AI ENHANCEMENT v15 — Sector Diversification + Composite Confidence
      // ══════════════════════════════════════════════════════════════════════
      //
      // Problem 1 — herd effect: 5 picks from same sector = correlated risk.
      //   Solution: cap per-sector to 2 buy picks; replace excess with next-best
      //   pick from a DIFFERENT sector.
      //
      // Problem 2 — score in isolation can't tell a chasing-the-pump trade
      //   apart from a quality pullback. Composite confidence blends:
      //     * Technical score (40%)
      //     * Tomorrow potential / Sell potential (25%)
      //     * Sector strength (15%)
      //     * News sentiment (10%)
      //     * Entry quality / pullback (10%)
      //
      // Problem 3 — chasing extended trends: prefer entries near MA20 over
      //   entries far above. Penalize price > 5% above MA20.
      // ══════════════════════════════════════════════════════════════════════

      // Sector strength lookup
      const sectorStrengthMap = {};
      for (const s of sectorRotation) sectorStrengthMap[s.sector] = s.avgScore;

      // Compute composite confidence + entry quality for each pick
      const enhancePick = (p) => {
        const baseScore = p.score || 50;
        const sectorScore = sectorStrengthMap[p.sector] || 0; // -3 to +3 typical
        const newsBoost = (p.newsScore || 0) * 1.2;
        const isSell = p.cls === 'sell';

        // Tomorrow / sell potential normalized to 0-100
        const potentialScore = isSell ? (p.sellPotential || 0) : (p.tomorrowPotential || 0);

        // Entry quality: hem recentPump hem MA20 mesafesi karisimi.
        // recentPump = son barlardaki agresif yukselis (chasing riski)
        // distFromMA20 = fiyat MA20'den uzakta mi? (extended trend riski)
        const pump = Math.max(p.todayPumpReal || 0, p.recentPump || 0);
        const ma20Dist = Math.abs(p.distFromMA20 || 0);
        let entryQuality = pump <= 1 ? 95 : pump <= 2 ? 85 : pump <= 3 ? 70 : pump <= 5 ? 50 : pump <= 7 ? 30 : 15;
        // MA20 cok uzaktaysa giris kalitesi cezalandirilir — SERTLESTIRILDI
        if (ma20Dist > 10) entryQuality = Math.max(5, entryQuality - 40);
        else if (ma20Dist > 7) entryQuality = Math.max(10, entryQuality - 30);
        else if (ma20Dist > 5) entryQuality = Math.max(20, entryQuality - 20);
        else if (ma20Dist > 3) entryQuality = Math.max(30, entryQuality - 10);
        else if (ma20Dist < 2) entryQuality = Math.min(98, entryQuality + 8);

        // ── DISTRIBUTION TRAP: Fiyat yukselirken OBV dagilim = BUYUK TUZAK ──
        // OZSUB/BVSAN tipi hisseler: yukseliyor ama akilli para cikiyor
        const isDistributionTrap = p.obvTrend === 'distribution'
          && (p.change || 0) > 0 && (p.rsi || 50) > 55;
        if (isDistributionTrap) entryQuality = Math.max(5, entryQuality - 35);

        // ── ZAYIF HACIM: yukselis + hacim < 1x = guvensiz sinyal ──
        if ((p.volRatio || 1) < 0.8 && (p.change || 0) > 1) {
          entryQuality = Math.max(10, entryQuality - 20);
        }

        // ── LIKIDITE SKORU (0-100) — pozisyon buyukluguyle olceklendiribiliriz ──
        // 2M TL: minimum (gecer-gecmez), 10M+ TL: BIST50 sinif, 50M+ TL: cok likit
        const volTL = p.avgVolumeTL || 0;
        const liquidityScore = volTL >= 50_000_000 ? 100
          : volTL >= 20_000_000 ? 85
          : volTL >= 10_000_000 ? 70
          : volTL >= 5_000_000 ? 55
          : volTL >= 2_000_000 ? 40
          : 20;

        // ── TAVAN CONTINUATION PROBABILITY ──
        // Tavan (>=%7 pump) hisseler icin devam olasiligi hesapla.
        // Bu deger hem UI'da gosterilir hem confidence'i etkiler.
        const continuationProbability = calcContinuationProbability(p);
        const effPump = Math.max(p.todayPumpReal || 0, p.recentPump || 0);
        const isTavanPick = effPump >= 7;

        // ── MOMENTUM HEALTH — yeni bileşen (v21) ──
        // Hacim teyidi + trend kalitesi + tukenis risk analizi
        // Dusuk hacimli rally + overbought = dusuk health = ceza
        let momentumHealth = 50; // notr
        const vr = p.volRatio || 1.0;
        const rsi = p.rsi || 50;
        // Hacim teyidi
        if (vr > 2.0) momentumHealth += 25;
        else if (vr > 1.3) momentumHealth += 15;
        else if (vr < 0.7) momentumHealth -= 25;
        else if (vr < 1.0) momentumHealth -= 10;
        // RSI durumu
        if (rsi > 75) momentumHealth -= 20;
        else if (rsi > 65) momentumHealth -= 10;
        else if (rsi < 35) momentumHealth += 15; // oversold = dipten donus firsati
        else if (rsi >= 40 && rsi <= 55) momentumHealth += 10; // sweet spot
        // OBV teyidi
        if (p.obvTrend === 'accumulation') momentumHealth += 15;
        else if (p.obvTrend === 'distribution') momentumHealth -= 25;
        // CMF para akisi
        if ((p.cmf || 0) > 0.10) momentumHealth += 10;
        else if ((p.cmf || 0) < -0.08) momentumHealth -= 15;
        // Zayif kapanis
        if (p.change > 2 && vr < 1.0) momentumHealth -= 20; // Yukselis hacim yok
        momentumHealth = Math.max(0, Math.min(100, momentumHealth));

        // ── COMPOSITE CONFIDENCE — agirliklar v21 ──
        // v20: 35/22/13/10/12/8 = teknik, potansiyel, sektor, haber, entry, likidite
        // v21: 28/18/10/8/18/8/10 = teknik, potansiyel, sektor, haber, entry, likidite, momentum_health
        // Entry quality %12 → %18: chasing cezası daha ağır
        // Momentum health %10: hacim/trend kalitesi artik composite'in parcasi
        // Teknik %35 → %28: diger faktorlerin dengeleyici etkisi artirildi
        const techComponent = baseScore * 0.28;
        const potentialComponent = potentialScore * 0.18;
        const sectorComponent = (50 + sectorScore * 8) * 0.10;
        const newsComponent = (50 + newsBoost * 4) * 0.08;
        const entryComponent = entryQuality * 0.18;
        const liqComponent = liquidityScore * 0.08;
        const healthComponent = momentumHealth * 0.10;

        let confidence = Math.round(
          techComponent + potentialComponent + sectorComponent +
          newsComponent + entryComponent + liqComponent + healthComponent
        );

        // TAVAN CEZASI: tavan hisselerin confidence'ini continuation prob'a gore asagi cek.
        // Bu sayede sort'ta non-tavan picks DAIMA tavan picks'in onune gecer.
        // continuationProbability < 30 → buyuk ceza; 30-40 → orta; > 40 → kucuk ceza.
        if (isTavanPick && continuationProbability !== null) {
          const tavanPenalty = continuationProbability < 25 ? 28
            : continuationProbability < 32 ? 20
            : continuationProbability < 40 ? 12
            : 6; // Guclu devam sinyali bile olsa biraz ceza
          confidence = Math.max(5, confidence - tavanPenalty);
        }

        // Confidence grade: A (>= 75), B (>= 65), C (>= 55), D (< 55)
        const grade = confidence >= 75 ? 'A' : confidence >= 65 ? 'B' : confidence >= 55 ? 'C' : 'D';

        // Skor seviyesi (UI'da "STRONG/GOOD/WEAK" rozeti icin)
        const tier = confidence >= 75 ? 'STRONG'
          : confidence >= 65 ? 'GOOD'
          : confidence >= 55 ? 'FAIR' : 'WEAK';

        return {
          ...p,
          confidence: Math.max(0, Math.min(100, confidence)),
          grade,
          tier,
          entryQuality,
          sectorStrength: sectorScore,
          liquidityScore,
          continuationProbability,  // null veya 5-55 arasi % (tavan devam olasiligi)
          // Tooltip / detay icin breakdown
          confidenceBreakdown: {
            technical: Math.round(techComponent),
            potential: Math.round(potentialComponent),
            sector: Math.round(sectorComponent),
            news: Math.round(newsComponent),
            entry: Math.round(entryComponent),
            liquidity: Math.round(liqComponent),
            momentumHealth: Math.round(healthComponent),
          },
        };
      };

      picks = picks.map(enhancePick);

      // ══════════════════════════════════════════════════════════════════════
      //  ML RULE SCORING — Discovered rules from SQLite self-learning engine
      // ══════════════════════════════════════════════════════════════════════
      //
      // Loads top rules via Electron IPC (better-sqlite3 in main process).
      // Falls back gracefully when: (a) not in Electron, (b) DB not trained yet,
      // (c) no rules discovered. Each pick gets:
      //   mlConfidenceBoost — additive confidence delta from ML engine
      //   mlBestRule        — top matched rule { setupName, winRate, conditions }
      //   mlMatchedCount    — how many rules fired (confluence)
      // ══════════════════════════════════════════════════════════════════════
      try {
        const mlDb = window.electronAPI?.mlDb;
        if (mlDb) {
          // Try lower minOccurrences first — fresh DBs may not have 10+ per rule yet
          let mlRules = await mlDb.getTopRules(50, 10);
          if (!mlRules?.length) {
            mlRules = await mlDb.getTopRules(50, 3); // relaxed: 3+ occurrences
          }
          console.log(`[AI Advisor] ML rules loaded: ${mlRules?.length || 0} rules`);
          if (mlRules?.length) {
            let mlMatched = 0;
            picks = picks.map(p => {
              const result = scoreNewSignal(p, mlRules);
              if (result.ruleCount > 0) {
                mlMatched++;
                const best = result.matchedRules[0];
                const boostedConf = Math.max(0, Math.min(100,
                  (p.confidence || 50) + result.confidenceBoost
                ));
                // Recalculate grade/tier with ML boost
                const grade = boostedConf >= 75 ? 'A' : boostedConf >= 65 ? 'B' : boostedConf >= 55 ? 'C' : 'D';
                const tier = boostedConf >= 75 ? 'STRONG' : boostedConf >= 65 ? 'GOOD' : boostedConf >= 55 ? 'FAIR' : 'WEAK';
                return {
                  ...p,
                  confidence: boostedConf,
                  grade,
                  tier,
                  mlConfidenceBoost: result.confidenceBoost,
                  mlBestRule: best ? {
                    setupName: best.setupName,
                    winRate: best.winRate,
                    avgRoi: best.avgRoi,
                    conditions: best.conditions,
                  } : null,
                  mlMatchedCount: result.ruleCount,
                };
              }
              // No ML match → standard signal, no badge
              return { ...p, mlConfidenceBoost: 0, mlBestRule: null, mlMatchedCount: 0 };
            });
            console.log(`[AI Advisor] ML scoring: ${mlMatched}/${picks.length} picks matched rules`);
          }
        } else {
          console.log('[AI Advisor] ML scoring skipped: electronAPI.mlDb not available');
        }
      } catch (mlErr) {
        // ML scoring is best-effort — never block the scan pipeline
        console.warn('[AI Advisor] ML scoring skipped:', mlErr?.message);
      }

      // Sector diversification: max 2 buy picks per sector
      const MAX_PER_SECTOR = 2;
      const sectorCount = {};
      const diversifiedBuys = [];
      const overflowBuys = [];

      for (const p of picks.filter(x => x.cls !== 'sell').sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
        const sec = p.sector || 'Diger';
        if ((sectorCount[sec] || 0) < MAX_PER_SECTOR) {
          sectorCount[sec] = (sectorCount[sec] || 0) + 1;
          diversifiedBuys.push(p);
        } else {
          overflowBuys.push(p);
        }
      }

      // Try to fill picks list with diverse sectors first, then overflow
      const sellsInPicks = picks.filter(x => x.cls === 'sell');
      picks = [...diversifiedBuys, ...overflowBuys, ...sellsInPicks];

      // ── FINAL SORT (v19) ──
      // Oncelik sirasi:
      // 1. Sell picks: her zaman en sona
      // 2. Non-pump buy picks: composite confidence'a gore (coil, dip bounce, erken birikim)
      // 3. Mid-pump (5-7%): non-tavan grubuyla beraber, ama duzgun pump cezasi confidence'da
      // 4. Tavan/yuksek-pump buy picks (>= 7%): continuation probability ile sort, en sona
      //    → Non-tavan picks her ZAMAN tavan picks'in ONUNE gelir
      picks.sort((a, b) => {
        // Sells: her zaman en sona
        if (a.cls === 'sell' && b.cls !== 'sell') return 1;
        if (b.cls === 'sell' && a.cls !== 'sell') return -1;

        // Tavan tespiti: todayPumpReal ground truth (BigPara live + dunku kapanis)
        // recentPump fallback olarak kalir
        const aPump = Math.max(a.todayPumpReal || 0, a.recentPump || 0);
        const bPump = Math.max(b.todayPumpReal || 0, b.recentPump || 0);
        const aIsTavan = aPump >= 7;  // 7%+ pump = arkaya
        const bIsTavan = bPump >= 7;

        // Non-tavan picks tavan picks'in onune gecer (her zaman)
        if (aIsTavan && !bIsTavan) return 1;
        if (bIsTavan && !aIsTavan) return -1;

        // Iki pick de tavan: continuation probability ile sort (yuksek ihtimal once)
        if (aIsTavan && bIsTavan) {
          return (b.continuationProbability || 0) - (a.continuationProbability || 0);
        }

        // Normal picks: composite confidence ile sort
        return (b.confidence || 0) - (a.confidence || 0);
      });

      // Cap final picks at 10
      picks = picks.slice(0, 10);

      // ── Market news enrichment: fetch borsa haberleri, eslestir + sentiment ──
      // Sadece top 10 pick + universe filtrelenir; tum tarama icin haber cekmiyoruz.
      let newsIndex = {};
      try {
        const universe = picks.map(p => p.symbol);
        if (universe.length) {
          const news = await fetchMarketNews({ universe, maxPerSource: 25 });
          newsIndex = indexBySymbol(news);
          // Inject per-pick news entry (score, count, top headline)
          for (const r of picks) {
            const e = newsIndex[r.symbol];
            if (e?.count) {
              r.newsScore = e.score;
              r.newsCount = e.count;
              r.newsCategories = e.categories;
              r.newsHeadline = e.topItem?.title || '';
              r.newsHighImpact = e.highImpact;
            }
          }
        }
      } catch { /* news enrichment is best-effort */ }

      // ── INSIDER TRADING ENRICHMENT (v22) ──
      // Top picks'in iceriden islem verilerini cek; insider buy = en guclu kataliz sinyali.
      // KAP'tan yonetici/ortak alim-satim verileri parse edilir.
      try {
        const insiderSymbols = picks.map(p => p.symbol);
        if (insiderSymbols.length > 0) {
          const insiderMap = await fetchInsiderBatch(insiderSymbols, 5);
          for (const p of picks) {
            const ins = insiderMap.get(p.symbol);
            if (ins) {
              p.insiderScore = ins.score;
              p.insiderNetBuys = ins.insiderNetBuys;
              p.hasRecentInsiderBuy = ins.hasRecentInsiderBuy;
              p.hasRecentInsiderSell = ins.hasRecentInsiderSell;
              p.insiderTransactions = ins.transactions?.slice(0, 5) || []; // son 5 islem

              // ── CONFIDENCE BOOST/PENALTY — insider activity ──
              // Insider buy = en guclu kataliz (akademik calismalar %5-15 abnormal return gosterir)
              // Insider sell = dikkat sinyali (her zaman kotu degil ama risk artirici)
              if (ins.score >= 5) {
                p.confidence = Math.min(100, (p.confidence || 50) + 8);
              } else if (ins.score >= 3) {
                p.confidence = Math.min(100, (p.confidence || 50) + 4);
              } else if (ins.score <= -5) {
                p.confidence = Math.max(5, (p.confidence || 50) - 6);
              } else if (ins.score <= -3) {
                p.confidence = Math.max(5, (p.confidence || 50) - 3);
              }

              // Insider buy -> newsCategories'e ekle (tavan continuation prob'da da etkili)
              if (ins.hasRecentInsiderBuy && !p.newsCategories?.includes('insider_buy')) {
                p.newsCategories = [...(p.newsCategories || []), 'insider_buy'];
              }
            }
          }
        }
      } catch { /* insider enrichment is best-effort */ }

      setScanResults(results);
      setTopPicks(picks);
      setMarketSentiment(sentimentObj);
      setSectorHeatmap(sectorMetrics);
      setLastUpdate(new Date());

      // Persist top picks to localStorage so the bottom panel survives page reload
      if (picks.length > 0) {
        try {
          localStorage.setItem('bist_last_ai_picks', JSON.stringify({
            picks: picks.slice(0, 10).map(p => ({
              symbol: p.symbol, sector: p.sector, price: p.price, change: p.change,
              signal: p.signal, cls: p.cls, score: p.score, rr: p.rr,
              stop: p.stop, target: p.target, stopPct: p.stopPct, targetPct: p.targetPct,
              holdText: p.holdText, atrPct: p.atrPct, tomorrowPotential: p.tomorrowPotential,
              sellPotential: p.sellPotential,
              confidence: p.confidence, grade: p.grade, tier: p.tier,
              entryQuality: p.entryQuality, sectorStrength: p.sectorStrength,
              liquidityScore: p.liquidityScore, avgVolumeTL: p.avgVolumeTL,
              distFromMA20: p.distFromMA20,
              confidenceBreakdown: p.confidenceBreakdown,
              _scanTs: p._scanTs, _dataSource: p._dataSource,
              _fallback: p._fallback, _warningPick: p._warningPick,
              _earlyPick: p._earlyPick, _earlySignals: p._earlySignals, _earlyCount: p._earlyCount,
              recentPump: p.recentPump, cumulativePump: p.cumulativePump,
              todayPumpReal: p.todayPumpReal,
              continuationProbability: p.continuationProbability,
              // Frontend safety filter icin gerekli teknik degerler
              rsi: p.rsi, mfi: p.mfi, cmf: p.cmf, volRatio: p.volRatio,
              obvTrend: p.obvTrend, supertrend: p.supertrend,
              // Insider trading data (v22)
              insiderScore: p.insiderScore, insiderNetBuys: p.insiderNetBuys,
              hasRecentInsiderBuy: p.hasRecentInsiderBuy, hasRecentInsiderSell: p.hasRecentInsiderSell,
              // ML Engine data (v24)
              mlConfidenceBoost: p.mlConfidenceBoost, mlBestRule: p.mlBestRule,
              mlMatchedCount: p.mlMatchedCount,
            })),
            sentiment: sentimentObj.sentiment,
            scanned: results.length,
            buys: sentimentObj.buys,
            sells: sentimentObj.sells,
            ts: Date.now(),
          }));
        } catch { /* localStorage full or unavailable */ }
      }
      
      const modeLabel = isAfterHours ? 'Kapanis Sonrasi (Yarin Icin)' : 'Canli';
      pushLog({ type: 'ok', msg: `${modeLabel} tarama: ${results.length} hisse, ${buyPicks.length} AL / ${sellPicks.length} SAT firsat` });

      // Dispatch event for other systems (AlertLog, ChatPanel, notifications)
      window.dispatchEvent(new CustomEvent('advisor-scan-complete', {
        detail: {
          results,
          topPicks: picks,
          marketContext: sentimentObj,
          sectorRotation,
          riskAlerts,
          newsIndex,
          timestamp: Date.now(),
          scanMode: isAfterHours ? 'afterHours' : 'intraday',
        },
      }));
    } catch (err) {
      pushLog({ type: 'err', msg: 'Tarama hatasi: ' + (err.message || err) });
    } finally {
      setScanning(false);
      runningRef.current = false;
    }
  }, [portfolio, pushLog, riskAlerts]);

  const manualScan = useCallback(() => {
    runScan({ universe: SCAN_UNIVERSE });
  }, [runScan]);


  // Auto-scan loop — dual mode: market open vs after hours
  useEffect(() => {
    let timer = null;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const marketOpen = isMarketOpen();
      
      if (!runningRef.current) {
        if (marketOpen) {
          // Market open: standard 15-min scan with intraday momentum boost
          runScan({ universe: SCAN_UNIVERSE }).catch(() => {});
        } else {
          // After hours: run "Tomorrow Picks" scan with end-of-day analysis
          runScan({ universe: SCAN_UNIVERSE, afterHours: true }).catch(() => {});
        }
      }
      
      // Scan interval: 15 min during market, 30 min after hours
      const interval = marketOpen ? AUTO_SCAN_INTERVAL_MS : AUTO_SCAN_INTERVAL_MS * 2;
      timer = setTimeout(tick, interval);
    };
    // Kick off delayed first scan (5s) so app has time to mount
    timer = setTimeout(tick, 5000);
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [runScan]);

  return {
    topPicks,
    scanResults,
    results: scanResults, // alias for backward-compat
    riskAlerts,
    marketSentiment,
    globalMarket,
    advisorLog,
    sectorHeatmap,
    scanning,
    scanProgress,
    lastUpdate,
    manualScan,
    runScan,
    setGlobalMarket,
  };
}
