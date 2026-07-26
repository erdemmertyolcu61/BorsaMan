// ── THEMATIC MACRO TAILWINDS (v30.4) — pure, testable ─────────────────────
// The per-stock scan reads price/volume/indicators but is BLIND to structural
// macro linkages: a Brent spike lifts refinery margins (TUPRS) while raising
// airline fuel costs (THYAO/PGSUS); a weaker lira lifts FX-revenue exporters.
// This curated map nudges the score/confidence of beneficiaries — so a macro
// tailwind name can SURFACE into the AL list even if the raw scan left it at TUT —
// and penalizes clear headwind names. Hand-curated structural priors, NOT a
// correlation model. Only themes whose driver series is actually fetched
// (macroContextEngine: brent, usdtry, gold, silver, copper, vix, sp500, natgas, wheat) are active.

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
  {
    id: 'lira_strong',
    label: 'TL degerlenmesi → FX-borc rahatlamasi',
    active: (m) => (m?.usdtry?.change5d ?? 0) <= -2.5,   // mirror of lira_weak_exporters
    beneficiaries: ['TTKOM', 'TCELL', 'TAVHL'],          // FX-denominated debt/capex heavy
    headwinds: ['EREGL', 'KRDMD', 'SISE'],               // exporters — margin squeezed
    boost: 4, penalty: -4,
  },
  {
    id: 'risk_off_haven',
    label: 'Kuresel risk-off (VIX yuksek) → guvenli liman',
    active: (m) => (m?.vix?.value ?? 0) >= 25,
    beneficiaries: ['KOZAL', 'KOZAA'],                   // gold miners bid as safe haven
    headwinds: [],
    boost: 5, penalty: 0,
  },
  {
    id: 'risk_on_beta',
    label: 'Kuresel risk-on (S&P guclu) → yuksek-beta holding',
    active: (m) => (m?.sp500?.change5d ?? 0) >= 3,
    beneficiaries: ['KCHOL', 'SAHOL', 'ASELS'],          // index-beta proxies (modest link)
    headwinds: [],
    boost: 3, penalty: 0,
  },
  // ── ENERJI — elektrik ureticileri ──
  {
    id: 'natgas_up_power',
    label: 'Dogalgaz yukselisi → elektrik fiyati / yenilenebilir marji',
    active: (m) => (m?.natgas?.change5d ?? 0) >= 6,
    beneficiaries: ['GWIND', 'AYDEM', 'ZOREN'],          // dusuk-yakit-maliyetli yenilenebilir uretici
    headwinds: [],
    boost: 5, penalty: 0,
  },
  // ── GIDA — tahil girdi maliyeti ──
  {
    id: 'wheat_down_food',
    label: 'Bugday dususu → gida ureticisi girdi rahatlamasi',
    active: (m) => (m?.wheat?.change5d ?? 0) <= -5,
    beneficiaries: ['ULKER', 'BANVT', 'PNSUT', 'TUKAS', 'PETUN'],
    headwinds: [],
    boost: 5, penalty: 0,
  },
  {
    id: 'wheat_up_food',
    label: 'Bugday yukselisi → gida ureticisi girdi maliyeti artar',
    active: (m) => (m?.wheat?.change5d ?? 0) >= 5,
    beneficiaries: [],
    headwinds: ['ULKER', 'BANVT', 'PNSUT', 'TUKAS', 'PETUN'],
    boost: 0, penalty: -5,
  },
  // ── BANKACILIK — TL istikrari / yabanci girisi ──
  {
    id: 'lira_strong_banks',
    label: 'TL istikrari → banka yabanci girisi / dusuk kredi riski',
    active: (m) => (m?.usdtry?.change5d ?? 0) <= -2.5,
    beneficiaries: ['GARAN', 'AKBNK', 'YKBNK', 'ISCTR'], // big private banks — foreign inflow beta
    headwinds: [],
    boost: 5, penalty: 0,
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

// ── SECTOR-AWARE MACRO (v31.11) — pure, testable ──────────────────────────
// The flat macroCtx.scoreAdjust hit every pick equally. But sectors don't share
// one macro sensitivity: cyclicals (holding/auto/airline) move WITH global risk
// appetite, defensives (telecom/food/utility) hold up when risk-off; and in TR's
// high-rate world rate-sensitive sectors (REIT/construction) are structurally
// pressured while banks/insurers benefit. This is SECTOR-level and dynamic —
// complements (does not duplicate) the stock-specific commodity/FX thematic layer.

// Risk-beta: >0 cyclical (hurt risk-off / helped risk-on), <0 defensive (resilient).
const SECTOR_RISK_BETA = {
  Holding: 1, Havayolu: 1, Otomotiv: 1, Metal: 1, Insaat: 1, Teknoloji: 1,
  'Cam/Sanayi': 0.6, Petrokimya: 0.6, 'Beyaz Esya': 0.6, Lastik: 0.6, Kimya: 0.6,
  'Gubre/Kimya': 0.6, Tekstil: 0.6, Banka: 0.4, GYO: 0.3, Savunma: 0, Madencilik: 0,
  Telekom: -1, Gida: -1, Perakende: -0.6, Enerji: -0.6, Sigorta: -0.4,
};
// Rate sensitivity in a high-rate regime: <0 pressured, >0 benefits.
const RATE_SENSITIVITY = {
  GYO: -1, Insaat: -1, Holding: -0.6, Otomotiv: -0.6, Banka: 0.8, Sigorta: 0.6,
};
const SECTOR_ADJ_CLAMP = 6;

/**
 * Sector-level macro adjustment for a stock's sector under the current macro.
 * @param {object|null} macro - macroContextEngine ctx (vix/sp500/tcmb)
 * @param {string} sector - sector name (constants.js SECTORS values)
 * @returns {{ delta: number, reasons: string[] }} delta bounded to +/-6
 */
export function computeSectorMacroAdjust(macro, sector) {
  if (!macro || !sector) return { delta: 0, reasons: [] };
  let delta = 0;
  const reasons = [];

  // 1) Global risk sentiment (VIX + S&P) × sector risk-beta.
  const vixCls = macro.vix?.classification;
  const spChg = macro.sp500?.change5d;
  let risk = 0; // -1 risk-off … +1 risk-on
  if (vixCls === 'panic' || (spChg != null && spChg < -3)) risk = -1;
  else if (vixCls === 'elevated') risk = -0.5;
  else if (vixCls === 'complacent' && spChg != null && spChg > 2) risk = 1;
  const beta = SECTOR_RISK_BETA[sector] ?? 0;
  if (risk !== 0 && beta !== 0) {
    delta += risk * beta * 3;
    if (risk < 0 && beta > 0) reasons.push(`Risk-off + döngüsel sektör baskısı (${sector})`);
    else if (risk < 0 && beta < 0) reasons.push(`Defansif sektör risk-off'ta dayanıklı (${sector})`);
    else if (risk > 0 && beta > 0) reasons.push(`Risk-on beta sektör lehine (${sector})`);
    else reasons.push(`Risk-on'da defansif sektör geride (${sector})`);
  }

  // 2) High-rate regime: rate-sensitive sectors tilted.
  const rate = macro.tcmb?.rate;
  const rs = RATE_SENSITIVITY[sector];
  if (rate != null && rate >= 40 && rs) {
    delta += rs * 2.5;
    if (rs < 0) reasons.push(`Yüksek faiz (%${rate}) faize-duyarlı sektöre baskı (${sector})`);
    else reasons.push(`Yüksek faiz (%${rate}) ${sector} lehine (marj/float)`);
  }

  delta = Math.max(-SECTOR_ADJ_CLAMP, Math.min(SECTOR_ADJ_CLAMP, Math.round(delta * 10) / 10));
  return { delta, reasons };
}
