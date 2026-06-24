// ════════════════════════════════════════════════════════════════════
// tradingCosts.js — Unified transaction cost model
// ════════════════════════════════════════════════════════════════════
//
// Every simulation surface (backtest, signal tracker, paper engine) must
// price in the SAME friction, otherwise reported returns are inflated and
// not comparable. This is the single source of truth for:
//
//   - commission + exchange/clearing fees
//   - bid/ask spread + slippage (liquidity-dependent)
//
// BIST retail reality (round trip, rough but honest):
//   commission ~0.10-0.20%, spread+slippage 0.05-0.80% by liquidity.
// We model a default round-trip of 0.30% and split it evenly across the
// entry and exit legs.
// ════════════════════════════════════════════════════════════════════

// Default total round-trip cost (commission + spread + slippage estimate).
export const TOTAL_COST_PCT = 0.003;

// Liquidity-tier slippage (PER LEG, fraction). Mirrors the tiers used by the
// AI Advisor liquidity gate. Higher tier = tighter spread = less slippage.
const SLIPPAGE_BY_TIER = {
  VERY_LOW: 0.008,
  LOW: 0.005,
  MEDIUM: 0.003,
  HIGH: 0.0015,
  INSTITUTIONAL: 0.0015,
};
const DEFAULT_LEG_SLIPPAGE = 0.002; // normal-market default per leg

// Resolve a per-leg slippage fraction from a liquidity descriptor.
// Accepts a tier string, or an object with `.tier`, or null/undefined.
export function liquiditySlippagePct(liquidity) {
  if (!liquidity) return DEFAULT_LEG_SLIPPAGE;
  const tier = typeof liquidity === 'string' ? liquidity : liquidity.tier;
  return SLIPPAGE_BY_TIER[tier] ?? DEFAULT_LEG_SLIPPAGE;
}

// Apply entry-leg cost: a buyer pays UP, a short-seller receives DOWN.
export function applyEntryCost(price, cls = 'buy', legPct = TOTAL_COST_PCT / 2) {
  if (!price || !Number.isFinite(price)) return price;
  return cls === 'sell' ? price * (1 - legPct) : price * (1 + legPct);
}

// Apply exit-leg cost: closing a long sells DOWN, closing a short buys UP.
export function applyExitCost(price, cls = 'buy', legPct = TOTAL_COST_PCT / 2) {
  if (!price || !Number.isFinite(price)) return price;
  return cls === 'sell' ? price * (1 + legPct) : price * (1 - legPct);
}

export default {
  TOTAL_COST_PCT,
  liquiditySlippagePct,
  applyEntryCost,
  applyExitCost,
};
