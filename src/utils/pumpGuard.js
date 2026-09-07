// ── TAVAN / TUKENIS KAPISI (v31.33) — saf, test edilebilir ────────────────
//
// NEDEN CIKARILDI: bu iki fonksiyon `useAIAdvisor.js` (3.481 satir) icinde
// yasiyordu ve HIC testi yoktu — oysa `isUnsafeForTomorrow` uc ayri filtre
// yolundan (buyPicks / fallbackBuys / lastResort) cagrilan TEK KARAR NOKTASI:
// "bugun patlamis bir hisseyi yarin icin AL olarak gostermeli miyiz?"
// Sermayeyi en dogrudan koruyan kapi buydu ve regresyona karsi kilitli degildi.
//
// Davranis AYNEN korundu — kod tasindi, yeniden yazilmadi. Testler mevcut
// esikleri (RSI>90, MFI>92, tp>=7 icin 38/45/50, cp>=22 icin 55, cp>=18
// kataliz sarti) oldugu gibi kilitler; degistirmek isteyen once testi gorur.

export function calcContinuationProbability(r) {
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

// ══════════════════════════════════════════════════════════════════════
// isUnsafeForTomorrow — TEK NOKTA TAVAN/EXHAUSTION KAPISI
// Tum filter path'leri (buyPicks/fallbackBuys/lastResort) AYNI kurallari uygular.
// Wall Street kurali: bugun tavan = yarinin riskini saticiya verme.
// ══════════════════════════════════════════════════════════════════════
export function isUnsafeForTomorrow(r) {
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
}
