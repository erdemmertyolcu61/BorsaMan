import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSingle, fetchBigParaBatchPrices, fetchBigParaQuote, clearCache as clearFetchCache } from '../utils/fetchEngine.js';
import { getUnifiedAnalysis, genSignal, extractFiredSignals } from '../utils/signals.js';
import { calcAll } from '../utils/indicators.js';
import { getStockList, SECTORS } from '../utils/constants.js';
import { calcSectorMetrics, rankSectors } from '../utils/sectorEngine.js';
import { fetchMarketNews, indexBySymbol } from '../utils/marketNewsEngine.js';
import { fetchInsiderBatch } from '../utils/insiderEngine.js';
import { scoreNewSignal } from '../utils/ML_BacktestEngine.js';
import { classifyBistRegime, regimeLabel, applyRegimeGate } from '../utils/regimeGate.js';
import { getMacroContext } from '../utils/macroContextEngine.js';
import { classifyRegime } from '../utils/regimeEngine.js';
import { correlationCapFilter } from '../utils/portfolioOptimizer.js';
import { netRR, TOTAL_COST_PCT } from '../utils/tradingCosts.js';
import { computeGovernor, adaptiveStopMult } from '../utils/profitGovernor.js';
import { loadJournal, journalStats } from '../utils/forwardTestJournal.js';

/**
 * _istanbulParts — returns { day, h, m } in Europe/Istanbul regardless of host TZ.
 */
function _istanbulParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value; // 'Mon'…'Sun'
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[weekdayStr] ?? -1, h: get('hour'), m: get('minute') };
}

/**
 * isMarketOpen — BIST continuous session 09:55–18:10 TRT, Mon–Fri.
 */
export function isMarketOpen() {
  const { day, h, m } = _istanbulParts();
  if (day < 1 || day > 5) return false;          // weekend
  const t = h * 60 + m;
  return t >= 595 && t < 1090;                   // 09:55 – 18:10
}

/**
 * isMarketClosedForDay — true after 18:10 TRT on a weekday (session ended).
 */
export function isMarketClosedForDay() {
  const { day, h, m } = _istanbulParts();
  if (day === 0 || day === 6) return true;
  return h * 60 + m >= 1090;                     // >= 18:10
}

const isCapacitor = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform();

