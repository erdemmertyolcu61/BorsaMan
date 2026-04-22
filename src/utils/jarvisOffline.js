/**
 * jarvisOffline.js — Rule-based fallback answers when Claude API is unavailable.
 * Keeps JARVIS useful (Efendim tone + multi-intent keyword routing) without internet.
 *
 * Supported intents:
 *   - Greeting / smalltalk
 *   - Time / date / market status
 *   - Stock: AL/SAT/RISK/HEDEF/STRATEJI/POZISYON/TREND/AKILLI PARA/DIVERJANS
 *   - Bilanco / fundamentals
 *   - Hafiza / memory
 *   - Haber (info message only — needs live API)
 *   - Generic analysis fallback
 */

const MEMORY_KEY = 'bist_jarvis_memory';

function normalizeTr(s) {
  return (s || '').toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's')
    .replace(/[öÖ]/g, 'o').replace(/[üÜ]/g, 'u')
    .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g');
}

function loadMemory() {
  try {
    const list = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function getRecentMemory(n = 5) { return loadMemory().slice(0, n); }
function getMemoryForSymbol(sym) { return loadMemory().filter(m => m.symbol === sym); }

function isMarketOpenNow() {
  const d = new Date();
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return t >= 595 && t <= 1090; // 09:55–18:10
}

function fmtMoney(x) {
  if (x == null || !Number.isFinite(x)) return 'N/A';
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(1) + ' Milyar TL';
  if (a >= 1e6) return (x / 1e6).toFixed(0) + ' Milyon TL';
  return x.toFixed(0) + ' TL';
}

// ----- Main entry -----
/**
 * Returns a Turkish offline answer string.
 * @param {string} rawMsg - user question
 * @param {string} symbol
 * @param {object} ind - technical indicators object
 * @param {object} sig - signal object (genSignal result)
 * @param {object} fundamentals - optional fundamentalEngine output
 * @param {object} bilanco - optional isyatirim bilanco object { ratios, latest }
 * @param {object} advisor - optional advisor data
 */
export function jarvisOffline(rawMsg, symbol, ind, sig, fundamentals, bilanco, advisor) {
  const msg = normalizeTr(rawMsg || '');

  // ---- Smalltalk (no symbol needed) ----
  if (/^(merhaba|selam|naber|nasilsin|iyi misin|hey|hi|hello)\b/.test(msg)) {
    return `Efendim, hos geldiniz. JARVIS aktif, 7 katmanli analiz motoru hazir. ${symbol ? `Su an **${symbol}** uzerinde caliseyim — ` : ''}teknik, temel veya makro herhangi bir soru emrinizdeyim.

_(Not: Claude API anahtari tanimli degil, bu yuzden offline kural tabanli modda yanitliyorum. Ayarlardan anahtari ekleyerek tam sohbet moduna gecebilirsiniz.)_`;
  }

  if (/tesekkur|sagol|eyvallah|tesekurler|iyi calismalar/.test(msg)) {
    return `Rica ederim Efendim. Piyasa verilerini taramaya devam ediyorum. Yeni bir emir veya analiz ihtiyacinizda bildirin.`;
  }

  if (/saat kac|tarih|bugun ne|gun|yil/.test(msg)) {
    const d = new Date();
    const day = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const t = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const open = isMarketOpenNow();
    return `Efendim, su an **${day}**, saat **${t}**. BIST su an **${open ? 'ACIK' : 'KAPALI'}** — ${open ? 'aktif islem saatleri' : 'bir sonraki seans icin pusuda'}.`;
  }

  if (/piyasa nasil|piyasa ne alemde|market nasil|bist nasil|genel durum/.test(msg)) {
    if (advisor?.marketSentiment) {
      const ms = advisor.marketSentiment;
      return `Efendim, son advisor taramasina gore piyasa duyarliligi: **${ms.sentiment}**. ${ms.buys} AL / ${ms.sells} SAT sinyali, ortalama RSI **${ms.avgRSI?.toFixed(0) ?? '-'}**. ${ms.accumulations || 0} hissede akilli para birikimi tespit edildi. ${advisor.marketSentiment?.sectorRotation?.[0] ? `En guclu sektor: **${advisor.marketSentiment.sectorRotation[0].sector}**.` : ''}`;
    }
    return `Efendim, su an aktif advisor taramasi yok. BIST ${isMarketOpenNow() ? 'acik' : 'kapali'} — detayli yorum icin en az bir hisse analizi calistirmak gerekiyor.`;
  }

  // ---- Memory / past readings ----
  if (/gecen|once|hatirl|hafiz|son analiz|ne soylemist|ne demist/.test(msg)) {
    const mine = symbol ? getMemoryForSymbol(symbol) : [];
    if (mine.length > 1) {
      const past = mine.slice(1, 4).map(m => {
        const when = new Date(m.date).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `- **${when}**: Sinyal **${m.signal}** (Skor: ${m.score}) — ${(m.summary || '').slice(0, 130)}`;
      });
      const cur = sig ? `Su anki sinyal **${sig.signal}** (skor: ${(sig.score ?? 0).toFixed(0)}).` : '';
      const trend = sig && mine[1]?.signal !== sig.signal ? 'Yon degismis — dikkat.' : 'Yon stabil.';
      return `Efendim, **${symbol}** icin gecmis analizlerim:\n\n${past.join('\n')}\n\n${cur} ${trend}`;
    }
    const recent = getRecentMemory(5);
    if (recent.length) {
      const lines = recent.map(m => {
        const when = new Date(m.date).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
        return `- **${m.symbol}** (${when}): ${m.signal} / Skor ${m.score}`;
      });
      return `Efendim, son analizlerim:\n${lines.join('\n')}\n\nDetayli karsilastirma icin spesifik bir hisse sorun.`;
    }
    return `Efendim, henuz kayitli gecmis analizim yok. Hisse analizi yaptikca hafizam dolacaktir.`;
  }

  // ---- Need a symbol for the rest ----
  if (!symbol || !ind || !sig) {
    return `Efendim, bu soruyu yanitlamak icin once bir hisse analiz etmem gerekiyor. Sol panelden bir sembol girip **ANALIZ ET**'e basin, sonra ayni soruyu tekrar sorun.

_(API anahtari olmadan offline modda calistigim icin sadece veri tabanli sorulara yanit verebiliyorum.)_`;
  }

  // Local variables from data
  const price = ind.lastClose ?? 0;
  const priceStr = price.toFixed(2);
  const rsi = ind.lastRSI ?? 50;
  const atr = sig.chandelier?.atr ?? sig.atr ?? 0;
  const obv = ind.obvTrend || 'neutral';
  const wyc = ind.wyckoffPhase || 'ranging';
  const mfi = ind.mfi ?? 50;
  const volR = ind.volRatio ?? 1;
  const adx = ind.adx ?? 15;
  const cmf = ind.cmf ?? 0;
  const aboveMA20 = ind.lastMA20 ? price > ind.lastMA20 : false;
  const aboveMA50 = ind.lastMA50 ? price > ind.lastMA50 : false;
  const macdHist = ind.macd?.histogram;
  const macdLast = macdHist?.length ? macdHist[macdHist.length - 1] : 0;
  const macdPrev = macdHist?.length > 1 ? macdHist[macdHist.length - 2] : 0;
  const macdRising = macdLast > 0 && macdLast > macdPrev;

  const smartLine = obv === 'accumulation' && mfi < 40 && cmf > 0
    ? 'Efendim, kurumsal oyuncular **sessiz birikim** yapiyor: OBV yukari, MFI talep bolgesinde, CMF pozitif. "Institutional Accumulation" protokolu aktif.'
    : obv === 'distribution'
      ? 'Dikkat Efendim, **akilli para dagitim** modunda. Yukselisler tuzak olabilir.'
      : volR < 0.5
        ? `Hacim cok dusuk (${volR.toFixed(1)}x) — manipulasyon riski var, temkinli olun.`
        : 'Kurumsal iz su an notr. Belirgin birikim/dagitim gormuyorum.';

  // ---- AL / GIR / YATIRIM ----
  if (/\b(al|alir|aliyim|almali|gir|girmeli|hamle|yatirim|firsat)\b/.test(msg)) {
    if (sig.cls === 'buy' && sig.score >= 5 && volR > 0.8) {
      const teyit = [];
      if (aboveMA20) teyit.push('fiyat MA-20 uzerinde');
      if (rsi > 40 && rsi < 65) teyit.push(`RSI ideal bolgede (${rsi.toFixed(0)})`);
      if (obv === 'accumulation') teyit.push('akilli para birikimde');
      if (macdRising) teyit.push('MACD ivmeleniyor');
      if (adx > 20) teyit.push(`trend gucu yeterli (ADX: ${adx.toFixed(0)})`);
      if (ind.obvDivergence === 'bullish_div') teyit.push('OBV bullish diverjans');
      if (ind.rsiDivergence === 'bullish') teyit.push('RSI bullish diverjans');
      if (ind.wyckoffSpring === 'spring') teyit.push('Wyckoff Spring — yukari patlama potansiyeli');
      if (ind.volumeClimax === 'selling_climax') teyit.push('satis klimaksi — taban sinyali');

      return `Efendim, **${symbol}** uzerinde **${teyit.length} katli teyit** tespit ediyorum:\n\n${teyit.map(t => '- ' + t).join('\n')}\n\nSinyal skoru **${sig.score?.toFixed(0)}/100**. Giris: **${sig.entry?.toFixed(2)} TL**, Stop: **${sig.stop?.toFixed(2)} TL**, Hedef 1: **${sig.t1?.toFixed(2)} TL**, Hedef 2: **${sig.t2?.toFixed(2)} TL**. R/R: **1:${sig.rr?.toFixed(1)}** (${sig.rrQuality || '?'}).\n\nStrateji: 10K hesapta sermayenizin maksimum %2'sini riske atin — 1/3 giris, teyit gelirse ekleyin.`;
    }
    if (sig.cls === 'buy' && sig.score >= 2) {
      return `Efendim, **${symbol}** uzerinde potansiyel goruyorum ancak **tam teyit olusmadi** (skor: ${sig.score?.toFixed(0)}/100). ${aboveMA20 ? '' : 'Fiyat hala MA-20 altinda.'} ${volR < 1 ? 'Hacim ortalamanin altinda.' : ''} Kucuk pozisyonla (hesabin %1'i) baslamak makul, ama agresif olmak icin erken.`;
    }
    if (sig.cls === 'sell') {
      return `Efendim, su an **${symbol}** icin alis onerisi sunmam mumkun degil. Teknik yapi arz baskisi altinda, sinyal **${sig.signal}**. ${rsi > 70 ? 'RSI asiri alim bolgesinde.' : ''} ${obv === 'distribution' ? 'Akilli para cikis yapiyor.' : ''} Yapisal kirilim (Market Structure Break) gorene kadar kenarda bekleyin.`;
    }
    return `Efendim, **${symbol}** su an **TUT** bolgesinde. Net bir katalist (hacim artisi, destek kirilimi veya Bollinger squeeze patlamasi) olmadan pozisyon acmak kumar olur.`;
  }

  // ---- RISK / STOP / ZARAR ----
  if (/\b(risk|stop|zarar|tehlike|korunma|hedge)\b/.test(msg)) {
    const risks = [];
    if (rsi > 70) risks.push(`RSI **asiri alim** (${rsi.toFixed(0)}) — duzeltme riski`);
    if (mfi > 80) risks.push(`MFI **${mfi.toFixed(0)}** — kurumsal kar realizasyonu baslamis olabilir`);
    if (obv === 'distribution') risks.push('OBV **dagitim** — akilli para cikiyor');
    if (volR < 0.5) risks.push('**Cok dusuk hacim** — manipulasyona acik');
    if (adx < 15) risks.push(`**Trendsiz piyasa** (ADX: ${adx.toFixed(0)}) — whipsaw riski`);
    if (ind.ttmSqueeze?.squeezeOn && ind.ttmSqueeze.momentum < 0) risks.push('Bollinger Squeeze **asagi momentumla** — dususe patlayabilir');
    if (!risks.length) risks.push('Mevcut yapida ciddi risk sinyali algilamiyorum');

    return `Efendim, **${symbol}** icin risk degerlendirmem:\n\n${risks.map(r => '- ' + r).join('\n')}\n\n**Risk Yonetimi:**\nStop-Loss: **${sig.stop?.toFixed(2)} TL** (ATR ${atr.toFixed(2)} bazli)\nMaksimum kayip: Sermayenizin %1-2'si\nATR volatilitesi: **${atr.toFixed(2)}** — ${atr > 2 ? 'yuksek oynaklik' : 'normal oynaklik'}.\n\nKural: Stop tetiklenirse sorgusuz cikin.`;
  }

  // ---- HEDEF ----
  if (/\b(hedef|t1|t2|nereye|yukari|potansiyel|kazanc|kar)\b/.test(msg)) {
    const resis = (sig.sr && Array.isArray(sig.sr) ? sig.sr : [])
      .filter(r => r.type === 'resistance' && r.price > price)
      .sort((a, b) => a.price - b.price);
    const resTxt = resis.length ? resis.slice(0, 3).map(r => `**${r.price.toFixed(2)} TL**`).join(', ') : 'belirgin direnc yok';
    const fibTxt = sig.fibs ? `\n**Fibonacci:** 0.382: ${sig.fibs['0.382']?.toFixed?.(2) || '?'} TL, 0.618: ${sig.fibs['0.618']?.toFixed?.(2) || '?'} TL` : '';
    return `Efendim, **${symbol}** icin yukari yonlu hedefler:\n\n**Hedef 1 (Kisa Vade):** ${sig.t1?.toFixed(2)} TL — ilk arz bolgesi. %50 kar al.\n**Hedef 2 (Orta Vade):** ${sig.t2?.toFixed(2)} TL — ana direnc.\n\nDirenc seviyeleri: ${resTxt}${fibTxt}\n\nHedefler statik degil — hacim ve momentum degistikce guncellenir.`;
  }

  // ---- BILANCO / TEMEL ----
  if (/\b(mali|bilanco|karne|temel|finansal|temettu|kar|gelir|borc|roe|marj|faaliyet)\b/.test(msg)) {
    let out = `Efendim, **${symbol}** mali rontgenini paylasiyorum:\n\n`;
    const r = bilanco?.ratios;
    if (r) {
      const latest = bilanco.latest || {};
      out += `**Kaynak: Is Yatirim Mali Tablolar (${latest.period || 'Son Donem'})**\n\n`;
      out += `**GELIR TABLOSU:**\n`;
      out += `- Hasilat: **${fmtMoney(latest.revenue)}**\n`;
      out += `- Net Kar: **${fmtMoney(latest.netIncome)}** ${latest.netIncome > 0 ? '(karli)' : '(zarar)'}\n`;
      if (r.grossMargin != null) out += `- Brut Kar Marji: **%${r.grossMargin.toFixed(1)}** ${r.grossMargin > 20 ? '(guclu)' : r.grossMargin > 10 ? '(normal)' : '(dusuk)'}\n`;
      if (r.netMargin != null) out += `- Net Kar Marji: **%${r.netMargin.toFixed(1)}** ${r.netMargin > 15 ? '(yuksek karlilik)' : r.netMargin > 5 ? '(kabul edilebilir)' : '(zayif)'}\n`;
      if (r.revenueGrowth != null) out += `- Ciro Buyumesi: **%${r.revenueGrowth.toFixed(1)}** ${r.revenueGrowth > 10 ? '(guclu)' : r.revenueGrowth > 0 ? '(pozitif)' : '(daraliyor)'}\n`;
      out += `\n**BILANCO:**\n`;
      out += `- Toplam Varlik: **${fmtMoney(latest.totalAssets)}**\n`;
      out += `- Nakit: **${fmtMoney(latest.cash)}**\n`;
      out += `- Ozkaynak: **${fmtMoney(latest.totalEquity)}**\n\n`;
      out += `**ORANLAR:**\n`;
      if (r.roe != null) out += `- ROE: **%${r.roe.toFixed(1)}** ${r.roe > 15 ? '(sermaye verimliligi iyi)' : r.roe > 5 ? '(normal)' : '(dusuk)'}\n`;
      if (r.currentRatio != null) out += `- Cari Oran: **${r.currentRatio.toFixed(2)}** ${r.currentRatio > 1.5 ? '(saglam)' : r.currentRatio > 1 ? '(yeterli)' : '(DIKKAT: likidite riski)'}\n`;
      if (r.debtToEquity != null) out += `- Borc/Ozkaynak: **${r.debtToEquity.toFixed(2)}** ${r.debtToEquity < 1 ? '(saglikli)' : r.debtToEquity < 2 ? '(orta)' : '(YUKSEK kaldirac)'}\n`;
      const healthy = (r.roe > 10 && r.currentRatio > 1) || (fundamentals?.score > 6);
      out += `\nTemel veriler, teknik sinyalleri **${healthy ? 'destekleyen bir Confluence unsuru' : 'zayiflatan bir faktor'}**.`;
      return out;
    }
    if (fundamentals?.score != null) {
      out += `**Karne: ${fundamentals.grade?.label || '-'}** (skor: ${fundamentals.score.toFixed(1)}/10)\n`;
      if (fundamentals.roe != null) out += `- ROE: **%${fundamentals.roe.toFixed(1)}**\n`;
      if (fundamentals.netMargin != null) out += `- Net Kar Marji: **%${fundamentals.netMargin.toFixed(1)}**\n`;
      if (fundamentals.currentRatio != null) out += `- Cari Oran: **${fundamentals.currentRatio.toFixed(2)}**\n`;
      if (fundamentals.debtToEquity != null) out += `- Borc/Ozkaynak: **${fundamentals.debtToEquity.toFixed(2)}**\n`;
      return out;
    }
    return `Efendim, bu sirketin detayli mali raporlarina su an ulasimim yok. Teknik veriler uzerinden kurumsal analiz sunabilirim.`;
  }

  // ---- TREND / YON ----
  if (/\b(trend|yon|yonde|yukseli|dusu|ivme|momentum)\b/.test(msg)) {
    const lines = [];
    lines.push(aboveMA20 ? 'Fiyat MA-20 **uzerinde** (kisa vade yukselis)' : 'Fiyat MA-20 **altinda** (kisa vade zayif)');
    lines.push(aboveMA50 ? 'Fiyat MA-50 **uzerinde** (orta vade yukselis)' : 'Fiyat MA-50 **altinda** (orta vade zayif)');
    lines.push(`ADX: **${adx.toFixed(0)}** — ${adx > 25 ? 'guclu trend' : adx > 15 ? 'orta gucte trend' : 'trendsiz / yatay'}`);
    lines.push(`MACD Histogram: ${macdRising ? '**pozitif ivmeleniyor**' : macdLast > 0 ? '**pozitif ama yavasliyor**' : '**negatif** (duzeltme baskisi)'}`);
    lines.push(`Wyckoff Fazi: **${wyc}**`);
    const verdict = aboveMA20 && aboveMA50 && adx > 20
      ? 'Trend yapisi saglikli — cekmelerde alis firsati aranabilir.'
      : !aboveMA20 && !aboveMA50
        ? 'Trend yapisi zayif — alis icin erken. Donus sinyali bekliyorum.'
        : 'Karisik sinyaller — net yon belirlenene kadar temkinli olun.';
    return `Efendim, **${symbol}** trend analizim:\n\n${lines.map(l => '- ' + l).join('\n')}\n\n**Sonuc:** ${verdict}`;
  }

  // ---- AKILLI PARA / OBV / HACIM ----
  if (/\b(akilli|kurumsal|para|obv|birikim|hacim|mfi|cmf)\b/.test(msg)) {
    return `Efendim, **${symbol}** Akilli Para (Smart Money) analizi:\n\n${smartLine}\n\n**Detay:**\n- OBV Trend: **${obv}**\n- MFI(14): **${mfi.toFixed(0)}** — ${mfi < 20 ? 'kurumsal talep bolgesi' : mfi < 40 ? 'talep artisi' : mfi > 80 ? 'asiri alim / kar realizasyonu' : 'notr'}\n- CMF(20): **${cmf.toFixed(3)}** — ${cmf > 0.1 ? 'guclu para girisi' : cmf < -0.1 ? 'para cikisi' : 'dengeli'}\n- Hacim Orani: **${volR.toFixed(1)}x** — ${volR > 2 ? 'kurumsal iz var' : volR > 1.2 ? 'normalin uzerinde' : volR < 0.5 ? 'cok dusuk — dikkat' : 'normal'}`;
  }

  // ---- STRATEJI / PLAN ----
  if (/\b(strateji|plan|nasil yapmali|ne yapmali|ne yapayim|taktik)\b/.test(msg)) {
    if (sig.cls === 'buy' && sig.score >= 4) {
      const lotSize = sig.stop && price > sig.stop ? Math.floor(200 / (price - sig.stop)) : '?';
      return `Efendim, **${symbol}** kisa vadeli strateji onerim:\n\n**Momentum Takip:**\n- Giris: **${sig.entry?.toFixed(2)} TL**\n- Stop: **${sig.stop?.toFixed(2)} TL**\n- Hedef 1: **${sig.t1?.toFixed(2)} TL** (%50 kar al)\n- Hedef 2: **${sig.t2?.toFixed(2)} TL** (kalan trailing)\n- R/R: **1:${sig.rr?.toFixed(1)}**\n- Sure: **${sig.holdText || '1-5 gun'}**\n\n**Pozisyon:** 10K hesapta max %2 risk ≈ **${lotSize} lot**\n\n**Kritik:** Stop tetiklenirse sorgusuz cikin. Hedef 1'de %50 realize edin.`;
    }
    return `Efendim, su an **${symbol}** icin agresif strateji onermem. Piyasa net yon vermeden pozisyon almak kumardir. Su uc teyidi bekleyin:\n1. Fiyat MA-20'yi yukari kirsin\n2. Hacim ortalamanin ustune ciksin\n3. RSI 50 uzerinde sabitlesin\n\nUclu teyit olustugunda beni tekrar sorun.`;
  }

  // ---- DIVERJANS / ILERI SINYAL ----
  if (/\b(diverjans|divergence|spring|klimaks|climax|utad|ileri sinyal)\b/.test(msg)) {
    const adv = [];
    if (ind.obvDivergence === 'bullish_div') adv.push('**OBV Bullish Diverjans:** Fiyat dusuk dip, OBV yuksek dip — gizli kurumsal alim.');
    if (ind.obvDivergence === 'bearish_div') adv.push('**OBV Bearish Diverjans:** Fiyat yuksek tepe, OBV dusuk tepe — akilli para sessizce cikiyor.');
    if (ind.rsiDivergence === 'bullish') adv.push('**RSI Bullish Diverjans:** Momentum toparlanma sinyali.');
    if (ind.rsiDivergence === 'bearish') adv.push('**RSI Bearish Diverjans:** Momentum zayifliyor, zirve riski.');
    if (ind.wyckoffSpring === 'spring') adv.push('**Wyckoff Spring:** Destek altina inip geri toparlandi — yukari atis potansiyeli yuksek.');
    if (ind.wyckoffSpring === 'utad') adv.push('**Wyckoff UTAD:** Direnc ustune cikip geri cekildi — dagitim tuzagi.');
    if (ind.volumeClimax === 'selling_climax') adv.push('**Satis Klimaks:** Tum saticilar bosaldi — taban olusumu olabilir.');
    if (ind.volumeClimax === 'buying_climax') adv.push('**Alis Klimaks:** Son alicilar da girdi — tavan olusumu olabilir.');
    if (!adv.length) return `Efendim, **${symbol}** uzerinde su an belirgin diverjans veya ileri sinyal yok. Olusum aninda bildiririm.`;
    return `Efendim, **${symbol}** ileri sinyal analizim:\n\n${adv.join('\n\n')}\n\n**Yorum:** Diverjanslar en guclu donus sinyalleridir ama tek baslarina yeterli degil — destek/direnc ve hacim teyidi sart.`;
  }

  // ---- POZISYON / LOT ----
  if (/\b(pozisyon|lot|buyukluk|kac lot|ne kadar hisse)\b/.test(msg)) {
    const risk = Math.abs(price - (sig.stop || price * 0.95));
    const lot = risk > 0 ? Math.floor(200 / risk) : 0;
    const total = lot * price;
    return `Efendim, **${symbol}** icin pozisyon buyuklugu:\n\n**Hesap:** 10,000 TL | **Risk Limiti:** %2 (200 TL)\n**Giris:** ${priceStr} TL | **Stop:** ${sig.stop?.toFixed(2)} TL\n**Hisse Basi Risk:** ${risk.toFixed(2)} TL\n\n**Onerilen:** **${lot} lot** (toplam ${total.toFixed(0)} TL, hesabin %${(total / 100).toFixed(0)}'i)\n**Maksimum Kayip:** ${(lot * risk).toFixed(0)} TL\n\nTek bir pozisyonda %2'den fazla riske atmayin.`;
  }

  // ---- HABER ----
  if (/\b(haber|neden|niye|ne oldu|ne oluyor|sahib|ortakl|son gelism|aciklam|bildirim|ceo)\b/.test(msg)) {
    return `Efendim, canli haber erisimim icin Claude API anahtari gerekli. Elinizdeki **${symbol}** terminal verilerinden gorunenler:\n\n**Teknik:** Fiyat ${priceStr} TL, RSI ${rsi.toFixed(0)}. ${obv === 'distribution' ? 'Akilli para cikis yapiyor — haberle ilgili olabilir.' : obv === 'accumulation' ? 'Akilli para birikimde — olasi haber olumlu algilanmis.' : 'Belirgin kurumsal tepki yok.'}\n\n${volR > 2 ? `Hacim normalin **${volR.toFixed(1)}x** ustunde — katalist etkisi olusmus olabilir.` : 'Hacim normal — buyuk haber henuz fiyatlanmamis.'}\n\n**Claude API anahtarini** Ayarlar > API Anahtari'ndan ekleyin — canli haber aramasi ve sentiment analizi aktiflesir.`;
  }

  // ---- Generic fallback (general reading) ----
  const posture = aboveMA20 ? 'kisa vadede yukari yonlu' : 'kisa vadede baski altinda';
  const rsiLine = rsi > 70 ? 'asiri alim bolgesinde — duzeltme riski'
    : rsi < 30 ? 'asiri satim — dipten donus potansiyeli'
    : rsi > 55 ? 'yukselis momentumunda'
    : rsi < 45 ? 'zayiflayan momentumda'
    : 'notr bolgede';
  const advList = [];
  if (ind.obvDivergence) advList.push(`OBV: ${ind.obvDivergence}`);
  if (ind.rsiDivergence) advList.push(`RSI: ${ind.rsiDivergence}`);
  if (ind.wyckoffSpring) advList.push(`Wyckoff: ${ind.wyckoffSpring}`);
  if (ind.volumeClimax) advList.push(`Hacim: ${ind.volumeClimax}`);
  const advStr = advList.length ? `\n**5. Ileri Sinyaller:** ${advList.join(', ')}.` : '';

  return `Efendim, sorunuzu anliyorum. **${symbol}** uzerinde tum kurumsal taramami paylasiyorum:

**1. Fiyat Yapisi:** ${priceStr} TL, ${posture}.
**2. Momentum:** RSI **${rsi.toFixed(0)}** — ${rsiLine}. MACD ${macdRising ? 'pozitif ivmeleniyor' : macdLast > 0 ? 'pozitif ama yavasliyor' : 'negatif bolgede'}.
**3. Akilli Para:** ${smartLine}
**4. Trend Gucu:** ADX **${adx.toFixed(0)}** — ${adx > 25 ? 'guclu trend' : 'trendsiz piyasa'}. Wyckoff: **${wyc}**.${advStr}

Stratejik olarak **${(sig.signal || '').toUpperCase()}** yonundeyim (skor: ${(sig.score ?? 0).toFixed(0)}/100). ${sig.cls === 'buy' ? `Stop: **${sig.stop?.toFixed(2)} TL**, Hedef: **${sig.t1?.toFixed(2)} TL**, R/R: 1:${sig.rr?.toFixed(1)}.` : 'Net firsat gorene kadar sermaye koruma modunda.'}

_(Offline modda — Claude API icin Ayarlar > API Anahtari.)_`;
}

export function isApiKeyError(errorText) {
  if (!errorText) return false;
  return /API anahtari|api key|apikey|anahtar/i.test(errorText);
}
