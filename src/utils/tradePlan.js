// ── TRADE MANAGEMENT PLAN (v31.18) — pure, testable ───────────────────────
// The analysis showed entry/stop/target numbers but not HOW to manage the trade.
// This turns a signal into an explicit, step-by-step plan the user can follow:
//   - scale-in (where to add), stop management (breakeven → trail), staged profit
//     taking (sell fractions at T1/T2/T3), invalidation, and hold horizon.
// Mirrors the live-guard trailing constants (breakeven +3%, lock 50% above +5%),
// so what the plan says matches what useLivePrices actually does.

const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (Number.isFinite(v) ? v : null);

export const PLAN_CONST = { BREAKEVEN_PCT: 3, TRAIL_ACTIVE_PCT: 5, LOCK_FRACTION: 0.5 };

/**
 * Build a deterministic trade-management plan from a signal.
 * @param {object} sig - { entry, stop, t1, t2, t3, atr, rr, holdText, cls }
 * @returns {object|null} plan, or null if entry/stop are missing/invalid.
 */
export function buildTradePlan(sig = {}) {
  const entry = num(sig.entry), stop = num(sig.stop);
  if (!entry || entry <= 0 || !stop) return null;
  const isBuy = sig.cls !== 'sell';
  const dir = isBuy ? 1 : -1;
  const atr = num(sig.atr);
  const t1 = num(sig.t1), t2 = num(sig.t2), t3 = num(sig.t3);
  // direction-adjusted return of a price level vs entry (buy: up = +, sell: down = +)
  const pct = (p) => (p == null ? null : round2(((p - entry) / entry) * 100 * dir));
  const half = atr && atr > 0 ? atr * 0.5 : entry * 0.01; // add-zone half-step

  const pullback = round2(entry - dir * half);   // add on a pullback toward support
  const breakout = round2(entry + dir * half);   // add on a confirmed breakout
  const beTrigger = round2(entry * (1 + dir * PLAN_CONST.BREAKEVEN_PCT / 100));
  const lockTrigger = round2(entry * (1 + dir * PLAN_CONST.TRAIL_ACTIVE_PCT / 100));

  const entrySteps = [
    { fraction: 40, at: round2(entry), note: 'İlk giriş — sinyal fiyatı' },
    { fraction: 30, at: pullback, note: `Ekleme — geri çekiliş (${pct(pullback)}%)` },
    { fraction: 30, at: breakout, note: `Ekleme — kırılım teyidi (${pct(breakout) >= 0 ? '+' : ''}${pct(breakout)}%)` },
  ];

  const exitSteps = [];
  if (t1) exitSteps.push({ fraction: 40, at: round2(t1), note: `Hedef 1 (+${pct(t1)}%) → %40 sat` });
  if (t2) exitSteps.push({ fraction: 30, at: round2(t2), note: `Hedef 2 (+${pct(t2)}%) → %30 sat` });
  if (t3) exitSteps.push({ fraction: 30, at: round2(t3), note: `Hedef 3 (+${pct(t3)}%) → kalanı trailing` });
  else exitSteps.push({ fraction: 30, at: null, note: 'Kalan %30 — trailing stop ile taşı' });

  const stopSteps = [
    { at: round2(stop), trigger: null,
      note: `Başlangıç stop (${pct(stop)}%) — günlük KAPANIŞ bunun ${isBuy ? 'altında' : 'üstünde'} ise çık` },
    { at: round2(entry), trigger: beTrigger,
      note: `+%${PLAN_CONST.BREAKEVEN_PCT} kârda → stop'u girişe çek (artık risksiz)` },
    { at: null, trigger: lockTrigger,
      note: `+%${PLAN_CONST.TRAIL_ACTIVE_PCT} üstü → kârın %50'sini kilitle, kalanı fiyatın %2 ${isBuy ? 'altında' : 'üstünde'} trailing` },
  ];

  return {
    isBuy,
    entry: round2(entry),
    stop: round2(stop),
    riskPct: pct(stop),          // negative — the initial risk
    pullback, breakout,
    beTrigger, lockTrigger,
    entrySteps, exitSteps, stopSteps,
    invalidation: round2(stop),
    holdHorizon: sig.holdText || null,
    rr: num(sig.rr),
  };
}
