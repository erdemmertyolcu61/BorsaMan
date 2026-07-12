// ── ML RULE LOADER — platform parity (v29) ────────────────────────────────
// ML rules live in SQLite (bist_ml_engine.db) accessed via electronAPI.mlDb,
// which ONLY exists in the Electron desktop app. Web/mobile builds have no
// native SQLite, so historically they skipped ML entirely — producing DIFFERENT
// picks than desktop (violates the "same picks on mobile and PC" requirement).
//
// Fix: bundle a static snapshot of the top rules (src/data/mlRules.json,
// regenerated via `npm run ml:export`). Electron keeps using the LIVE DB
// (feedback loop + weekly retraining); web/mobile use the bundled snapshot.
// The scoring logic (scoreNewSignal + filterRulesForRegime) is platform-agnostic,
// so both platforms apply the SAME ML boost.
//
// The JSON is imported STATICALLY so Rollup/Vite bundles it into the JS chunk —
// this is what makes it available at runtime on web/mobile. A @vite-ignore
// dynamic import does NOT bundle the file and fails at runtime in the production
// build (dist/data/ doesn't exist), silently zeroing ML everywhere.
// Build safety: the file is committed to git AND the `prebuild` npm script writes
// an empty { rules: [] } fallback if it's ever missing, so the static import
// never breaks the build.
import staticRulesData from '../data/mlRules.json';

let _staticCache = null;

/**
 * Returns the ML rule set for scoring, transparently choosing the best source.
 * @param {number} minSamples - minimum total_count (mirrors getTopRules)
 * @returns {Promise<{ rules: Array, source: string, meta?: object }>}
 */
export async function getMlRules(minSamples = 10) {
  const mlDb = (typeof window !== 'undefined') && window.electronAPI?.mlDb;

  // 1. Electron live DB — freshest (includes paper-trade feedback + retraining)
  if (mlDb) {
    try {
      let rules = await mlDb.getTopRules(50, minSamples);
      if (!rules?.length) rules = await mlDb.getTopRules(50, 3); // relaxed fallback
      if (rules?.length) return { rules, source: 'electron-live' };
    } catch {
      // fall through to the bundled snapshot
    }
  }

  // 2. Web/mobile (or Electron with an empty DB) — bundled static snapshot
  if (_staticCache && _staticCache._min === minSamples) return _staticCache;
  const rules = (staticRulesData?.rules || []).filter(r => (r.total_count || 0) >= minSamples);
  _staticCache = { rules, source: 'static-snapshot', meta: staticRulesData?._meta, _min: minSamples };
  return _staticCache;
}
