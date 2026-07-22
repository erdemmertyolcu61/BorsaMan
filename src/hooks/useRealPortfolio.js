/**
 * useRealPortfolio — REAL (manually maintained) multi-market portfolio.
 *
 * Ported from the standalone Python tracker. Unlike the terminal's virtual
 * "Portföy" paper account, these are actual holdings across US + BIST.
 *
 * Prices:
 *   BIST → fetchBigParaQuote (existing engine)
 *   US   → fetchYahooSeries (raw-symbol Yahoo; fetchEngine's helpers force .IS)
 *   USD/TRY → getMacroContext().usdtry — needed for the combined TRY total
 *
 * Positions live ONLY in localStorage (personal financial data — never committed).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchBigParaQuote, fetchBigParaBatchPrices } from '../utils/fetchEngine.js';
import { fetchYahooSeries, getMacroContext } from '../utils/macroContextEngine.js';
import { normalizePositions, portfolioTotals, checkAlerts } from '../utils/realPortfolio.js';

const STORAGE_KEY = 'bist_real_portfolio';

// First-run seed: src/data/realPortfolio.local.json (gitignored — personal data).
// import.meta.glob resolves to {} when the file is absent, so builds/CI on a
// machine without it still work. Copy realPortfolio.example.json to create one.
const _seedModules = import.meta.glob('../data/realPortfolio.local.json', { eager: true });
function seedPositions() {
  try {
    const mod = Object.values(_seedModules)[0];
    const data = mod?.default ?? mod;
    return data ? normalizePositions(data) : [];
  } catch { return []; }
}

function loadPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizePositions(JSON.parse(raw));
  } catch { /* fall through to seed */ }
  // Nothing stored yet → seed from the local file so the tab is populated
  // immediately after an update, with no manual paste.
  const seeded = seedPositions();
  if (seeded.length) savePositions(seeded);
  return seeded;
}

function savePositions(positions) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ positions })); } catch {}
}

async function fetchUsPrice(ticker) {
  const series = await fetchYahooSeries(ticker, '5d', '1d', 9000);
  if (!series || !series.length) return null;
  const last = series[series.length - 1];
  return Number.isFinite(last?.close) ? last.close : null;
}

async function fetchBistPrice(ticker) {
  try {
    const q = await fetchBigParaQuote(ticker);
    return Number.isFinite(q?.price) && q.price > 0 ? q.price : null;
  } catch { return null; }
}

export function useRealPortfolio() {
  const [positions, setPositionsState] = useState(() => loadPositions());
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [usdTry, setUsdTry] = useState(null);
  const runningRef = useRef(false);

  const setPositions = useCallback((next) => {
    const norm = normalizePositions(next);
    setPositionsState(norm);
    savePositions(norm);
  }, []);

  const refresh = useCallback(async () => {
    if (runningRef.current) return;
    const current = loadPositions();
    if (!current.length) { setLastUpdate(new Date()); return; }
    runningRef.current = true;
    setLoading(true);
    try {
      // USD/TRY (cached upstream) — needed to combine the two legs.
      let rate = null;
      try {
        const macro = await getMacroContext();
        rate = Number.isFinite(macro?.usdtry?.value) ? macro.usdtry.value : null;
      } catch { rate = null; }
      setUsdTry(rate);

      // BIST: one batch call covers every symbol (the per-symbol quote endpoint is
      // flaky — it silently dropped KCHOL in testing). Per-symbol is the fallback
      // for whatever the batch misses. Same pattern as useLivePrices.
      let batch = {};
      if (current.some(p => p.market === 'BIST')) {
        try { batch = (await fetchBigParaBatchPrices()) || {}; } catch { batch = {}; }
      }

      const priced = await Promise.all(current.map(async (p) => {
        let price;
        if (p.market === 'US') {
          price = await fetchUsPrice(p.ticker).catch(() => null);
        } else {
          const b = batch[p.ticker];
          price = Number.isFinite(b?.price) && b.price > 0 ? b.price : await fetchBistPrice(p.ticker);
        }
        return { ...p, currentPrice: price };
      }));

      setPositionsState(priced);
      savePositions(priced);
      setLastUpdate(new Date());
    } finally {
      runningRef.current = false;
      setLoading(false);
    }
  }, []);

  // Refresh once on mount when positions exist.
  useEffect(() => {
    if (loadPositions().length) refresh();
  }, [refresh]);

  const totals = portfolioTotals(positions, usdTry);
  const alerts = checkAlerts(positions);

  return { positions, setPositions, refresh, loading, lastUpdate, usdTry, totals, alerts };
}
