// ════════════════════════════════════════════════════════════════════
// macroContextEngine.js — Live Macro Risk Regime Detection
// ════════════════════════════════════════════════════════════════════
//
// BIST'e ozgu makro kor-noktayi kapatir: USDTRY momentum + VIX + TCMB
// faiz takvimi + BIST100/USD yabanci gozu birlestirilip risk-on/off
// sinyali uretir. score adjust (-15..+8) tum BUY picks'e uygulanir,
// Claude prompt'una MAKRO satiri enjekte edilir.
//
// API:
//   getMacroContext() -> Promise<MacroContext>
//   classifyRegime(context) -> 'risk_on' | 'neutral' | 'risk_off' | 'panic'
//   buildMacroPromptLine(context) -> string  (claude.js icin)
// ════════════════════════════════════════════════════════════════════

import { getDataViaProxies } from './fetchEngine.js';

// ── In-memory cache (10 dakika TTL) ────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000;
let _cache = null;       // { ts, value }
let _inflight = null;    // dedupe parallel calls

// ── TCMB statik fallback (API erisilemezse) ────────────────────────
// Son bilinen PPK kararlari. Gercek veri cekilemezse bunu donar +
// `isStale: true` flag ile UI rozetinde uyari.
const TCMB_FALLBACK = {
  rate: 50.0,
  lastDecision: '2026-04-17',
  nextMeeting: '2026-05-15',  // PPK takvimi (TCMB.gov.tr)
  isStale: true,
};

// ── Yahoo chart parse helper ───────────────────────────────────────
function parseYahooSeries(text) {
  try {
    const data = JSON.parse(text);
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp || r.timestamp.length < 5) return null;
    const q = r.indicators?.quote?.[0];
    if (!q?.close) return null;
    const out = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = q.close[i];
      if (c == null || c <= 0) continue;
      out.push({ t: r.timestamp[i] * 1000, close: c });
    }
    return out.length >= 5 ? out : null;
  } catch { return null; }
}

// Exported: generic RAW-symbol Yahoo series fetcher (no .IS suffix — unlike
// fetchEngine's BIST-only helpers). Reused by the real-portfolio tab for US
// tickers (NVDA/MRVL/ETN) and by the macro drivers (USDTRY=X, ^VIX, GC=F...).
export async function fetchYahooSeries(symbol, range = '1mo', interval = '1d', ms = 8000) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  try {
    const text = await getDataViaProxies(url, ms);
    return parseYahooSeries(text);
  } catch { return null; }
}

