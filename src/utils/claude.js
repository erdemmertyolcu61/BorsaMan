/**
 * claude.js - Claude AI integration (v8)
 *
 * Features:
 *  - Expert prompt builder with 7-layer analysis hierarchy
 *  - Daily picks prompt with A/B/C setup grades
 *  - KAP disclosure sentiment analysis (via proxy backend)
 *  - Web search tool use (news lookup)
 *  - Claude Opus 5.5 (claude-opus-5-5) on every route — see CLAUDE_MODEL below
 */

import { buildMacroPromptLine } from './macroContextEngine.js';
import { PROXY_BASE_URL } from './fetchEngine.js';
import { KAP_EVENT_EVIDENCE } from './kapFeed.js';

const API_KEY_STORAGE = 'claude_api_key';
const PROXY_CLAUDE_ENDPOINT = '/api/claude'; // relative — served by proxy server

// v31.46: every route runs on Claude Opus 5.5. The previous default,
// claude-sonnet-4-20250514, was RETIRED on 2026-06-15 — from then on every
// JARVIS chat, expert analysis, KAP and market-intel request failed upstream.
// Opus 5.5's request surface differs from Sonnet 4 in ways that 400 if ignored:
//   - no sampling parameters (temperature / top_p / top_k)
//   - thinking is ALWAYS on; `output_config.effort` is the only control and its
//     default is "medium" — so every route sets it explicitly
//   - thinking tokens count toward max_tokens (see THINKING_HEADROOM)
//   - web search is `web_search_20260209`
export const CLAUDE_MODEL = 'claude-opus-5-5';

// Thinking counts toward max_tokens even though its text is not returned. Callers
// pass the REPLY budget they want; this headroom is added on top so a long think
// can never truncate the answer itself (a 1,200-token cap sized for Sonnet 4
// would otherwise be eaten by reasoning and come back empty).
export const THINKING_HEADROOM = Object.freeze({ low: 2000, medium: 6000, high: 12000 });

// Opt into server-side refusal fallbacks: if a safety classifier declines a
// request, Anthropic re-runs it on its recommended fallback model inside the
// same call instead of returning an empty refusal.
export const CLAUDE_BETA = 'server-side-fallback-2026-07-01';

// Client wait must outlast the proxy's own limit (vercel.json maxDuration 60 s),
// otherwise the browser gives up on a request the function is still serving.
const CLAUDE_TIMEOUT_MS = 65_000;

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

// ── Expert Prompt (7-layer analysis) ───────────────────────────────────────
// Render the rich global / commodity macro block for the expert prompt.
// `macro` is the getMacroContext() object (usdtry/vix/tcmb/sp500/brent/gold/…).
// A 25-year strategist reads oil, global risk and rates alongside the chart —
// this surfaces all of it so the model can weigh the stock in a world context.
function _renderMacroBlock(macro, fmt) {
  if (!macro) return '   (kuresel/emtia verisi su an yok — model web arama ile guncel durumu teyit etmeli)';
  const lines = [];
  const chg = (o) => o && Number.isFinite(o.change5d) ? `${o.change5d >= 0 ? '+' : ''}${o.change5d.toFixed(1)}%` : '-';
  if (macro.usdtry) {
    const d = macro.tcmb?.nextMeeting ? Math.ceil((new Date(macro.tcmb.nextMeeting).getTime() - Date.now()) / 86400000) : null;
    lines.push(`   Kur/Faiz: USDTRY=${fmt(macro.usdtry.value)} (5g ${chg(macro.usdtry)}${macro.usdtry.vol20d != null ? `, vol ${macro.usdtry.vol20d.toFixed(0)}%` : ''})${macro.tcmb?.rate != null ? ` | TCMB=${macro.tcmb.rate}%${d != null && d >= 0 ? ` (PPK ${d}g sonra)` : ''}` : ''}`);
  }
  const risk = [];
  if (macro.vix) risk.push(`VIX=${fmt(macro.vix.value, 1)} (${macro.vix.classification || '-'})`);
  if (macro.sp500) risk.push(`S&P500 5g ${chg(macro.sp500)}`);
  if (macro.bistUsd) risk.push(`BIST/USD 20g ${macro.bistUsd.change20d >= 0 ? '+' : ''}${macro.bistUsd.change20d.toFixed(1)}%`);
  if (risk.length) lines.push(`   Kuresel risk: ${risk.join(' | ')}`);
  const comm = [];
  if (macro.brent) comm.push(`Brent $${fmt(macro.brent.value, 1)} (5g ${chg(macro.brent)})`);
  if (macro.gold) comm.push(`Altin $${fmt(macro.gold.value, 0)} (5g ${chg(macro.gold)})`);
  if (macro.silver) comm.push(`Gumus $${fmt(macro.silver.value, 1)} (5g ${chg(macro.silver)})`);
  if (macro.copper) comm.push(`Bakir (5g ${chg(macro.copper)})`);
  if (macro.natgas) comm.push(`Dogalgaz (5g ${chg(macro.natgas)})`);
  if (macro.wheat) comm.push(`Bugday (5g ${chg(macro.wheat)})`);
  if (comm.length) lines.push(`   Emtia: ${comm.join(' | ')}`);
  if (macro.regime) {
    const rs = Array.isArray(macro.reasons) && macro.reasons.length ? ` — ${macro.reasons.slice(0, 3).join('; ')}` : '';
    lines.push(`   Makro rejim: ${String(macro.regime).toUpperCase()}${rs}`);
  }
  return lines.length ? lines.join('\n') : '   (veri yok)';
}

