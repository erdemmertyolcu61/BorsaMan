/**
 * errorLogger.js — Centralized error dispatch.
 *
 * Replaces silent `catch {}` / `catch { return null }` blocks across the
 * codebase. Every failure (fetch, parse, indicator math, AI call) must:
 *   1. Log to console with a scope tag so devtools remain debuggable.
 *   2. OPTIONALLY surface to the user via the global AlertLog/AlertCenter
 *      (bist-alert CustomEvent) — so no user ever trades on corrupted data
 *      without seeing a warning.
 *
 * Scopes: 'fetch' | 'parse' | 'ai' | 'indicator' | 'signal' | 'portfolio' |
 *         'news' | 'kap' | 'persist' | 'worker'
 *
 * Severity: 'debug' (never surfaced) | 'warn' (surfaced quiet) | 'error' (surfaced loud)
 */

const _recent = new Map(); // dedupe key → last-ts
const DEDUPE_MS = 8000;

function _dedupeOK(key) {
  const now = Date.now();
  const last = _recent.get(key) || 0;
  if (now - last < DEDUPE_MS) return false;
  _recent.set(key, now);
  // prune
  if (_recent.size > 200) {
    for (const [k, ts] of _recent) if (now - ts > DEDUPE_MS * 4) _recent.delete(k);
  }
  return true;
}

function _surface({ severity, scope, message, symbol }) {
  if (severity === 'debug') return;
  try {
    window.dispatchEvent(new CustomEvent('bist-alert', {
      detail: {
        severity: severity === 'error' ? 'error' : 'warn',
        title: scope.toUpperCase() + ' — hata',
        message,
        symbol: symbol || null,
        source: 'errorLogger',
      },
    }));
  } catch { /* window missing (SSR/tests) — noop */ }
}

/**
 * logError(scope, message, err?, opts?)
 * @param {string} scope — subsystem tag (e.g. 'fetch', 'parse')
 * @param {string} message — short human-readable context
 * @param {Error|unknown} [err] — the caught error object
 * @param {{ severity?: 'debug'|'warn'|'error', symbol?: string, silent?: boolean }} [opts]
 */
export function logError(scope, message, err, opts = {}) {
  const severity = opts.severity || 'warn';
  const detail = err && err.message ? err.message : (err != null ? String(err) : '');
  const full = `[${scope}] ${message}` + (detail ? ` — ${detail}` : '');

  // Dedupe identical messages so a failing endpoint doesn't flood AlertLog
  const key = scope + '|' + message + '|' + (opts.symbol || '');
  const firstOccurrence = _dedupeOK(key);

  if (severity === 'error') console.error(full, err || '');
  else if (severity === 'warn' && firstOccurrence) console.warn(full);
  else if (severity === 'debug') console.debug(full);

  if (opts.silent) return;
  if (firstOccurrence) _surface({ severity, scope, message: full, symbol: opts.symbol });
}

/** Wrap an async fn so any throw is logged + re-thrown as null. */
export async function safeAsync(scope, message, fn, opts = {}) {
  try { return await fn(); }
  catch (err) { logError(scope, message, err, opts); return opts.fallback ?? null; }
}

/** Wrap a sync fn. */
export function safeSync(scope, message, fn, opts = {}) {
  try { return fn(); }
  catch (err) { logError(scope, message, err, opts); return opts.fallback ?? null; }
}
