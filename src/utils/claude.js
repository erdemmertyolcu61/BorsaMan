/**
 * claude.js - Claude AI integration (v8)
 *
 * Features:
 *  - Expert prompt builder with 7-layer analysis hierarchy
 *  - Daily picks prompt with A/B/C setup grades
 *  - KAP disclosure sentiment analysis (via proxy backend)
 *  - Web search tool use (news lookup)
 *  - Temperature 0.6 for consistent Wall-Street style reasoning
 *  - claude-sonnet-4-20250514 model by default
 */

import { logError } from './errorLogger.js';

const API_KEY_STORAGE = 'claude_api_key';
const PROXY_CLAUDE_ENDPOINT = '/api/claude'; // relative — served by proxy server
const EXPERT_MODEL = 'claude-opus-4-7';              // deep expert analysis
const BATCH_MODEL  = 'claude-sonnet-4-20250514';     // high-volume / batch ops
const DEFAULT_MODEL = EXPERT_MODEL;
const DEFAULT_TEMPERATURE = 0.6;

export function setApiKey(key) {
  if (typeof key === 'string' && key.trim()) {
    localStorage.setItem(API_KEY_STORAGE, key.trim());
  } else {
    localStorage.removeItem(API_KEY_STORAGE);
  }
}

export function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch { return ''; }
}

// ── Market regime detector ─────────────────────────────────────────────────
// Classifies the macro climate so the prompt can adapt the bias (risk-on / risk-off / chop).
export function detectMarketRegime(market = {}) {
  const ms = market.marketSentiment || market.sentiment || {};
  const xu100Chg = Number(market.xu100Change ?? ms.indexChange ?? 0);
  const avgRSI = Number(ms.avgRSI || 50);
  const buys = Number(ms.buys || 0);
  const sells = Number(ms.sells || 0);
  const breadth = buys + sells > 0 ? (buys - sells) / (buys + sells) : 0;

  let regime = 'CHOP';
  let bias = 'NEUTRAL';
  if (xu100Chg >= 1.2 && breadth >= 0.3 && avgRSI >= 55) { regime = 'BULL_TREND'; bias = 'RISK_ON'; }
  else if (xu100Chg <= -1.2 && breadth <= -0.3 && avgRSI <= 45) { regime = 'BEAR_TREND'; bias = 'RISK_OFF'; }
  else if (avgRSI >= 70) { regime = 'OVERBOUGHT'; bias = 'RISK_OFF'; }
  else if (avgRSI <= 30) { regime = 'OVERSOLD'; bias = 'CONTRARIAN_LONG'; }
  else if (Math.abs(xu100Chg) >= 2) { regime = 'VOLATILE'; bias = 'CAUTIOUS'; }

  return { regime, bias, xu100Chg, avgRSI, breadth };
}

// ── Portfolio risk context ─────────────────────────────────────────────────
export function buildPortfolioContext(portfolio = {}) {
  const positions = portfolio?.positions || [];
  const open = positions.filter(p => p.status === 'open');
  const totalValue = open.reduce((s, p) => s + (p.entryPrice || 0) * (p.quantity || 0), 0);
  const cash = portfolio?.cash || 0;
  const bySector = {};
  for (const p of open) {
    const sec = p.sector || 'Diger';
    bySector[sec] = (bySector[sec] || 0) + ((p.entryPrice || 0) * (p.quantity || 0));
  }
  const concentration = Object.entries(bySector).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { openCount: open.length, totalValue, cash, concentration, symbols: open.map(p => p.symbol) };
}

