#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// train_bist30_1yr.js — PoC Training Script for BIST ML Engine
// ════════════════════════════════════════════════════════════════════
//
// Usage:
//   node scripts/train_bist30_1yr.js
//   node scripts/train_bist30_1yr.js --symbols THYAO,ASELS,GARAN
//   node scripts/train_bist30_1yr.js --skip-fetch   (use cached data)
//
// Pipeline:
//   1. Fetch 1yr daily OHLCV for BIST30 via Yahoo Finance
//   2. Slide a 100-bar window across each symbol's history
//   3. At each bar, run calcAll + genSignal → technical snapshot
//   4. Bulk-insert all signals into SQLite
//   5. Backfill T+1/T+3/T+5 actual ROI from future bars
//   6. Run feature importance + rule discovery
//   7. Print top rules in a formatted table
//
// Requires: better-sqlite3 (npm i better-sqlite3)
// ════════════════════════════════════════════════════════════════════

import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

// Helper: Windows absolute paths (C:\...) are invalid ESM specifiers.
// Node requires file:// URLs → pathToFileURL converts them correctly.
const imp = (relPath) => import(pathToFileURL(resolve(ROOT, relPath)).href);

// ── Dynamic imports (ESM compat with the src/ tree) ────────────────

const { calcAll }            = await imp('src/utils/indicators.js');
const { genSignal, extractFiredSignals } = await imp('src/utils/signals.js');
const { initMLDatabase }     = await imp('src/utils/DatabaseManager.js');
const {
  evaluateHistoricalSignals,
  runOutcomeBackfill,
  computeFeatureImportance,
  extractWinningRules,
  ingestScanResults,
} = await imp('src/utils/ML_BacktestEngine.js');

// ── BIST30 universe ───────────────────────────────────────────────

const BIST30 = [
  'AKBNK', 'ARCLK', 'ASELS', 'BIMAS', 'EKGYO', 'EREGL', 'FROTO',
  'GARAN', 'GUBRF', 'HEKTS', 'KCHOL', 'PETKM', 'PGSUS', 'SAHOL',
  'SISE',  'TAVHL', 'TCELL', 'THYAO', 'TOASO', 'TUPRS', 'VESTL',
  'YKBNK',
];

// ── CLI argument parsing ──────────────────────────────────────────

