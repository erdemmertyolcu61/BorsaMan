// ── TRACKING RESET ────────────────────────────────────────────────────────
// Wipes every trace of past paper trades, signal scores and learned calibration
// so the system starts from a genuinely clean slate.
//
// v31.24 — made COMPLETE. The previous version cleared six localStorage keys and
// the SQLite paper tables, which left three ways for old state to survive:
//   1. Keys it did not know about (ML signal store, forward-test journal, pick
//      memory, per-day scan stamp) kept feeding the UI and the scheduler.
//   2. The in-memory calibration model and reliability hints live in module
//      scope. Clearing localStorage does NOT clear them, so old win rates kept
//      biasing live scores until the page happened to reload.
//   3. Settings the user actually wants to keep (API keys, proxy URL, real
//      portfolio, broker config) were never separated from tracking data, so a
//      "clear everything" instinct risked taking those with it.
// All three are addressed below, and the key list is now explicit about what is
// deliberately PRESERVED.

import { clearSignalCalibration } from './signalCalibration.js';
import { clearSignalReliabilityHints } from './signals.js';

/** Bump to trigger a fresh automatic reset on every device. */
const RESET_EPOCH = '2026-08-24';
const RESET_EPOCH_KEY = 'bist_reset_epoch';

/**
 * Everything that constitutes "what the system has learned / recorded".
 * This is the full tracking surface — paper trades, signals, scores, caches of
 * scored output, and the schedulers that would otherwise think today is done.
 */
export const TRACKING_KEYS = [
  'bist_signal_history_v2',   // useSignalTracker — signal history + day-by-day series
  'bist_paper_trading_v1',    // usePaperTrading  — standard paper portfolio
  'bist_paper_ml_engine_v1',  // PaperTradeEngine — ML paper portfolio (web fallback)
  'bist_paper_ml_auto',       // ML auto-trade toggle
  'bist_ml_signals_v2',       // DatabaseManager  — ML signal store (web fallback)
  'bist_forward_journal_v1',  // forwardTestJournal — forward-test accuracy record
  'bist_last_ai_picks',       // AIAdvisorPanel   — cached scan output
  'bist_ai_pick_memory',      // useAIAdvisor     — stagnant-pick memory
  'bist_scan_history',        // scan history
  'bist_last_scan_day',       // once-per-day scan stamp (must re-arm after reset)
  'bist_jarvis_memory',       // JARVIS conversation memory
  'bist_portfolio',           // virtual (paper) positions — headless but still paper
  'bist_tracker_reset_v3',    // legacy one-shot flag, superseded by the epoch
];

/**
 * Deliberately PRESERVED — these are settings and real data, not tracking:
 *   bist_real_portfolio   real holdings (personal data, never auto-wiped)
 *   bist_watchlist        user's own watchlist
 *   bist_broker_config    broker settings
 *   bist_proxy_url, bist_evds_api_key, bist_tcmb_override
 *   bist_notification_settings, bist_telemetry_enabled
 *   bist_fetch_l2_cache_v1, bist_isyatirim_cache_v3, bist_daily_intel_cache,
 *   bist_foreign_flow_cache/_breaker  — price/news caches, not learned state
 */

/**
 * SYNCHRONOUS localStorage half of the reset.
 *
 * Split out so it can run BEFORE React renders (see main.jsx). Learned by
 * measurement: the reset used to live in an App effect, i.e. after the first
 * render — so a single malformed tracking record crashed the app on load and
 * the reset that would have removed it never got the chance to run. Clearing
 * pre-render makes a corrupt record self-healing instead of fatal.
 */
export function clearTrackingLocalStorage(opts = {}) {
  const { keepVirtualPortfolio = false } = opts;
  const cleared = [];
  const failed = [];
  const keys = keepVirtualPortfolio
    ? TRACKING_KEYS.filter(k => k !== 'bist_portfolio')
    : TRACKING_KEYS;
  for (const key of keys) {
    try {
      if (localStorage.getItem(key) !== null) cleared.push(key);
      localStorage.removeItem(key);
    } catch {
      failed.push(key);
    }
  }
  return { cleared, failed };
}

/**
 * Clear all tracking state. Returns a summary so callers can report honestly
 * instead of claiming success blindly.
 * @param {{ keepVirtualPortfolio?: boolean }} [opts]
 */
export async function resetTrackingData(opts = {}) {
  const { cleared, failed } = clearTrackingLocalStorage(opts);

  // In-memory learned state — localStorage alone does not touch these, and they
  // feed genSignal directly, so skipping this leaves the "reset" system still
  // scoring with the old model.
  let memoryCleared = false;
  try {
    clearSignalCalibration();
    clearSignalReliabilityHints();
    memoryCleared = true;
  } catch { /* non-fatal */ }

  // SQLite paper tables (Electron only).
  let sqliteCleared = false;
  try {
    const paperDb = window.electronAPI?.paperDb;
    if (paperDb?.reset) {
      await paperDb.reset();
      sqliteCleared = true;
    }
  } catch (e) {
    failed.push('sqlite:paper');
  }

  return { cleared, failed, memoryCleared, sqliteCleared };
}

/**
 * Automatic once-per-epoch reset, run at app start. Bumping RESET_EPOCH makes
 * every device wipe its tracking history exactly once.
 * The virtual portfolio is included: it is paper state, and the user asked to
 * start paper trading from zero.
 */
export function isFreshResetPending() {
  try { return localStorage.getItem(RESET_EPOCH_KEY) !== RESET_EPOCH; }
  catch { return false; }
}

/**
 * Pre-render half: wipe the tracking keys and stamp the epoch synchronously, so
 * nothing downstream can read stale (or corrupt) state. Safe to call twice.
 */
export function runFreshRegimeResetSync() {
  try {
    if (!isFreshResetPending()) return null;
    const summary = clearTrackingLocalStorage();
    // NOTE: the epoch is deliberately NOT stamped here. runFreshRegimeReset()
    // (called from App) still has to clear the in-memory model and the SQLite
    // paper tables; it stamps once the whole job is done. Re-running the sync
    // clear on a crash in between is harmless — it is idempotent.
    console.log(`[Reset] Fresh start (epoch ${RESET_EPOCH}) — ${summary.cleared.length} key cleared pre-render`
      + (summary.failed.length ? `, FAILED: ${summary.failed.join(', ')}` : ''));
    return summary;
  } catch (err) {
    console.warn('[Reset] Pre-render reset failed (non-fatal):', err?.message);
    return null;
  }
}

export async function runFreshRegimeReset() {
  try {
    if (localStorage.getItem(RESET_EPOCH_KEY) === RESET_EPOCH) return null;

    const summary = await resetTrackingData();
    localStorage.setItem(RESET_EPOCH_KEY, RESET_EPOCH);
    console.log(
      `[Reset] Fresh start (epoch ${RESET_EPOCH}) — ${summary.cleared.length} key cleared, ` +
      `memory ${summary.memoryCleared ? 'ok' : 'skipped'}, ` +
      `sqlite ${summary.sqliteCleared ? 'ok' : 'n/a'}` +
      (summary.failed.length ? `, FAILED: ${summary.failed.join(', ')}` : '')
    );
    return summary;
  } catch (err) {
    console.warn('[Reset] Reset failed (non-fatal):', err?.message);
    return null;
  }
}
