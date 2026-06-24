#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// train_bist100_3yr.js — Enterprise-Grade 3-Year BIST100 Training
// ════════════════════════════════════════════════════════════════════
//
// Usage:
//   node scripts/train_bist100_3yr.js
//   node scripts/train_bist100_3yr.js --symbols THYAO,ASELS,GARAN
//   node scripts/train_bist100_3yr.js --resume          (skip already-ingested symbols)
//   node scripts/train_bist100_3yr.js --batch-size 5    (commit every N symbols)
//   node scripts/train_bist100_3yr.js --delay 3000      (ms between symbols)
//   node scripts/train_bist100_3yr.js --pipeline-only   (skip fetch, run pipeline on existing data)
//
// Pipeline:
//   Phase 1 — Sequential fetch of 3yr daily OHLCV (strict 2s throttle, 3x retry)
//   Phase 2 — Sliding-window signal generation with batch DB commits
//   Phase 3 — T+1/T+3/T+5 ROI backfill
//   Phase 4 — Feature importance + combinatorial rule discovery
//   Phase 5 — Detailed final report
//
// Memory: Processes one symbol at a time. Prices are discarded after signal
// extraction. DB inserts are batched every N symbols (default 10) and the
// V8 heap is given breathing room via setImmediate between batches.
//
// Requires: better-sqlite3 (npm i better-sqlite3)
// ════════════════════════════════════════════════════════════════════

import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

// Windows-safe ESM dynamic import helper
const imp = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href);

// ── Dynamic imports ───────────────────────────────────────────────

const { calcAll }                              = await imp('src/utils/indicators.js');
const { genSignal, extractFiredSignals }       = await imp('src/utils/signals.js');
const { initMLDatabase }                       = await imp('src/utils/DatabaseManager.js');
const {
  evaluateHistoricalSignals,
  runOutcomeBackfill,
  computeFeatureImportance,
  extractWinningRules,
} = await imp('src/utils/ML_BacktestEngine.js');

// ═══════════════════════════════════════════════════════════════════
// BIST100 UNIVERSE
// ═══════════════════════════════════════════════════════════════════

const BIST30 = [
  'AKBNK','ARCLK','ASELS','BIMAS','EKGYO','EREGL','FROTO','GARAN',
  'GUBRF','HEKTS','KCHOL','PETKM','PGSUS','SAHOL','SISE','TAVHL',
  'TCELL','THYAO','TOASO','TUPRS','VESTL','YKBNK',
];
const BIST50_EXTRA = [
  'AEFES','AKSA','ALARK','AYGAZ','CCOLA','DOHOL','ENKAI','GESAN',
  'HALKB','ISGYO','KONTR','LOGO','MPARK','NETAS','OTKAR','OYAKC',
  'SARKY','SOKM','TTKOM','VAKBN',
];
const BIST100_EXTRA = [
  'ADEL','AFYON','AGESA','AKCNS','AKENR','AKFGY','ALGYO','ALKIM',
  'ANHYT','ANSGR','AVISA','AYDEM','BASGZ','BIENY','BRISA','BRYAT',
  'BUCIM','CANTE','CEMTS','CIMSA','DOAS','EGEEN','ENJSA','EUPWR',
  'GENIL','GLYHO','GOZDE','GSDHO','INDES','ISMEN','KARSN','KLSER',
  'KORDS','MAVI','OBAMS','SELEC','SKBNK','SNGYO','TATGD','TMSN',
  'TRGYO','TSKB','TTRAK','TURSG','ULKER','ULUUN','VERUS','YATAS',
];
const BIST100 = [...new Set([...BIST30, ...BIST50_EXTRA, ...BIST100_EXTRA])];

// ═══════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════