// ── Expert Prompt (7-layer analysis) ───────────────────────────────────────
export function buildExpertPrompt(symbol, analysis = {}, market = {}, portfolio = null) {
  const {
    price, change, signal, cls, score, conf,
    rsi, macd, macdSignal, bb, atr, vwap, mfi, obv,
    ma20, ma50, ma100, ma200,
    entry, stop, target, rr,
    targetT2, targetT3, targetLong: longTerm,
    setup = [], wyckoff, sector, holdText,
    mcProfitProb, mcMedian,
    fundamentals = {},
    // Smart Money / Flow
    adx, cmf, obvTrend, obvDivergence, rsiDivergence,
    // Advanced indicators
    ichimoku, supertrend, trix, williamsR, roc10,
    wyckoffSpring, volumeClimax, stochRSI,
    // Momentum profile
    dayHighLowRange, momentumScore, forwardMomentum, momentumTrend,
    // Fundamental grade
    fundamentalGrade, fundamentalScore,
    // SMC levels
    bosSignal, fvgSignal, orderBlockLevel,
  } = analysis;

  const {
    xu100 = null, usdtry = null, cpi = null, govBond10y = null,
    marketSentiment = null,
  } = market;

  const fmt = (v, d = 2) => (v == null || !Number.isFinite(Number(v))) ? '-' : Number(v).toFixed(d);
  const pct = (v) => v == null ? '-' : `%${fmt(v, 1)}`;
  const setupList = Array.isArray(setup) ? setup.slice(0, 8).join(', ') : (setup || '-');
  const regime = detectMarketRegime(market);

  // ── Smart Money fingerprint ──────────────────────────────────────────────
  const smartMoneySignals = [];
  if (obvTrend === 'accumulation') smartMoneySignals.push('OBV birikim');
  if (cmf != null && cmf > 0.1) smartMoneySignals.push(`CMF=${fmt(cmf, 2)} (kurumsal giris)`);
  if (mfi != null && mfi < 30) smartMoneySignals.push(`MFI=${fmt(mfi, 0)} (ucuz alim)`);
  if (mfi != null && mfi > 75) smartMoneySignals.push(`MFI=${fmt(mfi, 0)} (kurumsal cikis)`);
  if (obvDivergence === 'bullish') smartMoneySignals.push('OBV pozitif diverjans (gizli alim)');
  if (rsiDivergence === 'bullish') smartMoneySignals.push('RSI bullish diverjans');
  if (rsiDivergence === 'bearish') smartMoneySignals.push('RSI bearish diverjans');
  if (wyckoffSpring) smartMoneySignals.push('Wyckoff Spring (stop-hunt sonrasi toparlanma)');
  if (volumeClimax === 'selling') smartMoneySignals.push('Satis klimaksi — dip transferi olasi');
  if (volumeClimax === 'buying') smartMoneySignals.push('Alis klimaksi — tepeden panikli satis olabilir');

  // ── Multi-timeframe trend summary ──────────────────────────────────────
  const trendLines = [];
  if (ma20 && price) trendLines.push(`MA20(${price > ma20 ? '▲' : '▼'}${fmt(ma20)})`);
  if (ma50 && price) trendLines.push(`MA50(${price > ma50 ? '▲' : '▼'}${fmt(ma50)})`);
  if (ma100 && price) trendLines.push(`MA100(${price > ma100 ? '▲' : '▼'}${fmt(ma100)})`);
  if (ma200 && price) trendLines.push(`MA200(${price > ma200 ? '▲' : '▼'}${fmt(ma200)})`);
  if (supertrend) trendLines.push(`ST(${supertrend.trend || '-'}${supertrend.flip ? ' FLIP!' : ''} ${fmt(supertrend.value)})`);
  if (ichimoku) trendLines.push(`Ichi(${ichimoku.cloudPosition || '-'} cloud${ichimoku.tkCross ? ' TK:' + ichimoku.tkCross : ''}${ichimoku.kumoBreakout ? ' KUMO!' : ''})`);

  // ── Advanced momentum snapshot ───────────────────────────────────────────
  const momLines = [];
  if (stochRSI) {
    const k = stochRSI.k ? stochRSI.k[stochRSI.k.length - 1] : null;
    const d = stochRSI.d ? stochRSI.d[stochRSI.d.length - 1] : null;
    if (k != null) momLines.push(`StochRSI K=${fmt(k, 0)} D=${fmt(d, 0)}`);
  }
  if (adx != null) momLines.push(`ADX=${fmt(adx, 0)}${adx > 25 ? '(TRENDLI)' : adx < 15 ? '(YATAY)' : ''}`);
  if (trix) momLines.push(`TRIX(${trix.crossover || (trix.lastTRIX > 0 ? 'pozitif' : 'negatif')})`);
  if (williamsR != null) momLines.push(`WillR=${fmt(williamsR, 0)}${williamsR < -80 ? '(ASIRI SATIM)' : williamsR > -20 ? '(ASIRI ALIM)' : ''}`);
  if (roc10 != null) momLines.push(`ROC10=${pct(roc10)}`);
  if (dayHighLowRange != null) momLines.push(`GunIci=${pct(dayHighLowRange * 100)}(${dayHighLowRange > 0.7 ? 'ZIRVEYE YAKIN' : dayHighLowRange < 0.3 ? 'DIBE YAKIN' : 'orta'})`);
  if (momentumScore != null) momLines.push(`MomSkor=${fmt(momentumScore, 0)}/100`);

  // ── Portfolio context (optional) ──────────────────────────────────────────
  let portfolioBlock = '';
  if (portfolio) {
    const pc = buildPortfolioContext(portfolio);
    const alreadyHolds = pc.symbols.includes(symbol);
    const concentration = pc.concentration.map(([s, v]) => `${s}:${((v / (pc.totalValue || 1)) * 100).toFixed(0)}%`).join(' ');
    portfolioBlock = `\nPORTFOY: ${pc.openCount} acik poz, deger=${fmt(pc.totalValue)} TL, nakit=${fmt(pc.cash)} TL. Sektör: ${concentration || '-'}. ${alreadyHolds ? `⚠ ${symbol} zaten portfoyde — pozisyon büyütme mi, çıkış hazırlığı mı?` : ''}`;
  }

  // ── Auto-detected contrarian flags ────────────────────────────────────────
  const flags = [];
  if (score >= 7 && ma200 && price && price < ma200) flags.push('skor yuksek AMA fiyat MA200 altinda — ana trend karsiti');
  if (rsi != null && rsi >= 72) flags.push(`RSI=${fmt(rsi, 0)} asiri alim — momentum fade riski`);
  if (rsi != null && rsi <= 28) flags.push(`RSI=${fmt(rsi, 0)} asiri satim — bıçak tutma riski`);
  if (regime.regime === 'BEAR_TREND' && cls === 'buy') flags.push('MAKRO BEAR TREND / AL sinyali — kontr-trend, %30 daha az boyut');
  if (regime.regime === 'OVERBOUGHT' && cls === 'buy') flags.push('PIYASA ASIRI ALIM — yeni girisler yerine kar realizasyonu one al');
  if (mcProfitProb != null && mcProfitProb < 45 && cls === 'buy') flags.push(`Monte Carlo P(kar)=${pct(mcProfitProb)} — istatistiksel dezavantaj`);
  if (adx != null && adx < 15 && cls === 'buy') flags.push('ADX < 15 — trendsiz piyasa, kırılım sinyali daha güvenilir');
  if (dayHighLowRange != null && dayHighLowRange < 0.25 && cls === 'buy') flags.push('Gün içi zayıf kapanış (%25 altı) — kurumsal baskı devam edebilir');
  if (ichimoku?.cloudPosition === 'below' && cls === 'buy') flags.push('Ichimoku bulutu altında — güçlü direnc bölgesi');
  if (rsiDivergence === 'bearish' && cls === 'buy') flags.push('RSI bearish diverjans — fiyat yapay yükseliyor olabilir');
  if (obvDivergence === 'bearish' && cls === 'buy') flags.push('OBV bearish diverjans — kurumsal dağıtım sinyali');
  const flagsText = flags.length ? flags.map(f => `⚠ ${f}`).join('\n') : '✓ Kritik uyarı tespit edilmedi';

  return `Sen elit bir Wall Street stratejisti ve BIST uzmanisin. ${symbol} hakkinda derinlemesine, somut, sayisal bir analiz yap.

═══ PIYASA REJIMI & MAKRO ═══
Rejim: ${regime.regime}  Bias: ${regime.bias}  XU100: ${pct(regime.xu100Chg)}  Breadth: ${fmt(regime.breadth, 2)}  Ort.RSI: ${fmt(regime.avgRSI, 0)}
USDTRY=${fmt(usdtry, 4)}  ${cpi != null ? `TUFE=${pct(cpi)}` : ''}  ${govBond10y != null ? `10Y Tahvil=%${fmt(govBond10y, 2)}` : ''}
Sentiment: ${marketSentiment?.sentiment || '-'}  AL:${marketSentiment?.buys || '-'}  SAT:${marketSentiment?.sells || '-'}
KURAL: BEAR_TREND → AL'ları yalnızca güçlü temel+teknik örtüşmesiyle değerlendir, boyutu %50 küçült. OVERBOUGHT → kar realizasyonu öncelikli.

═══ 7-KATMANLI ANALİZ ═══
1) MAKRO (x1.0): Yukaridaki piyasa rejim verileri geçerli.
2) SEKTOREL (x0.9): ${sector || '-'}  ${market.sectorRotation ? `Sektör skoru: ${market.sectorRotation}` : ''}
3) TEMEL (x0.8): F/K=${fmt(fundamentals.pe)} PD/DD=${fmt(fundamentals.pb)} ROE=${pct(fundamentals.roe)} KarTrend=${fundamentals.profitTrend || '-'} Grade=${fundamentalGrade || fundamentals.grade || '-'}
   BrütMarj=${pct(fundamentals.grossMargin)} OpMarj=${pct(fundamentals.opMargin)} NetMarj=${pct(fundamentals.netMargin)} D/E=${fmt(fundamentals.debtToEquity)}
4) TEKNİK (x1.0):
   Fiyat=${fmt(price)} Değ=${pct(change)} | ${trendLines.join(' | ')}
   RSI=${fmt(rsi, 1)} MACD=${fmt(macd, 3)}/${fmt(macdSignal, 3)} ATR=${fmt(atr)} VWAP=${fmt(vwap)}
   BB=${bb ? `${fmt(bb.lower)}-${fmt(bb.upper)}` : '-'}  Wyckoff=${wyckoff || '-'}
5) ZAMAN (x0.9): Sinyal=${signal || '-'} (${cls || '-'})  Skor=${fmt(score, 1)}/10  Güven=${fmt(conf, 0)}%
6) RİSK (x1.2): Stop=${fmt(stop)}  Stop Uzaklığı=${atr && stop && price ? pct(((price - stop) / price) * 100) : '-'}  ATR Katsayısı=${atr && stop && price ? fmt(Math.abs(price - stop) / atr, 1) : '-'}
7) POZİSYON (x1.0): Giriş=${fmt(entry)} T1=${fmt(target)} T2=${fmt(targetT2)} T3=${fmt(targetT3)} Uzun=${fmt(longTerm)} R/R=1:${fmt(rr, 2)} Vade=${holdText || '-'}

═══ AKILLI PARA & KURUMSAL AKIŞ ═══
${smartMoneySignals.length ? smartMoneySignals.map(s => `• ${s}`).join('\n') : '• Kurumsal akış nötr'}

═══ MOMENTuM & İLERİ GÖSTERGELER ═══
${momLines.length ? momLines.join('  |  ') : '-'}
SMC Setup'lar: ${setupList || '-'}
Monte Carlo: P(kâr)=${pct(mcProfitProb)} Medyan=${fmt(mcMedian)}${portfolioBlock}

═══ OTOMATİK TESPİT EDİLEN UYARILAR ═══
${flagsText}

═══ CONTRARİAN PROTOKOL ═══
Her uyarıyı cevabında AÇIKÇA ele al. Uyarı var → confidence -20 puan minimum. Birden fazla uyarı → D notu düşün.
Monte Carlo P(kâr) < %45 + AL öneri = istatistiksel gerekçe zorunlu.

═══ YANIT FORMATI (Türkçe, profesyonel, max 240 kelime) ═══
[ONERI] AL/TUT/SAT + vade + güven (DÜŞÜK/ORTA/YÜKSEK) + Setup Grade (A/B/C/D)
[CONFIDENCE] 1-10 skala + TEK cümle gerekçe + flag varsa nasıl etkiledi
[OZET] Belirleyici 3 faktör — hangisi ağır basıyor (makro/sektör/teknik/akıllı para)?
[RISK] En büyük 2 somut risk + tetikleyici seviyeler
[AKSIYON] Giriş=${fmt(entry)} Stop=${fmt(stop)} T1=${fmt(target)} T2=${fmt(targetT2)} T3=${fmt(targetT3)} + Kademeli alım planı (ör: %40 şimdi/%40 pullback/${fmt(ma20)} /%20 breakout)
[ALTERNATIF] Sinyal geçersizleşirse hangi seviye, ne izle${portfolio ? '\n[PORTFOY_ETKI] Korelasyon, konsantrasyon ve mevcut pozisyonlara etkisi' : ''}`;
}

