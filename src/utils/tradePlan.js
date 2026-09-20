// ── TRADE PLAN CONSTANTS (v31.18, trimmed v31.44) ─────────────────────────
// This module used to also BUILD a step-by-step management plan for the analyse
// screen ("İŞLEM YÖNETİM PLANI"). The user removed that panel in v31.44 — the
// screen was too crowded — so the builder had no consumer left and went with
// it. What the plan DESCRIBED is unchanged and still enforced where it counts:
// `useLivePrices` moves the real stop (breakeven at +3%, lock half above +5%),
// and `planSimulation` replays the same constants when the learning loop asks
// what a signal would have returned.
//
// Keep these numbers here as the single source: planSimulation.js and
// scripts/sweep-exit-params.mjs import them.

export const PLAN_CONST = { BREAKEVEN_PCT: 3, TRAIL_ACTIVE_PCT: 5, LOCK_FRACTION: 0.5 };

/** v31.30: cikis politikasi olcume dayali olarak trailing-only. */
export const EXIT_POLICY = 'trailing';
