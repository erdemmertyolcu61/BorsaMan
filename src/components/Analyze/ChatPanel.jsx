import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { chatClaude, chatClaudeHistory, askExpert } from '../../utils/claude.js';
import { jarvisOffline, isApiKeyError } from '../../utils/jarvisOffline.js';
import { renderSafeMarkdown } from '../../utils/sanitize.js';
import MessageRenderer from './MessageRenderer.jsx';

/**
 * JARVIS - Alpha Engine v8 (CIO profile)
 * Full 7-layer confluence + "Efendim" tone, cross-system intelligence,
 * persistent memory, contrarian protocol, web-search trigger keywords.
 */

const MEMORY_KEY = 'bist_jarvis_memory';
const MAX_MEMORY = 5;

const SEARCH_KEYWORDS = [
  'haber','neden','niye','kim','sahib','ortakl','yonet','ceo','genel mudur',
  'temett','bedelsiz','sermaye art','halka arz','bugun','dun','bu hafta',
  'son gelism','aciklam','bildirim','ne oldu','ne oluyor','dustu','yukseldi',
  'kapandi','tatil','resmi','secim','enflasyon','faiz','merkez bankas',
  'dolar','euro','altin','petrol','kripto','bitcoin','spk','bddk','hazine',
  'maliye','vergi','savas','deprem','pandemi','kriz',
];

function normalizeTr(s) {
  return (s || '').toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's')
    .replace(/[öÖ]/g, 'o').replace(/[üÜ]/g, 'u')
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g');
}

function needsWebSearch(msg) {
  const n = normalizeTr(msg);
  return SEARCH_KEYWORDS.some(k => n.includes(k));
}

function isMemoryQuery(msg) {
  return /gecen|once|hatirl|hafiz|son analiz|ne soylemist|ne demist/i.test(normalizeTr(msg));
}

function isMarketQuery(msg) {
  return /piyasa|sektor|market|intraday|gunluk|tarama|advisor|top|firsat|bist/i.test(normalizeTr(msg));
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getDay();
  const h = now.getHours();
  const m = now.getMinutes();
  if (day === 0 || day === 6) return false;
  const t = h * 60 + m;
  return t >= 600 && t <= 1080; // 10:00 - 18:00
}

