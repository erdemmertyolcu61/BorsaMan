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
import { buildMacroPromptLine } from './macroContextEngine.js';
import { PROXY_BASE_URL } from './fetchEngine.js';

const API_KEY_STORAGE = 'claude_api_key';
const PROXY_CLAUDE_ENDPOINT = '/api/claude'; // relative — served by proxy server
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TEMPERATURE = 0.6;
const CLAUDE_TIMEOUT_MS = 60_000;

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
    ma20, ma50, ma200,
    entry, stop, target, rr,
    targetT2, targetT3, targetLong: longTerm,
    setup = [], wyckoff, sector, holdText,
    mcProfitProb, mcMedian,
    fundamentals = {},
    foreignRatio, foreignChangeWeek,
  } = analysis;

  const {
    xu100 = null, usdtry = null, marketSentiment = null,
  } = market;

  const fmt = (v, d = 2) => (v == null || !Number.isFinite(v)) ? '-' : Number(v).toFixed(d);
  const setupList = Array.isArray(setup) ? setup.slice(0, 6).join(', ') : (setup || '-');
  const regime = detectMarketRegime(market);

  // Portfolio context (optional)
  let portfolioBlock = '';
  if (portfolio) {
    const pc = buildPortfolioContext(portfolio);
    const alreadyHolds = pc.symbols.includes(symbol);
    const concentration = pc.concentration.map(([s, v]) => `${s}:${((v / (pc.totalValue || 1)) * 100).toFixed(0)}%`).join(' ');
    portfolioBlock = `\nPORTFOY: ${pc.openCount} acik poz, deger=${fmt(pc.totalValue)} TL, nakit=${fmt(pc.cash)} TL. Sektor konsant: ${concentration || '-'}. ${alreadyHolds ? `DIKKAT: ${symbol} zaten portfoyde.` : ''}`;
  }

  // Contrarian flags auto-detected — injected to force the model to address them
  const flags = [];
  if (score >= 7 && ma200 && price && price < ma200) flags.push('skor yuksek AMA fiyat MA200 altinda (trend ters)');
  if (rsi >= 70) flags.push(`RSI=${fmt(rsi, 0)} asiri alim`);
  if (rsi <= 30) flags.push(`RSI=${fmt(rsi, 0)} asiri satim`);
  if (regime.regime === 'BEAR_TREND' && cls === 'buy') flags.push('makro bear trend ama AL sinyali');
  if (regime.regime === 'OVERBOUGHT' && cls === 'buy') flags.push('piyasa asiri alim, AL riskli');
  if (mcProfitProb != null && mcProfitProb < 45 && cls === 'buy') flags.push(`Monte Carlo P(kar)=%${fmt(mcProfitProb, 0)} dusuk`);
  const flagsText = flags.length ? flags.map(f => `- ${f}`).join('\n') : '- tespit yok';

  return `Sen BIST uzmani bir Wall Street stratejistisin. ${symbol} icin profesyonel, tarafsiz, olculu bir degerlendirme yap.

=== PIYASA REJIMI ===
Rejim: ${regime.regime}  Bias: ${regime.bias}  XU100 Deg: ${fmt(regime.xu100Chg, 2)}%  Breadth: ${fmt(regime.breadth, 2)}  Ort.RSI: ${fmt(regime.avgRSI, 0)}
Kural: BEAR_TREND'te AL sinyallerine agir supheyle yaklas. OVERBOUGHT'ta karli satis onerileri one cikar. OVERSOLD'da contrarian long firsatlari degerlendir.

=== 7-KATMANLI ANALIZ HIYERARSISI (siradan agirlikli) ===
1) MAKRO (x1.0): XU100=${fmt(xu100)}  USDTRY=${fmt(usdtry, 4)}  Sentiment=${marketSentiment?.sentiment || '-'}
2) SEKTOREL (x0.9): ${sector || '-'}
3) TEMEL (x0.8): F/K=${fmt(fundamentals.pe)} PD/DD=${fmt(fundamentals.pb)} ROE=${fmt(fundamentals.roe)}% KarTrend=${fundamentals.profitTrend || '-'} BrutMarj=${fmt(fundamentals.grossMargin)}% OpMarj=${fmt(fundamentals.opMargin)}%
4) TEKNIK (x1.0): Fiyat=${fmt(price)} Deg=%${fmt(change)} MA20=${fmt(ma20)} MA50=${fmt(ma50)} MA200=${fmt(ma200)} RSI=${fmt(rsi, 1)} MACD=${fmt(macd, 3)}/${fmt(macdSignal, 3)} BB=${bb ? `${fmt(bb.lower)}-${fmt(bb.upper)}` : '-'} ATR=${fmt(atr)} VWAP=${fmt(vwap)}
5) ZAMAN (x0.9): Sinyal=${signal || '-'} (${cls || '-'})  Skor=${fmt(score, 1)}/10  Conf=${fmt(conf, 0)}%  Wyckoff=${wyckoff || '-'}
6) RISK (x1.2): Stop=${fmt(stop)}  ATR-multiple=${atr && stop && price ? fmt(Math.abs(price - stop) / atr, 1) : '-'}
7) POZISYON (x1.0): Giris=${fmt(entry)}  T1=${fmt(target)}  T2=${fmt(targetT2)}  T3=${fmt(targetT3)}  Uzun=${fmt(longTerm)}  R/R=1:${fmt(rr, 2)}  Vade=${holdText || '-'}

AKILLI PARA: MFI=${fmt(mfi, 0)} OBV=${obv?.trend || '-'} YabanciTakas=${fmt(foreignRatio)}% (Haftalik: ${foreignChangeWeek > 0 ? '+' : ''}${fmt(foreignChangeWeek)}%)
SETUPLAR: ${setupList || '-'}
MONTE CARLO: P(kar)=%${fmt(mcProfitProb, 0)}  Medyan=${fmt(mcMedian)}${portfolioBlock}

=== OTOMATIK TESPIT EDILEN UYARILAR ===
${flagsText}

=== CONTRARIAN PROTOKOL ===
Her uyariyi cevabinda ACIKCA ele al. Uyari varsa confidence'i >=20 puan dusur. Hicbir uyari YOKSA ve rejim sinyalle uyumluysa confidence artirilabilir.

=== CEVAP FORMATI (Turkce, sade, max 220 kelime) ===
[ONERI] AL/TUT/SAT + vade (gun/hafta/ay) + guven (DUSUK/ORTA/YUKSEK).
[CONFIDENCE] 1-10 arasi kendi degerlendirmen. Gerekce 1 cumle.
[OZET] En kritik 3 madde (makro/sektor/teknik hangisi belirleyici).
[RISK] En buyuk 2 risk — somut, sayisal.
[AKSIYON] Giris-stop-T1-T2-T3 fiyatlari + kademeli alim plani (orn: %40 sinyalde, %40 pullback'te, %20 breakout'ta).
[ALTERNATIF] Sinyal yanlisa kirilim seviyesi nedir, ne izlemeli?${portfolio ? '\n[PORTFOY_ETKI] Bu pozisyon mevcut portfoy ile nasil etkilesir? (konsantrasyon/korelasyon).' : ''}`;
}

