// ── ARKA PLAN TAKIP UYARILARI (v31.27) — saf, test edilebilir ─────────────
//
// Bu modul HEM tarayicida HEM de GitHub Actions icindeki headless is tarafindan
// kullanilir. Tek bir karar noktasi olmasi bilincli: "hangi durumda bildirim
// atilir" sorusunun iki farkli cevabi olursa, kullanicinin telefonuna gelen
// uyari ile uygulamada gordugu durum birbirini tutmaz.
//
// Girdi kasitli olarak minimal: takip edilen sinyaller + o anki fiyatlar. Ne ag
// bilir ne saat; bu yuzden testte tam olarak kurgulanabilir.

/** Hedefe bu kadar yaklasinca "yaklasiyor" uyarisi (yuzde puan). */
export const NEAR_TARGET_PCT = 1.5;

export const ALERT_KINDS = {
  TARGET_HIT: 'TARGET_HIT',
  STOP_HIT: 'STOP_HIT',
  NEAR_TARGET: 'NEAR_TARGET',
};

/**
 * Bir sinyalin o anki fiyata gore uyari durumu.
 * Yon duzeltmeli: 'sell' sinyalinde hedef ASAGIDA, stop YUKARIDA.
 *
 * @param {object} sig  { symbol, entryPrice|price, target, stop, cls }
 * @param {number} price
 * @returns {{kind:string, pct:number}|null}
 */
export function classifySignalAlert(sig, price) {
  const entry = sig?.entryPrice ?? sig?.price;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(entry) || entry <= 0) return null;
  const isSell = sig?.cls === 'sell';
  const dir = isSell ? -1 : 1;
  const pct = ((price - entry) / entry) * 100 * dir;

  const target = Number.isFinite(sig?.target) ? sig.target : null;
  const stop = Number.isFinite(sig?.stop) ? sig.stop : null;

  // Stop once kontrol edilir: ayni anda iki seviye de gecilmisse kanitlayamadigimiz
  // kazanci degil, kesin olan kaybi bildiririz (evaluateOutcomeFromBars ile ayni
  // konvansiyon).
  if (stop != null && (isSell ? price >= stop : price <= stop)) {
    return { kind: ALERT_KINDS.STOP_HIT, pct: +pct.toFixed(2) };
  }
  if (target != null && (isSell ? price <= target : price >= target)) {
    return { kind: ALERT_KINDS.TARGET_HIT, pct: +pct.toFixed(2) };
  }
  if (target != null && entry > 0) {
    // Hedefe kalan mesafe, girise gore yuzde puan cinsinden.
    const remaining = Math.abs((target - price) / entry) * 100;
    const movedRightWay = isSell ? price < entry : price > entry;
    if (movedRightWay && remaining <= NEAR_TARGET_PCT) {
      return { kind: ALERT_KINDS.NEAR_TARGET, pct: +pct.toFixed(2) };
    }
  }
  return null;
}

/**
 * Uyari kimligi — ayni olayin tekrar tekrar bildirilmemesi icin.
 * Gun anahtari NEAR_TARGET icin dahil edilir (her gun bir kez hatirlatmak makul),
 * TARGET/STOP icin degil (bir kez olur, bir kez bildirilir).
 */
export function alertKey(sig, kind, dayKey = '') {
  const base = `${sig?.id || sig?.symbol}:${kind}`;
  return kind === ALERT_KINDS.NEAR_TARGET ? `${base}:${dayKey}` : base;
}

/**
 * Takip edilen sinyaller + fiyatlardan gonderilecek uyarilari uretir.
 *
 * @param {Array<object>} signals   takip edilenler (kapali olanlar atlanir)
 * @param {Record<string, number>} prices  { SYMBOL: price }
 * @param {{sent?: string[], dayKey?: string, max?: number}} [opts]
 *        sent: daha once gonderilmis uyari anahtarlari (tekrar gonderilmez)
 * @returns {{alerts: Array<object>, keys: string[]}}
 */
export function buildTrackingAlerts(signals, prices, opts = {}) {
  const { sent = [], dayKey = '', max = 10 } = opts;
  const sentSet = new Set(sent);
  const list = Array.isArray(signals) ? signals : [];
  const px = prices && typeof prices === 'object' ? prices : {};

  const alerts = [];
  for (const sig of list) {
    if (!sig || !sig.symbol) continue;
    if (sig.status && sig.status !== 'active') continue;   // zaten kapanmis
    const price = px[sig.symbol];
    const hit = classifySignalAlert(sig, price);
    if (!hit) continue;
    const key = alertKey(sig, hit.kind, dayKey);
    if (sentSet.has(key)) continue;
    sentSet.add(key);
    alerts.push({
      key,
      id: sig.id || sig.symbol,
      symbol: sig.symbol,
      kind: hit.kind,
      pct: hit.pct,
      price,
      entry: sig.entryPrice ?? sig.price,
      target: sig.target ?? null,
      stop: sig.stop ?? null,
      cls: sig.cls || 'buy',
    });
  }

  // En anlamli olanlar once: gerceklesmis sonuclar, sonra yaklasanlar; her grupta
  // buyuk hareket once. Bildirim sayisi sinirli — telefonu bogmak faydali degil.
  const rank = (a) => (a.kind === ALERT_KINDS.NEAR_TARGET ? 1 : 0);
  alerts.sort((a, b) => (rank(a) - rank(b)) || (Math.abs(b.pct) - Math.abs(a.pct)));

  const capped = alerts.slice(0, Math.max(0, max));
  return { alerts: capped, keys: capped.map(a => a.key) };
}

/** Bildirim metni — tarayici ve headless is ayni cumleyi uretsin. */
export function formatAlert(a) {
  if (!a) return { title: '', body: '' };
  const sign = a.pct >= 0 ? '+' : '';
  if (a.kind === ALERT_KINDS.TARGET_HIT) {
    return {
      title: `🎯 ${a.symbol} hedefe ulaşti`,
      body: `${sign}${a.pct}% · giris ${a.entry} → ${a.price}. Hedef ${a.target}.`,
    };
  }
  if (a.kind === ALERT_KINDS.STOP_HIT) {
    return {
      title: `🛑 ${a.symbol} stop seviyesinde`,
      body: `${sign}${a.pct}% · giris ${a.entry} → ${a.price}. Stop ${a.stop}.`,
    };
  }
  return {
    title: `📈 ${a.symbol} hedefe yaklasti`,
    body: `${sign}${a.pct}% · ${a.price} / hedef ${a.target}.`,
  };
}
