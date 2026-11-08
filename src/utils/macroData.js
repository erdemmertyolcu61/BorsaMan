/**
 * macroData.js — the four macro tiles on the analyse screen.
 *
 * Shape contract (consumed by MacroPanel.jsx):
 *   getLiveIndicators() -> Promise<{ policyRate, vix, usdtry, brent, ...metals }>
 *   each tile: { label, value:number|null, unit, trend:'yukselis'|'dusus'|'yatay'|null,
 *                stale?:boolean, asOf?:string|null, note?:string }
 *
 * v31.47 — three fabrications removed, measured on the live screen:
 *   - USDTRY fell back to a hard-coded 38.42 with "▲ YUKSELIS" whenever the feed
 *     did not answer. Yahoo read 50.15 on 2026-11-08: the tile was 23% off and
 *     looked live. A missing value is now null and the tile says "VERI YOK".
 *   - TCMB showed 50% from a stale snapshot; it now comes from TCMB's own table
 *     (tcmbRate.js, 36% on 2026-10-23) and a fallback is labelled "son bilinen".
 *   - The "Makroekonomik Takvim" header counted 8 "upcoming events" that were
 *     generated on the client (today+2 days, today+5 ...) with invented
 *     forecasts, and a "rate decision → BIST100" table was a static sample.
 *     Both are gone; there is no free calendar feed wired in.
 */
import { getMacroContext } from './macroContextEngine.js';

const trendOf = (s) => (s && Number.isFinite(s.change5d) ? (s.change5d >= 0 ? 'yukselis' : 'dusus') : null);
const valueOf = (s) => (s && Number.isFinite(s.value) && s.value > 0 ? s.value : null);

export async function getLiveIndicators() {
  let ctx = null;
  try { ctx = await getMacroContext(); } catch { ctx = null; }

  const t = ctx?.tcmb || null;
  const rate = t && Number.isFinite(t.rate) ? t.rate : null;
  const prev = t && Number.isFinite(t.previousRate) ? t.previousRate : null;
  const policyTrend = rate == null || prev == null ? 'yatay' : rate < prev ? 'dusus' : rate > prev ? 'yukselis' : 'yatay';

  const out = {
    policyRate: {
      label: 'TCMB faiz', value: rate, unit: '%', trend: policyTrend,
      stale: !!t?.isStale, asOf: t?.lastDecision || t?.staleSince || null,
    },
    vix:    { label: 'VIX',    value: valueOf(ctx?.vix),    unit: '',  trend: trendOf(ctx?.vix) },
    usdtry: { label: 'USDTRY', value: valueOf(ctx?.usdtry), unit: '',  trend: trendOf(ctx?.usdtry) },
    brent:  { label: 'Brent',  value: valueOf(ctx?.brent),  unit: '$', trend: trendOf(ctx?.brent) },
  };
  // Thematic metal drivers — shown only when fetched (thematicMacro consumes these).
  if (valueOf(ctx?.gold))   out.gold   = { label: 'Altın',    value: ctx.gold.value,   unit: '$', trend: trendOf(ctx.gold) };
  if (valueOf(ctx?.silver)) out.silver = { label: 'Gümüş',    value: ctx.silver.value, unit: '$', trend: trendOf(ctx.silver) };
  if (valueOf(ctx?.copper)) out.copper = { label: 'Bakır',    value: ctx.copper.value, unit: '$', trend: trendOf(ctx.copper) };
  if (valueOf(ctx?.natgas)) out.natgas = { label: 'Doğalgaz', value: ctx.natgas.value, unit: '$', trend: trendOf(ctx.natgas) };
  if (valueOf(ctx?.wheat))  out.wheat  = { label: 'Buğday',   value: ctx.wheat.value,  unit: '¢', trend: trendOf(ctx.wheat) };
  return out;
}
