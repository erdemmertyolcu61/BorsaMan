// ── Fresh Regime Reset ────────────────────────────────────────────────
// Run once to wipe all historical signal/paper-trading data and start clean.
// Guarded by a reset-epoch key so it only fires once per epoch bump.

const RESET_EPOCH = '2026-05-04'; // bump this string to trigger another reset
const RESET_EPOCH_KEY = 'bist_reset_epoch';

const LS_KEYS_TO_CLEAR = [
  'bist_signal_history',        // useSignalTracker — 500 closed trades
  'bist_paper_trading_v1',      // usePaperTrading  — standard paper portfolio
  'bist_paper_ml_engine_v1',    // PaperTradeEngine — ML paper portfolio (fallback)
  'bist_last_ai_picks',         // AIAdvisorPanel   — cached scan results
  'bist_jarvis_memory',         // JARVIS AI memory
  'bist_scan_history',          // scan history drawer
];

export async function runFreshRegimeReset() {
  try {
    const lastEpoch = localStorage.getItem(RESET_EPOCH_KEY);
    if (lastEpoch === RESET_EPOCH) return; // already reset for this epoch

    console.log(`[Reset] Fresh regime reset triggered (epoch ${RESET_EPOCH})`);

    // 1. Clear localStorage keys
    for (const key of LS_KEYS_TO_CLEAR) {
      localStorage.removeItem(key);
    }

    // 2. Reset SQLite paper trading via Electron IPC (if available)
    const paperDb = window.electronAPI?.paperDb;
    if (paperDb) {
      await paperDb.reset();
      console.log('[Reset] SQLite paper_trades + paper_portfolio cleared');
    }

    // 3. Mark epoch as done
    localStorage.setItem(RESET_EPOCH_KEY, RESET_EPOCH);
    console.log('[Reset] Fresh regime reset complete — all tracking history cleared');
  } catch (err) {
    console.warn('[Reset] Reset failed (non-fatal):', err?.message);
  }
}
