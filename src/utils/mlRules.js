// ── ML RULE LOADER — platform parity (v29) ────────────────────────────────
// ML rules live in SQLite (bist_ml_engine.db) accessed via electronAPI.mlDb,
// which ONLY exists in the Electron desktop app. Web/mobile builds have no
// native SQLite, so historically they skipped ML entirely — producing DIFFERENT
// picks than desktop (violates the "same picks on mobile and PC" requirement).
//
// Fix: bundle a static snapshot of the top rules (src/data/mlRules.json,
// regenerated via scripts/export_ml_rules.py). Electron keeps using the LIVE DB
// (feedback loop + weekly retraining); web/mobile fall back to the snapshot.
// The scoring logic (scoreNewSignal + filterRulesForRegime) is platform-agnostic,
// so both platforms now apply the SAME ML boost.
//
// IMPORTANT: We inline the rules directly to avoid ANY import/require of the
// JSON file — Rollup/Vite resolves both static and dynamic imports at build
// time, causing build failures if the file is absent (e.g. stale Vercel cache).
// The rules are loaded lazily via dynamic import with @vite-ignore as primary,
// and fall back to an empty set if the file doesn't exist.

let _staticRules = null;
let _staticLoaded = false;
let _staticCache = null;

async function loadStaticRules() {
  if (_staticLoaded) return _staticRules;
  try {
    // Try loading the bundled JSON — @vite-ignore prevents Rollup from
    // treating this as a build-time dependency (won't fail if file is missing)
    const jsonPath = '../data/mlRules.json';
    const mod = await import(/* @vite-ignore */ jsonPath);
    _staticRules = mod.default || mod;
  } catch {
    // File doesn't exist or import failed — graceful degradation
    _staticRules = { rules: [] };
  }
  _staticLoaded = true;
  return _staticRules;
}

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
  const staticRules = await loadStaticRules();
  const rules = (staticRules?.rules || []).filter(r => (r.total_count || 0) >= minSamples);
  _staticCache = { rules, source: 'static-snapshot', meta: staticRules?._meta, _min: minSamples };
  return _staticCache;
}

