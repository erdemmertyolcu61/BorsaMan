// ════════════════════════════════════════════════════════════════════
// ml-training-worker.cjs — Background ML Training Worker (child_process)
// ════════════════════════════════════════════════════════════════════
//
// Spawned by Electron main process via fork(). Runs the full ML pipeline
// (fetch OHLCV → signal generation → outcome backfill → rule discovery)
// in an isolated process so the UI never freezes.
//
// Communication:
//   Parent → Worker:  { type: 'start', dbPath, symbols?, range? }
//   Worker → Parent:  { type: 'progress', phase, pct, msg }
//   Worker → Parent:  { type: 'complete', newRules, mergedRules, elapsed }
//   Worker → Parent:  { type: 'error', message }
//
// Usage from main.cjs:
//   const worker = fork(path.join(__dirname, 'ml-training-worker.cjs'));
//   worker.send({ type: 'start', dbPath: '...' });
//   worker.on('message', (msg) => { ... });
// ════════════════════════════════════════════════════════════════════

'use strict';

const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// Windows-safe ESM dynamic import helper
const imp = (rel) => import(pathToFileURL(path.resolve(ROOT, rel)).href);

// ── Communicate with parent ──
function send(msg) {
  if (process.send) process.send(msg);
  else console.log('[MLWorker]', JSON.stringify(msg));
}

function progress(phase, pct, msg) {
  send({ type: 'progress', phase, pct, msg });
}

// ── Yahoo Finance Fetcher ──

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
};

function parseYahooChart(text) {
  try {
    const data = JSON.parse(text);
    const r = data?.chart?.result?.[0];
    if (!r?.timestamp || r.timestamp.length < 10) return null;
    const q = r.indicators?.quote?.[0];
    if (!q?.close) return null;
    const ts = r.timestamp;
    const prices = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close[i];
      if (c == null || c <= 0) continue;
      let o = q.open[i] ?? c, h = q.high[i] ?? c, l = q.low[i] ?? c;
      h = Math.max(h, o, c);
      l = Math.min(l, o, c);
      if (h < l) continue;
      prices.push({ date: new Date(ts[i] * 1000), open: o, high: h, low: l, close: c, volume: q.volume[i] || 0 });
    }
    return prices.length >= 50 ? prices : null;
  } catch { return null; }
}