// ── USDTRY: spot + 5d momentum + 20d volatility ────────────────────
async function fetchUSDTRY() {
  const series = await fetchYahooSeries('USDTRY=X', '2mo', '1d');
  if (!series || series.length < 10) return null;
  const last = series[series.length - 1];
  const ref5 = series[Math.max(0, series.length - 6)];
  const ref20 = series[Math.max(0, series.length - 21)];
  const change5d = ((last.close - ref5.close) / ref5.close) * 100;
  const change20d = ((last.close - ref20.close) / ref20.close) * 100;
  // 20d realized volatility (annualized %)
  const rets = [];
  for (let i = Math.max(1, series.length - 20); i < series.length; i++) {
    rets.push(Math.log(series[i].close / series[i - 1].close));
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const vol20d = Math.sqrt(variance) * Math.sqrt(252) * 100;
  return { value: last.close, change5d, change20d, vol20d };
}

// ── VIX: global risk-off proxy ─────────────────────────────────────
async function fetchVIX() {
  const series = await fetchYahooSeries('%5EVIX', '1mo', '1d');
  if (!series || series.length < 5) return null;
  const last = series[series.length - 1];
  const ref5 = series[Math.max(0, series.length - 6)];
  const change5d = ((last.close - ref5.close) / ref5.close) * 100;
  let classification = 'normal';
  if (last.close > 30) classification = 'panic';
  else if (last.close > 25) classification = 'elevated';
  else if (last.close < 14) classification = 'complacent';
  return { value: last.close, change5d, classification };
}

// ── S&P 500: global equity sentiment ────────────────────────────────
async function fetchSP500() {
  const series = await fetchYahooSeries('%5EGSPC', '1mo', '1d');
  if (!series || series.length < 5) return null;
  const last = series[series.length - 1];
  const ref5 = series[Math.max(0, series.length - 6)];
  const change5d = ((last.close - ref5.close) / ref5.close) * 100;
  return { value: last.close, change5d };
}

// ── Brent Crude: global inflation / energy risk ─────────────────────
async function fetchBrent() {
  const series = await fetchYahooSeries('BZ=F', '1mo', '1d');
  if (!series || series.length < 5) return null;
  const last = series[series.length - 1];
  const ref5 = series[Math.max(0, series.length - 6)];
  const change5d = ((last.close - ref5.close) / ref5.close) * 100;
  return { value: last.close, change5d };
}

// ── Commodity futures: thematic drivers (metals, energy, grains) ──
// Same Yahoo futures pattern as Brent → { value, change5d }. Consumed by
// thematicMacro.js: gold→KOZAL/KOZAA, copper→SARKY, natgas→power gens, wheat→food.
async function fetchFutureSeries(ticker) {
  const series = await fetchYahooSeries(ticker, '1mo', '1d');
  if (!series || series.length < 5) return null;
  const last = series[series.length - 1];
  const ref5 = series[Math.max(0, series.length - 6)];
  const change5d = ((last.close - ref5.close) / ref5.close) * 100;
  return { value: last.close, change5d };
}
const fetchMetal  = fetchFutureSeries;        // back-compat alias
const fetchGold   = () => fetchFutureSeries('GC=F'); // Gold futures
const fetchSilver = () => fetchMetal('SI=F'); // Silver futures
const fetchCopper = () => fetchMetal('HG=F'); // Copper futures
const fetchNatgas = () => fetchFutureSeries('NG=F'); // Natural gas — power-price driver
const fetchWheat  = () => fetchFutureSeries('ZW=F'); // Wheat — food producer input cost

// ── BIST100 / USD (yabanci gozu) ───────────────────────────────────
async function fetchBistUsd(usdtryNow) {
  if (!usdtryNow) return null;
  const series = await fetchYahooSeries('XU100.IS', '2mo', '1d');
  if (!series || series.length < 21) return null;
  // Simple: BIST100 TL / current USDTRY (proxy — BIST'in dolar bazinda gucu)
  const last = series[series.length - 1];
  const ref20 = series[Math.max(0, series.length - 21)];
  // Note: kullaniciya 20g performans olarak gosteriyoruz; USDTRY change20d ile mahsup
  return {
    value: last.close / usdtryNow,
    change20d: ((last.close - ref20.close) / ref20.close) * 100,
  };
}

// ── TCMB EVDS: policy rate + next meeting countdown ────────────────
// EVDS API tam erisim icin token gerekir. Public endpoint coalition
// olmadigi icin: cache-first, sonra HTML scrape fallback, sonra static.
async function fetchTCMB() {
  // TCMB takvim sayfasi statik fallback (rate + nextMeeting yenilenebilir)
  // Production: localStorage'da elle override edilebilir
  try {
    const raw = localStorage.getItem('bist_tcmb_override');
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj?.rate != null && obj?.nextMeeting) return { ...obj, isStale: false };
    }
  } catch {}
  return { ...TCMB_FALLBACK };
}

// ── Regime classification + scoreAdjust ────────────────────────────
function computeRegime(parts) {
  const { usdtry, vix, tcmb, bistUsd, sp500, brent } = parts;
  let adjust = 0;
  const reasons = [];

  // USDTRY pressure
  if (usdtry) {
    if (usdtry.change5d > 5) { adjust -= 7; reasons.push(`USDTRY 5g +%${usdtry.change5d.toFixed(1)} (panik) -7`); }
    else if (usdtry.change5d > 3) { adjust -= 5; reasons.push(`USDTRY 5g +%${usdtry.change5d.toFixed(1)} -5`); }
    else if (usdtry.change5d < -2) { adjust += 3; reasons.push(`USDTRY 5g ${usdtry.change5d.toFixed(1)}% (TL guclu) +3`); }
    if (usdtry.vol20d > 30) { adjust -= 4; reasons.push(`USDTRY vol ${usdtry.vol20d.toFixed(0)}% (yuksek) -4`); }
  } else {
    reasons.push('USDTRY verisi yok');
  }

  // VIX (global risk-off)
  if (vix) {
    if (vix.classification === 'panic') { adjust -= 8; reasons.push(`VIX ${vix.value.toFixed(1)} PANIC -8`); }
    else if (vix.classification === 'elevated') { adjust -= 5; reasons.push(`VIX ${vix.value.toFixed(1)} (yuksek) -5`); }
    else if (vix.classification === 'complacent') { adjust += 2; reasons.push(`VIX ${vix.value.toFixed(1)} (sakin) +2`); }
  }

  // S&P 500 (global equities proxy)
  if (sp500) {
    if (sp500.change5d < -3) { adjust -= 6; reasons.push(`S&P500 5g %${sp500.change5d.toFixed(1)} (kuresel satis) -6`); }
    else if (sp500.change5d > 3) { adjust += 3; reasons.push(`S&P500 5g +%${sp500.change5d.toFixed(1)} (kuresel ralli) +3`); }
  }

  // Brent Oil (inflation / energy risk)
  if (brent) {
    if (brent.change5d > 5) { adjust -= 3; reasons.push(`Brent 5g +%${brent.change5d.toFixed(1)} (enflasyon riski) -3`); }
  }

  // TCMB meeting proximity
  if (tcmb?.nextMeeting) {
    const daysToMeeting = Math.ceil((new Date(tcmb.nextMeeting).getTime() - Date.now()) / 86400000);
    if (daysToMeeting >= 0 && daysToMeeting <= 3) {
      adjust -= 3;
      reasons.push(`TCMB PPK ${daysToMeeting}g sonra (belirsizlik) -3`);
    }
  }

  // BIST/USD (foreign view)
  if (bistUsd) {
    if (bistUsd.change20d < -5) { adjust -= 4; reasons.push(`BIST100/USD 20g ${bistUsd.change20d.toFixed(1)}% (yabanci cikis) -4`); }
    else if (bistUsd.change20d > 5) { adjust += 3; reasons.push(`BIST100/USD 20g +${bistUsd.change20d.toFixed(1)}% +3`); }
  }

  // Clamp
  adjust = Math.max(-15, Math.min(8, adjust));

  // Regime classification
  let regime = 'neutral';
  let badge = '🌍 NORMAL';
  let badgeColor = '#888';
  if (adjust <= -12) { regime = 'panic'; badge = '🚨 PANIC'; badgeColor = '#dc2626'; }
  else if (adjust <= -6) { regime = 'risk_off'; badge = '🌍 RISK-OFF'; badgeColor = '#f59e0b'; }
  else if (adjust >= 4) { regime = 'risk_on'; badge = '🌍 RISK-ON'; badgeColor = '#10b981'; }

  return { regime, scoreAdjust: adjust, reasons, badge, badgeColor };
}

