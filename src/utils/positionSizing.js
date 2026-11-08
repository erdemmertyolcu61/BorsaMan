// ── KONVIKSIYON-BAZLI POZISYON BOYUTU (v31.28) — saf, test edilebilir ─────
//
// PROBLEM: `_positionSizeMult` yalniz REJIM (regimeEngine.riskMult) ve profit
// governor'dan besleniyordu. Yani ayni rejimde score 82'lik bir "sniper" ile
// score 56'lik bir "early" AYNI buyuklukte aciliyordu — oysa olculen edge
// bu ikisi arasinda ciddi farkli.
//
// ARITMETIK (kullanicinin kendi olculen rakamlari, %0,3 gidis-donus maliyeti dahil):
//   YUKSELIS  +%1,14 brut → +%0,84 net
//   YATAY     -%1,68 brut → -%1,98 net
//   DUSUS     -%3,36 brut → -%3,66 net
// YATAY'da tam boyutla islem yapmak, YUKSELIS'in kazancini karisim icinde
// tamamen siliyor (YUKSELIS gunleri %70 bile olsa net ~0). Cozum tek basina
// "daha az goster" degil, "daha kucuk ac" — gorunurluk korunur, sermaye korunur.
//
// DURUST SINIR: bu carpanlar edge YARATMAZ. Sermayeyi olculen edge'in yogun
// oldugu yere kaydirir. Rejim olcumleri de v31.20/v31.22/v31.26 duzeltmelerinden
// ONCE alindi (sektor sisirmesi, olu haber hatti, bozuk d5, hic kapanmayan
// sinyaller) — yon guvenilir, kesin degerler degil. Temiz veri birikince
// yeniden ayarlanmali.

/** Konviksiyon kademesi carpanlari — sniper tam, early yarim. */
export const TIER_MULT = { sniper: 1.0, flagged: 0.75, early: 0.5, sell: 1.0 };

/**
 * YATAY icin EK kisitlama.
 *
 * BILINCLI BILESIK ETKI — cifte sayim degil, dozaj:
 * zincirdeki mevcut `regimeEngine.riskMult` YATAY'i (RANGE) 0.8 ile carpiyor.
 * 0.8, beklentisi -%1,98 NET olan bir rejim icin cok hafif. Bu katman uzerine
 * 0.5 daha koyar → toplam ~0.4. Iki farkli siniflandiricinin (regimeEngine ve
 * classifyBistRegime) ayni yone bakmasi tesaduf degil; hedeflenen toplam doz budur.
 * DUSUS zaten `_watchOnly` (hic pozisyon acilmaz) → burada ayrica cezalandirilmaz.
 */
export const NEUTRAL_EXTRA_MULT = 0.5;

/** Toplam carpan bu araligin disina cikamaz. */
export const MIN_MULT = 0;
export const MAX_MULT = 1.5;

/** Kademeyi damgadan al, yoksa score'dan turet (stampSegKeys ile birebir: 75/65). */
export function convictionTierOf(pick = {}) {
  if (pick.convictionTier) return pick.convictionTier;
  if (pick.cls === 'sell') return 'sell';
  const s = pick.score || 0;
  return s >= 75 ? 'sniper' : s >= 65 ? 'flagged' : 'early';
}

/**
 * Mevcut `_positionSizeMult` zincirine konviksiyon + YATAY dozajini ekler.
 * TEK giris noktasi — cagri yerinde ayrica rejim carpani UYGULANMAZ.
 *
 * @param {number} current mevcut _positionSizeMult (regimeEngine.riskMult × governor)
 * @param {object} pick { convictionTier, score, cls, _regime, _watchOnly }
 * @param {string} [regimeFallback] pick uzerinde _regime yoksa kullanilir
 * @returns {number} 0..1.5 arasi carpan
 */
