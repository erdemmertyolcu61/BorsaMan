/**
 * wallStreet.js — Wall Street grade meta-analysis layer
 *
 * Hisse sinyaline ve ham veriye kurumsal seviyede ek filtreler uygular:
 *   1) Piyasa rejimi siniflandirmasi (TRENDING / CHOPPY / VOLATILE / QUIET)
 *   2) Veri kalitesi denetimi (stale bar, zero-volume streak, duplicate close)
 *   3) Likidite yeterliligi (ortalama hacim TL bazinda)
 *   4) Risk-adjusted edge skoru (R/R + rejim + kalite)
 *   5) Kurulum notu (A+/A/B/C/D) — score + rejim + kalite hibrit
 *
 * Bu modul saf fonksiyonlardan olusur; hic dis kaynaga baglanmaz.
 */

// ──────────────────────────────────────────────────────────────
// 1) MARKET REGIME CLASSIFIER
// ──────────────────────────────────────────────────────────────

/**
 * classifyMarketRegime — Hangi tur piyasadayiz?
 *   TRENDING_UP   : ADX > 25, fiyat MA50 ustunde, yukari egilimli
 *   TRENDING_DOWN : ADX > 25, fiyat MA50 altinda, asagi egilimli
 *   VOLATILE      : ATR% > 4 (yuksek oynaklik), ADX < 25 (trend yok)
 *   CHOPPY        : ADX < 20, dar BB, hacim dusuk — range bound
 *   QUIET         : ATR% < 1.5 — sessiz, trade etmeme
 *   NORMAL        : Digerleri
 *
 * Her rejim icin farkli taktik onerisi donulur.
 */
export function classifyMarketRegime(prices, ind) {
  if (!prices || prices.length < 30 || !ind) {
    return { regime: 'UNKNOWN', label: 'Yetersiz veri', tactic: '-', volatility: 0, trend: 0 };
  }
  const p = ind.lastClose || 0;
  const atrPct = p > 0 && ind.atr ? (ind.atr / p) * 100 : 0;
  const adx = ind.adx || 0;
  const aboveMA50 = ind.lastMA50 ? p > ind.lastMA50 : null;
  const aboveMA200 = ind.lastMA200 ? p > ind.lastMA200 : null;
  const bbWidth = (ind.lastBU && ind.lastBL && ind.lastBM)
    ? (ind.lastBU - ind.lastBL) / ind.lastBM : 0;

  // 20-bar realized volatility (std of log returns)
  let rv = 0;
  const tail = prices.slice(-21);
  if (tail.length >= 21) {
    const rets = [];
    for (let i = 1; i < tail.length; i++) {
      const r = Math.log(tail[i].close / tail[i - 1].close);
      if (isFinite(r)) rets.push(r);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    rv = Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %
  }

  let regime, label, tactic;
  if (atrPct < 1.5 && adx < 18 && bbWidth < 0.04) {
    regime = 'QUIET';
    label = 'Sessiz Piyasa';
    tactic = 'Islem yok — sikisma cozulene kadar bekle.';
  } else if (atrPct > 4.5 || rv > 55) {
    regime = 'VOLATILE';
    label = 'Yuksek Oynaklik';
    tactic = 'Genis stop + kucuk pozisyon. Breakout tuzaklarina dikkat.';
  } else if (adx > 25 && aboveMA50 === true && (aboveMA200 === null || aboveMA200 === true)) {
    regime = 'TRENDING_UP';
    label = 'Yukseli Trendi';
    tactic = 'Trend ile calis: Geri cekilmeleri al, ters yonde islem acma.';
  } else if (adx > 25 && aboveMA50 === false && (aboveMA200 === null || aboveMA200 === false)) {
    regime = 'TRENDING_DOWN';
    label = 'Dusus Trendi';
    tactic = 'Short bias veya nakit. Dip arayisina erken girme.';
  } else if (adx < 20 && bbWidth < 0.08) {
    regime = 'CHOPPY';
    label = 'Yatay Sikisma';
    tactic = 'Range trade: Destekten al, direncten sat. Breakout bekleniyor.';
  } else {
    regime = 'NORMAL';
    label = 'Normal';
    tactic = 'Standart kurallar; teyit aranmali.';
  }

  return {
    regime, label, tactic,
    volatility: Number(atrPct.toFixed(2)),
    realizedVol: Number(rv.toFixed(1)),
    adx: Number(adx.toFixed(1)),
    bbWidth: Number(bbWidth.toFixed(3)),
    trend: aboveMA200 === true ? 1 : aboveMA200 === false ? -1 : 0,
  };
}

// ──────────────────────────────────────────────────────────────
// 2) DATA QUALITY CHECKER
// ──────────────────────────────────────────────────────────────

/**
 * assessDataQuality — Ham fiyat datasinin guvenilirligi
 *   issues: gap, stale_bar, zero_volume_streak, duplicate_close
 *   score: 0-100 (100 = temiz)
 *   verdict: CLEAN / ACCEPTABLE / POOR
 */
export function assessDataQuality(prices) {
  if (!Array.isArray(prices) || prices.length < 10) {
    return { score: 0, verdict: 'POOR', issues: ['Yetersiz bar sayisi'], bars: prices?.length || 0 };
  }
  const issues = [];
  let penalty = 0;

  // A) Stale — son bar'in tarihi 7 gunden eskiyse
  const last = prices[prices.length - 1];
  const lastDate = new Date(last.date || last.time || Date.now());
  const ageDays = (Date.now() - lastDate.getTime()) / 86400000;
  if (ageDays > 7) { issues.push(`Son bar ${ageDays.toFixed(0)} gun eski`); penalty += 30; }
  else if (ageDays > 3) { issues.push(`Son bar ${ageDays.toFixed(0)} gun eski`); penalty += 10; }

  // B) Zero-volume streak
  let zeroStreak = 0, maxZeroStreak = 0;
  for (const b of prices) {
    if (!b.volume || b.volume === 0) { zeroStreak++; maxZeroStreak = Math.max(maxZeroStreak, zeroStreak); }
    else zeroStreak = 0;
  }
  if (maxZeroStreak >= 5) { issues.push(`${maxZeroStreak} bar sifir hacim`); penalty += 20; }
  else if (maxZeroStreak >= 3) { issues.push(`${maxZeroStreak} bar sifir hacim`); penalty += 10; }

  // C) Duplicate closes (fiyat donmus mu?)
  let dupStreak = 0, maxDup = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i].close === prices[i - 1].close) { dupStreak++; maxDup = Math.max(maxDup, dupStreak); }
    else dupStreak = 0;
  }
  if (maxDup >= 5) { issues.push(`${maxDup} bar ayni kapanis — islem yok`); penalty += 20; }

  // D) Missing OHLC integrity
  let invalidBars = 0;
  for (const b of prices) {
    if (b.high < Math.max(b.open, b.close) - 0.001 || b.low > Math.min(b.open, b.close) + 0.001) invalidBars++;
  }
  if (invalidBars > 0) { issues.push(`${invalidBars} bar OHLC tutarsiz`); penalty += 15; }

  // E) Extreme single-bar move (potential bad print)
  for (let i = 1; i < prices.length; i++) {
    const move = Math.abs(prices[i].close - prices[i - 1].close) / prices[i - 1].close;
    if (move > 0.5) { issues.push(`${new Date(prices[i].date || 0).toLocaleDateString('tr-TR')} %${(move * 100).toFixed(0)} hareket — yanlis fiyat olabilir`); penalty += 15; break; }
  }

  const score = Math.max(0, 100 - penalty);
  const verdict = score >= 85 ? 'CLEAN' : score >= 60 ? 'ACCEPTABLE' : 'POOR';
  return { score, verdict, issues, bars: prices.length, lastBarAgeDays: Number(ageDays.toFixed(1)) };
}

