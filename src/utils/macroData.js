/**
 * macroData.js - Macro economic data, indicators, rate-decision history, event calendar
 *
 * Shape contracts (consumed by MacroPanel.jsx):
 *   getLiveIndicators() -> Promise<{ policyRate:{label,value,unit,trend}, tufe, usdtry, bist100 }>
 *   getRateDecisionImpact() -> Array<{ date, bist100Change }>
 *   getLiveEvents() -> Promise<Array<{ id,title,date,type,impact,source,forecast?,previous?,actual? }>>
 *   getEventTypeConfig(type) -> { icon, label }
 *   getImpactColor(impact) -> css color
 */

// ── Central Bank rate decision → BIST100 short-term impact history ─────────
// Static sample showing last ~8 TCMB rate decisions vs BIST100 next-day change.
const RATE_DECISION_HISTORY = [
  { date: '2025-08-21', decision: 'hold',  rateChange: 0,    bist100Change:  0.8 },
  { date: '2025-09-11', decision: 'cut',   rateChange: -2.5, bist100Change:  2.1 },
  { date: '2025-10-23', decision: 'cut',   rateChange: -2.5, bist100Change:  1.4 },
  { date: '2025-12-25', decision: 'cut',   rateChange: -1.5, bist100Change: -0.6 },
  { date: '2026-01-23', decision: 'hold',  rateChange: 0,    bist100Change: -1.2 },
  { date: '2026-02-27', decision: 'cut',   rateChange: -2.5, bist100Change:  1.8 },
  { date: '2026-03-20', decision: 'cut',   rateChange: -2.5, bist100Change:  0.5 },
  { date: '2026-04-17', decision: 'hold',  rateChange: 0,    bist100Change: -0.3 },
];

export function getRateDecisionImpact(/* country, rate */) {
  // Sync array — MacroPanel stores this in useState() synchronously.
  return RATE_DECISION_HISTORY;
}

// ── Key live indicators (promises — fetched in useEffect) ──────────────────
// Live wiring: getMacroContext() doldurur. Hata/fallback durumda statik degerler.
import { getMacroContext } from './macroContextEngine.js';

export async function getLiveIndicators() {
  let ctx = null;
  try { ctx = await getMacroContext(); } catch {}
  const usdtryVal = ctx?.usdtry?.value ?? 38.42;
  const usdtryTrend = ctx?.usdtry
    ? (ctx.usdtry.change5d >= 0 ? 'yukselis' : 'dusus')
    : 'yukselis';
  const tcmbRate = ctx?.tcmb?.rate ?? 50.0;
  const vixVal = ctx?.vix?.value ?? 0;
  const brentVal = ctx?.brent?.value ?? 0;
  const trendOf = (s) => (s?.change5d >= 0 ? 'yukselis' : 'dusus');
  const out = {
    policyRate: { label: 'TCMB Faiz', value: tcmbRate, unit: '%', trend: 'yatay' },
    vix:        { label: 'VIX',       value: vixVal,   unit: '', trend: ctx?.vix?.change5d >= 0 ? 'yukselis' : 'dusus' },
    usdtry:     { label: 'USDTRY',    value: usdtryVal, unit: '', trend: usdtryTrend },
    brent:      { label: 'BRENT',     value: brentVal, unit: '$', trend: ctx?.brent?.change5d >= 0 ? 'yukselis' : 'dusus' },
  };
  // Thematic metal drivers — shown only when fetched (thematicMacro consumes these).
  if (ctx?.gold)   out.gold   = { label: 'ALTIN',  value: ctx.gold.value,   unit: '$', trend: trendOf(ctx.gold) };
  if (ctx?.silver) out.silver = { label: 'GUMUS',  value: ctx.silver.value, unit: '$', trend: trendOf(ctx.silver) };
  if (ctx?.copper) out.copper = { label: 'BAKIR',  value: ctx.copper.value, unit: '$', trend: trendOf(ctx.copper) };
  return out;
}

// ── Upcoming macro events (promise) ────────────────────────────────────────
// Returns a local calendar of typical upcoming TR/US events. MacroPanel will
// show these until a live feed (e.g. forexfactory) is wired in.
export function getLiveEvents() {
  const today = new Date();
  const mk = (offsetDays, title, type, impact, extras = {}) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(10, 0, 0, 0);
    return {
      id: `local-${type}-${offsetDays}`,
      title, type, impact,
      date: d.toISOString(),
      source: 'local',
      ...extras,
    };
  };

  return Promise.resolve([
    mk(2,  'TUFE Aylik',                   'cpi',       'high',   { forecast: '2.1%', previous: '2.3%' }),
    mk(5,  'TCMB PPK Faiz Karari',         'rate',      'high',   { forecast: '42.5%', previous: '42.5%' }),
    mk(7,  'Issizlik Orani',               'jobs',      'medium', { previous: '8.6%' }),
    mk(10, 'Sanayi Uretimi (Yillik)',      'industry',  'medium', { previous: '3.1%' }),
    mk(12, 'FOMC Faiz Karari',             'rate',      'high',   { forecast: '4.50%', previous: '4.50%' }),
    mk(15, 'Dis Ticaret Dengesi',          'trade',     'medium', { previous: '-8.2B' }),
    mk(18, 'PMI Imalat',                   'pmi',       'medium', { previous: '49.8' }),
    mk(22, 'Yillik Buyume (GSYH)',         'gdp',       'high',   { previous: '2.4%' }),
  ]);
}

export function getUpcomingEvents(days = 7) {
  return getLiveEvents().then(all => {
    const cutoff = Date.now() + days * 86400000;
    return all.filter(e => new Date(e.date).getTime() <= cutoff);
  });
}

// ── Event type → icon/label ────────────────────────────────────────────────
const EVENT_TYPE_CONFIG = {
  rate:     { icon: '🏦', label: 'Faiz Karari' },
  cpi:      { icon: '📈', label: 'Enflasyon'   },
  jobs:     { icon: '👷', label: 'Istihdam'    },
  industry: { icon: '🏭', label: 'Sanayi'      },
  trade:    { icon: '🚢', label: 'Dis Ticaret' },
  pmi:      { icon: '📊', label: 'PMI'         },
  gdp:      { icon: '💹', label: 'GSYH'        },
  default:  { icon: '📅', label: 'Etkinlik'    },
};

export function getEventTypeConfig(eventType) {
  return EVENT_TYPE_CONFIG[eventType] || EVENT_TYPE_CONFIG.default;
}

export function getImpactColor(impact) {
  const colors = {
    high:    '#ef4444',
    medium:  '#f59e0b',
    low:     '#4ade80',
    neutral: '#888888',
  };
  return colors[impact] || colors.neutral;
}