// ── Daily Picks Prompt (A/B/C/D grades) ────────────────────────────────────
export function buildDailyPicksPrompt(picks = [], market = {}) {
  const ctx = market.marketSentiment || market.sentiment || {};
  const regime = detectMarketRegime(market);

  const fmt = (v, d = 2) => (v == null || !Number.isFinite(Number(v))) ? '-' : Number(v).toFixed(d);

  const header = `Rejim: ${regime.regime} (Bias: ${regime.bias})
XU100: ${regime.xu100Chg >= 0 ? '+' : ''}${regime.xu100Chg?.toFixed(1) || '-'}%  Breadth: ${fmt(regime.breadth, 2)}  OrtRSI: ${ctx.avgRSI?.toFixed(0) || '-'}
AL:${ctx.buys || 0} SAT:${ctx.sells || 0}  Sentiment: ${ctx.sentiment || '-'}`;

  const rows = picks.slice(0, 10).map(p => {
    const grade = gradeSetup(p, regime.regime);

    // Smart money summary
    const sm = [];
    if (p.obvTrend === 'accumulation') sm.push('OBV+');
    if (p.mfi != null && p.mfi < 35) sm.push(`MFI=${fmt(p.mfi, 0)}`);
    if (p.cmf != null && p.cmf > 0.05) sm.push(`CMF=${fmt(p.cmf, 2)}`);
    const smStr = sm.length ? sm.join('/') : '-';

    const stDir = p.supertrend?.trend
      ? p.supertrend.trend.slice(0, 2).toUpperCase()
      : (p.ichimoku?.cloudPosition === 'above' ? 'UC' : '-');
    const wy = p.wyckoff ? p.wyckoff.slice(0, 3).toUpperCase() : '-';
    const fg = p.fundamentalGrade || p.fundamentals?.grade || '-';
    const mc = p.mcProfitProb != null ? `MC=${fmt(p.mcProfitProb, 0)}%` : '';

    // KAP haber sentiment — varsa kısa başlık ile (max 45 karakter)
    let kapStr = '';
    if (p.kapSentiment != null && p.kapCount > 0) {
      const sign = p.kapSentiment >= 0 ? '+' : '';
      const headline = p.kapHeadline ? ` "${p.kapHeadline.slice(0, 45)}"` : '';
      kapStr = ` KAP=${sign}${fmt(p.kapSentiment, 1)}(${p.kapCount})${headline}`;
    }

    return `- ${p.symbol}[${grade}] ${p.signal || '-'} sk=${fmt(p.score, 1)} fiy=${fmt(p.price, 2)} stop=${fmt(p.stop, 2)} T1=${fmt(p.target, 2)} RR=1:${fmt(p.rr, 2)} RSI=${fmt(p.rsi, 0)} AkPar:${smStr} Tr:${stDir} Wy:${wy} Fund:${fg}${mc ? ' ' + mc : ''}${kapStr}`;
  }).join('\n');

  const regimeWarn = regime.regime === 'BEAR_TREND'
    ? '\n!! BEAR_TREND: Yalnizca A-notlu + guclu temel destekli hisseler. Boyutlari -%30-50 kucult.'
    : regime.regime === 'OVERBOUGHT'
    ? '\n!! OVERBOUGHT: Yeni giris yerine mevcut pozisyon yonetimi on planda. A notu esigini yukselt.'
    : '';

  return `Sen Wall Street seviyesinde BIST gunluk strateji uzmanisin. Bugunun en iyi firsatlarini analiz et.

=== PIYASA BAGLAMI ===
${header}${regimeWarn}

=== ADAY LISTESI ===
${rows}

=== GRADELEME KRITERLERI ===
A (Elite): Skor>=6.8/10, R/R>=2.0, hacim teyidi, >=2 akilli para sinyali, trend uyumlu, rejim uyumlu
B (Guclu): Skor>=5.8/10, R/R>=1.5, >=1 akilli para VEYA trend sinyali
C (Zayif): Kriter eksik, sistematik avantaj yok
D (Girilmez): Rejim karsit+coklu uyari VEYA P(kar)<%40 VEYA stop>%10

=== YANIT FORMATI (Turkce, max 200 kelime) ===
TOP-3 BUGUN: (A notu yoksa en guclu B'ler — onceligini gerekce ile)
Her biri: 1 cumle NEDEN + giris/stop/T1 + vade (intraday/swing/uzun)
ORTAK TEMA: Sektor rotasyonu, momentum tipi, makro uyum
KACIN: C/D notlu hisseler ve kisa gerekcesi
PIYASA TAVSIYESI: 1 cumle (rejimi ve hacim durumunu dikkate al)`;
}

