// ── AI FIRSATLAR KART ROZETLERI (v31.47) — saf, test edilebilir ────────────
//
// Kart basina 20'ye yakin olasi rozet vardi: her biri 8 px, buyuk harf, emoji,
// gradyan ve parlama. 280 px'lik bir mobil kartta bunlar ust uste binip
// "pixel-art" goruntusu veriyordu (kullanici: "cok pixelart havasi var") ve asil
// soru (al / alma, kac lot, stop nerede) rozetlerin altinda kaliyordu.
//
// Simdi rozetler bir listeye toplanir ve ONCELIGE gore siralanir: once alimi
// engelleyen / riski degistiren uyarilar, sonra kademe, en son bilgi. Kart ilk
// MAX_VISIBLE tanesini gosterir, gerisi "+N" rozetinin ipucunda. Bilgi kaybolmaz.

import { KAP_TYPE_LABELS, kapEvidenceNote } from './kapFeed.js';

export const MAX_VISIBLE_CHIPS = 3;

const fx = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '0');
const signed = (v, d = 0) => `${v >= 0 ? '+' : ''}${fx(v, d)}`;

/**
 * @param {object} p pick
 * @returns {Array<{key:string,label:string,tone:'danger'|'warn'|'good'|'info'|'neutral',prio:number,title:string}>}
 */