// ──────────────────────────────────────────────────────────────
// 3) LIQUIDITY CHECK
// ──────────────────────────────────────────────────────────────

/**
 * assessLiquidity — Hisse kurumsal pozisyon tasiyabilir mi?
 *   avgDailyVolumeTL hesabi + esik karsilastirma
 */
export function assessLiquidity(prices) {
  if (!prices || prices.length < 20) return { tier: 'UNKNOWN', avgVolTL: 0, message: '-' };
  const tail = prices.slice(-20);
  const avgVolTL = tail.reduce((s, b) => s + (b.volume || 0) * (b.close || 0), 0) / tail.length;
  let tier, message;
  if (avgVolTL >= 100_000_000) { tier = 'INSTITUTIONAL'; message = 'Kurumsal likidite (100M+ TL/gun)'; }
  else if (avgVolTL >= 25_000_000) { tier = 'HIGH'; message = 'Yuksek likidite (25-100M TL/gun)'; }
  else if (avgVolTL >= 5_000_000) { tier = 'MEDIUM'; message = 'Orta likidite (5-25M TL/gun)'; }
  else if (avgVolTL >= 1_000_000) { tier = 'LOW'; message = 'Dusuk likidite — buyuk pozisyon tasimaz'; }
  else { tier = 'VERY_LOW'; message = 'Cok dusuk likidite — slip riski yuksek'; }
  return { tier, avgVolTL: Math.round(avgVolTL), message };
}

// ──────────────────────────────────────────────────────────────
// 4) EDGE SCORE + SETUP GRADE
// ──────────────────────────────────────────────────────────────

/**
 * computeEdgeScore — Risk-adjusted sinyal edge'i
 *   Input: signal (genSignal output), indicators, regime, quality, liquidity
 *   Output: 0-100 edge skoru + detayli reason listesi
 *
 * Bir Wall Street trader su faktorlere bakar:
 *   - Skor ve yönü
 *   - Rejim uyumu (trend-following sinyali TRENDING'de, mean-reversion CHOPPY'de iyidir)
 *   - Veri kalitesi (kotu veri = edge yok)
 *   - Likidite (dusukse boyut kuculur)
 *   - R/R kalitesi (>=2.0 ideal)
 *   - Hacim teyidi
 */