// gradeSetup — multi-factor A/B/C/D classification matching SMC_RULEBOOK thresholds
// score is on 0-10 scale; A >= 6.8/10 (= 68/100), B >= 5.8/10 (= 58/100)
function gradeSetup(p, regimeOverride) {
  const s = p.score || 0;
  const rr = p.rr || 0;
  const cls = p.cls || (typeof p.signal === 'string' && p.signal.includes('AL') ? 'buy' : 'hold');
  const isBuy = cls === 'buy';
  const regime = regimeOverride || p.regime || p.marketRegime || '';
  const bearTrend = regime === 'BEAR_TREND';
  const overbought = regime === 'OVERBOUGHT';

  // ── D: hard disqualifiers (checked first) ─────────────────────────────
  const mcProb = p.mcProfitProb ?? null;
  if (mcProb != null && mcProb < 40) return 'D';

  const stopDist = p.stopDistancePct != null
    ? p.stopDistancePct
    : (p.price > 0 && p.stop > 0 ? Math.abs((p.price - p.stop) / p.price) * 100 : null);
  if (stopDist != null && stopDist > 10) return 'D';

  // Multiple active contra-signals → D
  let contraCount = 0;
  if (bearTrend && isBuy) contraCount++;
  if (overbought && isBuy) contraCount++;
  if (p.rsi != null && p.rsi > 72 && isBuy) contraCount++;
  if (p.rsiDivergence === 'bearish' && isBuy) contraCount++;
  if (p.obvDivergence === 'bearish' && isBuy) contraCount++;
  if (contraCount >= 2) return 'D';

  // ── Smart money signal count ───────────────────────────────────────────
  let smartMoney = 0;
  if (p.obvTrend === 'accumulation') smartMoney++;
  if (p.mfi != null && p.mfi < 30) smartMoney++;
  if (p.cmf != null && p.cmf > 0.10) smartMoney++;
  if (p.wyckoffSpring) smartMoney++;
  if (p.obvDivergence === 'bullish') smartMoney++;

  // ── Trend alignment ────────────────────────────────────────────────────
  const supertrendUp = p.supertrend?.trend === 'UP' || p.supertrend?.direction === 'up';
  const ichimokuAbove = p.ichimoku?.cloudPosition === 'above';
  const maAligned = p.ma50 && p.ma200 && p.price > 0 && p.price > p.ma50 && p.ma50 > p.ma200;
  const trendAligned = supertrendUp || ichimokuAbove || maAligned;

  // Volume confirmation — omit penalty when field absent (don't penalize missing data)
  const volConfirmed = p.volRatio != null ? p.volRatio >= 1.3 : true;

  // Fundamental strength bonus
  const fg = p.fundamentalGrade || p.fundamentals?.grade || '';
  const fundStrong = fg === 'A+' || fg === 'A' || fg === 'B+';

  // ── A: Elit Kurulum ───────────────────────────────────────────────────
  if (s >= 6.8 && rr >= 2.0 && volConfirmed && smartMoney >= 2 && trendAligned && !bearTrend && !overbought) return 'A';
  // Strong score compensates missing vol if fundamentals support
  if (s >= 7.5 && rr >= 2.0 && smartMoney >= 2 && trendAligned && !bearTrend && fundStrong) return 'A';

  // ── B: Guclu Kurulum ──────────────────────────────────────────────────
  if (s >= 5.8 && rr >= 1.5 && (smartMoney >= 1 || trendAligned)) return 'B';
  // Multiple confirmations compensate borderline score
  if (s >= 5.5 && rr >= 1.5 && smartMoney >= 2 && trendAligned) return 'B';

  return 'C';
}