// ── Daily Picks Prompt (A/B/C grades) ──────────────────────────────────────
export function buildDailyPicksPrompt(picks = [], market = {}) {
  const ctx = market.marketSentiment || market.sentiment || {};
  const header = `Piyasa: ${ctx.sentiment || '-'}  AL:${ctx.buys || 0} SAT:${ctx.sells || 0}  RSI ort: ${ctx.avgRSI?.toFixed(0) || '-'}`;
  const macroLine = ctx.macro ? buildMacroPromptLine(ctx.macro) : '';

  const rows = picks.slice(0, 8).map(p => {
    const grade = gradeSetup(p);
    // KAP haberleri (varsa)
    let kapStr = '';
    if (p.kapSentiment != null && p.kapCount > 0) {
      const sign = p.kapSentiment >= 0 ? '+' : '';
      const head = p.kapHeadline ? ` "${p.kapHeadline.slice(0, 40)}"` : '';
      kapStr = ` KAP=${sign}${p.kapSentiment.toFixed(1)}(${p.kapCount})${head}`;
    }
    // Borsa haberleri (yabanci alimi, fundamental sira, geri alim, vb.)
    let newsStr = '';
    if (p.newsCount > 0) {
      const sign = p.newsScore >= 0 ? '+' : '';
      const cats = p.newsCategories?.length ? `[${p.newsCategories.slice(0, 3).join(',')}]` : '';
      const head = p.newsHeadline ? ` "${p.newsHeadline.slice(0, 40)}"` : '';
      newsStr = ` HABER${cats}=${sign}${p.newsScore?.toFixed?.(1) ?? p.newsScore}(${p.newsCount})${head}`;
    }
    let foreignStr = p.foreignRatio != null ? ` Yabanci=%${p.foreignRatio.toFixed(1)}(${p.foreignChangeWeek > 0 ? '+' : ''}${p.foreignChangeWeek?.toFixed(1) || 0})` : '';
    const rrStr = p.rrNet != null
      ? `R/R(net)=1:${p.rrNet.toFixed(2)}`
      : `R/R=1:${p.rr?.toFixed(2)}`;
    return `- ${p.symbol} [${grade}] ${p.signal} skor=${p.score?.toFixed(1)} fiyat=${p.price?.toFixed(2)} stop=${p.stop?.toFixed(2)} T1=${p.target?.toFixed(2)} ${rrStr} RSI=${p.rsi?.toFixed(0)}${kapStr}${newsStr}${foreignStr}`;
  }).join('\n');

  return `Sen BIST gunluk strateji uzmanisin. Bugun icin en iyi firsatlari sirala.

${header}${macroLine ? '\n' + macroLine : ''}

ADAY LISTESI:
${rows}

NOT: KAP=sirket bildirimleri (-10..+10).
HABER[kategori]=borsa haberleri sentiment'i. Kategoriler:
  fund_inflow=yabanci/kurumsal alim, fundamental_rank=cari oran/F-K/karlilik siralamasi,
  buyback=geri alim, insider_buy=iceriden alim, dividend=temettu, upgrade=tavsiye yukselt,
  downgrade=tavsiye dusur, contract=sozlesme/ihale, risk=dava/sorusturma/ceza.
Kategoriler kurulum kalitesini tartmada AGIR rol oynamali — fund_inflow + fundamental_rank
birlesince A notu icin onemli teyittir; risk kategorisi C notuna dusurur.

Her hisseyi A/B/C notuyla derecelendir:
- A = guclu kurulum (skor>=70, net R/R>=2, teknik+temel uyumlu, hacim destekli)
- B = orta kurulum (skor 55-70, net R/R 1.5-2, tek teyit eksik)
- C = zayif kurulum (skor<55 veya net R/R<1.5 veya teyit yok)

CEVAP FORMATI:
1. Bugunun TOP3'u (sadece A notunu ver)
2. Her biri icin 1 cumle neden
3. Ortak tema (sektor rotasyonu, momentum, defansif vb.)
4. Kacinilmasi gereken hisseler (C notu)
5. Genel piyasa tavsiyesi (1 cumle)
Max 180 kelime, Turkce.`;
}