async function fetchSymbol(symbol, range, interval) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}`,
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
        clearTimeout(timer);
        if (res.status === 429) {
          await sleep(4000 * Math.pow(2, attempt - 1));
          break;
        }
        if (!res.ok) continue;
        const text = await res.text();
        const prices = parseYahooChart(text);
        if (prices?.length >= 50) return prices;
      } catch { continue; }
    }
    if (attempt < 3) await sleep(4000 * Math.pow(2, attempt - 1));
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BIST100 Universe ──

const BIST100 = [
  'AKBNK','ARCLK','ASELS','BIMAS','EKGYO','EREGL','FROTO','GARAN',
  'GUBRF','HEKTS','KCHOL','PETKM','PGSUS','SAHOL','SISE','TAVHL',
  'TCELL','THYAO','TOASO','TUPRS','VESTL','YKBNK',
  'AEFES','AKSA','ALARK','AYGAZ','CCOLA','DOHOL','ENKAI','GESAN',
  'HALKB','ISGYO','KONTR','LOGO','MPARK','NETAS','OTKAR','OYAKC',
  'SARKY','SOKM','TTKOM','VAKBN',
  'ADEL','AFYON','AGESA','AKCNS','AKENR','AKFGY','ALGYO','ALKIM',
  'ANHYT','ANSGR','AVISA','AYDEM','BASGZ','BIENY','BRISA','BRYAT',
  'BUCIM','CANTE','CEMTS','CIMSA','DOAS','EGEEN','ENJSA','EUPWR',
  'GENIL','GLYHO','GOZDE','GSDHO','INDES','ISMEN','KARSN','KLSER',
  'KORDS','MAVI','OBAMS','SELEC','SKBNK','SNGYO','TATGD','TMSN',
  'TRGYO','TSKB','TTRAK','TURSG','ULKER','ULUUN','VERUS','YATAS',
];

// ── Signal Generation ──

const LOOKBACK_BARS = 100;
const SIGNAL_STEP   = 5;

function generateHistoricalSignals(symbol, prices, calcAll, genSignal, extractFiredSignals) {
  if (!prices || prices.length < LOOKBACK_BARS + 10) return [];
  const signals = [];
  const end = prices.length - 5;
  for (let i = LOOKBACK_BARS; i < end; i += SIGNAL_STEP) {
    try {
      const window = prices.slice(0, i + 1);
      const ind = calcAll(window);
      if (!ind?.lastClose) continue;
      const sig = genSignal(ind, window);
      if (!sig) continue;
      const fired = extractFiredSignals(ind, window);
      const bar = prices[i];
      signals.push({
        symbol,
        ts:            bar.date.getTime(),
        direction:     sig.cls?.toUpperCase() || 'HOLD',
        score100:      sig.score ?? 50,
        rawScore:      sig.rawScore ?? 0,
        entry:         ind.lastClose,
        stop:          sig.stop,
        t1:            sig.t1,
        rr:            sig.rr,
        atrPct:        ind.atr && ind.lastClose ? (ind.atr / ind.lastClose) * 100 : null,
        rsi:           ind.lastRSI,
        mfi:           ind.mfi,
        adx:           ind.adx,
        cmf:           ind.cmf,
        volRatio:      ind.volRatio,
        bollPct:       ind.lastBU && ind.lastBL
                         ? ((ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL)) * 100 : null,
        distFromMA20:  ind.lastMA20 ? ((ind.lastClose - ind.lastMA20) / ind.lastMA20) * 100 : null,
        ma50pct:       ind.lastMA50 ? ((ind.lastClose - ind.lastMA50) / ind.lastMA50) * 100 : null,
        obvTrend:      ind.obvTrend,
        wyckoff:       ind.wyckoffPhase,
        supertrend:    ind.supertrend,
        ichimoku:      ind.ichimoku,
        ttmSqueeze:    ind.ttmSqueeze,
        firedSignals:  fired,
        regime:        sig.regime,
        setupGrade:    sig.setupGrade,
        sector:        null,
      });
    } catch { continue; }
  }
  return signals;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════

async function runPipeline(config) {
  const T0 = performance.now();
  const {
    dbPath,
    symbols = BIST100,
    range = '1y',
    interval = '1d',
    interSymbolMs = 2000,
    batchSize = 10,
  } = config;

  progress(1, 0, 'ML modulleri yukleniyor...');

  // Dynamic ESM imports
  const { calcAll }                         = await imp('src/utils/indicators.js');
  const { genSignal, extractFiredSignals }  = await imp('src/utils/signals.js');
  const { initMLDatabase }                  = await imp('src/utils/DatabaseManager.js');
  const {
    runOutcomeBackfill,
    computeFeatureImportance,
    extractWinningRules,
  } = await imp('src/utils/ML_BacktestEngine.js');

  // ── Phase 1: DB Init ──
  progress(1, 5, 'Veritabani baslatiliyor...');
  const db = await initMLDatabase(dbPath);

  // ── Phase 2: Fetch + Signal Generation ──
  progress(2, 0, `${symbols.length} sembol icin veri cekiliyor...`);
  const allPrices = new Map();
  let pendingSignals = [];
  let fetched = 0, failed = 0, totalSignals = 0;

  for (let idx = 0; idx < symbols.length; idx++) {
    const sym = symbols[idx];
    const pct = Math.round(((idx + 1) / symbols.length) * 100);
    progress(2, pct, `[${idx + 1}/${symbols.length}] ${sym} veri cekiliyor...`);

    const prices = await fetchSymbol(sym, range, interval);
    if (!prices) {
      failed++;
      if (idx < symbols.length - 1) await sleep(interSymbolMs);
      continue;
    }

    const signals = generateHistoricalSignals(sym, prices, calcAll, genSignal, extractFiredSignals);
    allPrices.set(sym, prices.map(p => ({ date: p.date, close: p.close, high: p.high, low: p.low })));
    pendingSignals.push(...signals);
    fetched++;
    totalSignals += signals.length;

    // Batch commit
    if (pendingSignals.length > 0 && ((idx + 1) % batchSize === 0 || idx === symbols.length - 1)) {
      db.insertSignals(pendingSignals);
      pendingSignals = [];
    }

    if (idx < symbols.length - 1) await sleep(interSymbolMs);
  }

  // Flush remaining
  if (pendingSignals.length > 0) {
    db.insertSignals(pendingSignals);
    pendingSignals = [];
  }

  progress(2, 100, `Veri tamamlandi: ${fetched}/${symbols.length} sembol, ${totalSignals} sinyal`);

  // ── Phase 3: ROI Backfill ──
  progress(3, 0, 'ROI hesaplaniyor (T+1/T+3/T+5)...');
  const backfill = runOutcomeBackfill(db, allPrices);
  allPrices.clear(); // free memory
  progress(3, 100, `Backfill: ${backfill.evaluated} sinyal, ${backfill.wins}W/${backfill.losses}L`);

  // ── Phase 4: Feature Importance + Rule Discovery ──
  progress(4, 30, 'Feature importance hesaplaniyor...');
  const features = computeFeatureImportance(db, 'BUY');

  progress(4, 60, 'Kural kesfediliyor...');
  const dbStats = db.getStats();
  const minOcc = Math.max(8, Math.floor((dbStats.closed || 0) * 0.005));

  const rules = extractWinningRules(db, {
    topK:           18,
    minOccurrences: minOcc,
    maxDepth:       3,
    direction:      'BUY',
  });

  progress(4, 100, `${rules.length} kural kesfedildi (${features.length} feature)`);

  // ── Done ──
  const elapsed = Math.round((performance.now() - T0) / 1000);

  // Count new vs merged from rules result
  const newRules = rules.filter(r => !r._merged).length;
  const mergedRules = rules.length - newRules;

  return {
    newRules: rules.length,
    mergedRules: 0,
    totalSignals,
    fetched,
    failed,
    features: features.length,
    elapsed,
  };
}

// ═══════════════════════════════════════════════════════════════════
// IPC MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════

process.on('message', async (msg) => {
  if (msg?.type !== 'start') return;

  try {
    const result = await runPipeline({
      dbPath: msg.dbPath,
      symbols: msg.symbols || BIST100,
      range: msg.range || '1y',
      interval: msg.interval || '1d',
      interSymbolMs: msg.interSymbolMs || 2000,
      batchSize: msg.batchSize || 10,
    });

    send({
      type: 'complete',
      ...result,
    });
  } catch (err) {
    send({ type: 'error', message: err?.message || String(err) });
  }

  // Exit cleanly after pipeline completes
  setTimeout(() => process.exit(0), 500);
});

// If started without IPC (direct node execution for testing)
if (!process.send) {
  console.log('[MLWorker] Running in standalone mode (no IPC parent)...');
  runPipeline({
    dbPath: path.resolve(ROOT, 'data', 'bist_ml_engine.db'),
    range: '1y',
  }).then(result => {
    console.log('[MLWorker] Pipeline complete:', result);
    process.exit(0);
  }).catch(err => {
    console.error('[MLWorker] Pipeline failed:', err);
    process.exit(1);
  });
}