export function computeEdgeScore({ sig, ind, regime, quality, liquidity }) {
  if (!sig) return { edge: 0, grade: 'D', reasons: ['Sinyal yok'] };

  const reasons = [];
  let edge = Number(sig.conf) || 50;

  // Rejim uyumu
  if (regime?.regime === 'TRENDING_UP' && sig.cls === 'buy') { edge += 10; reasons.push('Yukselen trendde alim — +10'); }
  else if (regime?.regime === 'TRENDING_DOWN' && sig.cls === 'buy') { edge -= 15; reasons.push('Dusen trendde alim — ciddi karsi rüzgar (-15)'); }
  else if (regime?.regime === 'TRENDING_DOWN' && sig.cls === 'sell') { edge += 10; reasons.push('Dusen trendde satis — +10'); }
  else if (regime?.regime === 'CHOPPY') {
    // In chop, only counter-trend extremes work
    if (ind?.lastRSI < 30 && sig.cls === 'buy') { edge += 5; reasons.push('Chop rejiminde asiri satim alimi — +5'); }
    else if (ind?.lastRSI > 70 && sig.cls === 'sell') { edge += 5; reasons.push('Chop rejiminde asiri alim satisi — +5'); }
    else { edge -= 8; reasons.push('Chop rejiminde yonlu islem zayif (-8)'); }
  } else if (regime?.regime === 'VOLATILE') { edge -= 5; reasons.push('Yuksek oynaklik — stopun tetiklenme riski (-5)'); }
  else if (regime?.regime === 'QUIET') { edge -= 15; reasons.push('Sessiz piyasa — edge yok (-15)'); }

  // Kalite
  if (quality?.verdict === 'POOR') { edge -= 20; reasons.push(`Veri kalitesi dusuk (${quality.score}/100) — ${quality.issues.join(', ')}`); }
  else if (quality?.verdict === 'ACCEPTABLE') { edge -= 5; reasons.push(`Veri kalitesi kabul edilir (${quality.score}/100)`); }

  // Likidite
  if (liquidity?.tier === 'VERY_LOW') { edge -= 15; reasons.push('Cok dusuk likidite — slip riski (-15)'); }
  else if (liquidity?.tier === 'LOW') { edge -= 7; reasons.push('Dusuk likidite (-7)'); }
  else if (liquidity?.tier === 'INSTITUTIONAL') { edge += 3; reasons.push('Kurumsal likidite (+3)'); }

  // R/R kalitesi
  const rr = Number(sig.rr) || 0;
  if (rr >= 3) { edge += 8; reasons.push(`R/R 1:${rr.toFixed(1)} mukemmel (+8)`); }
  else if (rr >= 2) { edge += 4; reasons.push(`R/R 1:${rr.toFixed(1)} iyi (+4)`); }
  else if (rr >= 1.5) { reasons.push(`R/R 1:${rr.toFixed(1)} yeterli`); }
  else if (rr > 0) { edge -= 8; reasons.push(`R/R 1:${rr.toFixed(1)} yetersiz (-8)`); }

  // Hacim teyidi
  if (ind?.volRatio >= 2) { edge += 5; reasons.push(`Hacim ${ind.volRatio.toFixed(1)}x — kurumsal teyit (+5)`); }
  else if (ind?.volRatio < 0.6) { edge -= 5; reasons.push('Dusuk hacim — momentum zayif (-5)'); }

  // Akilli para filtresi
  if (sig.cls === 'buy' && ind?.obvTrend === 'distribution') { edge -= 12; reasons.push('OBV dagilim — akilli para cikis yapiyor (-12)'); }
  if (sig.cls === 'sell' && ind?.obvTrend === 'accumulation') { edge -= 8; reasons.push('OBV birikim — satis sinyaline ragmen alim (-8)'); }

  edge = Math.max(0, Math.min(100, edge));

  // Setup grade
  const score = Number(sig.score) || 0;
  let grade;
  if (edge >= 80 && rr >= 2 && quality?.verdict === 'CLEAN' && Math.abs(score) >= 6) grade = 'A+';
  else if (edge >= 70 && rr >= 1.8 && quality?.verdict !== 'POOR') grade = 'A';
  else if (edge >= 60 && rr >= 1.5) grade = 'B';
  else if (edge >= 45) grade = 'C';
  else grade = 'D';

  return { edge: Math.round(edge), grade, reasons };
}

// ──────────────────────────────────────────────────────────────
// 5) ALL-IN-ONE META ANALYSIS
// ──────────────────────────────────────────────────────────────

/**
 * runWallStreetAnalysis — Hepsini birden calistirir
 */
export function runWallStreetAnalysis(prices, ind, sig) {
  const regime = classifyMarketRegime(prices, ind);
  const quality = assessDataQuality(prices);
  const liquidity = assessLiquidity(prices);
  const edge = computeEdgeScore({ sig, ind, regime, quality, liquidity });
  return { regime, quality, liquidity, edge };
}