const args = process.argv.slice(2);
const flagIdx    = (f) => args.findIndex(a => a === f);
const flagVal    = (f) => { const i = flagIdx(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const skipFetch  = args.includes('--skip-fetch');
const symbolsArg = flagVal('--symbols');
const symbols    = symbolsArg ? symbolsArg.split(',').map(s => s.trim().toUpperCase()) : BIST30;

// ── Configuration ─────────────────────────────────────────────────

const LOOKBACK_BARS   = 100;    // min bars before we start generating signals
const YAHOO_RANGE     = '1y';
const YAHOO_INTERVAL  = '1d';
const FETCH_DELAY_MS  = 350;    // rate-limit gap between Yahoo requests
const FETCH_TIMEOUT   = 15000;
const MAX_CONCURRENT  = 3;      // parallel Yahoo requests
const DB_PATH         = resolve(ROOT, 'data', 'bist_ml_training.db');

// ── Fancy console helpers ─────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  magenta:'\x1b[35m',
  white:  '\x1b[37m',
  bgCyan: '\x1b[46m',
  bgGreen:'\x1b[42m',
};

function banner(text) {
  const line = '═'.repeat(64);
  console.log(`\n${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}\n`);
}

function step(n, text) {
  console.log(`${C.bold}${C.green}[STEP ${n}]${C.reset} ${text}`);
}

function info(text) {
  console.log(`${C.dim}  → ${text}${C.reset}`);
}

function warn(text) {
  console.log(`${C.yellow}  ⚠ ${text}${C.reset}`);
}

function err(text) {
  console.log(`${C.red}  ✗ ${text}${C.reset}`);
}

function ok(text) {
  console.log(`${C.green}  ✓ ${text}${C.reset}`);
}

// ════════════════════════════════════════════════════════════════════
// YAHOO FINANCE DATA FETCHER (Node.js native — no CORS issues)
// ════════════════════════════════════════════════════════════════════

async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.IS?range=${range}&interval=${interval}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v7/finance/chart/${symbol}.IS?range=${range}&interval=${interval}`,
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'tr-TR,tr;q=0.9',
  };

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) continue;
      const text = await res.text();
      const prices = parseYahooChart(text);
      if (prices && prices.length >= 50) return prices;
    } catch {
      continue; // try next URL
    }
  }

  return null;
}

function parseYahooChart(text) {
  try {
    const data = JSON.parse(text);
    const result = data?.chart?.result?.[0];
    if (!result?.timestamp || result.timestamp.length < 10) return null;

    const q = result.indicators?.quote?.[0];
    if (!q?.close) return null;

    const ts = result.timestamp;
    const prices = [];

    for (let i = 0; i < ts.length; i++) {
      const c = q.close[i];
      if (c == null || c <= 0) continue;

      let o = q.open[i] ?? c;
      let h = q.high[i] ?? c;
      let l = q.low[i] ?? c;
      h = Math.max(h, o, c);
      l = Math.min(l, o, c);
      if (h < l) continue;

      prices.push({
        date:   new Date(ts[i] * 1000),
        open:   o,
        high:   h,
        low:    l,
        close:  c,
        volume: q.volume[i] || 0,
      });
    }

    return prices.length >= 10 ? prices : null;
  } catch {
    return null;
  }
}

// ── Concurrency-limited batch fetcher ─────────────────────────────

async function fetchAllSymbols(syms) {
  const results = new Map();
  let completed = 0;
  const total = syms.length;

  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < syms.length; i += MAX_CONCURRENT) {
    const chunk = syms.slice(i, i + MAX_CONCURRENT);
    const promises = chunk.map(async (sym) => {
      const prices = await fetchYahoo(sym, YAHOO_RANGE, YAHOO_INTERVAL);
      completed++;
      const pct = ((completed / total) * 100).toFixed(0);
      if (prices) {
        info(`[${pct.padStart(3)}%] ${sym.padEnd(6)} → ${prices.length} bars (${prices[0].date.toISOString().slice(0, 10)} to ${prices[prices.length - 1].date.toISOString().slice(0, 10)})`);
      } else {
        warn(`[${pct.padStart(3)}%] ${sym.padEnd(6)} → FAILED (no data)`);
      }
      return [sym, prices];
    });

    const chunk_results = await Promise.all(promises);
    for (const [sym, prices] of chunk_results) {
      if (prices) results.set(sym, prices);
    }

    // Rate-limit delay between chunks
    if (i + MAX_CONCURRENT < syms.length) {
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    }
  }

  return results;
}


// ════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION — Sliding Window over Historical Bars
// ════════════════════════════════════════════════════════════════════
//
// For each symbol with N bars, we slide a window from bar[LOOKBACK] to bar[N-6].
// At each position we run calcAll+genSignal on the preceding bars, producing
// a signal snapshot. The last 5 bars are reserved for T+5 ROI measurement.

function generateHistoricalSignals(symbol, prices) {
  if (!prices || prices.length < LOOKBACK_BARS + 10) return [];

  const signals = [];
  // Reserve last 5 bars for T+5 outcome measurement
  const end = prices.length - 5;

  // Step every 3 bars to balance coverage vs speed (100+ signals per symbol is plenty)
  const STEP = 3;

  for (let i = LOOKBACK_BARS; i < end; i += STEP) {
    try {
      const window = prices.slice(0, i + 1); // bars [0..i]
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
                         ? ((ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL)) * 100
                         : null,
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
      // Skip bars where indicator calc fails (insufficient data edge cases)
      continue;
    }
  }

  return signals;
}


// ════════════════════════════════════════════════════════════════════
// PRETTY TABLE RENDERER
// ════════════════════════════════════════════════════════════════════

function printTable(headers, rows, widths) {
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const hdr = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');

  console.log(`  ┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐`);
  console.log(`  │${C.bold}${hdr}${C.reset}│`);
  console.log(`  ├${sep}┤`);

  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const str = String(cell);
      // Color-code win rate
      if (i === 2) { // win rate column
        const n = parseFloat(str);
        const color = n >= 65 ? C.green : n >= 55 ? C.yellow : C.red;
        return ` ${color}${str.padStart(widths[i])}${C.reset} `;
      }
      if (i === 3) { // expectancy column
        const n = parseFloat(str);
        const color = n > 0 ? C.green : C.red;
        return ` ${color}${str.padStart(widths[i])}${C.reset} `;
      }
      return ` ${str.padEnd(widths[i]).slice(0, widths[i])} `;
    });
    console.log(`  │${cells.join('│')}│`);
  }

  console.log(`  └${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘`);
}

function printStatsTable(stats) {
  console.log(`\n  ${C.bold}${C.magenta}Database Stats${C.reset}`);
  const entries = [
    ['Total Signals', String(stats.total || 0)],
    ['Closed',        String(stats.closed || 0)],
    ['Wins (T+1>0)', String(stats.wins || 0)],
    ['Win Rate',      stats.closed > 0 ? ((stats.wins / stats.closed) * 100).toFixed(1) + '%' : 'N/A'],
    ['Avg T+1 ROI',   stats.avg_t1 != null ? stats.avg_t1.toFixed(2) + '%' : 'N/A'],
    ['Avg T+3 ROI',   stats.avg_t3 != null ? stats.avg_t3.toFixed(2) + '%' : 'N/A'],
  ];
  for (const [k, v] of entries) {
    console.log(`  ${C.dim}${k.padEnd(18)}${C.reset} ${C.bold}${v}${C.reset}`);
  }
}


// ════════════════════════════════════════════════════════════════════
// MAIN — Orchestrate the full training pipeline
// ════════════════════════════════════════════════════════════════════

async function main() {
  const t0 = performance.now();

  banner('BIST ML Engine — Training Pipeline (PoC)');
  info(`Symbols: ${symbols.length} (${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '...' : ''})`);
  info(`DB Path: ${DB_PATH}`);
  info(`Date:    ${new Date().toISOString().slice(0, 19)}`);
  console.log();

  // ── Step 0: Ensure data directory exists ─────────────────────
  const fs = await import('node:fs');
  const dataDir = resolve(ROOT, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    info(`Created ${dataDir}`);
  }

  // ── Step 1: Initialize Database ──────────────────────────────
  step(1, 'Initializing SQLite database...');
  let db;
  try {
    db = await initMLDatabase(DB_PATH);
    ok(`Database ready (${db.isNode ? 'better-sqlite3' : 'browser fallback'})`);
  } catch (e) {
    err(`Database init failed: ${e.message}`);
    err('Have you installed better-sqlite3? Run: npm install better-sqlite3');
    process.exit(1);
  }

  // ── Step 2: Fetch 1yr OHLCV data ────────────────────────────
  step(2, `Fetching 1-year daily data for ${symbols.length} symbols...`);
  const tFetch = performance.now();
  let allPrices;

  if (skipFetch) {
    warn('--skip-fetch: Using cached data (not implemented in PoC, fetching anyway)');
  }

  allPrices = await fetchAllSymbols(symbols);
  const fetchElapsed = ((performance.now() - tFetch) / 1000).toFixed(1);
  ok(`Fetched ${allPrices.size}/${symbols.length} symbols in ${fetchElapsed}s`);
  if (allPrices.size === 0) {
    err('No data fetched. Check your internet connection or Yahoo Finance availability.');
    process.exit(1);
  }
  console.log();

  // ── Step 3: Generate historical signals ──────────────────────
  step(3, 'Generating signals via sliding window (calcAll + genSignal)...');
  const tGen = performance.now();
  let totalSignals = 0;
  const perSymbolCounts = [];

  for (const [sym, prices] of allPrices) {
    try {
      const signals = generateHistoricalSignals(sym, prices);
      if (signals.length > 0) {
        const inserted = db.insertSignals(signals);
        totalSignals += inserted;
        perSymbolCounts.push({ sym, bars: prices.length, signals: signals.length, inserted });
      } else {
        perSymbolCounts.push({ sym, bars: prices.length, signals: 0, inserted: 0 });
      }
    } catch (e) {
      warn(`${sym}: Signal generation failed — ${e.message}`);
      perSymbolCounts.push({ sym, bars: 0, signals: 0, inserted: 0, error: e.message });
    }
  }

  const genElapsed = ((performance.now() - tGen) / 1000).toFixed(1);
  ok(`Generated ${totalSignals} signals in ${genElapsed}s`);

  // Mini summary per symbol
  const topGen = perSymbolCounts
    .filter(x => x.signals > 0)
    .sort((a, b) => b.signals - a.signals)
    .slice(0, 8);
  if (topGen.length > 0) {
    info(`Top generators: ${topGen.map(x => `${x.sym}(${x.signals})`).join(', ')}`);
  }

  const failCount = perSymbolCounts.filter(x => x.error || x.signals === 0).length;
  if (failCount > 0) {
    warn(`${failCount} symbols produced zero signals`);
  }
  console.log();

  // ── Step 4: Backfill T+1/T+3/T+5 ROI outcomes ──────────────
  step(4, 'Evaluating signal outcomes (T+1/T+3/T+5 ROI backfill)...');
  const tBack = performance.now();

  const backfillResult = runOutcomeBackfill(db, allPrices);
  const backElapsed = ((performance.now() - tBack) / 1000).toFixed(1);
  ok(`Backfilled ${backfillResult.evaluated} signals: ${C.green}${backfillResult.wins}W${C.reset} / ${C.red}${backfillResult.losses}L${C.reset} (${backElapsed}s)`);
  console.log();

  // ── Step 5: Feature importance ──────────────────────────────
  step(5, 'Computing feature importance (information gain + correlation)...');
  const tFeat = performance.now();

  const features = computeFeatureImportance(db, 'BUY');
  const featElapsed = ((performance.now() - tFeat) / 1000).toFixed(1);
  ok(`Ranked ${features.length} features in ${featElapsed}s`);

  if (features.length > 0) {
    console.log(`\n  ${C.bold}${C.magenta}Top 10 Predictive Features${C.reset}`);
    const fHeaders = ['#', 'Feature', 'Info Gain', 'Corr', 'WinRate', 'AvgROI', 'N'];
    const fWidths  = [3, 30, 10, 8, 8, 8, 6];
    const fRows = features.slice(0, 10).map((f, i) => [
      String(i + 1),
      f.name,
      f.infoGain.toFixed(4),
      (f.correlation || 0).toFixed(4),
      ((f.winRate || 0) * 100).toFixed(1) + '%',
      (f.avgRoi || 0).toFixed(2) + '%',
      String(f.sampleCount || 0),
    ]);
    printTable(fHeaders, fRows, fWidths);
  }
  console.log();

  // ── Step 6: Rule discovery ──────────────────────────────────
  step(6, 'Discovering winning rule combinations...');
  const tRule = performance.now();

  const rules = extractWinningRules(db, {
    topK: 15,
    minOccurrences: Math.max(8, Math.floor(totalSignals * 0.02)), // adaptive: 2% of signals or 8
    maxDepth: 3,
    direction: 'BUY',
  });
  const ruleElapsed = ((performance.now() - tRule) / 1000).toFixed(1);
  ok(`Discovered ${rules.length} rules in ${ruleElapsed}s`);

  if (rules.length > 0) {
    // ── TOP 5 RULES TABLE ──
    console.log(`\n  ${C.bold}${C.bgGreen}${C.white} TOP 5 DISCOVERED RULES ${C.reset}\n`);

    const rHeaders = ['#', 'Setup Name', 'WinRate%', 'Expect%', 'Sharpe', 'PF', 'Count'];
    const rWidths  = [3, 44, 8, 8, 7, 6, 6];
    const top5 = rules.slice(0, 5);
    const rRows = top5.map((r, i) => [
      String(i + 1),
      r.setup_name || r.setupName,
      (r.win_rate_pct || 0).toFixed(1),
      (r.expectancy || 0).toFixed(2),
      (r.sharpe || 0).toFixed(3),
      (r.profit_factor || 0).toFixed(1),
      String(r.total_count || 0),
    ]);
    printTable(rHeaders, rRows, rWidths);

    // Print detail breakdown for #1 rule
    const best = top5[0];
    if (best) {
      console.log(`\n  ${C.bold}Best Rule Detail:${C.reset}`);
      info(`Name:           ${best.setup_name}`);
      info(`Win Rate:       ${C.bold}${(best.win_rate_pct || 0).toFixed(1)}%${C.reset}`);
      info(`Avg ROI:        ${(best.avg_roi_pct || 0).toFixed(2)}%`);
      info(`Avg Win ROI:    ${C.green}+${(best.avg_win_roi || 0).toFixed(2)}%${C.reset}`);
      info(`Avg Loss ROI:   ${C.red}${(best.avg_loss_roi || 0).toFixed(2)}%${C.reset}`);
      info(`Expectancy:     ${(best.expectancy || 0).toFixed(2)}%`);
      info(`Sharpe:         ${(best.sharpe || 0).toFixed(3)}`);
      info(`Profit Factor:  ${(best.profit_factor || 0).toFixed(2)}`);
      info(`Max Drawdown:   ${(best.max_drawdown || 0).toFixed(2)}%`);
      info(`Occurrences:    ${best.total_count} (${best.win_count}W / ${best.loss_count}L)`);
      try {
        const conds = JSON.parse(best.conditions);
        info(`Conditions:     ${conds.map(c => `${c.name}`).join(' AND ')}`);
      } catch {}
    }

    // ── Extended: top 20 rules compact ──
    if (rules.length > 5) {
      console.log(`\n  ${C.dim}Extended (6-20):${C.reset}`);
      const ext = rules.slice(5, 20);
      for (let i = 0; i < ext.length; i++) {
        const r = ext[i];
        const wr = (r.win_rate_pct || 0).toFixed(1);
        const ex = (r.expectancy || 0).toFixed(2);
        const cnt = r.total_count || 0;
        const color = r.win_rate_pct >= 60 ? C.green : r.win_rate_pct >= 50 ? C.yellow : C.dim;
        console.log(`  ${C.dim}${String(i + 6).padStart(3)}.${C.reset} ${color}${(r.setup_name || '').padEnd(46)}${C.reset} WR:${wr}% Exp:${ex}% (n=${cnt})`);
      }
    }
  } else {
    warn('No rules discovered — need more data. Try running with more symbols or longer history.');
  }

  // ── Final stats ─────────────────────────────────────────────
  const stats = db.getStats();
  printStatsTable(stats);

  // ── Timing summary ──────────────────────────────────────────
  const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);

  banner('Pipeline Complete');
  console.log(`  ${C.bold}Timing Breakdown${C.reset}`);
  console.log(`  ${C.dim}Data Fetch:${C.reset}       ${fetchElapsed}s`);
  console.log(`  ${C.dim}Signal Gen:${C.reset}       ${genElapsed}s`);
  console.log(`  ${C.dim}ROI Backfill:${C.reset}     ${backElapsed}s`);
  console.log(`  ${C.dim}Feature Rank:${C.reset}     ${featElapsed}s`);
  console.log(`  ${C.dim}Rule Discovery:${C.reset}   ${ruleElapsed}s`);
  console.log(`  ${C.bold}Total:${C.reset}            ${C.bold}${C.cyan}${totalElapsed}s${C.reset}`);
  console.log(`\n  ${C.dim}Database: ${DB_PATH}${C.reset}`);
  console.log(`  ${C.dim}Signals:  ${stats.total || 0} total, ${stats.closed || 0} with outcomes${C.reset}`);
  console.log(`  ${C.dim}Rules:    ${rules.length} discovered${C.reset}`);
  console.log();

  // Cleanup
  try { db.close(); } catch {}
}

// ── Entry point ───────────────────────────────────────────────────

main().catch(e => {
  console.error(`\n${C.red}${C.bold}FATAL:${C.reset} ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