// ── Static SMC / strategy rulebook (CACHE-ELIGIBLE) ────────────────────────
// >= 1024 tokens ile birlikte — Anthropic prompt caching aktif.
const SMC_RULEBOOK = `=== SMART MONEY CONCEPTS (SMC) — WALL STREET KURALLARI ===

TEMEL PRENSİP: Piyasa yapıcılar (market maker) her hareketten önce likiditeyi temizler.
Büyük oyuncular pozisyon girmeden önce stop kümelerini süpürür, ardından gerçek yönde hareket eder.

BOS (Break of Structure — Yapı Kırılımı):
  - Bull BOS: Fiyat son swing high'ı KAPANIŞ bazında HACIMLE (>=1.3x ort) geçer → yukselis trendi teyidi.
    Stop: son swing low'un %0.5 altı. Minimum hacim şartı yerine getirilmezse ZAYIF BOS say.
  - Bear BOS: Fiyat son swing low'u KAPANIŞ bazında hacimle kırar → düşüş trendi teyidi.
  - Not: Gölge (wick) kırılması BOS DEĞİLDİR. Sadece kapanış fiyatı geçerlidir.

CHoCH (Change of Character — Karakter Değişimi):
  - Devam eden BOS zincirini KIRAN ilk karşıt yapı → trend dönüşü erken sinyali.
  - CHoCH + OBV diverjansı = yüksek güvenilirlik kombinasyonu.
  - Confluence kuralı: FVG + OB + MFI/OBV diverjansi = en az 2 teyit zorunlu.

Order Block (OB — Kurum Emirleri):
  - Bullish OB: Yukseliş BOS'undan önceki SON DÜŞÜŞ mumu. Alt-üst değerler destek bölgesidir.
  - Bearish OB: Düşüş BOS'undan önceki son yükseliş mumu. Alt-üst değerler direnç bölgesidir.
  - Kural: OB kırıldığında GEÇERSİZ OLUR — yeniden test bekleme.
  - Güçlü OB: Oluşumda hacim ortalamanın 1.5x üzeri + MFI desteği.

FVG (Fair Value Gap — Adil Değer Boşluğu):
  - Bullish FVG: bar[i].high < bar[i+2].low → doldurulmamış boşluk DESTEK görevi görür.
  - Bearish FVG: bar[i].low > bar[i+2].high → doldurulmamış boşluk DİRENÇ görevi görür.
  - FVG mitigate olduğunda geçersizdir. Kısmi dolum (%50) en güçlü reaksiyon noktasıdır.

Liquidity Sweep (Likidite Süpürmesi):
  - 20-bar ekstrem seviyesi (equal high/low) yakınında MFI/OBV diverjansı = STOP HUNT sinyali.
  - Sweep sonrası ters yön hareketi = "Judas Swing" → gerçek yön o yöndür.
  - BIST'e özgü: Sabah 09:30-10:00 arası likidite süpürmeleri yaygın, yönü 10:30'da teyit et.

Premium / Discount Zones:
  - Swing range'in %50'si (equilibrium): altı = discount (alım bölgesi), üstü = premium (satış bölgesi).
  - Kural: Trend UP → discount'tan al, premium'da sat. Trend DOWN → premium'dan sat, discount'ta kapat.

=== BIST'E ÖZGÜ PIYASA YAPISI ===
• Öğle arası (12:30-14:00): Hacim düşer, sahte breakout'lar yaygın. Bu saatte verilen sinyalleri görmezden gel veya beklettir.
• Açılış seansı (09:30-10:30): En volatil dönem. Gap fill trendi güçlü — boşlukların %65'i aynı gün kapanır.
• Kapanış saatleri (16:30-17:30): Kurumsal dengeleme — güçlü kapanış = ertesi gün açılış momentumu.
• Yabancı fon etkisi: USDTRY'de >%0.5 günlük artış → defansif sektörler (Sabancı, Koç) göreceli güçlenir.
• TCMB PPK kararları ve enflasyon verileri: Finans sektörü bu günlerde ana trende karşı hareket edebilir.
• Borç/Equity oranı yüksek şirketler (D/E > 2.0): TL faiz artışlarında orantısız zarar görür.

=== KURUMSAL AKIŞ TESPİTİ (Akıllı Para Fingerprint) ===
KUVVETLI BİRİKİM SİNYALLERİ (en az 3 tanesi):
  ✓ OBV birikim trendi (fiyat yatay/aşağı, OBV yükseliyor)
  ✓ MFI < 30 (ucuza kurumsal alım)
  ✓ CMF > +0.10 (Chaikin Money Flow pozitif)
  ✓ Düşüş mumlarında yüksek hacim, yükseliş mumlarında yüksek hacim YOK
  ✓ Wyckoff Accumulation (Spring + Test + BUEC faz sırası)
  ✓ OBV pozitif diverjans (fiyat dip yaparken OBV yeni dip YAPMIYOR)

KUVVETLI DAĞITIM SİNYALLERİ:
  ✓ OBV dağıtım (fiyat yükseliyor ama OBV düşüyor)
  ✓ MFI > 75 + fiyat yeni zirve = distribüsyon
  ✓ Wyckoff Distribution (UTAD + Sign of Weakness)
  ✓ Hacim klimaksı + kapanış alt yarıda

=== 7-KATMANLI AĞIRLIKLAMA (Sabit Kural) ===
Risk(1.2) = EN YÜKSEK → stop mesafesi ve ATR katsayısı her kararı belirler.
Makro(1.0) = Rejim belirleme — bear trend'de her AL sinyali %30 daha küçük boyutla ele alınır.
Teknik(1.0) = Birden fazla indikatör teyidi zorunlu.
Pozisyon(1.0) = R/R < 1.2 olan işlemler asla girilmez.
Sektörel(0.9) + Zaman(0.9) = Destekleyici faktörler.
Temel(0.8) = Uzun vade için kritik, kısa vade swing'ler için destekleyici.

=== CONTRARİAN PROTOKOL ===
Aşırı iyimser/kötümser tespit edildiğinde confidence -20 puan zorunlu.
Rejim karşıt (BEAR_TREND'te AL, OVERBOUGHT'ta AL) = uyarı ve boyut küçültme zorunlu.
Monte Carlo P(kâr) < %45 + AL önerisi = istatistiksel gerekçe ZORUNLU, aksi halde öneri YAPILMAZ.
RSI > 72 + yeni long önerisi = en az 1 teyit daha gerekli.
Birden fazla aktif uyarı = D notu, giriş ertelenir veya iptal edilir.

=== SETUP GRADE SİSTEMİ (A/B/C/D) ===
A (Elit Kurulum):
  • Skor >= 68/100 VE R/R >= 2.0 VE hacim teyidi (volRatio >= 1.3)
  • VE en az 2 akıllı para sinyali (OBV+MFI veya OBV+CMF)
  • VE trend uyumlu (Supertrend UP veya Ichimoku above cloud)
  • VE rejim uyumlu (BEAR_TREND'te A notu verilmez)
B (Güçlü Kurulum):
  • Skor >= 58/100 VE R/R >= 1.5
  • VE en az 1 akıllı para sinyali VEYA trend indikatörü teyidi
  • Tek eksik teyit kabul edilir
C (Zayıf Kurulum):
  • Skor < 58 VEYA R/R < 1.5 VEYA teyit yok
  • Risk/ödül oranı sistematik üstünlük sağlamaz
D (Girilmez):
  • Rejim karşıt VE birden fazla aktif uyarı
  • VEYA Monte Carlo P(kâr) < %40
  • VEYA stop mesafesi > %10 (ATR çok geniş)`;