function gradeSetup(p) {
  // Advisor picks carry 0-100 scores (the old >=7 check graded nearly every
  // rr>=2 pick as "A"). RR is net-of-cost when available.
  const s = p.score || 0;
  const rr = p.rrNet ?? p.rr ?? 0;
  if (s >= 70 && rr >= 2) return 'A';
  if (s >= 55 && rr >= 1.5) return 'B';
  return 'C';
}

// ── Static SMC / strategy rulebook (CACHE-ELIGIBLE) ────────────────────────
// This block is identical on every call — Anthropic prompt caching will
// return it from the cache for ~5 minutes, reducing input cost by ~90%
// on multi-ticker scans (e.g. Daily Picks, Advisor runs over BIST50).
//
// Must stay >= 1024 tokens combined with the base system prompt, otherwise
// Anthropic silently declines to cache. Keep this as the long, stable half.
const SMC_RULEBOOK = `=== SMART MONEY CONCEPTS (SMC) KURALLARI ===
BOS (Break of Structure): Onceki pivot high/low'un hacimli (>=1.3x ort) kirilimi trend teyididir.
  - Bull BOS: fiyat son swing high uzerine hacim ile kapanirsa; stop son swing low'un altinda.
  - Bear BOS: fiyat son swing low altina hacim ile kapanirsa; stop son swing high uzerinde.
CHoCH (Change of Character): BOS zincirinin tersine ilk kirilim — trend donus sinyali.
  Confluence: FVG + OB + MFI/OBV diverjansi birlesimi >= 2 teyit gerektirir.
Order Block (OB): BOS'tan onceki son KARSIT yonde mum. Retest zonunda tepki beklenir.
  - Bullish OB: bull BOS'tan onceki son bearish mum (low, high) bolgesi.
  - Bearish OB: bear BOS'tan onceki son bullish mum bolgesi.
  - OB kirildiginda gecersiz sayilir (broke-below / broke-above).
FVG (Fair Value Gap): 3-mumluk boslugun mitigate edilmemis alani.
  - Bullish FVG: bar[i+2].low > bar[i].high → fiyat geri donerse destek.
  - Bearish FVG: bar[i+2].high < bar[i].low → fiyat geri donerse direnc.
Liquidity Sweep: 20-bar ekstrem + MFI/OBV diverjans = stop-hunt. Ters yonde devam beklenir.

=== 7-KATMANLI AGIRLIKLANDIRMA ===
Makro(1.0) > Risk(1.2) > Teknik(1.0) > Pozisyon(1.0) > Sektorel(0.9) > Zaman(0.9) > Temel(0.8)
Risk katmani (1.2) en yuksek agirlikta — stop uzakligi, ATR katsayisi ve R/R orani kararı bukar.

=== CONTRARIAN PROTOKOL ===
Asiri iyimser/kotumser tespit edildiginde confidence -20 puan.
Rejim karsit (BEAR_TREND'te AL, OVERBOUGHT'ta AL) = uyari zorunlu.
Monte Carlo P(kar) < %45 ve AL onerisi = cevapta ACIKCA ele al.

=== SETUP GRADE (A/B/C/D) ===
A: skor>=7 + R/R>=2 + teknik+temel uyumlu + hacim destekli
B: skor 5-7 + R/R 1.5-2 + tek teyit eksik
C: skor<5 VEYA R/R<1.5 VEYA teyit yok
D: rejim karsit + birden fazla uyari aktif

=== MAKRO KATMANI ===
Prompt'taki MAKRO satiri rejim bilgisini iceriyor (USDTRY 5g momentum, VIX, TCMB PPK, BIST/USD).
RISK_OFF rejiminde: breakout sinyalleri zayiftir — A notunu B'ye dusur, R/R 2.0 ZORUNLU.
PANIC rejiminde: AL onerme; sadece SAT/TUT, defansif sektor (gida/elektrik/savunma) tercih.
TCMB PPK haftasi (<=3g): volatilite artar, stop genislet, kademeli giris ZORUNLU, lot kucult.
USDTRY 5g >+%5 (TL zayifliyor): ihracatci (TUPRS/FROTO/TOASO/EREGL) +B; ithalatci/borc agir (PETKM/TCELL) -B.
VIX > 25 (global panic): yuksek-beta hisseler (havacilik/banka) -B; dusuk-beta gida/elektrik +B.
RISK_ON rejiminde: momentum stratejisi ve breakout normal isler, A notunu serbestce ver.`;

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
async function callClaude({ prompt, messages, systemPrompt, tools, model = DEFAULT_MODEL, temperature = DEFAULT_TEMPERATURE, maxTokens = 1024, useCache = true, outputConfig = null }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { error: 'Claude API anahtari tanimlanmamis. Ayarlardan ekle.' };
  }

  const finalMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: prompt }];

  // Opus 4.7+ / Sonnet 5 / Fable 5 reject sampling params (temperature/top_p/top_k → 400).
  const samplingRemoved = /claude-(opus-4-[78]|sonnet-5|fable-5)/.test(model);

  const payload = {
    model,
    max_tokens: maxTokens,
    system: useCache
      ? buildCachedSystem(systemPrompt)
      : (systemPrompt || undefined),
    messages: finalMessages,
  };
  if (!samplingRemoved && temperature != null) payload.temperature = temperature;
  if (outputConfig) payload.output_config = outputConfig;
  if (tools && tools.length) payload.tools = tools;

  let tid;
  try {
    const baseUrl = PROXY_BASE_URL || '';
    if (!baseUrl) {
      return { error: 'CORS Proxy URL ayarlanmamis. Ayarlardan Vercel Proxy URL\'nizi girin.' };
    }
    const endpoint = baseUrl.replace(/\/+$/, '') + PROXY_CLAUDE_ENDPOINT;
    const controller = new AbortController();
    tid = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(tid);
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
    clearTimeout(tid);
    if (err.name === 'AbortError')
      return { error: `Claude API zaman asimi (${CLAUDE_TIMEOUT_MS / 1000}s). Tekrar deneyin.` };
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
    const m = result.text.match(/\[[\s\S]*\]/);
    if (!m) return { error: 'AI JSON dondurmedi.' };
    return JSON.parse(m[0]);
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

// ── Daily Picks (WS8) — structured, evidence-fed grading ────────────────────
// Model: claude-opus-4-8 (sampling params removed on 4.7+ — callClaude strips
// temperature automatically). Output is schema-constrained JSON so grades can
// be parsed into pick.claudeGrade and tracked in the forward journal.
const DAILY_PICKS_MODEL = 'claude-opus-4-8';
const DAILY_PICKS_SCHEMA = {
  type: 'object',
  properties: {
    grades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          grade: { type: 'string', enum: ['A', 'B', 'C'] },
          confidence: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['symbol', 'grade', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
    avoid: { type: 'array', items: { type: 'string' } },
    theme: { type: 'string' },
    marketAdvice: { type: 'string' },
  },
  required: ['grades', 'avoid', 'theme', 'marketAdvice'],
  additionalProperties: false,
};

// Measured-evidence block: the LLM grades with the system's actual track
// record instead of vibes. Best-effort — an empty/young journal yields ''.
function buildMeasuredStatsBlock(journalStatsObj) {
  const s = journalStatsObj;
  if (!s || !s.evaluated) return '';
  const lines = [
    `OLCULMUS PERFORMANS (forward journal, n=${s.evaluated}):`,
    `- Ertesi-gun yon isabeti: %${s.directionalAccuracy.toFixed(0)} | Net beklenti: %${(s.netExpectancy ?? 0).toFixed(2)}/pick`,
    `- Son 20 pick net beklenti: %${(s.rolling20?.netExpectancy ?? 0).toFixed(2)} (n=${s.rolling20?.samples ?? 0})`,
  ];
  const st = s.bySignalType || {};
  const typed = Object.entries(st).filter(([, v]) => v.total >= 8);
  if (typed.length) {
    const sorted = typed.sort((a, b) => b[1].accuracy - a[1].accuracy);
    const top = sorted.slice(0, 3).map(([k, v]) => `${k} %${v.accuracy.toFixed(0)}(n=${v.total})`).join(', ');
    const bot = sorted.slice(-3).map(([k, v]) => `${k} %${v.accuracy.toFixed(0)}(n=${v.total})`).join(', ');
    lines.push(`- En iyi sinyal tipleri: ${top}`);
    lines.push(`- En kotu sinyal tipleri: ${bot}`);
  }
  lines.push('Bu olcumleri notlandirmada AGIR kullan: dusuk isabetli sinyal tiplerine dayanan setuplar not kirmali.');
  return '\n' + lines.join('\n') + '\n';
}

export async function askDailyPicks(picks, market, opts = {}) {
  // Measured stats: caller can inject (test seam); default reads the journal.
  let statsBlock = '';
  try {
    if (opts.journalStats) {
      statsBlock = buildMeasuredStatsBlock(opts.journalStats);
    } else {
      const { loadJournal, journalStats } = await import('./forwardTestJournal.js');
      statsBlock = buildMeasuredStatsBlock(journalStats(loadJournal()));
    }
  } catch { /* evidence is optional */ }

  const prompt = buildDailyPicksPrompt(picks, market) + statsBlock +
    '\nSadece JSON dondur (grades/avoid/theme/marketAdvice). reason alanlari Turkce ve 1 cumle olsun.';

  const result = await callClaude({
    prompt,
    systemPrompt: 'Sen BIST gunluk strateji uzmanisin. Turkce yaz.',
    maxTokens: 1400,
    model: DAILY_PICKS_MODEL,
    outputConfig: { format: { type: 'json_schema', schema: DAILY_PICKS_SCHEMA } },
  });
  if (result.error) return result;

  // Parse structured grades; fall back to prose-only on any parse failure.
  try {
    const parsed = JSON.parse(result.text);
    if (Array.isArray(parsed.grades)) {
      return { ...result, ...parsed, structured: true };
    }
  } catch { /* fall through to prose-only */ }
  return { ...result, structured: false };
}

// ── Daily Market Intelligence (News & Events) ──────────────────────────────
export async function askMarketIntel(newsList = []) {
  const newsText = newsList.map((n, i) => `${i+1}. [${n.source}] ${n.title}`).join('\n');

  const prompt = `Sen BIST (Borsa Istanbul) istihbarat sefisin.
Sana asagida bugunun bazi RSS haberlerini verdim. Ancak bu yeterli degil.
Senden IKI GOREVIN var:
1. "web_search" aracini kullanarak bugunun (son 24 saat) "Borsa Istanbul araci kurum raporlari", "BIST 100 uzman yorumlari", "Hisse model portfoy guncellemeleri" gibi aramalar yap. Finans uzmanlarinin, analistlerin ve kurumlarin hangi hisselere AL verdigini veya hedef fiyat yukselttigini bul.
2. Bu topladigin verileri ve asagidaki RSS haberlerini birlestirip bana detayli bir JSON raporu dondur.

=== BUGUNUN RSS HABERLERI ===
${newsText || 'Haber yok.'}

=== CIKTI FORMATI ===
SADECE gecerli bir JSON dondur, baska metin yazma.
JSON formati su sekilde olmali:
{
  "newsMarkdown": "Günün en önemli 3 finans/ekonomi haberi ve etkileri. Sadece haberler. 1-2 paragraf.",
  "expertMarkdown": "Web aramasindan buldugun ARACI KURUM / UZMAN yorumlari. Hangi uzman hangi hisse icin ne demis? Liste halinde.",
  "impacts": [
    {
      "symbol": "ASELS",
      "impact": 15, // Pozitif haber/yorum icin +10 ile +20 arasi, negatif icin -10 ile -20 arasi
      "reason": "Ziraat Yatirim hedef fiyatini yukseltti ve model portfoyune ekledi."
    }
  ]
}

- impacts dizisine en cok etkilenen max 6 hisseyi ekle.
- Sadece JSON dondur.`;

  const result = await callClaude({
    prompt,
    systemPrompt: 'Sen BIST piyasa istihbarati analistisin. Istenilen formati (JSON) kesinlikle bozma.',
    temperature: 0.6,
    maxTokens: 1500,
    tools: [{
      type: 'web_search_20241020',
      name: 'web_search',
      max_uses: 3,
    }],
    useCache: false
  });

  if (result.error) return { error: result.error };
  try {
    const m = result.text.match(/\\{[\s\S]*\\}/);
    if (!m) return JSON.parse(result.text); // Try direct parse
    return JSON.parse(m[0]);
  } catch (e) {
    console.error("Market Intel JSON Parse Error:", e, result.text);
    return null;
  }
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