// ── Daily Picks Prompt (A/B/C grades) ──────────────────────────────────────
// v31.40: KAP olay turlerinin OLCULMUS etkisi (kapFeed.KAP_EVENT_EVIDENCE, 24 ay). "Yeni is
// anlasmasi" haberi sistemin alabildigi anda cogunlukla fiyatlanmis ve sonrasinda piyasanin
// gerisinde kaliyor; bu bilgi olmadan model "anlasma = kovala" sezgisiyle A notu verebilirdi.
function kapEvidencePromptNote() {
  const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const parts = ['new_business', 'buyback', 'bonus_issue', 'capital_increase']
    .map((t) => {
      const e = KAP_EVENT_EVIDENCE[t];
      return e ? `${t}: once ${pct(e.preMovePct)}, 5 seans ${pct(e.h5ExcessPct)}, 10 seans ${pct(e.h10ExcessPct)} (n=${e.n})` : '';
    })
    .filter(Boolean);
  return `KAP 24 aylik olcum (girisden sonra, piyasaya gore): ${parts.join('; ')}. `
    + 'Yeni is/sozlesme haberi tek basina A notu gerekcesi DEGILDIR (cogunlukla fiyatlanmis, kovalama riski); geri alim olumlu teyittir.';
}

export function buildDailyPicksPrompt(picks = [], market = {}) {
  const ctx = market.marketSentiment || market.sentiment || {};
  const header = `Piyasa: ${ctx.sentiment || '-'}  AL:${ctx.buys || 0} SAT:${ctx.sells || 0}  RSI ort: ${ctx.avgRSI?.toFixed(0) || '-'}`;
  const macroLine = ctx.macro ? buildMacroPromptLine(ctx.macro) : '';

  const rows = picks.slice(0, 8).map(p => {
    const grade = gradeSetup(p);
    // v31.40: KAP olaylari (kapFeed, son 7 gun). Eski `kapSentiment` alani olu KAP
    // katmanindandi ve hic dolmuyordu — Claude KAP'i hic gormuyordu.
    let kapStr = '';
    if (p.kapRisk) {
      kapStr = ` KAP[TEDBIR:${p.kapRisk}]`;
    } else if (Array.isArray(p.kapCategories) && p.kapCategories.length) {
      const head = p.kapHeadline ? ` "${String(p.kapHeadline).slice(0, 40)}"` : '';
      kapStr = ` KAP[${p.kapCategories.slice(0, 3).join(',')}]${head}`;
    } else if (p.kapSentiment != null && p.kapCount > 0) {
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
    let foreignStr = '';
    if (p.foreignRatio != null) {
      const cw = p.foreignChangeWeek || 0;
      const cm = p.foreignChangeMonth || 0;
      const label = p.foreignFlowLabel || '';
      foreignStr = ` Yabanci=%${p.foreignRatio.toFixed(1)}(H:${cw > 0 ? '+' : ''}${cw.toFixed(1)},A:${cm > 0 ? '+' : ''}${cm.toFixed(1)})${label && label !== 'NOTR' ? '[' + label + ']' : ''}`;
    }
    const rrStr = p.rrNet != null
      ? `R/R(net)=1:${p.rrNet.toFixed(2)}`
      : `R/R=1:${p.rr?.toFixed(2)}`;
    return `- ${p.symbol} [${grade}] ${p.signal} skor=${p.score?.toFixed(1)} fiyat=${p.price?.toFixed(2)} stop=${p.stop?.toFixed(2)} T1=${p.target?.toFixed(2)} ${rrStr} RSI=${p.rsi?.toFixed(0)}${kapStr}${newsStr}${foreignStr}`;
  }).join('\n');

  return `Sen BIST gunluk strateji uzmanisin. Bugun icin en iyi firsatlari sirala.

${header}${macroLine ? '\n' + macroLine : ''}

ADAY LISTESI:
${rows}

NOT: KAP[olay]=son 7 gunun sirket bildirimleri; KAP[TEDBIR:...]=hisseye islem tedbiri (AL listesine alinmaz).
${kapEvidencePromptNote()}
HABER[kategori]=borsa haberleri sentiment'i. Kategoriler:
  fund_inflow=yabanci/kurumsal alim, fundamental_rank=cari oran/F-K/karlilik siralamasi,
  buyback=geri alim, insider_buy=iceriden alim, dividend=temettu, upgrade=tavsiye yukselt,
  downgrade=tavsiye dusur, contract=sozlesme/ihale/siparis, catalyst_event=olay (transfer, ortaklik, satin alma),
  risk=dava/sorusturma/ceza.
Kategoriler kurulum kalitesini tartmada AGIR rol oynamali — fund_inflow + fundamental_rank
birlesince A notu icin onemli teyittir; risk kategorisi C notuna dusurur.
contract ve catalyst_event bilgi amaclidir, TEYIT SAYILMAZ: HABER skoru pozitif gorunse de KAP olcumunde
yeni is anlasmasi ve birlesme/edinim alinabildigi anda fiyatlanmis cikti; sistem bunlara guven artisi vermez.

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
// `maxTokens` is the REPLY budget; thinking headroom for `effort` is added on top.

/**
 * Pure request builder (tested): what callClaude sends to the proxy.
 * @returns {{ payload: object, headers: object }}
 */
export function buildClaudeRequest({ prompt, messages, systemPrompt, tools, effort = 'medium', maxTokens = 1024, useCache = true, outputConfig = null }) {
  const finalMessages = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: prompt }];
  const level = THINKING_HEADROOM[effort] != null ? effort : 'medium';
  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: Math.max(256, Math.round(maxTokens)) + THINKING_HEADROOM[level],
    system: useCache
      ? buildCachedSystem(systemPrompt)
      : (systemPrompt || undefined),
    messages: finalMessages,
    output_config: { ...(outputConfig || {}), effort: level },
    fallbacks: 'default',
  };
  if (tools && tools.length) payload.tools = tools;
  return {
    payload,
    headers: { 'Content-Type': 'application/json', 'anthropic-beta': CLAUDE_BETA },
  };
}

/**
 * Text out of a Messages API response. Reads blocks by TYPE: on Opus 5.5 a
 * response can open with (empty) thinking blocks before the text. A classifier
 * decline or a reply cut by max_tokens becomes an explicit error instead of an
 * empty answer the UI would show as "nothing to say".
 */
export function readClaudeResponse(data) {
  const text = (data?.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n')
    .trim();
  if (data?.stop_reason === 'refusal') {
    const cat = data?.stop_details?.category;
    return { error: `Claude bu istegi guvenlik filtresi nedeniyle yanitlamadi${cat ? ` (${cat})` : ''}. Soruyu farkli ifade etmeyi deneyin.`, raw: data };
  }
  if (!text && data?.stop_reason === 'max_tokens') {
    return { error: 'Claude yaniti token sinirina takildi (bos cevap). Daha kisa bir soru deneyin.', raw: data };
  }
  return { text, raw: data };
}

async function callClaude(opts) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { error: 'Claude API anahtari tanimlanmamis. Ayarlardan ekle.' };
  }
  const { payload, headers } = buildClaudeRequest(opts);

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
      headers: { ...headers, 'x-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `Claude HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return readClaudeResponse(await res.json());
  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError')
      return { error: `Claude API zaman asimi (${CLAUDE_TIMEOUT_MS / 1000}s). Tekrar deneyin.` };
    return { error: err.message || String(err) };
  }
}

// ── Daily Picks (WS8) — structured, evidence-fed grading ────────────────────
// Output is schema-constrained JSON (output_config.format) so grades can be
// parsed into pick.claudeGrade and tracked in the forward journal. Runs on the
// same CLAUDE_MODEL as every other route (was a separate claude-opus-4-8 pin).
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
    effort: 'medium',
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