const BASE_SYSTEM_PROMPT = 'Sen Wall Street tarzi BIST stratejistisin. Turkce cevap ver. Gerekirse haberlere web_search ile bak. Emin olmadigin yerde "emin degilim" de, uydurma. Asagidaki SMC ve 7-katmanli hiyerarsi kurallari TUM cevaplarinda gecerlidir.';

// Build a cached system-prompt array for Anthropic prompt caching.
// Structure: [ { dynamic_user_context }, { SMC_rulebook, cache_control: ephemeral } ]
function buildCachedSystem(dynamicSystemText) {
  const dyn = (dynamicSystemText && String(dynamicSystemText).trim()) || BASE_SYSTEM_PROMPT;
  return [
    { type: 'text', text: dyn },
    { type: 'text', text: SMC_RULEBOOK, cache_control: { type: 'ephemeral' } },
  ];
}

// ── Low-level Claude API caller (via proxy) ────────────────────────────────
// Accepts either { prompt } (single user turn) or { messages } (multi-turn history).
// `useCache`: default true — enables Anthropic prompt-caching of the SMC rulebook.
// When false (e.g. short one-off KAP JSON calls), bypasses caching overhead.
async function callClaude({ prompt, messages, systemPrompt, tools, model = DEFAULT_MODEL, temperature = DEFAULT_TEMPERATURE, maxTokens = 1024, useCache = true }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { error: 'Claude API anahtari tanimlanmamis. Ayarlardan ekle.' };
  }

  const finalMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: prompt }];

  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: useCache
      ? buildCachedSystem(systemPrompt)
      : (systemPrompt || undefined),
    messages: finalMessages,
  };
  if (tools && tools.length) payload.tools = tools;

  try {
    const res = await fetch(PROXY_CLAUDE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        // Required beta header for prompt caching. Harmless if disabled upstream.
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `Claude HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')
      .trim();
    return { text, raw: data };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ── KAP Disclosure sentiment analysis ──────────────────────────────────────
export async function analyzeKAPList(symbol, disclosures = []) {
  if (!Array.isArray(disclosures) || !disclosures.length) return [];

  const bullets = disclosures.slice(0, 10).map((d, i) => {
    const title = (d.title || '').slice(0, 180);
    const summary = (d.summary || '').slice(0, 280);
    return `${i + 1}. [id=${d.id || i}] ${title}\n   ${summary}`;
  }).join('\n');

  const prompt = `${symbol} hissesinin son KAP bildirimlerini degerlendir.
Her bildirim icin: sentiment (Pozitif/Negatif/Notr), score (1-10: yatirimci icin etki siddeti), reason (tek cumle).
Yalnizca JSON array dondur, baska metin yazma.

BILDIRIMLER:
${bullets}

Format: [{"id":"...","sentiment":"Pozitif","score":7,"reason":"..."}]`;

  const result = await callClaude({
    prompt,
    systemPrompt: 'Sen BIST KAP analisti uzmanisin. Sadece gecerli JSON dondur.',
    temperature: 0.3,
    maxTokens: 1200,
    useCache: false, // short JSON output — caching overhead not worth it
  });

  if (result.error) return { error: result.error };
  try {
    // Try full parse first, then extract first top-level array
    const text = result.text.trim();
    try { return JSON.parse(text); } catch {}
    const start = text.indexOf('[');
    if (start === -1) return { error: 'AI JSON dondurmedi.' };
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return { error: 'AI JSON dondurmedi.' };
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { error: 'JSON parse: ' + e.message };
  }
}

// ── Expert analysis with web search ────────────────────────────────────────
export async function askExpert(symbol, analysis, market, opts = {}) {
  const useWebSearch = opts.webSearch !== false;
  const tools = useWebSearch ? [{
    type: 'web_search_20241020',
    name: 'web_search',
    max_uses: 2,
  }] : undefined;

  return callClaude({
    prompt: buildExpertPrompt(symbol, analysis, market, opts.portfolio || null),
    systemPrompt: 'Sen Wall Street tarzi BIST stratejistisin. Turkce cevap ver. Gerekirse haberlere web_search ile bak. Emin olmadigin yerde "emin degilim" de, uydurma.',
    tools,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: 1600,
  });
}

// Multi-turn chat with conversation history (used by JARVIS for contextual dialogue)
export async function chatClaudeHistory(messages, systemPrompt, opts = {}) {
  return callClaude({
    messages,
    systemPrompt,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens || 1400,
    tools: opts.tools,
  });
}

export async function askDailyPicks(picks, market) {
  return callClaude({
    prompt: buildDailyPicksPrompt(picks, market),
    systemPrompt: 'Sen BIST gunluk strateji uzmanisin. Turkce yaz.',
    model: BATCH_MODEL,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: 900,
  });
}

// ── Strategy code generation (natural-language → JS filter) ───────────────
function buildStrategyPrompt(userInput) {
  return `Kullanicinin istedigi hisse secim stratejisini JavaScript arrow function olarak yaz.

ZORUNLU FORMAT:
(ind, sig, data) => {
  let s = 0;
  // skorlama kurallari
  if (...) s += N;
  return s >= ESIK;
}

KULLANILABILIR DEGISKENLER:
- ind.lastClose (son fiyat), ind.changePct (% degisim)
- ind.lastRSI (0-100), ind.lastMA20/50/100/200 (hareketli ortalamalar)
- ind.mfi (0-100, Money Flow), ind.obvTrend ("accumulation"/"distribution"/"neutral")
- ind.volRatio (hacim orani, 1.0 = ortalama), ind.cmf (-1 to 1, Chaikin)
- ind.adx (0-100, trend gucu), ind.wyckoffPhase ("accumulation"/"markup"/"distribution"/"markdown")
- ind.ttmSqueeze?.squeezeOn (boolean), ind.ttmSqueeze?.momentum (sayi)
- ind.candlePatterns (array of {name, type: "bullish"/"bearish"})
- ind.stochRSI?.k[son], ind.stochRSI?.d[son]
- sig.signal ("GUCLU AL"/"AL"/"TUT"/"SAT"/"GUCLU SAT")
- sig.cls ("buy"/"hold"/"sell"), sig.score (-10 to 10)
- sig.rr (risk/reward), sig.intradayRR
- data.prices (array of {date,open,high,low,close,volume})

NULL GUVENLIK: Her degiskeni kullanmadan once null check yap.
SADECE JS kodu don, aciklama YAZMA. Kod \`\`\`javascript blogu icinde olsun.

Kullanici istegi: "${userInput}"`;
}

function localStrategyParser(userInput) {
  const t = userInput.toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[öÖ]/g, 'o')
    .replace(/[üÜ]/g, 'u').replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g');
  let code = `(ind, sig, data) => {\n  let s = 0;\n`;
  const explanations = [];
  if (t.includes('momentum') || t.includes('yukselis') || t.includes('guclu')) {
    code += `  if (ind.lastRSI && ind.lastRSI > 50 && ind.lastRSI < 70) s += 2;\n`;
    code += `  if (ind.lastMA20 && ind.lastClose > ind.lastMA20) s += 2;\n`;
    code += `  if (ind.volRatio && ind.volRatio > 1.3) s += 2;\n`;
    code += `  if (sig.cls === "buy") s += 2;\n`;
    explanations.push('Momentum: RSI 50-70, MA-20 uzerinde, hacim yuksek');
  } else if (t.includes('dip') || t.includes('ucuz') || t.includes('donus')) {
    code += `  if (ind.lastRSI && ind.lastRSI < 35) s += 3;\n`;
    code += `  if (ind.mfi != null && ind.mfi < 25) s += 2;\n`;
    code += `  if (ind.obvTrend === "accumulation") s += 2;\n`;
    code += `  if (ind.changePct > 0) s += 1;\n`;
    explanations.push('Dipten donus: RSI asiri satim, MFI kurumsal alim, OBV birikim');
  } else if (t.includes('kurumsal') || t.includes('akilli') || t.includes('balina')) {
    code += `  if (ind.obvTrend === "accumulation") s += 3;\n`;
    code += `  if (ind.mfi != null && ind.mfi < 30) s += 2;\n`;
    code += `  if (ind.cmf != null && ind.cmf > 0.1) s += 2;\n`;
    code += `  if (ind.volRatio && ind.volRatio > 1.5) s += 1;\n`;
    explanations.push('Kurumsal birikim: OBV accumulation, MFI dusuk, CMF pozitif');
  } else if (t.includes('trend') || t.includes('takip')) {
    code += `  if (ind.lastMA20 && ind.lastMA50 && ind.lastClose > ind.lastMA20 && ind.lastMA20 > ind.lastMA50) s += 3;\n`;
    code += `  if (ind.adx && ind.adx > 25) s += 2;\n`;
    code += `  if (sig.cls === "buy") s += 2;\n`;
    code += `  if (ind.volRatio && ind.volRatio > 1) s += 1;\n`;
    explanations.push('Trend takip: MA sirali, ADX guclu, sinyal alis');
  } else if (t.includes('dusuk risk') || t.includes('guvenli') || t.includes('saglam')) {
    code += `  if (sig.rr && sig.rr > 1.5) s += 2;\n`;
    code += `  if (ind.adx && ind.adx > 20) s += 1;\n`;
    code += `  if (ind.lastRSI && ind.lastRSI > 40 && ind.lastRSI < 60) s += 2;\n`;
    code += `  if (ind.obvTrend === "accumulation") s += 2;\n`;
    code += `  if (ind.volRatio && ind.volRatio > 0.8) s += 1;\n`;
    explanations.push('Dusuk risk: Yuksek R/R, RSI notr bolge, OBV birikim');
  } else {
    code += `  if (sig.cls === "buy" && sig.score >= 3) s += 3;\n`;
    code += `  if (ind.lastRSI && ind.lastRSI > 40 && ind.lastRSI < 65) s += 1;\n`;
    code += `  if (ind.volRatio && ind.volRatio > 1) s += 1;\n`;
    code += `  if (ind.obvTrend === "accumulation") s += 2;\n`;
    code += `  if (ind.lastMA20 && ind.lastClose > ind.lastMA20) s += 1;\n`;
    explanations.push('Dengeli strateji: Sinyal, RSI, hacim, OBV ve MA kontrol');
  }
  code += `  return s >= 5;\n}`;
  return { code, source: 'local', explanations };
}

export async function generateStrategyCode(userInput) {
  const prompt = buildStrategyPrompt(userInput);
  const result = await callClaude({
    prompt,
    systemPrompt: 'Sen BIST strateji kodlayicisin. Sadece JS arrow function dondur.',
    temperature: 0.4,
    maxTokens: 800,
  });
  if (result && result.text && !result.error) {
    const raw = result.text;
    const m = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
    const code = m ? m[1].trim() : raw.replace(/```/g, '').trim();
    if (code.includes('=>') && code.includes('return')) {
      try {
        new Function('return ' + code);
        return { code, source: 'ai', explanations: ['AI tarafindan olusturulan skorlama bazli strateji.'] };
      } catch (e) { logError('ai', 'AI strategy code failed syntax check — falling back to local parser', e, { severity: 'warn' }); }
    }
  }
  return localStrategyParser(userInput);
}

// Generic chat (used by JARVIS)
export async function chatClaude(userMsg, systemPrompt, opts = {}) {
  return callClaude({
    prompt: userMsg,
    systemPrompt,
    temperature: opts.temperature || DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens || 1200,
    tools: opts.tools,
  });
}