// ── Public API ─────────────────────────────────────────────────────
export async function getMacroContext({ forceFresh = false } = {}) {
  const now = Date.now();
  if (!forceFresh && _cache && (now - _cache.ts) < CACHE_TTL_MS) return _cache.value;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const [usdtry, vix, tcmb, sp500, brent, gold, silver, copper, natgas, wheat] = await Promise.all([
        fetchUSDTRY().catch(() => null),
        fetchVIX().catch(() => null),
        fetchTCMB().catch(() => ({ ...TCMB_FALLBACK })),
        fetchSP500().catch(() => null),
        fetchBrent().catch(() => null),
        fetchGold().catch(() => null),
        fetchSilver().catch(() => null),
        fetchCopper().catch(() => null),
        fetchNatgas().catch(() => null),
        fetchWheat().catch(() => null),
      ]);
      const bistUsd = await fetchBistUsd(usdtry?.value).catch(() => null);

      const parts = { usdtry, vix, tcmb, bistUsd, sp500, brent, gold, silver, copper, natgas, wheat };
      const regime = computeRegime(parts);

      const ctx = {
        ts: now,
        regime: regime.regime,
        scoreAdjust: regime.scoreAdjust,
        badge: regime.badge,
        badgeColor: regime.badgeColor,
        reasons: regime.reasons,
        usdtry,
        vix,
        tcmb,
        bistUsd,
        sp500,
        brent,
        gold,
        silver,
        copper,
        natgas,
        wheat,
        isStale: !usdtry && !vix && !sp500,   // tum kaynaklar fail
      };
      _cache = { ts: now, value: ctx };
      return ctx;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

export function classifyRegime(ctx) {
  return ctx?.regime || 'neutral';
}

export function buildMacroPromptLine(ctx) {
  if (!ctx) return '';
  const parts = [];
  if (ctx.usdtry) parts.push(`USDTRY ${ctx.usdtry.value.toFixed(2)} (5g ${ctx.usdtry.change5d >= 0 ? '+' : ''}${ctx.usdtry.change5d.toFixed(1)}%)`);
  if (ctx.vix) parts.push(`VIX ${ctx.vix.value.toFixed(1)}`);
  if (ctx.tcmb?.rate != null) {
    const daysToMeeting = ctx.tcmb.nextMeeting
      ? Math.ceil((new Date(ctx.tcmb.nextMeeting).getTime() - Date.now()) / 86400000)
      : null;
    parts.push(`TCMB ${ctx.tcmb.rate}%${daysToMeeting != null && daysToMeeting >= 0 ? ` (PPK ${daysToMeeting}g sonra)` : ''}`);
  }
  if (ctx.sp500) parts.push(`S&P500 ${ctx.sp500.value.toFixed(0)} (5g ${ctx.sp500.change5d >= 0 ? '+' : ''}${ctx.sp500.change5d.toFixed(1)}%)`);
  if (ctx.brent) parts.push(`Brent $${ctx.brent.value.toFixed(1)}`);
  if (ctx.bistUsd) parts.push(`BIST/USD 20g ${ctx.bistUsd.change20d >= 0 ? '+' : ''}${ctx.bistUsd.change20d.toFixed(1)}%`);
  parts.push(`Rejim: ${ctx.regime.toUpperCase()}`);
  return `MAKRO: ${parts.join(' | ')}`;
}

// ── Test seam (vitest icin saf hesap) ──────────────────────────────
export const __test__ = {
  computeRegime,
  parseYahooSeries,
  TCMB_FALLBACK,
  resetCache: () => { _cache = null; _inflight = null; },
};