export function applyConvictionSizing(current, pick = {}, regimeFallback = null) {
  // Izle-only (DUSUS) → sifir: panelde gorunur ama pozisyon acilmaz.
  if (pick._watchOnly) return 0;

  const base = Number.isFinite(current) && current > 0 ? current : 1;
  const tierMult = TIER_MULT[convictionTierOf(pick)] ?? TIER_MULT.early;

  // SAT sinyalleri YATAY cezasindan muaf — ceza AL beklentisi olcumunden geliyor.
  const regime = pick._regime || regimeFallback;
  const neutralMult = (pick.cls !== 'sell' && regime === 'NEUTRAL') ? NEUTRAL_EXTRA_MULT : 1;

  const out = base * tierMult * neutralMult;
  return Math.max(MIN_MULT, Math.min(MAX_MULT, Math.round(out * 1000) / 1000));
}

// ── LOT ONERISI (v31.47) — kartlarda gosterilen, paper ile AYNI kural ──────
//
// v31.44'te islem plani kutusu kaldirilinca lot onerisi ekrandan gitti; AI
// Firsatlar kartlari giris/stop/hedefi gosteriyor ama "kac lot" sorusunu
// cevapsiz birakiyordu. Analiz ekranindaki eski hesap (calcPosition, sanal
// portfoyun 10.000 TL nakdi) konviksiyon carpanini ve %33 tavanini bilmiyordu.
//
// Kural PaperTradeEngine ile birebir (forward test onerilen stratejiyi olcsun):
//   risk butcesi  = sermaye × %2 × carpan
//   pozisyon (TL) = min(risk butcesi / stop mesafesi, sermaye × %33 × carpan, sermaye)
// Carpan pick._positionSizeMult (rejim × governor × konviksiyon, applyConvictionSizing).
// Izle-only (carpan 0) → pozisyon yok.

export const RISK_PER_TRADE_PCT = 2;
export const MAX_POSITION_PCT = 33;
export const MIN_POSITION_TL = 3000;
export const DEFAULT_CAPITAL = 100_000;
export const CAPITAL_KEY = 'bist_trading_capital';

/** Kullanicinin girdigi islem sermayesi (TL) ya da null. */
export function getTradingCapital() {
  try {
    const v = Number(localStorage.getItem(CAPITAL_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

/** 0 / bos → kaldir. */
export function setTradingCapital(value) {
  const v = Number(String(value ?? '').replace(/\./g, '').replace(',', '.'));
  try {
    if (Number.isFinite(v) && v > 0) localStorage.setItem(CAPITAL_KEY, String(Math.round(v)));
    else localStorage.removeItem(CAPITAL_KEY);
  } catch { /* storage yok */ }
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/** Pick'in boyut carpani: damga varsa o, yoksa konviksiyondan turet. */
export function sizeMultOf(pick = {}) {
  if (pick._watchOnly) return 0;
  const m = pick._positionSizeMult;
  if (Number.isFinite(m) && m >= 0) return Math.min(MAX_MULT, m);
  return applyConvictionSizing(1, pick);
}

/**
 * @param {{capital?:number, entry:number, stop:number, mult?:number}} p
 * @returns {{ok:boolean, reason?:string, lots?:number, costTl?:number, riskTl?:number,
 *            pctOfCapital?:number, capped?:boolean, capital:number, mult:number}}
 */
export function suggestPosition({ capital, entry, stop, mult = 1 } = {}) {
  const cap = Number.isFinite(capital) && capital > 0 ? capital : DEFAULT_CAPITAL;
  const m = Number.isFinite(mult) ? Math.max(MIN_MULT, Math.min(MAX_MULT, mult)) : 1;
  const base = { capital: cap, mult: m };
  if (!(entry > 0) || !(stop > 0) || stop >= entry) return { ...base, ok: false, reason: 'no_stop' };
  if (m === 0) return { ...base, ok: false, reason: 'watch_only' };
  const stopDist = (entry - stop) / entry;
  const riskSized = (cap * (RISK_PER_TRADE_PCT / 100) * m) / stopDist;
  const ceiling = cap * (MAX_POSITION_PCT / 100) * m;
  const sizeTl = Math.min(riskSized, ceiling, cap);
  const lots = Math.floor(sizeTl / entry);
  const costTl = lots * entry;
  if (lots < 1 || costTl < MIN_POSITION_TL) return { ...base, ok: false, reason: 'too_small', lots, costTl };
  return {
    ...base,
    ok: true,
    lots,
    costTl,
    riskTl: lots * (entry - stop),
    pctOfCapital: (costTl / cap) * 100,
    capped: ceiling < riskSized,
  };
}