export function buildPickChips(p = {}) {
  const chips = [];
  const add = (key, label, tone, prio, title = '') => chips.push({ key, label, tone, prio, title });
  const isBuy = p.cls !== 'sell';
  const pump = Math.max(p.todayPumpReal || 0, p.recentPump || 0);
  const cp = p.continuationProbability;

  // ── 0-2: alimi engelleyen / riski degistiren ──
  if (isBuy && p._watchOnly && p._fillerWatch) {
    add('watch', 'İzle · tamamlayıcı aday', 'warn', 0, [
      'Bugün kalite tabanını geçen AL sayısı 3’ten azdı; bu isim listeyi tamamlamak için gösteriliyor.',
      'Paper hesap bunu açmaz, lot önerisi yok — izleme amaçlı.',
    ].join('\n'));
  } else if (isBuy && p._watchOnly) {
    add('watch', 'İzle · alım değil', 'danger', 0, [
      'Piyasa düşüş trendinde: bu isim izlemek için gösteriliyor, yeni pozisyon önerilmez.',
      'Ölçüm: düşüş rejiminde AL pozisyonları tarihsel −%3,4 / %18,8 kazanma.',
    ].join('\n'));
  }
  if (p.kapRisk) {
    add('kaprisk', KAP_TYPE_LABELS[p.kapRisk] || 'KAP tedbiri', 'danger', 1,
      `${p.kapRiskLabel || 'İşlem tedbiri'} — KAP, son 7 gün. Bu hisse AL listesine alınmaz.`);
  }
  if (isBuy && p._counterRegime && !p._watchOnly) {
    add('counter', 'Rejime karşı', 'warn', 2, [
      'Piyasa düşüş trendinde. Düşüş rejiminde AL önerileri tarihsel −%3,4 (%18,8 kazanma).',
      'Küçük pozisyon / sıkı stop.',
    ].join('\n'));
  }

  // ── 3-7: kademe ve ciddi uyarilar ──
  if (isBuy && p._bestOfDay) {
    add('best', 'Günün adayı', 'info', 3, [
      'Rejim kapısı bugün kaliteli AL bırakmadı; henüz patlamamış, aşırı alımda olmayan en iyi aday.',
      'Rejim uyarısı geçerli: küçük pozisyon / sıkı stop.',
    ].join('\n'));
  }
  if (isBuy && p.convictionTier === 'sniper') {
    add('sniper', 'Nokta atışı', 'good', 4,
      `Sinyal skoru ${fx(p.score)}/100 (≥75). Backtest: %62,5 kazanma / +%0,77 beklenti.`);
  }
  if (pump >= 9) {
    add('pump', cp != null ? `Tavan bölgesi · %${cp} devam` : 'Tavan bölgesi', 'warn', 5,
      cp != null
        ? `Son bar +%${fx(p.recentPump, 1)} — tahmini devam olasılığı %${cp} (BIST tabanı ~%30-35).`
        : `Son bar +%${fx(p.recentPump, 1)} — ertesi gün ~%55-60 olasılıkla geri çekilir.`);
  } else if (pump >= 7 && cp != null) {
    add('pump', `%${cp} devam`, 'warn', 6, `Yüksek hareket +%${fx(p.recentPump, 1)} — devam tahmini %${cp}.`);
  }
  if (isBuy && (p._fundPenalty || 0) > 0) {
    add('fund', 'Temel zayıf', 'warn', 5,
      ['Bilanço kalitesi düşük', ...(p._fundReasons || []), p.fundGrade ? `Temel not: ${p.fundGrade}` : '',
        `Güven −${p._fundPenalty}`].filter(Boolean).join('\n'));
  }
  if ((p.cumulativePump || 0) >= 15 && (p.recentPump || 0) < 9 && cp == null) {
    add('tired', 'Yorgun', 'warn', 6, `3 günde +%${fx(p.cumulativePump, 1)} — momentum yorgun.`);
  }
  if (isBuy && p.entryTimingScore != null && p.entryTimingScore <= -30) {
    add('timing', 'Giriş için bekle', 'warn', 6, (p.entryTimingReasons || []).join(' | '));
  }
  if (p.hasRecentInsiderSell && !p.hasRecentInsiderBuy) {
    add('insider-sell', 'İçeriden satım', 'warn', 7, `İçeriden satım: skor ${p.insiderScore || 0}.`);
  }
  if (isBuy && p.htfWeeklyTrend === 'bear') {
    add('htf-bear', 'Haftalık düşüşte', 'warn', 7, 'Haftalık trend hâlâ düşüş yönünde — günlük sinyale ek dikkat.');
  }

  // ── 8+: bilgi ──
  if (isBuy && p._liveEdge) {
    const e = p._liveEdge;
    add('edge', `Canlı %${fx(e.winRate)}`, (e.expectancy || 0) >= 0 ? 'good' : 'danger', 8, [
      'Gerçek paper-trade sonucu (bu konviksiyon × rejim)',
      `Kazanma %${fx(e.winRate)}, beklenti ${signed(e.expectancy || 0, 2)}% · ${e.n} kapanış`,
    ].join('\n'));
  }
  if (p.hasRecentInsiderBuy) {
    add('insider-buy', 'İçeriden alım', 'good', 8, `İçeriden alım: skor ${p.insiderScore || 0}, net ${p.insiderNetBuys || 0} alım (30 gün).`);
  }
  if (isBuy && (p.rsLeading || p.rsLagging)) {
    add('rs', p.rsLeading ? `Endeksten güçlü ${signed(p.rsOutperf ?? 0)}` : 'Endeksten zayıf',
      p.rsLeading ? 'good' : 'neutral', p.rsLeading ? 8 : 11,
      `XU100'e göre ${signed(p.rsOutperf ?? 0)} puan (20g/60g) · güven ${signed(p.rsScore ?? 0)}`);
  }
  if (isBuy && p.entryTimingScore != null && p.entryTimingScore >= 55) {
    add('timing-ok', 'Giriş uygun', 'good', 9, (p.entryTimingReasons || []).join(' | '));
  }
  if (p._nearBreakoutPick) {
    add('breakout', 'Kırılım yakın', 'info', 9,
      `Patlama hazırlığı — ${p._nearBreakoutCount || 0}/10 sinyal: ${(p._nearBreakoutSignals || []).join(', ')}`);
  }
  if (isBuy && (p.topGainerScore || 0) >= 35) {
    add('top10', `Top10 adayı %${p.topGainerProb ?? 0}`, 'info', 9, [
      `Büyük gün (≥%6) tahmini ~%${p.topGainerProb ?? 0}; hissenin kendi taban oranı %${p.topGainerBaseRate ?? 0}.`,
      (p.topGainerDrivers || []).length ? `Nedenler: ${p.topGainerDrivers.join(', ')}` : '',
      'Tahmin, garanti değil.',
    ].filter(Boolean).join('\n'));
  }
  if (isBuy && p.convictionTier === 'flagged') {
    add('flagged', 'Düşük konviksiyon', 'neutral', 9,
      `Sinyal skoru ${fx(p.score)}/100 (65-74). Yatay piyasada yazı-tura (~%30 kazanma) — küçük pozisyon ya da teyit.`);
  }
  if (p._earlyPick) {
    add('early', 'Erken birikim', 'info', 10, `${p._earlyCount || 0}/10 sinyal: ${(p._earlySignals || []).join(', ')}`);
  }
  if (!p.kapRisk && Array.isArray(p.kapCategories) && p.kapCategories.length) {
    const first = KAP_TYPE_LABELS[p.kapCategories[0]] || 'KAP';
    add('kap', p.kapCategories.length > 1 ? `KAP: ${first} +${p.kapCategories.length - 1}` : `KAP: ${first}`, 'info', 10, [
      `KAP (son 7 gün): ${p.kapCategories.map(c => KAP_TYPE_LABELS[c] || c).join(', ')}`,
      p.kapHeadline ? `Son bildirim: ${p.kapHeadline}` : '',
      ...p.kapCategories.map(c => kapEvidenceNote(c)).filter(Boolean),
      p._kapBuybackBoost > 0 ? `Geri alım: güven +${p._kapBuybackBoost} (ölçülmüş olay)` : 'Skoru etkilemez — ölçülüyor',
    ].filter(Boolean).join('\n'));
  }
  if (isBuy && (p._thematicBoost || 0) > 0) {
    add('macro', `Makro +${p._thematicBoost}`, 'info', 10, ['Yapısal makro avantaj', ...(p._thematicReasons || [])].join('\n'));
  }
  if (isBuy && p.htfWeeklyTrend === 'bull' && p.htfTrend === 'bull') {
    add('htf-ok', 'Haftalık uyumlu', 'good', 11, 'Haftalık + günlük trend aynı yönde.');
  }
  if (p.foreignFlowLabel && p.foreignFlowLabel !== 'NOTR') {
    const s = p.foreignFlowScore || 0;
    add('foreign', `Yabancı ${p.foreignFlowLabel.toLowerCase()}`, s >= 3 ? 'good' : s <= -3 ? 'warn' : 'info', 11, [
      `Yabancı oranı %${fx(p.foreignRatio, 1)} (İş Yatırım)`,
      `Hafta ${signed(p.foreignChangeWeek || 0, 2)} · Ay ${signed(p.foreignChangeMonth || 0, 2)} puan`,
      'Skoru etkilemez — kaydedilip ölçülüyor',
    ].join('\n'));
  }
  if (p._mlOverride) {
    add('ml-gate', 'ML kapısı', 'info', 11, [
      'Standart likidite/skor filtrelerini geçemedi; ML kuralı eşleşti.',
      `Kazanma %${fx(p._mlConfidence || p.mlBestRule?.winRate || 0)} · küçük-cap kayma riski`,
    ].join('\n'));
  }
  if ((p.mlMatchedCount || 0) > 0 && p.mlBestRule) {
    add('ml', `ML %${fx(p.mlBestRule.winRate || 0)}`, 'info', 12, [
      `ML kuralı: ${p.mlBestRule.setupName}`,
      `Kazanma %${fx(p.mlBestRule.winRate || 0, 1)} · ort. getiri %${fx(p.mlBestRule.avgRoi || 0, 2)}`,
      p.mlMatchedCount > 1 ? `${p.mlMatchedCount} kural eşleşti` : '',
    ].filter(Boolean).join('\n'));
  }

  return chips.sort((a, b) => a.prio - b.prio);
}

/** Gorunen rozetler + geri kalanlarin ozeti. */
export function splitChips(chips, max = MAX_VISIBLE_CHIPS) {
  const list = Array.isArray(chips) ? chips : [];
  return { visible: list.slice(0, max), hidden: list.slice(max) };
}