const args         = process.argv.slice(2);
const flagVal      = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const pipelineOnly = args.includes('--pipeline-only');
const resumeMode   = args.includes('--resume');
const symbolsArg   = flagVal('--symbols');
const symbols      = symbolsArg
  ? symbolsArg.split(',').map(s => s.trim().toUpperCase())
  : BIST100;

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const LOOKBACK_BARS    = 100;             // min bars before signal generation starts
const SIGNAL_STEP      = 5;              // step size for sliding window (3yr → ~150 signals/sym)
const YAHOO_RANGE      = '3y';
const YAHOO_INTERVAL   = '1d';
const FETCH_TIMEOUT_MS = 20000;          // 20s per request
const MAX_RETRIES      = 3;
const BASE_RETRY_MS    = 4000;           // exponential backoff base
const INTER_SYMBOL_MS  = parseInt(flagVal('--delay') || '2000', 10);  // strict throttle
const BATCH_SIZE       = parseInt(flagVal('--batch-size') || '10', 10);
const DB_PATH          = resolve(ROOT, 'data', 'bist_ml_training_3yr.db');

// ═══════════════════════════════════════════════════════════════════
// CONSOLE HELPERS
// ═══════════════════════════════════════════════════════════════════

const C = {
  reset:   '\x1b[0m',  bold:    '\x1b[1m',  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',  green:   '\x1b[32m',  yellow:  '\x1b[33m',
  red:     '\x1b[31m',  magenta: '\x1b[35m',  white:   '\x1b[37m',
  bgCyan:  '\x1b[46m',  bgGreen: '\x1b[42m',  bgRed:   '\x1b[41m',
  bgYellow:'\x1b[43m',
};

const banner = (t) => {
  const l = '═'.repeat(68);
  console.log(`\n${C.cyan}${l}${C.reset}\n${C.bold}${C.cyan}  ${t}${C.reset}\n${C.cyan}${l}${C.reset}\n`);
};
const step  = (n, t) => console.log(`${C.bold}${C.green}[PHASE ${n}]${C.reset} ${t}`);
const info  = (t)    => console.log(`${C.dim}  → ${t}${C.reset}`);
const warn  = (t)    => console.log(`${C.yellow}  ⚠ ${t}${C.reset}`);
const err   = (t)    => console.log(`${C.red}  ✗ ${t}${C.reset}`);
const ok    = (t)    => console.log(`${C.green}  ✓ ${t}${C.reset}`);

function progressBar(current, total, width = 30) {
  const pct  = total > 0 ? current / total : 0;
  const fill = Math.round(pct * width);
  const bar  = '█'.repeat(fill) + '░'.repeat(width - fill);
  return `${bar} ${(pct * 100).toFixed(0).padStart(3)}%`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

// ═══════════════════════════════════════════════════════════════════
// YAHOO FINANCE FETCHER — Single Symbol, Retry-Aware
// ═══════════════════════════════════════════════════════════════════

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
};

const YAHOO_URLS = (sym, range, interval) => [
  `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.IS?range=${range}&interval=${interval}&includePrePost=false`,
  `https://query2.finance.yahoo.com/v7/finance/chart/${sym}.IS?range=${range}&interval=${interval}`,
];

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

/**
 * Fetch a single symbol with up to MAX_RETRIES attempts and exponential backoff.
 * Tries query1 (v8) first, falls back to query2 (v7) on each attempt.
 */
async function fetchWithRetry(symbol) {
  const urls = YAHOO_URLS(symbol, YAHOO_RANGE, YAHOO_INTERVAL);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
        clearTimeout(timer);

        if (res.status === 429) {
          // Rate-limited — back off and retry
          const wait = BASE_RETRY_MS * Math.pow(2, attempt - 1);
          warn(`${symbol} rate-limited (429). Waiting ${formatDuration(wait)}...`);
          await sleep(wait);
          break; // retry outer loop
        }
        if (!res.ok) continue; // try next URL

        const text = await res.text();
        const prices = parseYahooChart(text);
        if (prices && prices.length >= 50) return { prices, attempt };
      } catch (e) {
        if (e.name === 'AbortError') {
          // Timeout — will retry
        }
        continue; // try next URL
      }
    }

    // Between retry attempts: exponential backoff
    if (attempt < MAX_RETRIES) {
      const wait = BASE_RETRY_MS * Math.pow(2, attempt - 1);
      await sleep(wait);
    }
  }

  return { prices: null, attempt: MAX_RETRIES };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Yield to event loop (prevent V8 heap pressure on tight loops)