// PWA detection: running on Vercel (not Electron, not Capacitor, not localhost)
// Mobile Safari CORS-blocks direct fetches → all requests go through Vercel proxy
// → must throttle to avoid Vercel concurrency limits (Hobby: ~12 concurrent)
const _isPWAMode = (() => {
  try {
    if (isCapacitor) return false;
    if (typeof window !== 'undefined' && window.electronAPI?.remoteFetch) return false;
    if (typeof location !== 'undefined' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return true;
  } catch {}
  return false;
})();

const AUTO_SCAN_INTERVAL_MS = 1000 * 60 * 15; // 15-minute auto scan when market open
const SCAN_CONCURRENCY = (isCapacitor || _isPWAMode) ? 15 : 30;
const CHUNK_DELAY_MS = (isCapacitor || _isPWAMode) ? 200 : 30;
const SCAN_UNIVERSE = 'bistall';                // full universe ~648 symbols

// ══════════════════════════════════════════════════════════════════════════════
// v26 FIX 5 — RECENTLY FAILED PICK MEMORY (Self-feedback / cooldown)
//
// SORUN: Sistem stateless — dun onerdigi hisseyi bugun dusmus gorunce "ucuzladi,
// dip alimi" diye TEKRAR oneriyor. Kendi basarisiz tahminini hatirlamiyor.
// Kullanici sikayeti (16 May): "Fiyatlarinin dustugunu bilmesine ragmen ayni
// hisseleri onerdi."
//
// COZUM: localStorage'da onerilen her hissenin {oneri fiyati, ilk-oneri tarihi,
// son-oneri tarihi} tutulur. Yeni taramada bir aday son 3 gunde onerilmis VE
// o zamandan beri >%3 dusmusse = "basarisiz pick". Bunu tekrar onermek icin
// GUCLU reversal teyidi gerekir (bugun yesil + OBV birikim + MA20 ustu).
// Aksi halde cooldown — kullaniciyi zarara dogru ikinci kez itme.
// ══════════════════════════════════════════════════════════════════════════════
const PICK_MEMORY_KEY = 'bist_ai_pick_memory';
const PICK_MEMORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  // 7 gun (5 islem gunu) sonra unut
const PICK_FAIL_LOOKBACK_MS  = 3 * 24 * 60 * 60 * 1000;  // son 3 gun icindeki oneriler izlenir
const PICK_FAIL_DROP_PCT     = -3;                        // -%3+ dustuyse "basarisiz"

function loadPickMemory() {
  try {
    const raw = localStorage.getItem(PICK_MEMORY_KEY);
    if (!raw) return {};
    const mem = JSON.parse(raw);
    const now = Date.now();
    // Prune: eski kayitlari at
    const pruned = {};
    for (const [sym, e] of Object.entries(mem)) {
      if (e && e.lastRecTs && (now - e.lastRecTs) < PICK_MEMORY_MAX_AGE_MS) {
        pruned[sym] = e;
      }
    }
    return pruned;
  } catch { return {}; }
}

function savePickMemory(mem) {
  try { localStorage.setItem(PICK_MEMORY_KEY, JSON.stringify(mem)); } catch { /* full */ }
}

/**
 * isFailedRepeat — bu hisse yakinda onerildi ve o zamandan beri dustu mu?
 * @returns { failed: bool, dropPct: number, recPrice: number } | null
 */
function checkFailedRepeat(symbol, currentPrice, mem) {
  const e = mem?.[symbol];
  if (!e || !e.recPrice || !e.lastRecTs || !(currentPrice > 0)) return null;
  const age = Date.now() - e.lastRecTs;
  if (age > PICK_FAIL_LOOKBACK_MS) return null; // 3 gunden eski — cooldown bitti
  const dropPct = ((currentPrice - e.recPrice) / e.recPrice) * 100;
  return { failed: dropPct <= PICK_FAIL_DROP_PCT, dropPct, recPrice: e.recPrice };
}

/**
 * checkStagnantPick — 3+ gundur ust uste onerilen ama hic ilerlemeyen hisse.
 * Dusmedigi icin failed-repeat cooldown'una takilmaz, fakat olu sermayedir:
 * her gun listede yer kaplar, taze setup'larin onune gecer. Bloklamayiz —
 * ranking cezasi ile arkaya atariz (WS6 "stagnant" genislemesi).
 */
function checkStagnantPick(symbol, currentPrice, mem) {
  const e = mem?.[symbol];
  if (!e || !e.firstRecPrice || !e.firstRecTs || !(currentPrice > 0)) return null;
  const ageDays = (Date.now() - e.firstRecTs) / (1000 * 60 * 60 * 24);
  if (ageDays < 3 || (e.recCount || 0) < 3) return null;
  const movePct = ((currentPrice - e.firstRecPrice) / e.firstRecPrice) * 100;
  return { stagnant: movePct < 1, movePct, ageDays };
}

// ── HTF CONTEXT DERIVATION (sıfır ek fetch — mevcut günlük barlardan) ──────
// Her 5 günlük bar = 1 haftalık bar proxy.
// Haftalık trend + günlük trend hizalaması → genSignal'e bağlam sağlar.
// Bu sayede: günlük AL sinyali + haftalık DÜŞÜŞ → sinyal zayıflar veya filtre düşer.
function _deriveHTFContext(calcPrices, ind) {
  if (!calcPrices || calcPrices.length < 50) return null;
  const n = calcPrices.length;

  // ── Günlük trend: MA hizalaması ──
  const price = ind.lastClose || 0;
  const ma20  = ind.lastMA20  || 0;
  const ma50  = ind.lastMA50  || 0;
  const ma200 = ind.lastMA200 || 0;
  let trend = 'neutral';
  if (ma50 > ma200 * 1.005 && price > ma50) {
    trend = 'bull';
  } else if (ma50 < ma200 * 0.995 && price < ma50) {
    trend = 'bear';
  } else if (price > ma200 && ma20 > ma50) {
    trend = 'weak_bull';
  } else if (price < ma200 && ma20 < ma50) {
    trend = 'weak_bear';
  }

  // ── Haftalık proxy: her 5 bar bir hafta ──
  const weeklyCloses = [];
  for (let i = n - 1; i >= 0 && weeklyCloses.length < 16; i -= 5) {
    weeklyCloses.unshift(calcPrices[i].close);
  }
  let weeklyTrend = 'neutral';
  if (weeklyCloses.length >= 5) {
    const wn = weeklyCloses.length;
    const wLast  = weeklyCloses[wn - 1];
    const w4ago  = weeklyCloses[Math.max(0, wn - 5)];
    const wChg   = w4ago > 0 ? ((wLast - w4ago) / w4ago) * 100 : 0;
    // Haftalık MA4 eğimi (kısa dönem haftalık momentum)
    const wSlice = weeklyCloses.slice(-4);
    const wma4   = wSlice.reduce((s, v) => s + v, 0) / wSlice.length;
    const wPrev  = weeklyCloses.slice(-8, -4);
    const wma4p  = wPrev.length ? wPrev.reduce((s, v) => s + v, 0) / wPrev.length : wma4;
    const wSlope = wma4 > wma4p * 1.005 ? 'up' : wma4 < wma4p * 0.995 ? 'down' : 'flat';
    if      (wChg >  4 && wSlope === 'up')   weeklyTrend = 'bull';
    else if (wChg >  1.5)                    weeklyTrend = 'weak_bull';
    else if (wChg < -4 && wSlope === 'down') weeklyTrend = 'bear';
    else if (wChg < -1.5)                    weeklyTrend = 'weak_bear';
  }

  return {
    trend,
    weeklyTrend,
    rsi:        ind.lastRSI   || 50,
    adx:        ind.adx       || 15,
    ma200Above: price > ma200 && ma200 > 0,
  };
}

// ── GİRİŞ ZAMANLAMA SKORU (entry timing quality) ──────────────────────────
// Doğru hisse + doğru an kombinasyonu: en iyi giriş bölgesini puanlar.
// Returns: { score: -100..+100, label, reasons[] }
// +100 = mükemmel giriş anı  |  0 = nötr  |  -100 = sakın girme
function _scoreEntryTiming(ind, calcPrices) {
  let score = 0;
  const reasons = [];
  const n = calcPrices.length;
  if (!ind || n < 20) return { score: 0, label: 'NÖTR', reasons };

  const price   = ind.lastClose;
  const ma20    = ind.lastMA20  || price;
  const ma50    = ind.lastMA50  || price;
  const rsi     = ind.lastRSI   || 50;
  const bPct    = ind.lastBU && ind.lastBL
    ? (price - ind.lastBL) / (ind.lastBU - ind.lastBL) * 100
    : 50;
  const volRatio = ind.volRatio || 1;

  // 1. MA20 DESTEK BÖLGESİ: fiyat MA20'nin %3'ü içindeyse ideal giriş
  const distMa20Pct = ma20 > 0 ? ((price - ma20) / ma20) * 100 : 0;
  if (distMa20Pct >= -1.5 && distMa20Pct <= 2.0) {
    score += 25;
    reasons.push('MA20 destek bölgesinde (' + distMa20Pct.toFixed(1) + '%)');
  } else if (distMa20Pct > 6) {
    score -= 20;
    reasons.push('MA20\'den uzak (' + distMa20Pct.toFixed(1) + '%) — geç kalma riski');
  } else if (distMa20Pct < -6) {
    score -= 15;
    reasons.push('MA20 altında (' + distMa20Pct.toFixed(1) + '%) — trend zayıf');
  }

  // 2. RSI SWEET SPOT: 40-58 = en iyi giriş aralığı (aşırı alım/satım dışı)
  if (rsi >= 40 && rsi <= 58) {
    score += 20;
    reasons.push('RSI giriş bölgesi (' + rsi.toFixed(0) + ')');
  } else if (rsi < 30) {
    score += 10; // aşırı satım — dip potansiyeli var ama henüz toparlanma onayı yok
    reasons.push('RSI aşırı satım (' + rsi.toFixed(0) + ') — dip yakın');
  } else if (rsi > 68) {
    score -= 25;
    reasons.push('RSI aşırı alım (' + rsi.toFixed(0) + ') — geç kalmak');
  }

  // 3. BOLLİNGER BANDI KONUMU: alt %20-50 = toparlanma bölgesi
  if (bPct >= 15 && bPct <= 45) {
    score += 20;
    reasons.push('Bollinger alt yarısında (' + bPct.toFixed(0) + '%) — dip destek');
  } else if (bPct > 75) {
    score -= 20;
    reasons.push('Bollinger üst bölgede (' + bPct.toFixed(0) + '%) — yüksekte girme');
  }

  // 4. HACİM PATERNİ: son 3 günde azalan hacim (sessiz çekilme = sağlıklı pullback)
  if (n >= 5) {
    const vol3 = calcPrices.slice(-3).map(b => b.volume || 0);
    const volAvg = calcPrices.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;
    const vol3avg = vol3.reduce((s, v) => s + v, 0) / 3;
    const isQuietPullback = vol3avg < volAvg * 0.8 &&
      calcPrices[n - 1].close < calcPrices[n - 3].close; // fiyat çekilmiş, hacim azalmış
    const isVolSurgeUp = volRatio >= 1.5 && ind.changePct > 0.5; // hacimli yükseliş
    if (isQuietPullback) {
      score += 20;
      reasons.push('Sessiz çekilme: düşük hacim + fiyat destek arar');
    } else if (isVolSurgeUp && rsi < 60) {
      score += 15;
      reasons.push('Hacimli kırılım başlangıcı');
    } else if (volRatio > 2.5 && ind.changePct < -1) {
      score -= 20;
      reasons.push('Panik satış hacmi — bekle');
    }
  }

  // 5. MA50 ÜSTÜ İKEN MA20'YE ÇEKILME: en güvenli giriş setup'ı
  const aboveMa50 = price > ma50 && ma50 > 0;
  if (aboveMa50 && distMa20Pct >= -3 && distMa20Pct <= 1) {
    score += 15;
    reasons.push('MA50 üstü MA20 geri çekilme — klasik swing giriş');
  }

  const label = score >= 55 ? 'MÜKEMMEL AN' :
                score >= 30 ? 'İYİ AN' :
                score >= 10 ? 'MAKUL' :
                score >= -10 ? 'NÖTR' :
                score >= -30 ? 'ERKEN/GEÇ' : 'SAKINCA';

  return { score: Math.max(-100, Math.min(100, score)), label, reasons };
}

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
    tpScore -= 18;
  } else if (recentPump > 3) {
    tpScore -= 10;
  } else if (recentPump > 2) {
    tpScore -= 4;
  }

  // Kumulatif yorgunluk: 3 gunde +%15 ustu + haber yoksa ekstra -15
  if (isExhausted && !hasNewsCatalyst) tpScore -= 15;

  // ── PRE-PUMP COIL BONUS (v18 — v27 guncelleme) ──
  // Patlamadan ONCE yakalamak icin: dusuk pump + akilli para birikimi +
  // dusuk volatilite (sikisma) → patlamak uzere olan hisseler.
  // v27: OBV='notr' + CMF>0.03 da kabul edilir — sessiz birikim fazinda OBV henuz
  // tam 'accumulation' donmemis olabilir ama para girisi zaten baslamis.
  const obvBuildingUp = result.obvTrend === 'accumulation' ||
    (result.obvTrend === 'neutral' && (result.cmf || 0) > 0.03);
  const isCoiling = (
    recentPump <= 2 &&                          // Henuz hareket etmemis
    cumulativePump <= 5 &&                      // 3 gun de sakin
    obvBuildingUp &&                            // OBV birikim veya notr+CMF+
    (result.cmf || 0) > 0.03                    // Para girisi en az minimal pozitif
  );
  if (isCoiling) {
    // Guclu coil (tam OBV birikim + kuvvetli CMF): +25
    // Zayif coil (OBV notr ama CMF pozitif): +15 (sessiz birikim baslangici)
    const isStrongCoil = result.obvTrend === 'accumulation' && (result.cmf || 0) > 0.05;
    tpScore += isStrongCoil ? 25 : 15;
    // TTM Squeeze ek konfirmasyon
    if (result.ttmSqueeze?.squeezeOn) tpScore += 10;
    // Dar bant + birikim = en guclu coil
    if ((result.atrPct || 5) < 3) tpScore += 8;
  }
  // Volume buildup: hacim sessizce 1.3-2x kademeli artiyorsa = akilli para giriyor
  // v27: OBV notr da kabul — sessiz birikim icin kucuk bonus (tam birikim: +12, notr: +6)
  if (recentPump <= 3 && result.volRatio >= 1.3 && result.volRatio <= 2.0 && obvBuildingUp) {
    tpScore += result.obvTrend === 'accumulation' ? 12 : 6;
  }

  // ── GUNLUK ARALIK GATI: ATR/price < %2 ise hisse yeterince hareket etmez ──
  const atrPct = result.atrPct || 0;           // ATR / price * 100
  if (atrPct < 1.5) tpScore -= 20;            // cok dar bant
  else if (atrPct < 2.5) tpScore -= 5;
  else if (atrPct >= 5) tpScore += 15;        // cok genis aralik
  else if (atrPct >= 3) tpScore += 8;         // genis aralik — 5% mumkun

  // ── DISTRIBUTION TRAP CEZASI (v21) ──
  // Fiyat yukselirken OBV dagilim + CMF negatif → yarın dusus olasiligi cok yuksek
  if (result.obvTrend === 'distribution' && (result.change || 0) > 0) {
    tpScore -= 18;
    if ((result.cmf || 0) < -0.05) tpScore -= 8; // Ek CMF negatif cezasi
  }

  // ── EXHAUSTION CEZASI (v28 — sertlestirildi) ──
  // RSI yuksek + MFI yuksek + yukselis = kar realizasyonu yakın
  // v21'de -15 idi, ISYAT gibi RSI overbought + MFI>75 hisseler hala geciyordu.
  // v28: RSI>75 + MFI>70 = -25 (çok agir ceza), RSI>70 + MFI>65 = -18
  if ((result.rsi || 50) > 75 && (result.mfi || 50) > 70) {
    tpScore -= 25;
  } else if ((result.rsi || 50) > 70 && (result.mfi || 50) > 65 && (result.change || 0) > 0.5) {
    tpScore -= 18;
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

  // ── YABANCI AKIS ETKISI ──
  // Yabanci yatirimci giris/cikis trendi yarinki potansiyeli etkiler
  if (result.foreignFlowScore != null) {
    tpScore += Math.round(result.foreignFlowScore * 1.2); // [-18, +18] arasi
  } else if (result.foreignChangeWeek != null) {
    const cw = result.foreignChangeWeek;
    if (cw >= 1.5) tpScore += 10;
    else if (cw >= 0.5) tpScore += 4;
    else if (cw <= -1.5) tpScore -= 10;
    else if (cw <= -0.5) tpScore -= 4;
  }

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

  // ── R/R KALITESI (net-of-cost when available — gross RR flatters thin edges) ──
  const rrEff = result.rrNet ?? result.rr;
  if (rrEff >= 3) tpScore += 12;
  else if (rrEff >= 2.5) tpScore += 8;
  else if (rrEff >= 2) tpScore += 5;
  else if (rrEff < 1.2) tpScore -= 10;

  // ── MALIYET KAPISI: hedef round-trip maliyeti zar zor karsiliyorsa firsat degil ──
  // targetPct is the gross expected move; a move under ~2x the round-trip cost
  // leaves nothing after friction on a 1-3 day hold.
  if (result.targetPct != null && result.targetPct > 0) {
    const costPp = TOTAL_COST_PCT * 100;
    if (result.targetPct < costPp * 2) tpScore -= 15;      // < ~0.6% hedef: net edge yok
    else if (result.targetPct < costPp * 4) tpScore -= 6;  // < ~1.2%: cok ince
  }

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
  // v26: Piyasa rejimi (BULL/NEUTRAL/BEAR) — BIST100 gunluk performansina dayanir.
  // Tarama agresifligini belirler (BEAR=3 pick, NEUTRAL=5, BULL=8).
  const [marketRegime, setMarketRegime] = useState({ regime: 'NEUTRAL', bistChangePct: 0 });
  const runningRef = useRef(false);
  // Önceki taramadan kalan sektör güç haritası — mevcut taramada sinyal skorunu besler.
  // { 'Teknoloji': 72, 'Banka': 58, ... }
  const prevSectorMapRef = useRef({});

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

      // ── v26 FIX 2: MARKET REGIME DETECTION ─────────────────────────────────
      // BIST100 (XU100) endeksinin gunluk performansi sistemin agresiflig
      // Kullanıcı her durumda en iyi 8 fırsatı görmek istiyor.
      const maxBuyPicks = 8;
      // NEUTRAL: 5 pick orta-konservatif
      // Sebep: tek hisse skoru endeks dususune karsi koruyamaz; bear gunlerde
      // tum sektorler asagi gider, en guclu setup'lar bile zarar verir.
      // v29.2: Rejim artik TREND-bazli (BIST100 MA20 + 5-gun slope) — tek-gun
      // degisimi cok gurultuluydu. Rejim-bazli pick performans olcumu (walk-forward)
      // net gosterdi: AL pick'leri SADECE YUKSELIS'te pozitif (+1.14% beklenti),
      // YATAY'da -1.68%, DUSUS'ta -3.36%. Bu rejim, buyPicks'te AL kapisi surer.
      // v29.4: rejim siniflandirmasi pure fonksiyona cikarildi (regimeGate.js) — test edilebilir.
      let marketRegime = 'NEUTRAL';   // BULL=YUKSELIS, NEUTRAL=YATAY, BEAR=DUSUS
      let bistChangePct = 0;
      try {
        const bistData = await fetchSingle('XU100', '3mo', '1d', true).catch(() => null);
        const closes = (bistData?.prices || []).map(b => b.close);
        const cls = classifyBistRegime(closes);
        marketRegime = cls.regime;
        bistChangePct = cls.changePct;
      } catch { /* fallback NEUTRAL */ }
      pushLog({
        type: marketRegime === 'BEAR' ? 'warn' : 'info',
        msg: `Piyasa rejimi: ${regimeLabel(marketRegime)} (BIST100 5g trend ${bistChangePct >= 0 ? '+' : ''}${bistChangePct.toFixed(1)}%)`,
      });
      setMarketRegime({ regime: marketRegime, bistChangePct });
      // Rejim-bazli pick limiti kapatildi, kullanici her zaman 8 pick gormek istiyor.
      // ── v26 FIX 5: Onceki onerilerin hafizasini yukle ───────────────────
      // Bu tarama boyunca her aday "yakinda onerildi mi + dustu mu" kontrol edilir.
      const pickMemory = loadPickMemory();
      let _failedRepeatBlocked = 0; // log icin sayac

      const results = [];
      let done = 0;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Per-sembol hard timeout — tek yavaş sembol tüm chunk'ı bekletmesin.
      // fetchSingle zaten 10s ceiling'e sahip ama timeout kapısı dışarıdan daha güvenli.
      const symTimeoutMs = _isPWAMode ? 12000 : 8000;
      const withSymTimeout = (fn, ms = symTimeoutMs) =>
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

              // ── FORMING BAR HANDLING (v29) ──
              // Eskiden TÜM forming bar'lar indicator hesabından strip ediliyordu — bu
              // AI advisor'ın bugünün hareketini görmemesine yol açıyordu (kullanıcı
              // şikayeti: "bugünki mumlar gelmeden öneri yapıyor").
              //
              // YENI MANTIK:
              //   - Zero-range bar (H==L veya range < %0.1): strip (ATR'yi sıfırlar)
              //   - Normal forming bar (gerçek H>L hareketi var): DAHIL et
              //     Sebep: 14-bar ATR'da forming bar sadece 1/14 ağırlık taşır, ama
              //     advisor bugünün momentum/hacim/breakout sinyalini yakalar.
              const lastRaw = data.prices[data.prices.length - 1];
              const formingFlag = lastRaw?._isForming === true;
              const lastRange  = lastRaw ? (lastRaw.high - lastRaw.low) : 0;
              const lastClose  = lastRaw?.close || 0;
              const rangePct   = lastClose > 0 ? (lastRange / lastClose) * 100 : 0;
              // Sadece "ölü" forming bar (range yok) strip edilir — gerçek hareketli forming bar tutulur
              const isDeadForming = formingFlag && (lastRange <= 0 || rangePct < 0.1);
              const isFormingBar  = isDeadForming
                || (lastRaw?.high > 0 && lastRaw.high === lastRaw.low);
              const calcPrices = (isFormingBar && data.prices.length > 20)
                ? data.prices.slice(0, -1)
                : data.prices;

              const ind = calcAll(calcPrices);

              // ── HTF BAĞLAMI (sıfır ek fetch — mevcut barlardan türetilir) ──
              // Haftalık trend + günlük MA hizalaması → genSignal'e geçilir.
              // genSignal: haftalık DÜŞÜŞ + günlük AL → skoru %15-25 keser.
              //             haftalık+günlük YUKSELIŞ uyumu → +2.5 bonus.
              const htfCtx = _deriveHTFContext(calcPrices, ind);

              // ── SEKTÖR GÜCÜ (önceki tarama sonucu) ──
              // Güçlü sektördeki ortalama hisse, zayıf sektördeki güçlü hisseden
              // daha iyi performans gösterir — sektör momentumu skora yansır.
              const sectorName = SECTORS[sym] || 'Diger';
              const sectorStrengthVal = prevSectorMapRef.current[sectorName] || 0;

              const sig = genSignal(ind, calcPrices, {
                htfContext:      htfCtx,
                sectorStrength:  sectorStrengthVal,
              });
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

              // ── v26 FIX 3: PREV-DAY CHANGE — 2 GUN TEYIDI ICIN ──────────────
              // Dunku barin (calcPrices'in son tam barinin) bar-over-bar % degisimi.
              // Bu deger "2 gun ardisik tek-yonlu hareket" exhaustion tespitinde kullanilir.
              // Yani: bugun + dun ust uste +%2-3 olan hisse = momentum yorgun = red.
              // ASTOR/TUPRS gibi gunluk +%1-2 yapan hisseler korunur (ardisik 2 gun
              // sadece dunku +%2'yi ASMAZ ise gecer).
              let prevDayChange = 0;
              if (calcPrices.length >= 2) {
                // Forming bar varsa: calcPrices'in son tam bari "dun"; sonu icindeki -2 "dunden onceki"
                // Forming bar yoksa: -1 dun, -2 dunden onceki
                const yIdx = calcPrices.length - 1;
                const dyIdx = calcPrices.length - 2;
                const yClose = calcPrices[yIdx]?.close || 0;
                const dyClose = calcPrices[dyIdx]?.close || 0;
                if (dyClose > 0 && yClose > 0) {
                  prevDayChange = ((yClose - dyClose) / dyClose) * 100;
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
              const liveRRNet    = netRR(liveEntry, liveStop || liveEntry * 0.95, liveTarget || liveEntry * 1.10);

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
                weeklyTrend: htfCtx.weeklyTrend,  // v29: ML rejim-kapisi icin
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
                rrNet:     liveRRNet != null ? Math.round(liveRRNet * 100) / 100 : null,
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
                prevDayChange,  // v26 FIX 3: dunku barin bar-over-bar % degisimi
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
                // ── GİRİŞ ZAMANLAMA SKORU (entry timing) ──
                // Doğru hisse + doğru an: MA20 destek, RSI sweet spot, sessiz çekilme
                // UI'da "MÜKEMMEL AN / İYİ AN / NÖTR / SAKINCA" etiketi gösterir.
                ...(() => {
                  const timing = _scoreEntryTiming(ind, calcPrices);
                  return {
                    entryTimingScore:  timing.score,
                    entryTimingLabel:  timing.label,
                    entryTimingReasons: timing.reasons,
                  };
                })(),
                // ── HTF bağlamı özeti (UI tooltip + Claude prompt için) ──
                htfTrend:       htfCtx?.trend       || 'neutral',
                htfWeeklyTrend: htfCtx?.weeklyTrend || 'neutral',
                // ── Signal Attribution ──
                // Hangi teknik sinyaller bu tarama aninda atesleniyordu?
                // Paper trade/sinyal kaydi kapaninca bu liste bySignalType win-rate'ini gunceller.
                firedSignals: sig.firedSignals || extractFiredSignals(ind, calcPrices),
                // Compact recent close series — used ONLY for live correlation
                // de-dup of the final pick list. Not persisted (bist_last_ai_picks
                // maps an explicit field list), so no localStorage bloat.
                closeSeries: calcPrices.slice(-30).map(b => +((b.close ?? 0)).toFixed(2)),
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

      // ── Macro context (USDTRY + VIX + TCMB + BIST/USD) ──
      // Fire-and-await with 6s soft cap — non-blocking if all sources fail.
      let macroCtx = null;
      try {
        macroCtx = await Promise.race([
          getMacroContext(),
          new Promise(r => setTimeout(() => r(null), 6000)),
        ]);
      } catch { macroCtx = null; }

      // ── Market regime classification (breadth + momentum + macro stress) ──
      // Labels the tape so the forward journal can break accuracy down by regime
      // and downstream sizing can adapt. macroCtx.scoreAdjust <= -8 ≈ panic/stress.
      const sectorStrengthAvg = sectorRotation.length
        ? sectorRotation.reduce((s, x) => s + (x.strength || 0), 0) / sectorRotation.length
        : 0;
      const regime = classifyRegime({
        pctBull, avgRSI, scanned: results.length, sectorStrengthAvg,
        macroStress: !!(macroCtx && typeof macroCtx.scoreAdjust === 'number' && macroCtx.scoreAdjust <= -8),
      });

      // ── Profit Governor: journal-measured throttle (WS4) ──
      // Reads the forward journal's aggregates and returns bounded throttle
      // decisions. With a young journal it is a pure pass-through (NORMAL);
      // every applied rule is human-readable in governor.reasons.
      let governor = { mode: 'NORMAL', scoreCutoffDelta: 0, maxPicksMult: 1, positionMult: 1, reasons: [] };
      let stopMultInfo = { mult: 1.8, adapted: false };
      try {
        const _journalDays = loadJournal();
        const _jStats = journalStats(_journalDays);
        stopMultInfo = adaptiveStopMult(_jStats.stopQuality, regime.regime);
        if (stopMultInfo.adapted) {
          pushLog({ type: 'info', msg: `Adaptif stop: ${regime.regime} icin ${stopMultInfo.mult}×ATR — ${stopMultInfo.reason}` });
        }
        governor = computeGovernor(_journalDays, regime.regime, { stats: _jStats });
        if (governor.mode !== 'NORMAL') {
          pushLog({
            type: governor.mode === 'DEFENSE' ? 'warn' : 'info',
            msg: `Profit Governor ${governor.mode}: ${governor.reasons.join(' | ')}`,
          });
        }
      } catch { /* governor is best-effort — never block a scan */ }
      const govDelta = governor.scoreCutoffDelta || 0;

      const sentimentObj = {
        sentiment, color, buys, sells, scanned: results.length, avgRSI, accumulations,
        sectorRotation,
        macro: macroCtx,
        regime,                 // full regime object { regime, label, riskMult, confidence, ... }
        bias: regime.regime,    // stable label consumed by the forward journal's byRegime
        governor,               // journal-driven throttle { mode, reasons, ... }
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
        // Regime table + journal-measured adaptation (adaptiveStopMult):
        // BULL/RANGE 1.8, VOLATILE 2.2, BEAR 1.6 by default; ±0.2 once >=30
        // stop-outs show the stops are too tight (recoverers) or too loose.
        const MAX_STOP_MULT = stopMultInfo.mult;

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

        const computedRRNet = netRR(entry, stop ?? entry * 0.95, target ?? entry * 1.10);
        return {
          ...r, stop, target, stopPct, targetPct, rr: computedRR,
          rrNet: computedRRNet != null ? Math.round(computedRRNet * 100) / 100 : r.rrNet ?? null,
        };
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

        // ── MUTLAK REDLER (teknik tükenmişlik — devam ihtimali yok) ───────────
        // v25: tp >= 12% mutlak red KALDIRILDI — devam ihtimali >= 50% ise tavan
        // hisse de gosterilir. Sadece teknik exhaustion (RSI/MFI 90+) mutlak red.
        if ((r.rsi || 50) > 90) return true;   // RSI 90+ extreme exhaustion
        if ((r.mfi || 50) > 92) return true;   // MFI 92+ extreme overbought

        // ── AKILLI TAVAN/PUMP (>= 7%): devam olasılığı belirler ───────────────
        // tp 7-12%: continuation prob >= 38% gerekli
        // tp 12%+: continuation prob >= 50% gerekli (daha katı çünkü extreme zone)
        // tp 15%+: continuation prob >= 58% gerekli
        if (tp >= 7) {
          const prob = calcContinuationProbability(r);
          if (prob == null) return true;

          let requiredProb;
          if (tp >= 9.5) requiredProb = 50;      // Tam tavan: guclu kataliz + teknik teyit gerekli
          else if (tp >= 8) requiredProb = 45;   // Tavana yakin: yukari orta devam ihtimali
          else requiredProb = 38;                // 7-8%: makul devam esigi

          if (prob < requiredProb) return true;
          return false; // Yüksek devam ihtimali → tavan bile olsa göster
        }

        // ── v26 FIX 1: ORTA PUMP ZONE (tp 5-7%) — sertlestirildi ─────────────
        // Kullanici geri bildirimi (15 May 2026): dun +5-7% yapan picksler bugun
        // ekside kapandi. Bu zone "mean reversion" tuzagi — sistem bunu yakalayamadi.
        // YENI KURAL: tp 5-7% ise SADECE su 2 sart birden saglanirsa kabul:
        //   (a) Kataliz haber (insider/buyback/fund_inflow/contract)
        //   (b) En az 4 teknik teyit (OBV/CMF/volRatio/Wyckoff/squeeze/ADX)
        // Aksi halde: red — yarinki dususe karsi koruma.
        if (tp >= 5 && tp < 7) {
          const hasCatalyst = r.newsCategories?.some(c =>
            ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c));
          const techConfirms = [
            r.obvTrend === 'accumulation',
            (r.cmf || 0) > 0.05,
            (r.volRatio || 1) >= 1.3,
            r.wyckoffSpring === true || r.wyckoff === 'Markup',
            r.ttmSqueeze?.squeezeRelease === true,
            (r.adx || 0) > 25,
          ].filter(Boolean).length;
          // Kataliz YOK ise red; kataliz var ama < 4 teknik teyit ise red
          if (!hasCatalyst || techConfirms < 4) return true;
        }

        // ── KUMULATIF YORGUNLUK (cp >= 22): yorgunluk belirgin ───────────────
        // v25: cp >= 22% mutlak red KALDIRILDI — 2 gun ust uste tavan bile olsa
        // continuation prob >= 55% ise (haber + akilli para + fundamental) gosterilir.
        if (cp >= 22) {
          const prob = calcContinuationProbability(r);
          if (prob == null || prob < 55) return true; // 55%+ olmazsa red
          return false;
        }

        // ── ORTA KUMULATIF (cp 18-22): kataliz haberi yeter ──────────────────
        if (cp >= 18) {
          const hasCatalyst = r.newsCategories?.some(c =>
            ['insider_buy', 'buyback', 'fund_inflow', 'contract'].includes(c));
          if (!hasCatalyst) return true;
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
      const MICRO_CAP_MIN_VOLUME_TL = 100_000;     // mutlak taban — emrin dolabilmesi icin

      // ── PRE-PUMP / ERKEN BIRIKIM TESPITI ──
      // Hisse henuz patlamamis ama akilli para giriyor mu? 8 sinyal kontrol eder.
      // 4+ sinyal varsa "early accumulation" kabul edilir.
      const detectEarlyAccumulation = (r) => {
        // ZORUNLU: fiyat henuz BUYUK hareket etmemis olmali (chasing'e giremeyiz)
        // v25: 3% → 5% gevsetildi — CCOLA gibi hisseler patlamadan once 3-4% hareket
        // edebiliyor, bunlari early accumulation aramasinda kacirmamak icin.
        const recentPump = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
        if (recentPump > 5) return { isEarly: false, count: 0, signals: [] };
        // ZORUNLU: ATR makul (zaten ucmus hisseler dahil edilmesin)
        if ((r.atrPct || 0) > 5) return { isEarly: false, count: 0, signals: [] };
        // v28: overbought hisseler erken birikim olamaz
        if ((r.rsi || 50) > 68) return { isEarly: false, count: 0, signals: [] };
        if ((r.mfi || 50) > 65) return { isEarly: false, count: 0, signals: [] };

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
        // 6. MA20 etrafinda konsolide (chasing yok) — daha esnek aralik
        const ma20D = r.distFromMA20;
        if (ma20D != null && ma20D >= -3 && ma20D <= 4) signals.push('MA20 konsolidasyon');
        // 7. MFI nötr-pozitif (asiri alim degil, panik degil) — yukari aralik genisledi
        if (r.mfi != null && r.mfi >= 35 && r.mfi < 62) signals.push('MFI tarafsiz');
        // 8. Bollinger orta-uzeri band (kirilim hazirligi)
        if (r.bollPct != null && r.bollPct >= 25 && r.bollPct <= 70) signals.push('Boll orta');
        // 9. Pozitif kataliz haberi (bonus)
        if (r.newsCategories?.some(c =>
          ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c))) {
          signals.push('Kataliz haberi');
        }
        // 10. RSI sweet spot (40-58 — momentum baslamak uzere)
        if (r.rsi != null && r.rsi >= 40 && r.rsi <= 58) signals.push('RSI sweet spot');
        // 11. v25: Supertrend yukari donus — trend baslangic onayi
        if (r.supertrend?.flip && r.supertrend?.trend === 'UP') signals.push('Supertrend YUKARI');
        // 12. v25: Pozitif sektor momentumu — sektor lideri olabilir
        if ((r.sectorStrength || 0) > 65) signals.push('Sektor guclu');
        // 13. v25: Insider net alim (kurumsal sinyal)
        if (r.insiderScore != null && r.insiderScore > 3) signals.push('Insider alim');

        const count = signals.length;
        // Normal durum: 4+ sinyal sart — dusuk likit + sinyalsiz = riskli
        // Ultra-tight coil: recentPump <= 1% ise 3 sinyal yeterli —
        // hisse neredeyse hic hareket etmemis, en guvenilir pre-pump profili
        const minSignals = recentPump <= 1 ? 3 : 4;
        return { isEarly: count >= minSignals, count, signals };
      };

      // ── v25: NEAR-BREAKOUT TESPITI ──
      // "Coil + breakout-ready" hisseler: yarinki patlamayi BUGUN tespit eder.
      // Direnc seviyesinin %2'sine yaklasmis + hacim artiyor + sikisma var.
      // Bu setup cok kuvvetli — early accumulation'dan farkli olarak fiyat
      // direnci kirmaya hazir konumda.
      const detectNearBreakout = (r) => {
        if (!r) return { isNear: false, count: 0, signals: [] };
        // ZORUNLU: bugun zaten patlamamis (geç kalmamak icin)
        const recentPump = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
        if (recentPump > 4) return { isNear: false, count: 0, signals: [] };

        const signals = [];
        // 1. Bollinger ust banda yakin (>%70 ama %95'in altinda — patlamamis ama hazir)
        if (r.bollPct != null && r.bollPct >= 70 && r.bollPct < 95) signals.push('Bollinger üst banda yakın');
        // 2. ATR daralmis (sikisma)
        if ((r.atrPct || 0) < 3) signals.push('ATR daralmış (sıkışma)');
        // 3. Hacim isiniyor (1.5x+, ama tavan degil)
        if ((r.volRatio || 0) >= 1.5 && (r.volRatio || 0) < 3) signals.push('Hacim ısınıyor');
        // 4. RSI bullish (50-70 arasi — momentum var ama overbought degil)
        if (r.rsi != null && r.rsi >= 50 && r.rsi <= 70) signals.push('RSI yükseliş bölgesi');
        // 5. OBV birikim
        if (r.obvTrend === 'accumulation') signals.push('OBV birikim');
        // 6. CMF kuvvetli pozitif
        if ((r.cmf || 0) > 0.10) signals.push('CMF güçlü');
        // 7. Supertrend yukari + ichimoku bulutu üzerinde
        if (r.supertrend?.trend === 'UP' && r.ichimoku?.cloudPosition === 'above')
          signals.push('Trend onayı (Supertrend + Ichimoku)');
        // 8. TTM Squeeze release (sikisma yeni acildi — patlama enerjisi)
        if (r.ttmSqueeze?.squeezeRelease) signals.push('TTM Squeeze RELEASE');
        // 9. MFI > 55 ama < 78 (para girisi var ama overbought degil)
        if (r.mfi != null && r.mfi >= 55 && r.mfi < 78) signals.push('MFI para girişi');
        // 10. Pozitif kataliz haberi
        if (r.newsCategories?.some(c =>
          ['fund_inflow', 'buyback', 'insider_buy', 'contract', 'upgrade'].includes(c))) {
          signals.push('Kataliz haberi');
        }

        const count = signals.length;
        return { isNear: count >= 5, count, signals };
      };

      // ── BUY PICKS ──
      let buyPicks = results
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

          // Mutlak taban — emir dolmaz (mikro-cap dahil hepsi erken birikim kapisiyla girebilir)
          if (volTL < MICRO_CAP_MIN_VOLUME_TL) return false;

          // Dusuk hacim (100K-2M): sadece erken birikim sinyali varsa kabul et
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
            // v25: NEAR-BREAKOUT tespiti — coil + breakout ready
            // Bu setup detectEarlyAccumulation'dan farkli: fiyat direnc seviyesinde,
            // hacim isiniyor, sikisma var. Yarinki patlama bugün tespit edilebilir.
            const nearBreak = detectNearBreakout(r);
            if (nearBreak.isNear) r._nearBreakout = nearBreak;
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

          // ── EXHAUSTION GUARD (v28 — sertlestirildi) ──
          // RSI > 70 + MFI > 65 + son gun yukselis = asiri uzamis, duzeltme gelecek
          // v21'de score < 70 istisnaydı — ISYAT gibi overbought ama yuksek skorlu
          // hisseler filtreden geciyordu. v28: score istisnaası KALDIRILDI.
          // RSI overbought + MFI high = YARIN DUSECEK, skor ne olursa olsun.
          const isExhausted = (r.rsi || 50) > 70 && (r.mfi || 50) > 65
            && (r.change || 0) > 0.5;
          if (isExhausted) return false;

          // ── WEAK RALLY GUARD (v23 — yumusatildi) ──
          // Yukselis + hacim CIDDIYE dusuk + OBV dagilim = gercekten zayif rally
          // v21'de volRatio<0.9 + OBV!='accumulation' cok genisti; simdi sadece net zayiflik
          const isWeakRally = (r.change || 0) > 3
            && (r.volRatio || 1) < 0.6
            && r.obvTrend === 'distribution';
          if (isWeakRally && r.score < 55) return false;

          // ── YABANCI CIKIS GUARD ──
          // Guclu yabanci cikisi + zayif teknik = yarinki risk cok yuksek
          // Yabanci takas orani yuksek (>40%) ve haftalik cikis agir (-2%+)
          // ise bu hissenin yarinki potansiyeli cok dusuk
          if (r.foreignFlowScore != null && r.foreignFlowScore <= -8 && r.score < 60) return false;
          // Orta seviye cikis + distribution = teyitli risk
          if (r.foreignFlowScore != null && r.foreignFlowScore <= -5
            && r.obvTrend === 'distribution' && r.score < 65) return false;

          // ── TAVAN/EXHAUSTION GUARD (v19.1 — hard reject, allowance yok) ──
          if (isUnsafeForTomorrow(r)) return false;

          // ── v26 FIX 3: 2-GUN EXHAUSTION GUARD ────────────────────────────────
          // Bugun + dun ardisik tek-yonlu yukselis = momentum yorgun, yarin red.
          // Kural: bugun >= 3% VE dun >= 2% VE toplam (bugun + dun) >= 6% ise red.
          // Sebep: ardisik 2 gun ust uste yukselis sonrasi BIST'te %60+ ihtimalle
          // duzeltme gelir (kullanici 14 May -> 15 May yasadi).
          // ASTOR/TUPRS gibi gunluk +%1-2 yapan steady performerler korunur:
          // bunlar dunku +%2'yi nadir gecer, bugun +%3 olsa bile prevDayChange < 2.
          // ISTISNA: kataliz haber + insider buy varsa rejected gozetilir (gercek itki).
          {
            const todayPump = r.todayPumpReal || r.recentPump || 0;
            const yestPump = r.prevDayChange || 0;
            const isDoubleDayPump = todayPump >= 3 && yestPump >= 2 && (todayPump + yestPump) >= 6;
            if (isDoubleDayPump) {
              const hasStrongCatalyst = r.hasRecentInsiderBuy
                || r.newsCategories?.some(c => ['insider_buy', 'buyback', 'fund_inflow'].includes(c));
              if (!hasStrongCatalyst) return false;
            }
          }

          // ── v26 FIX 5: BASARISIZ PICK COOLDOWN ──────────────────────────────
          // Bu hisse son 3 gunde onerildi VE o zamandan beri >%3 dustuyse:
          // sistem kendi basarisiz tahminini tekrar etmesin. Yeniden onermek icin
          // GUCLU reversal teyidi gerekir (bugun belirgin yesil + OBV birikim +
          // fiyat MA20 ustu). Aksi halde cooldown — "dususe ikinci kez itme".
          {
            const curPrice = r.price || r.todayPumpReal != null
              ? (livePriceMap[r.symbol]?.price || r.price)
              : r.price;
            const fr = checkFailedRepeat(r.symbol, curPrice || r.price, pickMemory);
            // Stagnant tag: 3+ gun onerilip ilerlemeyen pick bloklanmaz ama
            // enhancePick'te confidence cezasi alir (olu sermaye rotasyonu).
            const st = checkStagnantPick(r.symbol, curPrice || r.price, pickMemory);
            if (st && st.stagnant) r._stagnantPick = true;
            if (fr && fr.failed) {
              const strongReversal =
                (r.change || 0) > 1.5 &&                       // bugun belirgin yesil
                r.obvTrend === 'accumulation' &&               // akilli para geri donmus
                (r.distFromMA20 == null || r.distFromMA20 > 0); // MA20 ustunde
              if (!strongReversal) { _failedRepeatBlocked++; return false; }
            }
          }

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
          // govDelta: Profit Governor'un journal'a dayali esik sikilastirmasi
          // (NORMAL modda 0 — davranis bugunku ile ayni).
          if (isAfterHours) {
            const hasSetup = r.score >= 45 + govDelta;
            const hasGoodRR = (r.rrNet ?? r.rr) >= 0.8;
            const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
            const hasSmartMoney = r.obvTrend === 'accumulation' || (r.cmf || 0) > 0.05;
            const hasCatalyst = r.newsCategories?.some(c =>
              ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c));
            const hasInsider = r.hasRecentInsiderBuy || (r.insiderScore || 0) >= 3;
            // Kataliz/insider = dusuk score bile kabul
            if ((hasCatalyst || hasInsider) && r.score >= 40 + govDelta) return true;
            // Setup: score >= 45 yeterli, RR veya trend veya smart money teyidi
            if (hasSetup && (hasGoodRR || hasTrend || hasSmartMoney)) return true;
            // Yuksek score tek basina yeterli
            if (r.score >= 55 + govDelta) return true;
            return false;
          } else {
            const hasTraditionalSignal = r.score >= 48 + govDelta && (r.rrNet ?? r.rr) >= 0.8;
            const hasMomentumBoost = r.momentumScore >= 40 && (r.change || 0) > 0 && r.score >= 42 + govDelta
              && (r.recentPump || 0) < 7;
            const hasTrendSignal = r.score >= 52 + govDelta
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
          // v25: Near-breakout (coil + breakout-ready) — yarinki patlama tespiti
          _nearBreakoutPick: r._nearBreakout?.isNear || false,
          _nearBreakoutSignals: r._nearBreakout?.signals || null,
          _nearBreakoutCount: r._nearBreakout?.count || 0,
        }))
        .sort((a, b) => {
          if (isAfterHours) {
            // v25: 3 katmanli bonus sistemi
            //   _nearBreakoutPick (coil + breakout-ready): EN YUKSEK +20 bonus
            //   _earlyPick (early accumulation): +14 bonus (orijinal)
            //   normal pick: 0 bonus
            const aBonus = (a._nearBreakoutPick ? 20 : 0) + (a._earlyPick ? 14 : 0);
            const bBonus = (b._nearBreakoutPick ? 20 : 0) + (b._earlyPick ? 14 : 0);
            return ((b.tomorrowPotential || 0) + bBonus) - ((a.tomorrowPotential || 0) + aBonus);
          }
          // ── Healthy Momentum Bonus (v25) ──
          // Bugun yukselen + hacim + OBV teyitli hisselere BONUS ver.
          // Sadece tavan/exhausted hisselere (rp >= 9) ceza ver.
          // Boylece "bugun en cok kazandiranlardan" 1-2 tane top 5'e girer.
          const calcMomentumAdj = (r) => {
            const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
            const volOk = (r.volRatio || 1) >= 1.0;
            const obvOk = r.obvTrend === 'accumulation';
            const cmfOk = (r.cmf || 0) > 0.05;
            const techConfirm = (volOk ? 1 : 0) + (obvOk ? 1 : 0) + (cmfOk ? 1 : 0);
            // Tavan zone (>=8): isUnsafeForTomorrow filtresini gecebilmisse (yani devam ihtimali %65-%75 uzerindeyse) gercek bir Tavan Serisi (Streak) adayidir.
            // Siralamada dibe atma, sadece kucuk bir FOMO cezasi ver.
            if (rp >= 8) return techConfirm >= 3 ? -5 : -12;
            // 6-8 zone: ceza, teyit varsa hafiflet
            if (rp >= 6) return techConfirm >= 2 ? -5 : -15;
            // SAGLIKLI MOMENTUM 4-7%: TEYITLI ise +6, teyitsiz -2
            if (rp >= 4) return techConfirm >= 2 ? +6 : -2;
            // SAGLIKLI MOMENTUM 2-4%: teyitli +4
            if (rp >= 2) return techConfirm >= 1 ? +4 : 0;
            return 0; // <2% notr
          };
          const momAdjA = calcMomentumAdj(a);
          const momAdjB = calcMomentumAdj(b);
          const earlyBonusA = a._earlyPick ? 28 : 0; // Erken tespitleri TEPEDE goster
          const earlyBonusB = b._earlyPick ? 28 : 0;
          // v25: Near-breakout (coil + breakout-ready) — canlida da +18 bonus -> +35'e cikarildi
          const nearBonusA = a._nearBreakoutPick ? 35 : 0; // Kırılıma en yakinlari EN TEPEDE goster
          const nearBonusB = b._nearBreakoutPick ? 35 : 0;
          
          // ML Boost'un sıralamada etkili olması için çarpılarak puana eklenmesi
          const mlBonusA = (a.mlConfidenceBoost || 0) * 5;
          const mlBonusB = (b.mlConfidenceBoost || 0) * 5;

          const scoreA = (a.score || 0) + ((a.momentumScore || 0) * 0.2) + momAdjA + earlyBonusA + nearBonusA + mlBonusA;
          const scoreB = (b.score || 0) + ((b.momentumScore || 0) * 0.2) + momAdjB + earlyBonusB + nearBonusB + mlBonusB;
          return scoreB - scoreA;
        });

      // ── v26 FIX 4: SEKTOR KONSANTRASYON SINIRI ─────────────────────────────
      // Onceki gun: 6 picksten 4'u "Diger" sektorden geldi → sistemik risk.
      // Yeni kural: spesifik sektorlerden max 1, "Diger" (catch-all) max 3.
      // Sebep: ayni sektorde toplu dusus oldugunda 4 pick ayni anda zarar verir.
      // ISTISNA: maxBuyPicks 8 ise sectore goz yum (bull regime), 5/3 ise sıkı uygula.
      {
        const SECTOR_LIMIT = (sec) => sec === 'Diger' ? 3 : 1;
        const seenBySector = new Map();
        const sectorLimited = [];
        for (const p of buyPicks) {
          const sec = p.sector || 'Diger';
          const count = seenBySector.get(sec) || 0;
          const limit = SECTOR_LIMIT(sec);
          if (count < limit) {
            sectorLimited.push(p);
            seenBySector.set(sec, count + 1);
          }
          // Bull rejiminde 8 hedefe ulasilamiyorsa loose mode (max 2 sektor basina)
          if (sectorLimited.length >= maxBuyPicks) break;
        }
        // Eger sektor limiti yuzunden hic pick yoksa veya cok az ise (BEAR'da 0 olabilir)
        // orijinal listeden tamamla
        if (sectorLimited.length < Math.min(maxBuyPicks, buyPicks.length)) {
          for (const p of buyPicks) {
            if (sectorLimited.length >= maxBuyPicks) break;
            if (!sectorLimited.includes(p)) sectorLimited.push(p);
          }
        }
        buyPicks = sectorLimited.slice(0, maxBuyPicks);
      }

      // ── Regime-aware trim ────────────────────────────────────────────────
      // maxBuyPicks already reflects the INDEX regime (BIST100 daily change).
      // Now apply the BREADTH+MOMENTUM+MACRO regime (regime.riskMult) on top and
      // take the MORE conservative count. This shines when the two disagree —
      // e.g. index up but breadth weak (narrow rally / bull trap) → fewer picks.
      {
        // Governor maxPicksMult stacks on top of the regime cap (both are
        // conservative bounds; the tighter one wins).
        const regimeMax = Math.max(2, Math.round(
          maxBuyPicks * (regime.riskMult ?? 1) * (governor.maxPicksMult ?? 1)
        ));
        if (regimeMax < buyPicks.length) {
          pushLog({
            type: regime.regime === 'BULL' ? 'info' : 'warn',
            msg: `Rejim filtresi (${regime.regime}${governor.mode !== 'NORMAL' ? '+' + governor.mode : ''}): ${buyPicks.length} → ${regimeMax} pick (riskMult ${regime.riskMult})`,
          });
          buyPicks = buyPicks.slice(0, regimeMax);
        }
        // Tag surfaced picks with the regime + a position-size multiplier that
        // downstream sizing (calcPosition / paper engine) can honor.
        for (const p of buyPicks) {
          p._regime = regime.regime;
          // Regime risk × governor kill-switch — the sizing chain downstream
          // (calcPosition / PaperTradeEngine) multiplies position size by this.
          p._positionSizeMult = (regime.riskMult ?? 1) * (governor.positionMult ?? 1);
        }
      }

      // ── v29.2 REGIME BUY-GATE (early, on buyPicks) — pure applyRegimeGate ──
      // Olcum: AL pick'leri SADECE YUKSELIS'te pozitif; YATAY -1.7%, DUSUS -3.4%.
      // (Nihai/authoritative kapi asagida picks + finalPicks uzerinde; bu erken
      // katman sektor-diversifikasyon gurultusunu azaltir.) buyPicks buy-only oldugu
      // icin BEAR → bosalir, NEUTRAL → score>=75.
      {
        const before = buyPicks.length;
        buyPicks = applyRegimeGate(buyPicks, marketRegime);
        if (before !== buyPicks.length) {
          pushLog({ type: 'warn', msg: marketRegime === 'BEAR'
            ? `REJIM KAPISI (DUSUS): ${before} AL pick susturuldu — tarihsel dusus AL beklentisi -3.4% (%18.8 WR). Bugun kaliteli long yok.`
            : `REJIM KAPISI (YATAY): sadece score>=75 — ${before} → ${buyPicks.length} pick (YATAY'da zayif kademe -1.7% beklenti)` });
        }
      }

      // ── SELL PICKS ──
      // Kullanıcı talebi: "AI en iyi fırsatlarda sadece en güçlü 8 AL göstersin, Güçlü Sat listesini gösterme."
      const sellPicks = [];

      // ── Fallback: surface at least N buy candidates ──
      // v26 FIX 2: Rejim-bazli minimum (BULL=5, NEUTRAL=4, BEAR=2)
      // Aksi halde fallback BEAR rejimini ezerek tekrar 5'e cikariyor.
      const minBuyCount = 8;
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
            if (volTL < MICRO_CAP_MIN_VOLUME_TL) return false;
            // TAVAN/EXHAUSTION GUARD — fallbackBuys: hard reject (v19.1)
            if (isUnsafeForTomorrow(r)) return false;

            // ── v28: BUYPPICKS ILE AYNI GUVENLIK KONTROLLERI ──
            // Onceden fallbackBuys 8 guvenlik kontrolunu atliyordu.
            // Confirmed bearish
            if (r.supertrend?.trend === 'DOWN' && r.ichimoku?.cloudPosition === 'below' && r.obvTrend === 'distribution') return false;
            // Active distribution
            if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.08 && (r.rsi || 50) > 50 && r.score < 60) return false;
            // Double bearish divergence
            if (r.rsiDivergence === 'bearish' && r.obvDivergence === 'bearish') return false;
            // Distribution trap
            if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.12 && (r.change || 0) > 1 && r.score < 60) return false;
            // Exhaustion: RSI>70 + MFI>65 = koşulsuz red
            if ((r.rsi || 50) > 70 && (r.mfi || 50) > 65 && (r.change || 0) > 0.5) return false;
            // Weak rally
            if ((r.change || 0) > 3 && (r.volRatio || 1) < 0.6 && r.obvTrend === 'distribution') return false;
            // Double-day pump
            {
              const todayP = r.todayPumpReal || r.recentPump || 0;
              const yestP = r.prevDayChange || 0;
              if (todayP >= 3 && yestP >= 2 && (todayP + yestP) >= 6) {
                const hasCat = r.hasRecentInsiderBuy || r.newsCategories?.some(c => ['insider_buy', 'buyback', 'fund_inflow'].includes(c));
                if (!hasCat) return false;
              }
            }
            // Cumulative pump >= 15 without catalyst
            if ((r.cumulativePump || 0) >= 15) {
              if (!r.newsCategories?.some(c => ['fund_inflow', 'buyback', 'insider_buy', 'contract'].includes(c))) return false;
            }

            // v26 FIX 5: Basarisiz pick cooldown — fallback path da uygular
            {
              const cp = livePriceMap[r.symbol]?.price || r.price;
              const fr = checkFailedRepeat(r.symbol, cp, pickMemory);
              if (fr && fr.failed) {
                const strongReversal = (r.change || 0) > 1.5
                  && r.obvTrend === 'accumulation'
                  && (r.distFromMA20 == null || r.distFromMA20 > 0);
                if (!strongReversal) return false;
              }
            }
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
            _nearBreakoutPick: r._nearBreakout?.isNear || false,
            _nearBreakoutSignals: r._nearBreakout?.signals || null,
            _nearBreakoutCount: r._nearBreakout?.count || 0,
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
      if (picks.length < 5) {
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
          _nearBreakoutPick: r._nearBreakout?.isNear || false,
          _nearBreakoutSignals: r._nearBreakout?.signals || null,
          _nearBreakoutCount: r._nearBreakout?.count || 0,
        }));
        picks = [...picks, ...lastResort];
      }

      // ══════════════════════════════════════════════════════════════════════
      // ── ACIL YEDEK (v26 — ENHANCED) — HEMEN 5 HISSE GOSTER ─────────────────
      // ══════════════════════════════════════════════════════════════════════
      // Tavan günü gibi tüm filtrelerin elediği oturumlarda bile "yarın +%4-5"
      // yapma potansiyeli yüksek hisseler vardır — kullanıcıya boş ekran gösterme.
      // Hisse yok ise: AGRESIF TARAMA
      //   TIER 1: 200K+ TL hacim + atrPct>=0.4 (daha ucuz hisseler bile kabul)
      //   TIER 2: 100K+ TL hacim (son çare — likit değil ama hareketli)
      // Tavan/bearish filtrelerini BYPASS et, ⚠ "⚡ YARIN UMUT" rozetiyle göster
      // v26: picks boş ise DAIMA emergency fallback çalıştır
      // v27: TOP 5 garantisi — picks 5'ten azsa eksikleri emergency ile doldur
      if (picks.length < 5) {
        const existingSyms3 = new Set(picks.map(p => p.symbol));
        const need = 5 - picks.length;

        // TIER 1: daha makul hacim + volatilite
        let emergencyPool = results
          .filter(r => {
            if (existingSyms3.has(r.symbol)) return false;
            if ((r.avgVolumeTL || 0) < 200_000) return false; // 200K TL min (eski 500K)
            if ((r.atrPct || 0) < 0.4) return false; // Yarın hareket edemeyecek hisseyi al (eski 0.6)
            if (r.cls === 'sell') return false;
            // v28: emergency de temel güvenlik kontrollerini uygular
            if ((r.rsi || 50) > 80) return false;
            if ((r.mfi || 50) > 80) return false;
            if (isUnsafeForTomorrow(r)) return false;
            // Confirmed bearish
            if (r.supertrend?.trend === 'DOWN' && r.ichimoku?.cloudPosition === 'below' && r.obvTrend === 'distribution') return false;
            // Active distribution
            if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.08 && (r.rsi || 50) > 50 && r.score < 60) return false;
            // Double bearish divergence
            if (r.rsiDivergence === 'bearish' && r.obvDivergence === 'bearish') return false;
            // Exhaustion: RSI>70 + MFI>65
            if ((r.rsi || 50) > 70 && (r.mfi || 50) > 65 && (r.change || 0) > 0.5) return false;
            return true;
          })
          .map(r => {
            // Acil yedek skor: YARINDA +%4-5 YAPMA İHTİMALİ PRİMER
            const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
            const tomorrowP = calcTomorrowPotential(r);
            // v26: tomorrowPotential %50'ye çıkartıldı (eski %30)
            let emergScore = (r.score || 0) * 0.25 + (r.confidence || 50) * 0.25 + tomorrowP * 0.50;
            // Bonus: trend onayı varsa
            if (r.supertrend?.trend === 'UP') emergScore += 8;
            if (r.obvTrend === 'accumulation') emergScore += 6;
            if ((r.cmf || 0) > 0.10) emergScore += 5;
            // Bonus: RSI sweet spot (35-55) = yarın başarılı trade ihtimali yüksek
            const rsi = r.rsi || 50;
            if (rsi >= 35 && rsi <= 55) emergScore += 7;
            // Bonus: pump bölgesinde devam ihtimali yüksekse
            if (rp >= 7) {
              const cprob = calcContinuationProbability(r);
              if (cprob && cprob >= 50) emergScore += 12;
              else if (cprob && cprob >= 38) emergScore += 6;
            }
            // Bonus: mevcut buy sinyali / momentum
            if (r.cls === 'buy') emergScore += 10;
            // Bonus: pozitif teknik konfluens
            const confCount = (r.obvTrend === 'accumulation' ? 1 : 0) + ((r.cmf || 0) > 0.05 ? 1 : 0) + (r.supertrend?.trend === 'UP' ? 1 : 0);
            if (confCount >= 2) emergScore += 6;
            return { ...r, _emergencyScore: emergScore };
          })
          .sort((a, b) => b._emergencyScore - a._emergencyScore);

        // TIER 1 ne kadar yeterli?
        const tier1 = emergencyPool.slice(0, need);
        let finalEmergency = tier1;

        // TIER 2: 100K+ TL hacim ise hala kiraç — son çare (hile değil, gerçek fırsat)
        if (finalEmergency.length < need) {
          const need2 = need - finalEmergency.length;
          const tier2 = results
            .filter(r => {
              if (existingSyms3.has(r.symbol)) return false;
              if (finalEmergency.some(e => e.symbol === r.symbol)) return false;
              if ((r.avgVolumeTL || 0) < 100_000) return false; // 100K TL min (son çare)
              if ((r.atrPct || 0) < 0.3) return false;
              if (r.cls === 'sell') return false;
              // v28: tier2 de aynı güvenlik kontrolleri
              if ((r.rsi || 50) > 80) return false;
              if ((r.mfi || 50) > 80) return false;
              if (isUnsafeForTomorrow(r)) return false;
              if (r.supertrend?.trend === 'DOWN' && r.ichimoku?.cloudPosition === 'below' && r.obvTrend === 'distribution') return false;
              if (r.obvTrend === 'distribution' && (r.cmf || 0) < -0.08 && (r.rsi || 50) > 50 && r.score < 60) return false;
              if (r.rsiDivergence === 'bearish' && r.obvDivergence === 'bearish') return false;
              if ((r.rsi || 50) > 70 && (r.mfi || 50) > 65 && (r.change || 0) > 0.5) return false;
              return true;
            })
            .map(r => {
              const rp = Math.max(r.todayPumpReal || 0, r.recentPump || 0);
              const tomorrowP = calcTomorrowPotential(r);
              let emergScore = (r.score || 0) * 0.20 + (r.confidence || 50) * 0.20 + tomorrowP * 0.60;
              if (r.supertrend?.trend === 'UP') emergScore += 6;
              if (r.obvTrend === 'accumulation') emergScore += 4;
              if ((r.cmf || 0) > 0.10) emergScore += 3;
              const rsi = r.rsi || 50;
              if (rsi >= 35 && rsi <= 55) emergScore += 5;
              if (rp >= 7) {
                const cprob = calcContinuationProbability(r);
                if (cprob && cprob >= 50) emergScore += 8;
              }
              if (r.cls === 'buy') emergScore += 8;
              return { ...r, _emergencyScore: emergScore };
            })
            .sort((a, b) => b._emergencyScore - a._emergencyScore)
            .slice(0, need2);
          finalEmergency = [...tier1, ...tier2];
        }

        const emergency = finalEmergency.map(r => normalizeStopTarget({
          ...r,
          tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
          _alreadyHolding: bullishPortfolio.includes(r.symbol),
          _scanMode: isAfterHours ? 'afterHours' : 'intraday',
          _fallback: true,
          _emergencyPick: true,  // ⚡ "YARIN UMUT" rozeti (not just warning)
          _warningPick: false,   // v26: warning değil, fırsat!
          _earlyPick: r._earlyAccumulation?.isEarly || false,
          _earlySignals: r._earlyAccumulation?.signals || null,
          _earlyCount: r._earlyAccumulation?.count || 0,
          _nearBreakoutPick: r._nearBreakout?.isNear || false,
          _nearBreakoutSignals: r._nearBreakout?.signals || null,
          _nearBreakoutCount: r._nearBreakout?.count || 0,
        }));
        picks = [...picks, ...emergency];
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
        let entryQuality = pump <= 1 ? 95 : pump <= 2 ? 85 : pump <= 3 ? 60 : pump <= 4 ? 40 : pump <= 5 ? 25 : pump <= 7 ? 15 : 5;
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
        // RSI durumu — v28: overbought cezalari sertlestirildi
        if (rsi > 75) momentumHealth -= 30;
        else if (rsi > 68) momentumHealth -= 15;
        else if (rsi > 62) momentumHealth -= 8;
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

        // ── MACRO RISK ADJUSTMENT ──
        let macroAdj = 0;
        if (macroCtx?.scoreAdjust) {
          macroAdj = isSell ? -macroCtx.scoreAdjust : macroCtx.scoreAdjust;
        }

        let confidence = Math.round(
          techComponent + potentialComponent + sectorComponent +
          newsComponent + entryComponent + liqComponent + healthComponent + macroAdj
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

        // STAGNANT CEZASI: 3+ gundur onerilen ama ilerlemeyen pick — olu
        // sermaye. Bloklamayiz, taze setup'larin arkasina duser.
        if (p._stagnantPick) confidence = Math.max(5, confidence - 8);

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
            macro: Math.round(macroAdj),
            foreignFlow: 0, // enrichment asamasinda guncellenir
          },
        };
      };

      picks = picks.map(enhancePick);

      // ── v28: D GRADE BUY ELEMESİ ──────────────────────────────────────
      // D grade (confidence < 55) buy pick'leri listeden cikar.
      // D grade = dusuk teknik + dusuk entry quality + dusuk momentum health.
      // Bu hisseler istisnasiz yarinki dususe aday — CMBTN, DGGYO gibi
      // D grade picklerin hepsi ertesi gun negatif kapandi.
      // SELL pickleri korunur (D grade sell hala valid sinyal).
      {
        const beforeCount = picks.length;
        picks = picks.filter(p => p.cls === 'sell' || p.grade !== 'D');
        const removed = beforeCount - picks.length;
        if (removed > 0) {
          pushLog({ type: 'info', msg: `v28 D-grade filtresi: ${removed} dusuk kaliteli pick elendi` });
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      //  MACRO SCORE ADJUSTMENT — USDTRY/VIX/TCMB regime
      // ══════════════════════════════════════════════════════════════════════
      // Risk-off macro: BUY picks lose 6-15 confidence. Risk-on: +4 to +8.
      // SELL picks unaffected (macro stress validates short bias).
      if (macroCtx && typeof macroCtx.scoreAdjust === 'number' && macroCtx.scoreAdjust !== 0) {
        picks = picks.map(p => {
          if (p.cls === 'sell') return { ...p, _macroAdjust: 0, _macroRegime: macroCtx.regime };
          const adjusted = Math.max(0, Math.min(100, (p.confidence || 50) + macroCtx.scoreAdjust));
          const grade = adjusted >= 75 ? 'A' : adjusted >= 65 ? 'B' : adjusted >= 55 ? 'C' : 'D';
          const tier = adjusted >= 75 ? 'STRONG' : adjusted >= 65 ? 'GOOD' : adjusted >= 55 ? 'FAIR' : 'WEAK';
          return {
            ...p,
            confidence: adjusted,
            grade,
            tier,
            _macroAdjust: macroCtx.scoreAdjust,
            _macroRegime: macroCtx.regime,
          };
        });
      }

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
        // v29 PLATFORM PARITY: getMlRules returns the Electron live DB rules when
        // available, else a bundled static snapshot (src/data/mlRules.json) so
        // web/mobile apply the SAME ML boost as desktop — identical picks everywhere.
        const { getMlRules } = await import('../utils/mlRules.js');
        const { rules: mlRules, source: mlSource } = await getMlRules(10);
        {
          console.log(`[AI Advisor] ML rules loaded: ${mlRules?.length || 0} rules (source: ${mlSource})`);
          if (mlRules?.length) {
            // ── v29 ML REJIM-KAPISI (regime-aware boost) ──────────────────────
            // ML kurallari 3 yillik veriyle (bogadonemi dahil) egitildi; en yuksek
            // beklentili kurallar ASIRI ALIM momentum setuplari (RSI_OVERBOUGHT,
            // MFI_HIGH — %71-90 WR). Ama v29 backtest'i son 6 ay choppy'de bu
            // pattern'in %20 WR verdigini gosterdi. Cozum: asiri-alim momentum
            // kurallarini SADECE teyitli yukselis trendinde uygula
            // (ADX>25 + supertrend UP + haftalik bull). Ortak helper: filterRulesForRegime.
            const { filterRulesForRegime } = await import('../utils/ML_BacktestEngine.js');
            let mlMatched = 0;
            let mlGatedCount = 0;
            picks = picks.map(p => {
              const { rules: rulesForPick, gated } = filterRulesForRegime(mlRules, {
                adx: p.adx,
                supertrendTrend: p.supertrend?.trend,
                weeklyTrend: p.weeklyTrend,
              });
              const result = scoreNewSignal(p, rulesForPick);
              if (gated) mlGatedCount++;
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
                    totalCount: best.totalCount || 0, // rule's historical backtest sample count ("N örnek")
                  } : null,
                  mlMatchedCount: result.ruleCount,
                  // v29: asiri-alim momentum kurallari bu pick icin devre disi mi?
                  mlRegimeGated: gated,
                };
              }
              // No ML match → standard signal, no badge
              return { ...p, mlConfidenceBoost: 0, mlBestRule: null, mlMatchedCount: 0, mlRegimeGated: gated };
            });
            console.log(`[AI Advisor] ML scoring: ${mlMatched}/${picks.length} picks matched rules; rejim-kapisi ${mlGatedCount} pick'te asiri-alim momentum kurallarini devre disi birakti`);
          } else {
            console.log('[AI Advisor] ML scoring skipped: no rules available (empty snapshot + no Electron DB)');
          }
        }
      } catch (mlErr) {
        // ML scoring is best-effort — never block the scan pipeline
        console.warn('[AI Advisor] ML scoring skipped:', mlErr?.message);
      }

      // ── Apply Unified Decision (same logic as Single Stock Analysis) ──
      // When ML rules match, override cls/signal so AI Advisor and AnalyzeTab
      // produce IDENTICAL labels for the same stock.
      try {
        const { getUnifiedDecision } = await import('../utils/unifiedDecision.js');
        picks = picks.map(p => {
          const u = getUnifiedDecision(p.score, p.mlConfidenceBoost, {
            mlMatchedCount: p.mlMatchedCount,
            baseSignal: p.signal,
            baseCls: p.cls,
          });
          return { ...p, cls: u.cls, signal: u.signal, unifiedSource: u.source, unifiedOverride: u.override };
        });
      } catch (uErr) {
        console.warn('[AI Advisor] Unified decision skipped:', uErr?.message);
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

      // ── Correlation de-dup (concentration risk, #8) ──
      // Sector caps catch obvious clustering, but two names in DIFFERENT sectors
      // can still move together (corr > 0.90 = effectively one bet). Demote the
      // lower-confidence duplicate to overflow — never delete — and annotate why,
      // mirroring how stale/adverse picks are surfaced rather than hidden.
      let primaryBuys = diversifiedBuys;
      try {
        const withSeries = diversifiedBuys.map(p => ({ ...p, series: p.closeSeries }));
        const { dropped } = correlationCapFilter(withSeries, 0.90);
        if (dropped.length) {
          const dropMap = new Map(dropped.map(d => [d.symbol, d]));
          primaryBuys = [];
          for (const p of diversifiedBuys) {
            const d = dropMap.get(p.symbol);
            if (d) overflowBuys.push({ ...p, _corrDup: true, _corrWith: d.conflictsWith, _corrVal: d.corr });
            else primaryBuys.push(p);
          }
          pushLog({ type: 'warn', msg: `${dropped.length} pick yuksek korelasyon (>0.90) ile alt sıraya alındı — aynı bahis tekrarını onler` });
        }
      } catch { /* correlation de-dup best-effort */ }

      // Try to fill picks list with diverse sectors first, then overflow
      const sellsInPicks = picks.filter(x => x.cls === 'sell');
      picks = [...primaryBuys, ...overflowBuys, ...sellsInPicks];

      // ── FINAL SORT (v25) ──
      // 3 Bucket sistemi:
      //   1. Sells → her zaman en sona
      //   2. NORMAL picks (tp < 9%) → confidence sort
      //   3. PUMP picks (tp >= 9%) → 2 alt-bucket:
      //      a. Yuksek devam (prob >= 50%) → confidence ile NORMAL picks arasinda yer alir
      //         (hibrit skor: confidence * (prob/50) ile boost)
      //      b. Dusuk devam (prob < 50%) → en sona
      //
      // KRITIK v25 degisiklik: Yuksek devam ihtimali olan pump picks artik
      // confidence skoruna gore NORMAL picks ile beraber siralanir. Boylece
      // CCOLA gibi tavan + kataliz + akilli para hisseleri top 5'e girebilir.
      // ── v29 KONVIKSIYON KADEMELENDIRME (backtest-driven) ──
      // Trade simulasyonu: Score>=75 (GUCLU AL) %62.5 WR / +0.77% beklenti (POZITIF),
      // Score 65-74 (AL) %27-29 WR / -0.9% (yatay piyasada yazi-tura). Kullanici
      // karari: 65-74 pick'ler gosterilsin ama etiketlensin + geri siralansin.
      // sniper = 75+ (nokta atisi), flagged = 65-74 (dusuk konviksiyon buy tier),
      // early = 65 alti erken/acil pick'ler (kendi rozetleri var, bu etiket verilmez).
      for (const p of picks) {
        if (p.cls === 'sell') { p.convictionTier = 'sell'; continue; }
        const sigScore = p.score || 0;
        const isSniper = sigScore >= 75 || (p.signal && p.signal.includes('GUCLU AL'));
        if (isSniper) { p.convictionTier = 'sniper'; p.convictionLabel = 'NOKTA ATISI'; }
        else if (sigScore >= 65) { p.convictionTier = 'flagged'; p.convictionLabel = 'DUSUK KONVIKSIYON'; }
        else { p.convictionTier = 'early'; p.convictionLabel = ''; }
      }
      // Yumusak konviksiyon bonusu (erken/near-breakout bonuslarini EZMEZ, onlarla toplanir):
      // sniper +20 one gecer, flagged -8 geri kalir, early notr (kendi bonusu var).
      const convictionBonus = (pick) => {
        if (pick.convictionTier === 'sniper') return 20;
        if (pick.convictionTier === 'flagged') return -8;
        return 0;
      };

      picks.sort((a, b) => {
        // Sells: her zaman en sona
        if (a.cls === 'sell' && b.cls !== 'sell') return 1;
        if (b.cls === 'sell' && a.cls !== 'sell') return -1;

        const aPump = a.todayPumpReal || 0;
        const bPump = b.todayPumpReal || 0;
        const aIsHighPump = aPump >= 9;
        const bIsHighPump = bPump >= 9;

        // Devam ihtimali yuksek olan pump pick: confidence'a +%30 bonus uygula
        // (effective confidence ile NORMAL picks ile rekabet eder)
        const effConf = (pick) => {
          const baseConf = pick.confidence || 0;
          const pump = pick.todayPumpReal || 0;
          const prob = pick.continuationProbability;
          if (pump < 9 || prob == null) return baseConf;
          // Yuksek devam (>=50%): boost = %30 (top tier)
          // Orta devam (38-50%): boost = %15 (mid tier)
          // Dusuk devam (<38%): boost = -%30 (en sonda kalsin)
          if (prob >= 50) return baseConf * 1.30;
          if (prob >= 38) return baseConf * 1.15;
          return baseConf * 0.70;
        };

        // Cok dusuk devam (prob < 38) hala arkaya it
        const aIsWeakPump = aIsHighPump && (a.continuationProbability || 0) < 38;
        const bIsWeakPump = bIsHighPump && (b.continuationProbability || 0) < 38;
        if (aIsWeakPump && !bIsWeakPump) return 1;
        if (bIsWeakPump && !aIsWeakPump) return -1;
        // Iki pick de zayif pump: continuation prob ile sirala
        if (aIsWeakPump && bIsWeakPump) {
          return (b.continuationProbability || 0) - (a.continuationProbability || 0);
        }

        // Erken birikim / near-breakout: nihai sirada da once kalsin
        // buyPicks.sort()'ta +12/+14 bonus verildi ama final sort
        // bunlari siler — burada ayni bonusu yeniden uyguluyoruz.
        const earlyConfBonus = (pick) => {
          if (pick._nearBreakoutPick) return 15; // Kirilim hazir: en yuksek oncelik
          if (pick._earlyPick) return 10;         // Erken birikim: ikinci oncelik
          return 0;
        };

        // Normal yarisma: effective confidence + erken birikim + konviksiyon bonusu
        return (effConf(b) + earlyConfBonus(b) + convictionBonus(b))
             - (effConf(a) + earlyConfBonus(a) + convictionBonus(a));
      });

      // Cap final picks at 10
      picks = picks.slice(0, 10);

      // ── v26 FIX 6: FINAL PICK PER-SYMBOL FIYAT REFRESH ──────────────────────
      // SORUN: Market kapaliyken batch (fetchBigParaBatchPrices) son=0 -> price=0
      // donduruyor (v22). Scan o zaman Yahoo'nun gecikmeli kapanisini kullaniyor
      // -> JANTS 18.74 gibi BAYAT fiyat persist ediliyor.
      // COZUM: Sadece final 10 pick icin per-symbol fetchBigParaQuote cagir.
      // Per-symbol "hisseyuzeysel" endpoint'i kapanis = BUGUNKU dogru kapanis/canli
      // fiyat (batch'ten FARKLI, dogru semantik). 10 cagri ~2-3s, kabul edilebilir.
      // Stop/target mutlak TL seviyeleri sabit; sadece % ve rr yeniden hesaplanir.
      const _withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('enrichment timeout')), ms)),
      ]);
      // ── PARALLEL ENRICHMENT ──
      // Price refresh, news, foreign flow, insider are independent — run all at once.
      // Each has its own 12s timeout; total enrichment capped at ~12s instead of ~45s sequential.
      const enrichTimeout = 12_000;
      const enrichResults = await Promise.allSettled([
        // [0] Price refresh
        _withTimeout((async () => {
          const priceResults = await Promise.allSettled(
            picks.map(p => fetchBigParaQuote(p.symbol)
              .then(q => ({ sym: p.symbol, q }))
              .catch(() => ({ sym: p.symbol, q: null })))
          );
          const freshPrices = {};
          for (const res of priceResults) {
            if (res.status === 'fulfilled' && res.value?.q?.price > 0) {
              freshPrices[res.value.sym] = res.value.q;
            }
          }
          for (const p of picks) {
            const q = freshPrices[p.symbol];
            if (!q || !(q.price > 0)) continue;
            const newPrice = q.price;
            if (Math.abs(newPrice - (p.price || 0)) / (p.price || 1) > 0.001) {
              p.price = newPrice;
              if (q.change != null && isFinite(q.change)) p.change = q.change;
              if (p.stop && newPrice > 0) {
                p.stopPct = ((p.stop - newPrice) / newPrice) * 100;
              }
              if (p.target && newPrice > 0) {
                p.targetPct = ((p.target - newPrice) / newPrice) * 100;
              }
              const riskD = Math.abs(newPrice - (p.stop || newPrice * 0.95));
              const rewD  = Math.abs((p.target || newPrice * 1.10) - newPrice);
              if (riskD > 0) p.rr = rewD / riskD;
              const refreshedNet = netRR(newPrice, p.stop || newPrice * 0.95, p.target || newPrice * 1.10);
              if (refreshedNet != null) p.rrNet = Math.round(refreshedNet * 100) / 100;
              p._priceRefreshed = true;
            }
          }
        })(), enrichTimeout),

        // [1] News
        _withTimeout((async () => {
          const universe = picks.map(p => p.symbol);
          if (!universe.length) return;
          const news = await fetchMarketNews({ universe, maxPerSource: 25 });
          const ni = indexBySymbol(news);
          for (const r of picks) {
            const e = ni[r.symbol];
            if (e?.count) {
              r.newsScore = e.score;
              r.newsCount = e.count;
              r.newsCategories = e.categories;
              r.newsHeadline = e.topItem?.title || '';
              r.newsHighImpact = e.highImpact;
            }
          }
        })(), enrichTimeout),

        // [2] Foreign flow — derinlemesine analiz (skorlama: pure computeForeignFlowScore)
        _withTimeout((async () => {
          const { fetchAllForeignRatios, computeForeignFlowScore } = await import('../utils/foreignFlowEngine.js');
          const foreignMap = await fetchAllForeignRatios();
          for (const p of picks) {
            const fr = foreignMap[p.symbol];
            if (!fr) continue;
            p.foreignRatio = fr.ratio;
            p.foreignChangeDay = fr.changeDay;
            p.foreignChangeWeek = fr.changeWeek;
            p.foreignChangeMonth = fr.changeMonth;

            const { score, label, confDelta } = computeForeignFlowScore(fr);
            p.foreignFlowScore = score;
            p.foreignFlowLabel = label;
            p.confidence = Math.max(0, Math.min(100, (p.confidence || 50) + confDelta));
            if (p.confidenceBreakdown) p.confidenceBreakdown.foreignFlow = confDelta;
          }
        })(), enrichTimeout),

        // [3] Insider trading
        _withTimeout((async () => {
          const insiderSymbols = picks.map(p => p.symbol);
          if (!insiderSymbols.length) return;
          const insiderMap = await fetchInsiderBatch(insiderSymbols, 5);
          for (const p of picks) {
            const ins = insiderMap.get(p.symbol);
            if (!ins) continue;
            p.insiderScore = ins.score;
            p.insiderNetBuys = ins.insiderNetBuys;
            p.hasRecentInsiderBuy = ins.hasRecentInsiderBuy;
            p.hasRecentInsiderSell = ins.hasRecentInsiderSell;
            p.insiderTransactions = ins.transactions?.slice(0, 5) || [];

            if (ins.score >= 5) {
              p.confidence = Math.min(100, (p.confidence || 50) + 8);
            } else if (ins.score >= 3) {
              p.confidence = Math.min(100, (p.confidence || 50) + 4);
            } else if (ins.score <= -5) {
              p.confidence = Math.max(5, (p.confidence || 50) - 6);
            } else if (ins.score <= -3) {
              p.confidence = Math.max(5, (p.confidence || 50) - 3);
            }

            if (ins.hasRecentInsiderBuy && !p.newsCategories?.includes('insider_buy')) {
              p.newsCategories = [...(p.newsCategories || []), 'insider_buy'];
            }
          }
        })(), enrichTimeout),
      ]);
      const enrichFailed = enrichResults.filter(r => r.status === 'rejected').length;
      if (enrichFailed) console.warn(`[AIAdvisor] ${enrichFailed}/4 enrichment steps failed`);

      // ── Claude grade (WS8) — structured A/B/C on the final picks ──
      // Best-effort with a hard timeout: no API key / proxy → skipped silently.
      // The grade rides into the forward journal (byClaudeGrade), and once the
      // journal PROVES the A-vs-C spread (n>=30, >=10pt) it earns influence on
      // confidence + position sizing. Below that floor: annotation only.
      try {
        const { askDailyPicks, getApiKey } = await import('../utils/claude.js');
        if (picks.length && getApiKey()) {
          const graded = await Promise.race([
            askDailyPicks(picks, { marketSentiment: sentimentObj }),
            new Promise(r => setTimeout(() => r(null), 25_000)),
          ]);
          if (graded?.structured && Array.isArray(graded.grades)) {
            const gradeMap = {};
            for (const g of graded.grades) gradeMap[g.symbol] = g;
            const jStats = journalStats(loadJournal());
            const cg = jStats.byClaudeGrade || {};
            const gradeProven = (cg.A?.total >= 30) && (cg.C?.total > 0)
              && ((cg.A.accuracy - (cg.C?.accuracy ?? 50)) >= 10);
            for (const p of picks) {
              const g = gradeMap[p.symbol];
              if (!g) continue;
              p.claudeGrade = g.grade;
              p.claudeGradeReason = g.reason;
              if (gradeProven) {
                if (g.grade === 'A') {
                  p.confidence = Math.min(100, (p.confidence || 50) + 5);
                  p._positionSizeMult = (p._positionSizeMult ?? 1) * 1.15;
                } else if (g.grade === 'C') {
                  p.confidence = Math.max(5, (p.confidence || 50) - 5);
                  p._positionSizeMult = (p._positionSizeMult ?? 1) * 0.85;
                }
              }
            }
            pushLog({ type: 'info', msg: `Claude notlari: ${graded.grades.map(g => `${g.symbol}=${g.grade}`).join(' ')}${gradeProven ? ' (kanitli etki aktif)' : ' (sadece anotasyon)'}` });
          }
        }
      } catch { /* LLM grading is best-effort — never block a scan */ }

      // ── v29 FIX: Only reclassify picks that have a genuine buy reason ──
      // _earlyPick veya _mlOverride gibi ozel sebeplerle listeye giren TUT hisseler
      // SADECE bu ozel sebep varsa AL yapilir — aksi halde TUT olarak gosterilir
      picks = picks.map(p => {
        if (p.cls === 'sell') return p;
        if (p.cls === 'buy') return p; // zaten AL
        // TUT/hold ise: sadece earlyPick veya ML override varsa AL yap
        if (p._earlyPick || p._mlOverride || p.score >= 55) {
          let sig = p.signal || 'AL';
          if (!sig.includes('AL') && !sig.includes('SAT')) sig = 'ZAYIF AL';
          return { ...p, cls: 'buy', signal: sig };
        }
        return p; // TUT olarak birak
      });

      // ── v29.2 REGIME BUY-GATE (panel/state picks) — pure applyRegimeGate ─────
      // picks buy-odakli liste (setTopPicks → panel "AI FIRSATLAR"). BEAR'da
      // buy'lari cikar → panel DUSUS bos-state gosterir. NEUTRAL'da sadece
      // score>=75. Ayrica asagida finalPicks (dispatch) ayni kapiden gecer.
      {
        const before = picks.length;
        picks = applyRegimeGate(picks, marketRegime);
        if (before !== picks.length) {
          pushLog({ type: 'warn', msg: marketRegime === 'BEAR'
            ? `REJIM KAPISI (DUSUS): ${before - picks.length} AL pick susturuldu — dusus rejiminde AL tarihsel -3.4% (%18.8 WR). Bugun kaliteli long yok.`
            : `REJIM KAPISI (YATAY): sadece score>=75 — ${before} → ${picks.length} pick (yatayda zayif AL -1.7% beklenti)` });
        }
      }

      setScanResults(results);
      setTopPicks(picks);
      setMarketSentiment(sentimentObj);
      setSectorHeatmap(sectorMetrics);
      setLastUpdate(new Date());

      // Sektör güç haritasını bir sonraki tarama için kaydet.
      // Sonraki taramada her sembolün genSignal'ı sektör gücünü görür ve skora yansır.
      // `strength` kullan: 0-100 composite (avgScore değil — o sadece ~40-60 arası).
      // genSignal eşikleri: >=80 → +1.5, >=70 → +1.0, <=20 → -1.5, <=30 → -1.0
      try {
        const newSectorMap = {};
        for (const sm of rankSectors(sectorMetrics)) {
          // strength: calcSectorMetrics'in 0-100 composite skoru
          // avgScore: genSignal sinyal ortalaması (genellikle 40-65 arası, genSignal'a uygun)
          // Her ikisini normalize ederek genSignal'ın 0-100 beklentisine uyarla:
          const strengthVal = sm.strength != null ? sm.strength : (sm.avgScore || 0);
          newSectorMap[sm.sector] = strengthVal;
        }
        prevSectorMapRef.current = newSectorMap;
      } catch { /* ignore */ }

      // Persist top picks to localStorage so the bottom panel survives page reload.
      // ALSO persist a compact verdict map for ALL scanned symbols — so Tekil Analiz
      // for ANY symbol (not just top-10) can inherit the advisor's cls/signal/score.
      if (picks.length > 0 || results.length > 0) {
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
              _nearBreakoutPick: p._nearBreakoutPick, _nearBreakoutSignals: p._nearBreakoutSignals, _nearBreakoutCount: p._nearBreakoutCount,
              _emergencyPick: p._emergencyPick,
              recentPump: p.recentPump, cumulativePump: p.cumulativePump,
              prevDayChange: p.prevDayChange, // v26 FIX 3: 2-day exhaustion icin
              todayPumpReal: p.todayPumpReal,
              continuationProbability: p.continuationProbability,
              rsi: p.rsi, mfi: p.mfi, cmf: p.cmf, volRatio: p.volRatio,
              obvTrend: p.obvTrend, supertrend: p.supertrend,
              insiderScore: p.insiderScore, insiderNetBuys: p.insiderNetBuys,
              hasRecentInsiderBuy: p.hasRecentInsiderBuy, hasRecentInsiderSell: p.hasRecentInsiderSell,
              mlConfidenceBoost: p.mlConfidenceBoost, mlBestRule: p.mlBestRule,
              mlMatchedCount: p.mlMatchedCount, mlRegimeGated: p.mlRegimeGated,
              foreignRatio: p.foreignRatio, foreignChangeDay: p.foreignChangeDay,
              foreignChangeWeek: p.foreignChangeWeek, foreignChangeMonth: p.foreignChangeMonth,
              foreignFlowScore: p.foreignFlowScore, foreignFlowLabel: p.foreignFlowLabel,
              convictionTier: p.convictionTier, convictionLabel: p.convictionLabel,
            })),
            // ── COMPACT VERDICT MAP — ALL scanned symbols ──
            // Tekil Analiz icin kullanilir: herhangi bir hisse ne karar aldi?
            // Sadece minimal alanlar — quota patlamasin.
            allVerdicts: results.reduce((acc, r) => {
              if (r?.symbol) {
                acc[r.symbol] = {
                  cls: r.cls,
                  signal: r.signal,
                  score: r.score,
                  confidence: r.confidence,
                  rr: r.rr,
                  rrNet: r.rrNet,
                  claudeGrade: r.claudeGrade,
                  stop: r.stop,
                  target: r.target,
                  mlConfidenceBoost: r.mlConfidenceBoost,
                  mlMatchedCount: r.mlMatchedCount,
                  mlBestRule: r.mlBestRule,
                  // HTF + timing — tekil analizde göster
                  htfTrend: r.htfTrend,
                  htfWeeklyTrend: r.htfWeeklyTrend,
                  entryTimingScore: r.entryTimingScore,
                  entryTimingLabel: r.entryTimingLabel,
                };
              }
              return acc;
            }, {}),
            sentiment: sentimentObj.sentiment,
            scanned: results.length,
            buys: sentimentObj.buys,
            sells: sentimentObj.sells,
            ts: Date.now(),
          }));
        } catch { /* localStorage full or unavailable */ }
      }

      // ── v26 FIX 5: Pick hafizasini guncelle ─────────────────────────────────
      // Onerilen her BUY pick'in oneri fiyati + tarihi kaydedilir. Bir sonraki
      // tarama bu hisseyi "yakinda onerildi mi + dustu mu" diye kontrol eder.
      try {
        const now = Date.now();
        const buyFinal = (picks || []).filter(p => p.cls !== 'sell');
        for (const p of buyFinal) {
          const prev = pickMemory[p.symbol];
          pickMemory[p.symbol] = {
            recPrice:      p._livePrice || p.price || prev?.recPrice || 0,
            firstRecPrice: prev?.firstRecPrice || p._livePrice || p.price || 0,
            firstRecTs:    prev?.firstRecTs || now,
            lastRecTs:     now,
            recCount:      (prev?.recCount || 0) + 1,
          };
        }
        savePickMemory(pickMemory);
      } catch { /* memory update best-effort */ }

      const modeLabel = isAfterHours ? 'Kapanis Sonrasi (Yarin Icin)' : 'Canli';
      pushLog({ type: 'ok', msg: `${modeLabel} tarama: ${results.length} hisse, ${buyPicks.length} AL / ${sellPicks.length} SAT firsat` });
      if (_failedRepeatBlocked > 0) {
        pushLog({ type: 'warn', msg: `${_failedRepeatBlocked} hisse "tekrar dusus" cooldown'una takildi (onceden onerildi + dustu)` });
      }

      // ── Strict event dispatch for ALL downstream systems ──
      // Subscribers: useSignalTracker, usePaperTrading, usePaperTradeML,
      //              AIAdvisorPanel, TradesTab, AlertLog, ChatPanel
      //
      // Multi-source fallback chain (prevents empty payloads when late-stage
      // filters drop all picks):
      //   1. `picks` — the same array fed to setTopPicks() (PREFERRED)
      //   2. [...buyPicks, ...sellPicks] — pre-diversification tradable list
      //   3. results.filter(buy|sell) — raw scan output
      let finalPicks = [];
      if (Array.isArray(picks) && picks.length > 0) {
        finalPicks = picks;
      } else if ((Array.isArray(buyPicks) && buyPicks.length) ||
                 (Array.isArray(sellPicks) && sellPicks.length)) {
        finalPicks = [...(buyPicks || []), ...(sellPicks || [])].slice(0, 10);
        console.warn('[AI Advisor] picks[] was empty — falling back to buyPicks+sellPicks');
      } else if (Array.isArray(results) && results.length > 0) {
        // BUY-SIDE FIRST. The old fallback sorted ALL results by confidence, which
        // let high-confidence SELLS dominate the list (e.g. VESTL/sell at #1) — so
        // the panel and signal tracker filled with sells instead of opportunities.
        // Surface the best non-sell candidates (score>=45) first, then a few sells.
        const buyish = results
          .filter(r => r && r.cls !== 'sell' && (r.score || 0) >= 45)
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        const sellish = results
          .filter(r => r && r.cls === 'sell')
          .sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
        finalPicks = [...buyish, ...sellish].slice(0, 10);
        console.warn(`[AI Advisor] picks[] empty — derived ${buyish.length} buy-side + ${sellish.length} sell from results`);
      }

      // ── v29.2 REGIME BUY-GATE — TEK CIKIS KAPISI (pure applyRegimeGate) ──
      // buyPicks'teki erken gate lastResort/emergency/fallback ile bypass ediliyordu.
      // Burasi finalPicks'in TUM kaynaklardan birlestigi tek nokta — dispatch oncesi.
      // Olcum: AL pick'leri SADECE YUKSELIS'te pozitif; YATAY -1.7%, DUSUS -3.4%.
      {
        const before = finalPicks.length;
        finalPicks = applyRegimeGate(finalPicks, marketRegime);
        if (before !== finalPicks.length) {
          console.warn(`[AI Advisor] REJIM KAPISI (${regimeLabel(marketRegime)}): ${before - finalPicks.length} AL pick susturuldu (dispatch)`);
        }
      }

      const allResults = Array.isArray(results) ? results : [];
      console.log('[AI Advisor] Dispatch payload sizes:', {
        finalPicks: finalPicks.length,
        rawPicks: Array.isArray(picks) ? picks.length : -1,
        buyPicks: Array.isArray(buyPicks) ? buyPicks.length : -1,
        sellPicks: Array.isArray(sellPicks) ? sellPicks.length : -1,
        results: allResults.length,
      });
      // Diagnostic: when buyPicks/picks come out empty, this reveals whether the
      // VOLUME data is the cause (all tiers gate on avgVolumeTL). If volPos≈0 while
      // results is large, the data source returned bars without volume.
      if (!Array.isArray(picks) || picks.length === 0 || (Array.isArray(buyPicks) && buyPicks.length === 0)) {
        const volPos = allResults.filter(r => (r.avgVolumeTL || 0) > 0).length;
        const vol200k = allResults.filter(r => (r.avgVolumeTL || 0) >= 200_000).length;
        const atrOk = allResults.filter(r => (r.atrPct || 0) >= 0.4).length;
        const buyCls = allResults.filter(r => r.cls === 'buy').length;
        console.warn('[AI Advisor] EMPTY-PICKS DIAGNOSTIC:', { results: allResults.length, volPositive: volPos, volGte200k: vol200k, atrGte0p4: atrOk, clsBuy: buyCls });
      }
      if (finalPicks.length > 0) {
        console.log('[AI Advisor] First topPick:', {
          symbol: finalPicks[0].symbol,
          cls: finalPicks[0].cls,
          signal: finalPicks[0].signal,
          score: finalPicks[0].score,
          price: finalPicks[0].price,
        });
      }

      window.dispatchEvent(new CustomEvent('advisor-scan-complete', {
        detail: {
          topPicks: finalPicks,
          sellPicks: Array.isArray(sellPicks) ? sellPicks : [],
          results: allResults,
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

  // ── AUTO-SCAN LOOP (Kullanici istegi uzerine degistirildi) ──
  // Artik her 15 dakikada bir surekli tarama YAPILMAZ.
  // Sadece BIST acilisinda (09:55) ve kapanisindan sonra (18:15) 1'er kez otomatik tarama yapilir.
  // Geri kalan zamanlarda kullanici \"TARA / YENILE\" butonuna basarsa manuel tarama yapilir.
  useEffect(() => {
    const iv = setInterval(() => {
      const { day, h, m } = _istanbulParts();
      
      // Hafta sonu ise otomatik tarama yok
      if (day < 1 || day > 5) return;

      // Sadece 09:55 ve 18:15 saatlerinde tam 1 kez calisacak (Dakikada bir calistigi icin o dakikanin icinde yakalar)
      const isOpenTime = (h === 9 && m === 55);
      const isCloseTime = (h === 18 && m === 15);

      if (isOpenTime || isCloseTime) {
        if (!runningRef.current) {
          runScan({ universe: SCAN_UNIVERSE, afterHours: isCloseTime });
        }
      }
    }, 60000); // Dakikada bir kontrol et

    return () => clearInterval(iv);
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
    marketRegime,    // v26 FIX 2: { regime: 'BULL'|'NEUTRAL'|'BEAR', bistChangePct }
    manualScan,
    runScan,
    setGlobalMarket,
  };
}