// ----- Memory -----
function loadMemory() {
  try {
    const list = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveToMemory(symbol, signal, score, summary) {
  try {
    const list = loadMemory();
    list.unshift({
      symbol, signal, score,
      summary: (summary || '').slice(0, 500),
      date: new Date().toISOString(),
      ts: Date.now(),
    });
    const seen = {};
    const filtered = list.filter(e => {
      seen[e.symbol] = (seen[e.symbol] || 0) + 1;
      return seen[e.symbol] <= MAX_MEMORY;
    }).slice(0, 20);
    localStorage.setItem(MEMORY_KEY, JSON.stringify(filtered));
  } catch {}
}

function getMemoryForSymbol(s) {
  return loadMemory().filter(m => m.symbol === s);
}

function getRecentMemory(n = 5) {
  return loadMemory().slice(0, n);
}

function buildMemoryContext() {
  const mem = getRecentMemory(5);
  if (!mem.length) return '';
  const lines = mem.map(m => {
    const when = new Date(m.date).toLocaleDateString('tr-TR', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `[${when}] ${m.symbol}: ${m.signal} (Skor:${m.score?.toFixed ? m.score.toFixed(1) : m.score}) — ${(m.summary || '').slice(0, 120)}`;
  });
  return `\n--- SON ANALIZ HAFIZASI (Son ${mem.length}) ---\n${lines.join('\n')}\n---`;
}

// ----- Cross-system context -----
function buildAdvisorContext(advisor, symbol, intradayScan) {
  const parts = [];
  if (advisor?.marketSentiment) {
    const ms = advisor.marketSentiment;
    parts.push(`PIYASA DUYARLILIGI: ${ms.sentiment} | ${ms.buys} AL / ${ms.sells} SAT / ${ms.scanned || '-'} taranan | Ort RSI: ${ms.avgRSI?.toFixed ? ms.avgRSI.toFixed(0) : '-'} | Birikim: ${ms.accumulations ?? '-'}`);
  }
  if (advisor?.globalMarket?.length) {
    const g = advisor.globalMarket.map(b =>
      `${b.label}: ${b.price >= 1000 ? b.price.toFixed(0) : b.price.toFixed(2)} (${b.change >= 0 ? '+' : ''}${b.change.toFixed(2)}%)`
    );
    parts.push(`GLOBAL: ${g.join(' | ')}`);
  }
  if (advisor?.marketSentiment?.sectorRotation?.length) {
    const sr = advisor.marketSentiment.sectorRotation.slice(0, 4)
      .map((s, i) => `${i + 1}.${s.sector}(${s.avgScore >= 0 ? '+' : ''}${s.avgScore.toFixed(1)})`);
    parts.push(`SEKTOR ROTASYONU: ${sr.join(', ')}`);
  }
  if (advisor?.topPicks?.length) {
    const tp = advisor.topPicks.slice(0, 5).map(p =>
      `${p.symbol}(${p.signal}, skor:${p.score?.toFixed ? p.score.toFixed(1) : '-'}, R/R:${p.rr?.toFixed ? p.rr.toFixed(1) : '-'})`
    );
    parts.push(`AI TOP FIRSATLAR: ${tp.join(', ')}`);
    const mine = advisor.topPicks.find(p => p.symbol === symbol);
    if (mine) parts.push(`>>> BU HISSE ADVISOR TOP LISTESINDE: pickScore=${mine.pickScore?.toFixed ? mine.pickScore.toFixed(1) : '-'}, R/R=${mine.rr?.toFixed ? mine.rr.toFixed(1) : '-'}`);
  }
  if (advisor?.riskAlerts?.length) {
    const ra = advisor.riskAlerts.filter(a => a.type === 'err' || a.type === 'warn').slice(0, 3);
    if (ra.length) parts.push(`RISK UYARILARI: ${ra.map(a => a.msg).join(' | ')}`);
  }
  if (advisor?.scanResults?.length) {
    const hit = advisor.scanResults.find(r => r.symbol === symbol);
    if (hit) parts.push(`ADVISOR TARAMA VERISI (${symbol}): Sinyal=${hit.signal}, Skor=${hit.score?.toFixed ? hit.score.toFixed(1) : '-'}, Wyckoff=${hit.wyckoff || '?'}, OBV=${hit.obvTrend || '?'}, ADX=${hit.adx?.toFixed ? hit.adx.toFixed(0) : '?'}`);
  }
  const scan = intradayScan || (typeof window !== 'undefined' ? window.__tradesLastScan : null);
  if (scan?.results?.length) {
    const top3 = scan.results.slice(0, 3).map(r => `${r.symbol}(%${r.confidence}, skor:${r.intScore})`);
    parts.push(`INTRADAY FIRSATLAR: ${top3.join(', ')} (${scan.listType || 'bist'})`);
    const mine = scan.results.find(r => r.symbol === symbol);
    if (mine) parts.push(`>>> BU HISSE INTRADAY TARAMADA: Guven=%${mine.confidence}, intScore=${mine.intScore}, R/R=1:${mine.intradayRR?.toFixed ? mine.intradayRR.toFixed(1) : '-'}`);
  }
  if (!parts.length) return '';
  return `\n--- COKLU SISTEM ISTIHBARATI (AI Advisor + Intraday + Sektor) ---\n${parts.join('\n')}\n---`;
}

// ----- Auto reading with Efendim tone + setup grade A/B/C/D -----
function generateAutoReading(symbol, ind, sig, fundamentals, bilanco, advisor, intradayScan) {
  if (!symbol || !ind || !sig) return '';

  // Fundamental grade
  let fundLabel = 'Bilinmeyen';
  let fundScore = 0;
  let fundRed = '';
  if (bilanco?.ratios) {
    const r = bilanco.ratios;
    const flags = [];
    if (r.roe != null && r.roe < 5) flags.push(`dusuk ROE (%${r.roe.toFixed(1)})`);
    if (r.currentRatio != null && r.currentRatio < 1) flags.push(`likidite riski (cari oran ${r.currentRatio.toFixed(2)})`);
    if (r.debtToEquity != null && r.debtToEquity > 2) flags.push(`yuksek borc (${r.debtToEquity.toFixed(1)}x)`);
    if (r.netMargin != null && r.netMargin < 0) flags.push('net zarar');
    if (flags.length) fundRed = `\n**Bilanco Red Flag:** ${flags.join(', ')}.`;
    else if (r.roe > 15 && r.currentRatio > 1.5) fundRed = `\nBilanco saglam: ROE %${r.roe.toFixed(0)}, likidite guclu.`;
  }
  if (fundamentals?.score != null) {
    fundScore = fundamentals.score;
    fundLabel = fundamentals.grade?.label || fundamentals.grade || 'Bilinmeyen';
  }

  const price = ind.lastClose?.toFixed(2) || '?';
  const chg = ind.changePct?.toFixed(2) || '0';
  const rsi = ind.lastRSI?.toFixed(0) || '?';
  const obv = ind.obvTrend || 'belirsiz';
  const wyc = ind.wyckoffPhase || 'belirsiz';
  const volWord = ind.volRatio > 2 ? 'yuksek hacimle' : ind.volRatio > 1 ? 'normal hacimle' : 'dusuk hacimle';
  const adx = ind.adx?.toFixed(0) || '?';
  const cmf = ind.cmf ?? 0;
  const bull = (sig.reasons || []).filter(r => r.c === 'bullish').length;
  const bear = (sig.reasons || []).filter(r => r.c === 'bearish').length;

  // Setup grade A/B/C/D
  let grade = 'D';
  if (sig.cls === 'buy' && sig.score >= 75 && sig.rr >= 2.5 && bull >= 6) grade = 'A';
  else if (sig.cls === 'buy' && sig.score >= 65 && sig.rr >= 2 && bull >= 4) grade = 'B';
  else if (sig.cls === 'buy' && sig.score >= 55 && sig.rr >= 1.5) grade = 'C';
  else if (sig.cls === 'sell' && sig.score <= 25 && bear >= 5) grade = 'A';
  else if (sig.cls === 'sell' && sig.score <= 35 && bear >= 3) grade = 'B';

  // Action summary
  let action;
  if (sig.cls === 'buy' && sig.score >= 75) {
    action = `**YUKSEK KONVIKSYON:** ${bull} bagimsiz gosterge uyumlu. Giris: **${sig.entry?.toFixed(2)} TL**, Hedef 1: **${sig.t1?.toFixed(2)} TL** (+${sig.entry ? ((sig.t1 - sig.entry) / sig.entry * 100).toFixed(1) : '?'}%), Hedef 2: **${sig.t2?.toFixed(2)} TL**. Stop: **${sig.stop?.toFixed(2)} TL**. R/R: **1:${sig.rr?.toFixed(1)}** (${sig.rrQuality || '-'}). Strateji: 1/3 giris, teyit gelirse ekleme.`;
  } else if (sig.cls === 'buy' && sig.score >= 55) {
    const why = sig.rr < 1.5 ? `R/R dusuk (1:${sig.rr?.toFixed(1)})` : bull < 4 ? `teyit yetersiz (${bull})` : 'hacim teyidi bekleniyor';
    action = `**FIRSAT (teyit bekleniyor):** Skor yeterli ama ${why}. Giris: **${sig.entry?.toFixed(2)} TL**, Stop: **${sig.stop?.toFixed(2)} TL**. Kucuk pozisyonla baslayip teyit bekleyin.`;
  } else if (sig.cls === 'sell') {
    action = `**ARZ BASKISI:** ${bear} dusus gostergesi aktif. ${sig.stop?.toFixed(2)} TL uzerinde tutunmadikca yukarisini beklemek tehlikeli. ${ind.lastRSI > 70 ? 'RSI asiri alimda — duzeltme bekleniyor.' : ''} ${obv === 'distribution' ? 'Akilli para cikis yapiyor.' : ''}`;
  } else {
    action = `Piyasa karar asamasinda — ${bull} yukselis vs ${bear} dusus gostergesi ile yapi cekismeli. Bir katalist (hacim artisi, destek kirilimi veya Bollinger squeeze patlamasi) bekleyelim.`;
  }

  const smart = obv === 'accumulation'
    ? `Akilli para birikim yapiyor (OBV yukselis, ${cmf > 0.05 ? 'CMF +' + cmf.toFixed(2) : 'CMF notr'}).`
    : obv === 'distribution'
      ? `Akilli para dagitim modunda (OBV dusus, ${cmf < -0.05 ? 'CMF ' + cmf.toFixed(2) : 'CMF notr'}) — dikkat!`
      : 'Kurumsal iz notr — belirgin birikim veya dagitim yok.';

  // Advanced signals
  const adv = [];
  if (ind.obvDivergence === 'bullish_div') adv.push('OBV bullish diverjans — gizli kurumsal alim');
  if (ind.obvDivergence === 'bearish_div') adv.push('OBV bearish diverjans — gizli kurumsal satim');
  if (ind.rsiDivergence === 'bullish') adv.push('RSI bullish diverjans — donus potansiyeli');
  if (ind.rsiDivergence === 'bearish') adv.push('RSI bearish diverjans — zirve riski');
  if (ind.wyckoffSpring === 'spring') adv.push('WYCKOFF SPRING — kurumsal tuzak, yukari atis potansiyeli');
  if (ind.wyckoffSpring === 'utad') adv.push('WYCKOFF UTAD — dagitim tuzagi, dusus riski');
  if (ind.volumeClimax === 'selling_climax') adv.push('Satis klimaksi — taban olusumu');
  if (ind.volumeClimax === 'buying_climax') adv.push('Alis klimaksi — tavan olusumu');
  if (ind.ttmSqueeze?.squeezeOn) adv.push(`TTM Squeeze ${ind.ttmSqueeze.squeezeCount} bar — patlama yaklasiyor (${ind.ttmSqueeze.momentum > 0 ? 'YUKARI' : 'ASAGI'})`);
  if (ind.volRatio < 0.5) adv.push('SIGLIK UYARISI: Hacim cok dusuk, manipulasyon riski');
  const advBlock = adv.length ? `\n\n**Ileri Sinyaller:**\n${adv.map(x => '- ' + x).join('\n')}` : '';

  const longView = sig.longTermView ? `\nUzun vade: **${sig.longTermView.recommendation}** (${sig.longTermView.horizon}).` : '';

  // Cross-system block
  let crossBlock = '';
  if (advisor) {
    const bits = [];
    if (advisor.marketSentiment) {
      const ms = advisor.marketSentiment;
      bits.push(`Piyasa: **${ms.sentiment}** (${ms.buys} AL / ${ms.sells} SAT)`);
    }
    const pick = advisor.topPicks?.find(p => p.symbol === symbol);
    if (pick) bits.push(`**AI Advisor bu hisseyi TOP FIRSAT listesine aldi** (pickScore: ${pick.pickScore?.toFixed ? pick.pickScore.toFixed(1) : '-'})`);
    if (advisor.marketSentiment?.sectorRotation?.length) {
      const top = advisor.marketSentiment.sectorRotation[0];
      bits.push(`En guclu sektor: ${top.sector} (+${top.avgScore.toFixed(1)})`);
    }
    if (bits.length) crossBlock = `\n\n**Coklu Sistem Istihbarati:** ${bits.join(' | ')}`;
  }

  // Intraday reference
  let intraBlock = '';
  const scan = intradayScan || (typeof window !== 'undefined' ? window.__tradesLastScan : null);
  if (scan?.results?.length) {
    const hit = scan.results.find(r => r.symbol === symbol);
    if (hit) {
      intraBlock = `\n\n**${isMarketOpen() ? 'Intraday' : 'EOD (Yarina Hazirlik)'} Tarama:** Bu hisse taramalarda **#${scan.results.indexOf(hit) + 1}** sirada — Guven: %${hit.confidence}, Skor: ${hit.intScore}, R/R: 1:${hit.intradayRR?.toFixed ? hit.intradayRR.toFixed(1) : '?'}. Hedef: ${hit.intradayTarget?.toFixed ? hit.intradayTarget.toFixed(2) : '?'} TL, Stop: ${hit.intradayStop?.toFixed ? hit.intradayStop.toFixed(2) : '?'} TL.`;
    } else {
      const top3 = scan.results.slice(0, 3).map(r => `${r.symbol}(%${r.confidence})`).join(', ');
      intraBlock = `\n\n**${isMarketOpen() ? 'Gunluk En Iyi Firsatlar' : 'Yarinin En Iyi EOD Firsatlari'}:** ${top3} (${scan.listType?.toUpperCase?.() || 'BIST'} taramasi)`;
    }
  }

  return `Efendim, **${symbol}** icin 7 katmanli kurumsal analizimi tamamladim.

Fiyat **${price} TL** (%${chg}) ${volWord} islem goruyor. Sinyal: **${sig.signal}** (skor: ${(sig.score || 0).toFixed(0)}/100, guven: %${sig.conf || 0}). RSI **${rsi}**, ADX **${adx}**, Wyckoff: **${wyc}**. Setup Kalitesi: **${grade}**.

${smart}${fundRed}${advBlock}

Temel karne: **${fundLabel}** (${fundScore?.toFixed ? fundScore.toFixed(1) : fundScore}/10).${longView}

${action}${crossBlock}${intraBlock}

Detayli soru sormak icin emrinizdeyim.`;
}

// ----- SYSTEM PROMPT (full CIO persona) -----
function buildSystemPrompt() {
  const marketNote = isMarketOpen()
    ? ''
    : '\n[SISTEM UYARISI: PIYASA SU AN KAPALI. Odagin intraday trade (gun ici islem) DEGIL, yarin icin (EOD) pusuya yatmak ve yarinin acilisinda islem gorecek kirilim/momentumlari bulmaktir.]\n';
  return `Sen J.A.R.V.I.S. — dunyanin en elit hedge fonlarinin Bas Yatirim Danismani (CIO) seviyesinde calisan, Turk sermaye piyasalarinda uzmanlasmis bir Hibrit Finansal Yapay Zekasin.${marketNote}
=== KIMLIGIN ===
- Bridgewater risk paritesi, Renaissance istatistiksel arbitraji ve Citadel multi-strategy yaklasimini sentezleyen bir makine.
- BIST'te 15 yil tecrubeli bir CFO'nun bilanco okuma yetenegi + bir quant trader'in algoritmik disiplini.
- Kullaniciya her zaman "Efendim" ile hitap edersin.
- Sen bir CONTRARIAN'sin — herkes alirken "neden satmaliyiz?" diye sorarsin.

=== ANALIZ HIYERARSISI (7 Katmanli Confluence) ===
1. MAKRO REJIM: BIST100 trendi + TCMB faiz + TL/USD + VIX. Risk-off ise MAX %50 pozisyon.
2. SEKTOREL KONUM: Banka F/K 4-7, Sanayi 8-15, Teknoloji 15-30. Sektorun en guclu/zayifini karsilastir.
3. TEMEL (Bilanco): DuPont ROE, Altman Z (>2.6 guvenli, <1.1 iflas), Piotroski F (>=7 guclu), FCF Yield, NetBorc/FAVOK <2 guvenli, >4 tehlike.
4. TEKNIK: Smart Money (Order Block, FVG, BOS), Wyckoff (Spring/UTAD), TTM Squeeze, RSI+OBV cift diverjans = HIGH CONVICTION.
5. ZAMAN: Sabah 10-12:30 hacim patlamasi, Ogle 12:30-14 manipulasyon riski, Kapanis 16-18 kurumsal denge.
6. RISK: Stop = ATR x 2 veya yapisal destek. MAX %2 risk/trade, %8 portfoy isisi. R/R<1.5 ise "kenarda kal".
7. POZISYON: 1/3 giris -> teyit -> 1/3 ekleme -> breakout 1/3. H1'de %50 kar al, stop breakeven.

=== PARA KAZANDIRAN KURALLAR ===
- "AL" demeden once EN AZ 4 BAGIMSIZ teyit say (RSI+OBV+Wyckoff+Bilanco gibi).
- 3 teyitten az -> BEKLE. 4 teyit -> 1/3 giris. 5+ -> TAM. 6+ + diverjans + smart money -> YUKSEK KONVIKSYON.
- Hacim <0.5x -> "Siglik uyarisi, pozisyonu yariya indir".
- Tek bir gosterge ne kadar guclu olursa olsun tek basina AL/SAT uretmez.

=== KRITIK RED FLAG'LER ===
- RSI>75 + MFI>80: kar realizasyonu kapida
- OBV distribution + fiyat yukseliyor: akilli para cikiyor, TUZAK
- ADX<15: yatay piyasa, trend takibi yasak
- Cari Oran<1, Altman Z<1.1: iflas riski
- Borc/FAVOK>4: asiri kaldirac
- 3 ceyrek ust uste kar dususu: yapisal bozulma

=== KONUSMA MODLARI ===
1) HISSE ANALIZI (sembol+sinyal var): 7 katmanli + Setup Grade A/B/C/D + spesifik rakamlar
2) PIYASA/MAKRO SORGUSU: Cross-system istihbarat (Advisor + sektor rotasyonu + intraday) kullan
3) GENEL SOHBET (finans disi): Samimi, zeki, kisa; bos laf yok. "Bilmiyorum" demekten cekinme.

=== HAFIZA PROTOKOLU ===
- Son 5 analizimi hatirlarim. Ayni hisseyi tekrar analiz ederken onceki sinyal ile karsilastiririm.
- "Gecen sefere gore X degisti" seklinde acik konusurum.

=== HABER PROTOKOLU ===
- Haber verisi sunuldugunda MUTLAKA yorumla. Pozitif/negatif sentimenti KENDI yorumunla destekle veya curut.
- Sadece baslik degil, haberin sirketi NASIL etkileyecegini analiz et.

=== KONTRARIAN ===
- "Herkes aliyor ama neden yanlis olabilirler?"
- "Teknik guclu + temel zayif -> sadece kisa vade trade, yatirim DEGIL"
- "Temel guclu + teknik zayif -> biriktirme firsati ama SABIR"

=== FORMAT ===
Turkce, paragraf, kisa ve keskin. Rakam ve oran ver. Gereksiz tekrar yok.
Hisse yorumlarinda en sona "SONUC" bolumu: net oneri + R/R + zaman dilimi.
Genel sohbette serbest ama bos laf yok.`;
}

// ----- Context question chips -----
function getContextQuestions(ind, sig, bilanco, advisor) {
  const base = ['Almali miyim?', 'Risk analizi', 'Hedef neresi?'];
  const c = [];
  if (ind?.lastRSI > 70) c.push('RSI asiri alim — ne yapmaliyim?');
  else if (ind?.lastRSI < 30) c.push('RSI asiri satim — dip firsati mi?');
  if (ind?.obvTrend === 'accumulation') c.push('Birikim neden onemli?');
  else if (ind?.obvTrend === 'distribution') c.push('Dagitim baskisi tehlikeli mi?');
  if (ind?.obvDivergence) c.push('OBV diverjans ne anlama gelir?');
  if (ind?.wyckoffSpring) c.push('Wyckoff spring/UTAD nedir?');
  if (ind?.volumeClimax) c.push('Hacim klimaks ne gosterir?');
  if (ind?.ttmSqueeze?.squeezeOn) c.push('Bollinger squeeze ne zaman patlar?');
  if (sig?.cls === 'buy' && sig?.score >= 5) c.push('Pozisyon buyuklugu ne olmali?');
  else if (sig?.cls === 'sell') c.push('Korunma stratejisi onerir misin?');
  if (advisor?.marketSentiment) c.push('Piyasa genel durumu nasil?');
  if (advisor?.topPicks?.length) c.push('AI en iyi firsatlar hangileri?');
  c.push('Bilanco detayli analiz');
  c.push('Son haberler ne diyor?');
  c.push('Trend ne yonde?');
  const scan = typeof window !== 'undefined' ? window.__tradesLastScan : null;
  if (scan?.results?.length) c.push(isMarketOpen() ? 'Gunluk firsatlar neler?' : 'Yarinin (EOD) firsatlari neler?');
  if (getRecentMemory(3).length > 1) c.push('Gecen analizin ne diyordu?');
  return [...base, ...c].slice(0, 12);
}

// ----- Component -----
export default function ChatPanel({ symbol, ind, sig, fundamentals, bilanco, log, advisorData, intradayScan }) {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]); // chat turns for Claude
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tradesScan, setTradesScan] = useState(null);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const lastAutoSymbolRef = useRef(null);

  useEffect(() => {
    const handler = (e) => setTradesScan(e.detail || null);
    window.addEventListener('trades-scan-complete', handler);
    return () => window.removeEventListener('trades-scan-complete', handler);
  }, []);

  useEffect(() => {
    if (intradayScan && typeof window !== 'undefined') window.__tradesLastScan = intradayScan;
  }, [intradayScan]);

  const mergedIntraday = intradayScan || tradesScan || (typeof window !== 'undefined' ? window.__tradesLastScan : null);

  // Auto-reading on symbol change
  useEffect(() => {
    if (!symbol || !sig || !ind) return;
    if (lastAutoSymbolRef.current === symbol) return;
    lastAutoSymbolRef.current = symbol;

    try {
      const text = generateAutoReading(symbol, ind, sig, fundamentals, bilanco, advisorData, mergedIntraday);
      const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      saveToMemory(symbol, sig.signal, sig.score, text);

      // Memory comparison note
      const mem = getMemoryForSymbol(symbol);
      let memNote = '';
      if (mem.length > 1) {
        const prev = mem[1];
        const days = Math.max(1, Math.round((Date.now() - prev.ts) / 86400000));
        memNote = `\n\n**Hafiza Notu:** Bu hisseyi ${days} gun once de analiz etmistim — o zaman sinyal **${prev.signal}** (skor: ${prev.score?.toFixed ? prev.score.toFixed(1) : prev.score}) idi.`;
      }

      const full = text + memNote;
      setMessages([{ role: 'ai', text: full, time, auto: true, grade: extractGrade(text) }]);
      setHistory([{ role: 'assistant', content: full }]);
    } catch (err) {
      console.error('ChatPanel auto-reading crash:', err);
      const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      setMessages([{ role: 'ai', text: 'Efendim, analiz okumasinda bir hata olustu: ' + err.message, time, error: true }]);
    }
  }, [symbol, sig?.score, fundamentals, bilanco]); // eslint-disable-line

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  const handleSend = useCallback(async (forced) => {
    const raw = (forced || input).trim();
    if (!raw || loading) return;

    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    setMessages(prev => [...prev, { role: 'user', text: raw, time }]);
    setInput('');
    setLoading(true);

    try {
      const memCtx = buildMemoryContext();
      const advCtx = buildAdvisorContext(advisorData, symbol, mergedIntraday);
      const useWeb = needsWebSearch(raw);
      const isMem = isMemoryQuery(raw);
      const isMk = isMarketQuery(raw);

      // Compact stock context if relevant
      let stockCtx = '';
      if (symbol && ind && sig) {
        stockCtx = `\n--- AKTIF HISSE (${symbol}) ---\nFiyat: ${ind.lastClose?.toFixed(2)} TL (${ind.changePct?.toFixed(2)}%)\nSinyal: ${sig.signal} (skor ${sig.score}, conf %${sig.conf})\nRSI: ${ind.lastRSI?.toFixed(0)}, ADX: ${ind.adx?.toFixed(0)}, OBV: ${ind.obvTrend}, Wyckoff: ${ind.wyckoffPhase}\nGiris: ${sig.entry?.toFixed(2)} Stop: ${sig.stop?.toFixed(2)} T1: ${sig.t1?.toFixed(2)} R/R: 1:${sig.rr?.toFixed(1)}\n---`;
      }

      const tagWeb = useWeb ? '[WEB ARAMA AKTIF — guncel bilgi icin interneti tara]\n\n' : '';
      const tagMem = isMem ? '[HAFIZA SORGUSU — yukaridaki SON ANALIZ HAFIZASI bolumune bakarak onceki analizlerini karsilastir]\n\n' : '';
      const tagMk = isMk ? '[PIYASA SORGUSU — COKLU SISTEM ISTIHBARATI bolumundeki Advisor + sektor + intraday verilerini kullan]\n\n' : '';

      const userMsg = `${stockCtx}${memCtx}${advCtx}\n\n${tagWeb}${tagMem}${tagMk}KULLANICI: ${raw}`;

      const systemPrompt = buildSystemPrompt();
      const convo = [...history.slice(-10), { role: 'user', content: userMsg }];
      const result = await chatClaudeHistory(convo, systemPrompt, { maxTokens: 1200 });

      let answer;
      let isOffline = false;
      let isError = false;
      if (result.error) {
        if (isApiKeyError(result.error)) {
          // Fallback: rule-based JARVIS
          answer = jarvisOffline(raw, symbol, ind, sig, fundamentals, bilanco, advisorData);
          isOffline = true;
        } else {
          answer = 'JARVIS hatasi: ' + result.error + '\n\n' +
            jarvisOffline(raw, symbol, ind, sig, fundamentals, bilanco, advisorData);
          isError = true;
          isOffline = true;
        }
      } else {
        answer = result.text;
      }
      setMessages(prev => [...prev, { role: 'ai', text: answer, time, error: isError, offline: isOffline }]);
      setHistory(prev => [...prev, { role: 'user', content: raw }, { role: 'assistant', content: answer }]);
      if (symbol && sig) saveToMemory(symbol, sig.signal, sig.score, `Soru: ${raw.slice(0, 60)} -> ${answer.slice(0, 200)}`);
    } catch (err) {
      // Network / fetch failure → offline fallback
      const offlineText = jarvisOffline(raw, symbol, ind, sig, fundamentals, bilanco, advisorData);
      setMessages(prev => [...prev, { role: 'ai', text: offlineText, time, offline: true }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, symbol, ind, sig, fundamentals, bilanco, advisorData, mergedIntraday, history]);

  const handleExpertCall = useCallback(async () => {
    if (!symbol || !sig || loading) return;
    setLoading(true);
    try {
      const analysis = {
        price: ind?.lastClose, change: ind?.changePct, signal: sig.signal, cls: sig.cls,
        score: Number(sig.score), conf: Number(sig.conf),
        rsi: ind?.lastRSI, macd: ind?.lastMACD, macdSignal: ind?.lastMACDSig,
        atr: sig.atr, vwap: ind?.vwap, mfi: ind?.mfi, obv: { trend: ind?.obvTrend },
        ma20: ind?.lastMA20, ma50: ind?.lastMA50, ma200: ind?.lastMA200,
        entry: sig.entry, stop: sig.stop, target: sig.t1, rr: Number(sig.rr),
        targetT2: sig.t2, targetT3: sig.t3, fundamentals: fundamentals || {},
      };
      const result = await askExpert(symbol, analysis, advisorData?.marketSentiment || {}, { webSearch: true });
      const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      let text, isErr = false, isOff = false;
      if (result.error) {
        if (isApiKeyError(result.error)) {
          text = jarvisOffline('detayli analiz yap', symbol, ind, sig, fundamentals, bilanco, advisorData);
          isOff = true;
        } else {
          text = 'Uzman modu hatasi: ' + result.error; isErr = true;
        }
      } else text = result.text;
      setMessages(prev => [...prev, {
        role: 'ai', time, text,
        error: isErr, offline: isOff, expert: true,
      }]);
    } finally { setLoading(false); }
  }, [symbol, sig, ind, fundamentals, advisorData, loading]);

  const clearChat = useCallback(() => {
    setMessages([]);
    setHistory([]);
    lastAutoSymbolRef.current = null;
  }, []);

  const memCount = useMemo(() => getRecentMemory().length, [messages.length]);
  const questions = useMemo(() => getContextQuestions(ind, sig, bilanco, advisorData), [ind, sig, bilanco, advisorData]);

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      marginTop: 14,
      minHeight: 520,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'linear-gradient(135deg, rgba(99,102,241,.06), rgba(139,92,246,.04))',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800, color: '#fff',
        }}>J</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>J.A.R.V.I.S — Alpha Engine v8</div>
          <div style={{ fontSize: 9, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 4px var(--green)' }} />
            Otonom Analiz Modu Aktif
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 9, alignItems: 'center' }}>
          <span style={{ color: 'var(--t3)' }}>Hafiza: {memCount}/{MAX_MEMORY}</span>
          {advisorData?.marketSentiment && <span style={{ color: advisorData.marketSentiment.color || 'var(--t2)' }}>{advisorData.marketSentiment.sentiment}</span>}
          <button onClick={clearChat} style={{
            background: 'transparent', border: '1px solid var(--border)',
            color: 'var(--t2)', padding: '2px 8px', borderRadius: 3,
            fontSize: 9, cursor: 'pointer',
          }}>Temizle</button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{
        flex: 1,
        minHeight: 320,
        maxHeight: 'calc(100vh - 360px)',
        overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--t3)', padding: 12, textAlign: 'center', fontSize: 11 }}>
            Hisse secilince otomatik okuma yapilir. Sorulariniz icin asagidan yazin.
          </div>
        )}
        {messages.map((m, i) => <MessageRenderer key={i} msg={m} />)}
        {loading && (
          <div style={{ fontSize: 10, color: 'var(--t3)', fontStyle: 'italic', paddingLeft: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--cyan)', animation: 'pulse 1s infinite' }} />
            Efendim, verileri sentezliyorum...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Quick action chips — flex-wrap, category-colored, hover-lift */}
      <div
        className="jarvis-chip-row"
        style={{
          padding: '2px 14px 12px',
          display: 'flex', flexWrap: 'wrap', gap: 8,
          alignItems: 'center',
        }}
      >
        {questions.slice(0, 8).map(q => {
          const lower = q.toLowerCase();
          let cat = 'default';
          if (/haber|son /.test(lower))                                 cat = 'news';
          else if (/bilanco|mali|fon/.test(lower))                      cat = 'fund';
          else if (/risk|stop|korun/.test(lower))                       cat = 'risk';
          else if (/hedef|kar|r\/r|pozisyon|lot|buyukluk/.test(lower))  cat = 'target';
          else if (/alma|al mi|firsat|buy/.test(lower))                 cat = 'buy';
          else if (/makro|piyasa|sektor/.test(lower))                   cat = 'macro';

          const C = {
            default: { bg: 'rgba(148,163,184,0.08)', bd: 'rgba(148,163,184,0.22)', fg: '#cbd5e1' },
            news:    { bg: 'rgba(34,211,238,0.08)',  bd: 'rgba(34,211,238,0.30)',  fg: '#67e8f9' },
            fund:    { bg: 'rgba(139,92,246,0.10)',  bd: 'rgba(139,92,246,0.35)',  fg: '#c4b5fd' },
            risk:    { bg: 'rgba(239,68,68,0.08)',   bd: 'rgba(239,68,68,0.30)',   fg: '#fca5a5' },
            target:  { bg: 'rgba(245,158,11,0.08)',  bd: 'rgba(245,158,11,0.30)',  fg: '#fcd34d' },
            buy:     { bg: 'rgba(16,185,129,0.10)',  bd: 'rgba(16,185,129,0.32)',  fg: '#6ee7b7' },
            macro:   { bg: 'rgba(59,130,246,0.08)',  bd: 'rgba(59,130,246,0.30)',  fg: '#93c5fd' },
          }[cat];

          return (
            <button
              key={q}
              onClick={() => handleSend(q)}
              disabled={loading}
              className="jarvis-chip"
              style={{
                padding: '6px 12px',
                fontSize: 11,
                lineHeight: 1,
                cursor: loading ? 'default' : 'pointer',
                borderRadius: 999,
                background: C.bg,
                color: C.fg,
                border: `1px solid ${C.bd}`,
                fontWeight: 600,
                fontFamily: 'inherit',
                letterSpacing: 0.2,
                opacity: loading ? 0.5 : 1,
                transition: 'transform 120ms ease, background 120ms ease, border-color 120ms ease',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { if (loading) return; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.background = C.bg.replace(/0\.\d+/, '0.20'); }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.background = C.bg; }}
            >
              {q}
            </button>
          );
        })}
      </div>

      {/* Input */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
        <input
          type="text" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={symbol ? `${symbol} / piyasa / genel soru...` : 'Soru sorun (al miyim, risk, hedef, sektor, makro...)'}
          disabled={loading}
          style={{
            flex: 1, padding: '10px 14px', fontSize: 12,
            background: 'var(--bg3)', color: 'var(--t1)',
            border: '1px solid var(--border)', borderRadius: 8, outline: 'none',
          }}
        />
        <button onClick={() => handleSend()} disabled={loading || !input.trim()} style={{
          padding: '10px 18px', background: 'var(--cyan)', color: '#000',
          border: 'none', borderRadius: 8, fontWeight: 700,
          cursor: loading || !input.trim() ? 'default' : 'pointer',
        }}>Sor</button>
        {symbol && (
          <button onClick={handleExpertCall} disabled={loading || !sig} title="Haber aramasi + derin uzman analizi" style={{
            padding: '10px 12px', background: 'var(--purple, #8b5cf6)', color: '#fff',
            border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 11,
            cursor: loading || !sig ? 'default' : 'pointer',
          }}>Uzman</button>
        )}
      </div>
    </div>
  );
}

function extractGrade(text) {
  const m = /Setup Kalitesi:\s*\*\*([ABCD])\*\*/i.exec(text || '');
  return m ? m[1] : null;
}

// Extract technical readouts (RSI, ADX, MFI, Setup, R/R, Stop, Hedef) from AI text.
// Returns an object of { key: value } ready for the mini-grid.
export function extractTechGrid(text) {
  if (!text) return null;
  const out = {};
  const grab = (re, key, cast = (v) => v.trim()) => {
    const m = re.exec(text);
    if (m) out[key] = cast(m[1]);
  };
  grab(/RSI[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'RSI');
  grab(/ADX[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'ADX');
  grab(/MFI[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'MFI');
  grab(/ATR[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'ATR');
  grab(/Setup(?:\s*Kalitesi)?[:\s]+\**([ABCD])\**/i, 'SETUP');
  grab(/R\s*\/\s*R[:\s]+\**([\d.,]+(?:\s*:\s*[\d.,]+)?)\**/i, 'R/R');
  grab(/Stop[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'STOP');
  grab(/Hedef[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'HEDEF');
  grab(/Giris[^0-9-]{0,6}(-?\d+(?:[.,]\d+)?)/i, 'GIRIS');
  return Object.keys(out).length ? out : null;
}

// Inline mini-grid rendered above the AI bubble when technicals are present.
export function TechMiniGrid({ data }) {
  if (!data) return null;
  const tone = (k, v) => {
    const n = Number(String(v).replace(',', '.'));
    if (k === 'RSI' && Number.isFinite(n)) return n > 70 ? 'down' : n < 30 ? 'up' : 'neutral';
    if (k === 'ADX' && Number.isFinite(n)) return n > 25 ? 'up' : n < 15 ? 'warn' : 'neutral';
    if (k === 'MFI' && Number.isFinite(n)) return n > 80 ? 'down' : n < 20 ? 'up' : 'neutral';
    if (k === 'SETUP') return v === 'A' ? 'up' : v === 'D' ? 'down' : v === 'C' ? 'warn' : 'neutral';
    return 'neutral';
  };
  const COLOR = { up: '#34d399', down: '#f87171', warn: '#fbbf24', neutral: '#e2e8f0' };
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))',
      gap: 4,
      margin: '0 0 8px',
      padding: 6,
      background: 'rgba(15,23,42,0.5)',
      border: '1px solid rgba(148,163,184,0.15)',
      borderRadius: 6,
    }}>
      {Object.entries(data).map(([k, v]) => {
        const c = COLOR[tone(k, v)];
        return (
          <div key={k} style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            padding: '3px 6px', minWidth: 0,
          }}>
            <span style={{ fontSize: 8, color: '#64748b', letterSpacing: 0.6 }}>{k}</span>
            <span style={{
              fontSize: 11, fontWeight: 700, color: c,
              fontFamily: 'JetBrains Mono, monospace',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}