function breathe() { return new Promise(r => setImmediate(r)); }

// ═══════════════════════════════════════════════════════════════════
// SIGNAL GENERATION — Sliding Window
// ═══════════════════════════════════════════════════════════════════

function generateHistoricalSignals(symbol, prices) {
  if (!prices || prices.length < LOOKBACK_BARS + 10) return [];

  const signals = [];
  const end = prices.length - 5; // reserve last 5 bars for T+5

  for (let i = LOOKBACK_BARS; i < end; i += SIGNAL_STEP) {
    try {
      const window = prices.slice(0, i + 1);
      const ind = calcAll(window);
      if (!ind || !ind.lastClose) continue;

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
    } catch {
      continue;
    }
  }

  return signals;
}

// ═══════════════════════════════════════════════════════════════════
// TABLE RENDERER
// ═══════════════════════════════════════════════════════════════════

function printTable(headers, rows, widths, colorCols = {}) {
  const top = widths.map(w => '─'.repeat(w + 2));
  const hdr = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');

  console.log(`  ┌${top.join('┬')}┐`);
  console.log(`  │${C.bold}${hdr}${C.reset}│`);
  console.log(`  ├${top.join('┼')}┤`);

  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const str = String(cell);
      const fn = colorCols[i];
      if (fn) {
        const color = fn(parseFloat(str));
        return ` ${color}${str.padStart(widths[i])}${C.reset} `;
      }
      return ` ${str.padEnd(widths[i]).slice(0, widths[i])} `;
    });
    console.log(`  │${cells.join('│')}│`);
  }

  console.log(`  └${top.join('┴')}┘`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const T0 = performance.now();

  banner('BIST100 × 3yr — Deep Learning Data Ingestion');
  info(`Universe:      ${symbols.length} symbols`);
  info(`Range:         ${YAHOO_RANGE} daily (${YAHOO_INTERVAL})`);
  info(`Throttle:      ${INTER_SYMBOL_MS}ms between symbols`);
  info(`Batch commit:  every ${BATCH_SIZE} symbols`);
  info(`Max retries:   ${MAX_RETRIES} (exp backoff ${BASE_RETRY_MS}ms base)`);
  info(`DB path:       ${DB_PATH}`);
  info(`Started:       ${new Date().toISOString()}`);
  if (pipelineOnly) info(`${C.yellow}--pipeline-only: skipping fetch, running pipeline on existing data${C.reset}`);
  if (resumeMode)   info(`${C.yellow}--resume: will skip symbols already in the database${C.reset}`);
  console.log();

  // ── Ensure data/ directory ─────────────────────────────────────
  const fs = await import('node:fs');
  const dataDir = resolve(ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ══════════════════════════════════════════════════════════════
  // PHASE 1 — Database Init
  // ══════════════════════════════════════════════════════════════

  step(1, 'Initializing SQLite database...');
  let db;
  try {
    db = await initMLDatabase(DB_PATH);
    const stats = db.getStats();
    ok(`Database ready (${db.isNode ? 'better-sqlite3 WAL' : 'browser fallback'})`);
    if (stats.total > 0) info(`Existing data: ${stats.total} signals, ${stats.closed || 0} with outcomes`);
  } catch (e) {
    err(`Database init failed: ${e.message}`);
    err('Install better-sqlite3: npm install better-sqlite3');
    process.exit(1);
  }

  // Build resume set (symbols already fully ingested)
  let skipSet = new Set();
  if (resumeMode && db.isNode) {
    try {
      const existing = db.raw.prepare(
        "SELECT DISTINCT symbol FROM trade_signals GROUP BY symbol HAVING COUNT(*) >= 50"
      ).all();
      skipSet = new Set(existing.map(r => r.symbol));
      if (skipSet.size > 0) info(`Resume: ${skipSet.size} symbols already ingested, will skip`);
    } catch {}
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 2 — Sequential Fetch + Signal Generation
  // ══════════════════════════════════════════════════════════════

  const total = symbols.length;
  const allPrices = new Map();        // kept alive for Phase 3 backfill
  const report = {                    // per-symbol stats
    fetched: 0, failed: 0, skipped: 0, totalBars: 0,
    totalSignals: 0, retries: 0,
    symbolDetails: [],
  };

  let pendingSignals = [];            // batch insert buffer

  if (!pipelineOnly) {
    step(2, `Fetching 3-year data and generating signals for ${total} symbols...`);
    console.log();

    const phaseT0 = performance.now();

    for (let idx = 0; idx < total; idx++) {
      const sym = symbols[idx];
      const num = idx + 1;

      // ── Progress line ──
      const prog = progressBar(num, total);
      const prefix = `  ${C.cyan}[${String(num).padStart(3)}/${total}]${C.reset}`;

      // Resume check
      if (skipSet.has(sym)) {
        process.stdout.write(`${prefix} ${sym.padEnd(7)} ${C.dim}SKIP (resume)${C.reset}\n`);
        report.skipped++;
        continue;
      }

      process.stdout.write(`${prefix} ${sym.padEnd(7)} fetching...`);

      // ── Fetch with retry ──
      const { prices, attempt } = await fetchWithRetry(sym);
      if (attempt > 1) report.retries += (attempt - 1);

      if (!prices) {
        process.stdout.write(`\r${prefix} ${sym.padEnd(7)} ${C.red}FAILED${C.reset} (${attempt} attempts)        \n`);
        report.failed++;
        report.symbolDetails.push({ sym, bars: 0, signals: 0, status: 'FAILED' });

        // Still throttle after failure
        if (idx < total - 1) await sleep(INTER_SYMBOL_MS);
        continue;
      }

      // ── Signal generation ──
      const signals = generateHistoricalSignals(sym, prices);

      // Keep prices for Phase 3 backfill (store only close+high+low+date to save RAM)
      allPrices.set(sym, prices.map(p => ({
        date: p.date, close: p.close, high: p.high, low: p.low,
      })));

      pendingSignals.push(...signals);
      report.fetched++;
      report.totalBars += prices.length;
      report.totalSignals += signals.length;

      const dateRange = `${prices[0].date.toISOString().slice(0, 10)}→${prices[prices.length - 1].date.toISOString().slice(0, 10)}`;
      const retryTag = attempt > 1 ? ` ${C.yellow}(${attempt} tries)${C.reset}` : '';
      process.stdout.write(
        `\r${prefix} ${sym.padEnd(7)} ${C.green}${String(prices.length).padStart(4)} bars${C.reset}  `
        + `${C.cyan}${String(signals.length).padStart(4)} sigs${C.reset}  `
        + `${C.dim}${dateRange}${C.reset}${retryTag}        \n`
      );

      report.symbolDetails.push({
        sym, bars: prices.length, signals: signals.length,
        status: 'OK', attempts: attempt,
      });

      // ── Batch commit every BATCH_SIZE symbols ──
      if (pendingSignals.length > 0 && (num % BATCH_SIZE === 0 || idx === total - 1)) {
        const batchCount = pendingSignals.length;
        db.insertSignals(pendingSignals);
        pendingSignals = [];  // release for GC
        info(`${C.dim}Committed batch: ${batchCount} signals → DB${C.reset}`);
        await breathe();      // yield to GC
      }

      // ── Strict inter-symbol throttle ──
      if (idx < total - 1) await sleep(INTER_SYMBOL_MS);
    }

    // Flush any remaining signals
    if (pendingSignals.length > 0) {
      db.insertSignals(pendingSignals);
      info(`Committed final batch: ${pendingSignals.length} signals → DB`);
      pendingSignals = [];
    }

    const phaseElapsed = performance.now() - phaseT0;
    console.log();
    ok(`Phase 2 complete in ${formatDuration(phaseElapsed)}`);
    info(`Fetched: ${report.fetched}/${total}  |  Failed: ${report.failed}  |  Skipped: ${report.skipped}  |  Retries: ${report.retries}`);
    info(`Total bars: ${report.totalBars.toLocaleString()}  |  Total signals: ${report.totalSignals.toLocaleString()}`);

    // ── Memory report ──
    const mem = process.memoryUsage();
    info(`Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}  |  RSS: ${formatBytes(mem.rss)}`);
    console.log();
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 3 — ROI Backfill
  // ══════════════════════════════════════════════════════════════

  step(3, 'Backfilling T+1 / T+3 / T+5 actual ROI...');
  const backT0 = performance.now();

  // If pipeline-only, allPrices is empty — need to load from open signals
  let backfillData = allPrices;
  if (pipelineOnly || allPrices.size === 0) {
    info('No in-memory prices — backfill will use whatever open signals exist');
    // Create a minimal Map to satisfy the API (evaluateHistoricalSignals handles missing syms)
    backfillData = new Map();
  }

  const backfill = runOutcomeBackfill(db, backfillData);
  const backElapsed = performance.now() - backT0;
  ok(`Backfilled ${backfill.evaluated} signals: ${C.green}${backfill.wins}W${C.reset} / ${C.red}${backfill.losses}L${C.reset}  (${formatDuration(backElapsed)})`);

  // Release price data to free memory before heavy pipeline
  allPrices.clear();
  if (global.gc) { global.gc(); info('Forced GC before pipeline'); }
  console.log();

  // ══════════════════════════════════════════════════════════════
  // PHASE 4 — Feature Importance + Rule Discovery
  // ══════════════════════════════════════════════════════════════

  step(4, 'Computing feature importance...');
  const featT0 = performance.now();
  const features = computeFeatureImportance(db, 'BUY');
  const featElapsed = performance.now() - featT0;
  ok(`Ranked ${features.length} features (${formatDuration(featElapsed)})`);

  if (features.length > 0) {
    console.log(`\n  ${C.bold}${C.magenta}Top 15 Predictive Features${C.reset}`);
    printTable(
      ['#', 'Feature', 'InfoGain', 'Corr', 'WinRate', 'AvgROI', 'N'],
      features.slice(0, 15).map((f, i) => [
        String(i + 1),
        f.name,
        f.infoGain.toFixed(4),
        (f.correlation || 0).toFixed(4),
        ((f.winRate || 0) * 100).toFixed(1) + '%',
        (f.avgRoi || 0).toFixed(2) + '%',
        String(f.sampleCount || 0),
      ]),
      [3, 32, 9, 8, 8, 8, 7],
      {
        4: v => v >= 60 ? C.green : v >= 50 ? C.yellow : C.red,
        5: v => v > 0 ? C.green : C.red,
      },
    );
  }
  console.log();

  step('4b', 'Discovering winning rule combinations...');
  const ruleT0 = performance.now();
  const dbStats = db.getStats();
  const minOcc = Math.max(10, Math.floor((dbStats.closed || 0) * 0.005)); // 0.5% of closed signals

  const rules = extractWinningRules(db, {
    topK:           18,
    minOccurrences: minOcc,
    maxDepth:       3,
    direction:      'BUY',
  });
  const ruleElapsed = performance.now() - ruleT0;
  ok(`Discovered ${rules.length} rules (minOcc=${minOcc}, ${formatDuration(ruleElapsed)})`);
  console.log();

  // ══════════════════════════════════════════════════════════════
  // PHASE 5 — Detailed Final Report
  // ══════════════════════════════════════════════════════════════

  const totalElapsed = performance.now() - T0;
  const stats = db.getStats();

  banner('FINAL REPORT');

  // ── Database summary ──
  console.log(`  ${C.bold}${C.magenta}═══ Database Overview ═══${C.reset}`);
  const statLines = [
    ['Total Signals',   (stats.total || 0).toLocaleString()],
    ['With Outcomes',   (stats.closed || 0).toLocaleString()],
    ['Wins  (T+1>0)',   (stats.wins || 0).toLocaleString()],
    ['Losses',          ((stats.closed || 0) - (stats.wins || 0)).toLocaleString()],
    ['Win Rate',        stats.closed > 0 ? `${((stats.wins / stats.closed) * 100).toFixed(1)}%` : 'N/A'],
    ['Avg T+1 ROI',     stats.avg_t1 != null ? `${stats.avg_t1.toFixed(3)}%` : 'N/A'],
    ['Avg T+3 ROI',     stats.avg_t3 != null ? `${stats.avg_t3.toFixed(3)}%` : 'N/A'],
    ['Date Range',      stats.first_ts && stats.last_ts
      ? `${new Date(stats.first_ts).toISOString().slice(0, 10)} → ${new Date(stats.last_ts).toISOString().slice(0, 10)}`
      : 'N/A'],
    ['Rules Discovered', String(rules.length)],
    ['Features Ranked',  String(features.length)],
  ];
  for (const [k, v] of statLines) {
    console.log(`  ${C.dim}${k.padEnd(20)}${C.reset} ${C.bold}${v}${C.reset}`);
  }

  // ── Top 10 rules by Profit Factor ──
  if (rules.length > 0) {
    // Sort by profit factor for this view (rules come sorted by expectancy from pipeline)
    const byPF = [...rules].sort((a, b) => (b.profit_factor || 0) - (a.profit_factor || 0));

    console.log(`\n  ${C.bold}${C.bgGreen}${C.white} TOP 10 RULES — Ranked by Profit Factor ${C.reset}\n`);
    printTable(
      ['#', 'Setup Name', 'WR%', 'Expect%', 'PF', 'Sharpe', 'MaxDD%', 'W', 'L', 'N'],
      byPF.slice(0, 10).map((r, i) => [
        String(i + 1),
        (r.setup_name || '').slice(0, 44),
        (r.win_rate_pct || 0).toFixed(1),
        (r.expectancy || 0).toFixed(2),
        (r.profit_factor || 0).toFixed(2),
        (r.sharpe || 0).toFixed(3),
        (r.max_drawdown || 0).toFixed(1),
        String(r.win_count || 0),
        String(r.loss_count || 0),
        String(r.total_count || 0),
      ]),
      [3, 44, 6, 8, 7, 7, 7, 5, 5, 5],
      {
        2: v => v >= 65 ? C.green : v >= 55 ? C.yellow : C.red,
        3: v => v > 0 ? C.green : C.red,
        4: v => v >= 2.0 ? C.green : v >= 1.2 ? C.yellow : C.red,
        6: v => v > -5 ? C.green : v > -15 ? C.yellow : C.red,
      },
    );

    // ── Top 10 rules by Win Rate ──
    const byWR = [...rules].sort((a, b) => (b.win_rate_pct || 0) - (a.win_rate_pct || 0));

    console.log(`\n  ${C.bold}${C.bgCyan}${C.white} TOP 10 RULES — Ranked by Win Rate ${C.reset}\n`);
    printTable(
      ['#', 'Setup Name', 'WR%', 'Expect%', 'PF', 'Sharpe', 'AvgWin%', 'AvgLoss%', 'N'],
      byWR.slice(0, 10).map((r, i) => [
        String(i + 1),
        (r.setup_name || '').slice(0, 44),
        (r.win_rate_pct || 0).toFixed(1),
        (r.expectancy || 0).toFixed(2),
        (r.profit_factor || 0).toFixed(2),
        (r.sharpe || 0).toFixed(3),
        `+${(r.avg_win_roi || 0).toFixed(2)}`,
        (r.avg_loss_roi || 0).toFixed(2),
        String(r.total_count || 0),
      ]),
      [3, 44, 6, 8, 7, 7, 8, 8, 5],
      {
        2: v => v >= 65 ? C.green : v >= 55 ? C.yellow : C.red,
        3: v => v > 0 ? C.green : C.red,
      },
    );

    // ── #1 Rule deep-dive ──
    const best = byPF[0];
    if (best) {
      console.log(`\n  ${C.bold}${C.cyan}═══ Best Rule (by Profit Factor) Deep Dive ═══${C.reset}`);
      info(`Name:           ${best.setup_name}`);
      info(`Direction:      ${best.direction || 'BUY'}`);
      info(`Win Rate:       ${C.bold}${(best.win_rate_pct || 0).toFixed(1)}%${C.reset}`);
      info(`Profit Factor:  ${C.bold}${(best.profit_factor || 0).toFixed(2)}${C.reset}`);
      info(`Expectancy:     ${(best.expectancy || 0).toFixed(3)}%`);
      info(`Sharpe:         ${(best.sharpe || 0).toFixed(4)}`);
      info(`Avg ROI:        ${(best.avg_roi_pct || 0).toFixed(3)}%`);
      info(`Avg Win:        ${C.green}+${(best.avg_win_roi || 0).toFixed(3)}%${C.reset}`);
      info(`Avg Loss:       ${C.red}${(best.avg_loss_roi || 0).toFixed(3)}%${C.reset}`);
      info(`Max Drawdown:   ${(best.max_drawdown || 0).toFixed(2)}%`);
      info(`Occurrences:    ${best.total_count} total (${best.win_count}W / ${best.loss_count}L)`);
      try {
        const conds = JSON.parse(best.conditions);
        info(`Conditions:`);
        for (const c of conds) {
          const desc = c.type === 'signal'
            ? `  • [SIGNAL] ${c.signalKey}`
            : `  • ${c.col} ${c.op} ${JSON.stringify(c.threshold)}`;
          info(desc);
        }
      } catch {}
    }
  } else {
    warn('No rules discovered. Need more closed signals with outcome data.');
    warn('Run again after market hours when more historical data is available.');
  }

  // ── Ingestion report ──
  if (!pipelineOnly) {
    console.log(`\n  ${C.bold}${C.magenta}═══ Ingestion Summary ═══${C.reset}`);
    const ingLines = [
      ['Symbols Processed', `${report.fetched + report.failed + report.skipped}/${total}`],
      ['Successful',        `${C.green}${report.fetched}${C.reset}`],
      ['Failed',            report.failed > 0 ? `${C.red}${report.failed}${C.reset}` : '0'],
      ['Skipped (resume)',  String(report.skipped)],
      ['Total Retries',     String(report.retries)],
      ['Total Bars',        report.totalBars.toLocaleString()],
      ['Total Signals',     report.totalSignals.toLocaleString()],
      ['Signals / Symbol',  report.fetched > 0 ? Math.round(report.totalSignals / report.fetched).toString() : 'N/A'],
      ['Bars / Symbol',     report.fetched > 0 ? Math.round(report.totalBars / report.fetched).toString() : 'N/A'],
    ];
    for (const [k, v] of ingLines) {
      console.log(`  ${C.dim}${k.padEnd(20)}${C.reset} ${v}`);
    }

    // ── Per-symbol failure list ──
    const failures = report.symbolDetails.filter(d => d.status === 'FAILED');
    if (failures.length > 0) {
      console.log(`\n  ${C.red}Failed symbols:${C.reset} ${failures.map(f => f.sym).join(', ')}`);
      info(`Re-run with: node scripts/train_bist100_3yr.js --symbols ${failures.map(f => f.sym).join(',')}`);
    }
  }

  // ── Timing ──
  console.log(`\n  ${C.bold}${C.magenta}═══ Timing ═══${C.reset}`);
  console.log(`  ${C.dim}Backfill:${C.reset}        ${formatDuration(backElapsed)}`);
  console.log(`  ${C.dim}Feature Rank:${C.reset}    ${formatDuration(featElapsed)}`);
  console.log(`  ${C.dim}Rule Discovery:${C.reset}  ${formatDuration(ruleElapsed)}`);
  console.log(`  ${C.bold}Total:${C.reset}           ${C.bold}${C.cyan}${formatDuration(totalElapsed)}${C.reset}`);

  // ── Memory ──
  const mem = process.memoryUsage();
  console.log(`\n  ${C.dim}Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}  |  RSS: ${formatBytes(mem.rss)}${C.reset}`);
  console.log(`  ${C.dim}DB:   ${DB_PATH}${C.reset}`);
  console.log();

  try { db.close(); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
main().catch(e => {
  console.error(`\n${C.red}${C.bold}FATAL:${C.reset} ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
