// ── THEMATIC MACRO TAILWINDS (v30.4) — pure, testable ─────────────────────
// The per-stock scan reads price/volume/indicators but is BLIND to structural
// macro linkages: a Brent spike lifts refinery margins (TUPRS) while raising
// airline fuel costs (THYAO/PGSUS); a weaker lira lifts FX-revenue exporters.
// This curated map nudges the score/confidence of beneficiaries — so a macro
// tailwind name can SURFACE into the AL list even if the raw scan left it at TUT —
// and penalizes clear headwind names. Hand-curated structural priors, NOT a
// correlation model. Only themes whose driver series is actually fetched
// (macroContextEngine: brent, usdtry, gold, silver, copper) are active.

export const THEMES = [
  {
    id: 'brent_up',
    label: 'Brent yukselisi → rafineri marji',
    active: (m) => (m?.brent?.change5d ?? 0) >= 4,
    beneficiaries: ['TUPRS'],            // refinery — crack spread widens
    headwinds: ['THYAO', 'PGSUS'],       // airlines — jet fuel cost up
    boost: 6, penalty: -5,
  },
  {
    id: 'brent_down',
    label: 'Brent dususu → havayolu yakit maliyeti azalir',
    active: (m) => (m?.brent?.change5d ?? 0) <= -4,
    beneficiaries: ['THYAO', 'PGSUS'],
    headwinds: ['TUPRS'],
    boost: 5, penalty: -4,
  },
  {
    id: 'lira_weak_exporters',
    label: 'TL deger kaybi → ihracatci gelir artisi',
    active: (m) => (m?.usdtry?.change5d ?? 0) >= 2.5,
    beneficiaries: ['EREGL', 'KRDMD', 'SISE', 'KORDS', 'HEKTS', 'CIMSA'], // FX-revenue heavy
    headwinds: [],
    boost: 4, penalty: 0,
  },
  {
    id: 'gold_up',
    label: 'Altin yukselisi → altin madencisi',
    active: (m) => (m?.gold?.change5d ?? 0) >= 3,
    beneficiaries: ['KOZAL', 'KOZAA'],   // Koza Altin / Koza Anadolu — BIST gold miners
    headwinds: [],
    boost: 6, penalty: 0,
  },
  {
    id: 'silver_up',
    label: 'Gumus yukselisi → degerli metal ralisi',
    active: (m) => (m?.silver?.change5d ?? 0) >= 4,
    beneficiaries: ['KOZAL', 'KOZAA'],   // proxy — precious-metals correlated
    headwinds: [],
    boost: 4, penalty: 0,
  },
  {
    id: 'copper_up',
    label: 'Bakir yukselisi → bakir ureticisi marji',
    active: (m) => (m?.copper?.change5d ?? 0) >= 4,
    beneficiaries: ['SARKY'],            // Sarkuysan — Turkiye'nin ana bakir ureticisi
    headwinds: [],
    boost: 6, penalty: 0,
  },
];

const CLAMP = 12;

/**
 * Net thematic adjustment for one symbol under the current macro context.
 * @param {object|null} macroCtx - macroContextEngine ctx (needs .brent/.usdtry with change5d)
 * @param {string} symbol
 * @returns {{ delta: number, reasons: string[], themes: string[] }}
 */
export function computeThematicAdjust(macroCtx, symbol) {
  if (!macroCtx || !symbol) return { delta: 0, reasons: [], themes: [] };
  const sym = String(symbol).toUpperCase().trim();
  let delta = 0;
  const reasons = [];
  const themes = [];
  for (const t of THEMES) {
    let on = false;
    try { on = !!t.active(macroCtx); } catch { on = false; }
    if (!on) continue;
    if (t.beneficiaries.includes(sym)) {
      delta += t.boost; reasons.push(`${t.label} +${t.boost}`); themes.push(t.id);
    } else if (t.headwinds.includes(sym)) {
      delta += t.penalty; reasons.push(`${t.label} ${t.penalty}`); themes.push(t.id);
    }
  }
  return { delta: Math.max(-CLAMP, Math.min(CLAMP, delta)), reasons, themes };
}

/** List of active theme labels (for UI / prompt context). */
export function activeThemes(macroCtx) {
  if (!macroCtx) return [];
  return THEMES.filter(t => { try { return !!t.active(macroCtx); } catch { return false; } })
    .map(t => t.label);
}
