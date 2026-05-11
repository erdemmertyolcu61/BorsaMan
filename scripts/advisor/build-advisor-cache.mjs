#!/usr/bin/env node
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fetchSingle } from '../../src/utils/fetchEngine.js';
import { genSignal } from '../../src/utils/signals.js';
import { calcAll } from '../../src/utils/indicators.js';
import { getStockList, SECTORS } from '../../src/utils/constants.js';
import { calcSectorMetrics, rankSectors } from '../../src/utils/sectorEngine.js';

const DEFAULTS = {
  universe: 'bistall',
  out: 'reports/advisor/latest.json',
  range: '6mo',
  interval: '1d',
  concurrency: 4,
  delayMs: 350,
  maxSymbols: null,
  progress: '',
  dryRun: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--universe') { args.universe = next || args.universe; i += 1; }
    else if (key === '--out') { args.out = next || args.out; i += 1; }
    else if (key === '--range') { args.range = next || args.range; i += 1; }
    else if (key === '--interval') { args.interval = next || args.interval; i += 1; }
    else if (key === '--concurrency') { args.concurrency = Math.max(1, Number(next) || args.concurrency); i += 1; }
    else if (key === '--delay-ms') { args.delayMs = Math.max(0, Number(next) || 0); i += 1; }
    else if (key === '--max-symbols') { args.maxSymbols = Math.max(0, Number(next) || 0); i += 1; }
    else if (key === '--progress') { args.progress = next || ''; i += 1; }
    else if (key === '--dry-run') { args.dryRun = true; }
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function isMarketOpen(date = new Date()) {
  const parts = istanbulParts(date);
  const weekday = String(parts.weekday).toLowerCase();
  if (weekday.startsWith('sat') || weekday.startsWith('sun')) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 570 && minutes < 750) || (minutes >= 840 && minutes < 1050);
}

function calcTomorrowPotential(result) {
  if (!result) return 0;
  let score = 0;
  if (result.bollPct != null) {
    if (result.bollPct < 20) score += 15;
    else if (result.bollPct < 40) score += 8;
    else if (result.bollPct > 80) score -= 10;
  }
  if (result.volRatio) {
    if (result.volRatio > 2) score += 12;
    else if (result.volRatio > 1.5) score += 8;
    else if (result.volRatio > 1.2) score += 4;
  }
  if (result.stopPct != null) {
    const riskPct = Math.abs(result.stopPct);
    if (riskPct < 3) score += 10;
    else if (riskPct < 5) score += 5;
  }
  if (result.momentumScore) score += Math.min(15, result.momentumScore * 0.2);
  if (result.ichimoku?.cloudPosition === 'above') score += 5;
  if (result.supertrend?.trend === 'UP') score += 5;
  if (result.ichimoku?.tkCross === 'bullish') score += 8;
  if (result.supertrend?.flip === 'bullish') score += 8;
  if (result.rr >= 2.5) score += 10;
  else if (result.rr >= 2) score += 6;
  else if (result.rr >= 1.5) score += 3;
  if (result.obvTrend === 'accumulation') score += 8;
  if (result.cmf > 0.1) score += 5;
  score += Math.min(15, (result.score || 0) * 0.2);
  return Math.max(0, Math.min(100, score));
}

async function scanSymbol(symbol, range, interval) {
  const data = await fetchSingle(symbol, range, interval, true);
  if (!data?.prices || data.prices.length < 20) return null;
  const ind = calcAll(data.prices);
  const sig = genSignal(ind, data.prices);
  const last = data.prices[data.prices.length - 1];
  const prev = data.prices[data.prices.length - 2] || last;
  const change = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const finalScore = Number(sig.score) || 50;

  return {
    symbol,
    sector: SECTORS[symbol] || 'Diger',
    price: ind.lastClose,
    change: ind.changePct ?? change,
    volume: last.volume,
    signal: sig.signal,
    cls: sig.cls,
    score: finalScore,
    momentumScore: ind.momentumScore || 0,
    conf: Number(sig.conf) || 0,
    rsi: ind.lastRSI,
    adx: ind.adx,
    mfi: ind.mfi,
    cmf: ind.cmf,
    volRatio: ind.volRatio,
    obvTrend: ind.obvTrend,
    obvDivergence: ind.obvDivergence,
    rsiDivergence: ind.rsiDivergence,
    wyckoff: ind.wyckoffPhase,
    wyckoffSpring: ind.wyckoffSpring,
    volumeClimax: ind.volumeClimax,
    entry: sig.entry,
    stop: sig.stop,
    target: sig.t1,
    targetT2: sig.t2,
    targetT3: sig.t3,
    rr: Number(sig.rr) || 0,
    rrQuality: sig.rrQuality,
    holdText: sig.holdText,
    longTermView: sig.longTermView,
    stopPct: sig.stop && sig.entry ? ((sig.stop - sig.entry) / sig.entry) * 100 : 0,
    targetPct: sig.t1 && sig.entry ? ((sig.t1 - sig.entry) / sig.entry) * 100 : 0,
    gapPct: ind.gapPct,
    gapUp: ind.gapUp,
    momentumIntraday: ind.momentumIntraday,
    volumeSurge: ind.volumeSurge,
    orBreakout: ind.orBreakout,
    ichimoku: ind.ichimoku ? {
      tkCross: ind.ichimoku.tkCross,
      kumoBreakout: ind.ichimoku.kumoBreakout,
      kumoTwist: ind.ichimoku.kumoTwist,
      cloudPosition: ind.ichimoku.cloudPosition,
    } : null,
    supertrend: ind.supertrend ? {
      trend: ind.supertrend.trend,
      flip: ind.supertrend.flip,
      value: ind.supertrend.value,
    } : null,
    trixCrossover: ind.trix?.crossover || null,
    williamsR: ind.lastWilliamsR,
    roc10: ind.lastROC10,
    bollPct: ind.lastBU && ind.lastBL ? (ind.lastClose - ind.lastBL) / (ind.lastBU - ind.lastBL) * 100 : null,
    volumeProfilePOC: ind.volumeProfile?.poc || null,
    source: data.source,
    dataConfidence: data.dataConfidence,
  };
}

function buildPayload(results, failures, symbols, args, startedAt, scanMode) {
  const buys = results.filter(r => r.cls === 'buy').length;
  const sells = results.filter(r => r.cls === 'sell').length;
  const accumulations = results.filter(r => r.obvTrend === 'accumulation').length;
  const avgRSI = results.length ? results.reduce((sum, r) => sum + (r.rsi || 50), 0) / results.length : 50;
  const pctBull = results.length ? buys / results.length : 0.5;
  let sentiment = 'NOTR';
  let color = 'var(--yellow)';
  if (pctBull > 0.55) { sentiment = 'YUKSELIS'; color = 'var(--green)'; }
  else if (pctBull < 0.25) { sentiment = 'DUSUS'; color = 'var(--red)'; }
  else if (pctBull < 0.35) { sentiment = 'TEMKINLI'; color = 'var(--orange)'; }

  const sectorMetrics = calcSectorMetrics(results);
  const sectorRotation = rankSectors(sectorMetrics).slice(0, 8).map(s => ({
    sector: s.sector,
    avgScore: s.avgScore,
    total: s.scanned,
    strength: s.strength,
    rotation: s.rotation,
  }));
  const isAfterHours = scanMode === 'afterHours';
  const topPicks = results
    .filter(r => {
      const isBuy = r.cls === 'buy';
      if (isAfterHours) {
        const hasSetup = isBuy && r.score >= 60 && r.rr >= 1.5;
        const hasTrend = (r.ichimoku?.cloudPosition === 'above') || (r.supertrend?.trend === 'UP');
        return hasSetup || (hasTrend && isBuy && r.score >= 55 && r.rr >= 1.2);
      }
      const hasTraditionalSignal = isBuy && r.score >= 60 && r.rr >= 1.5;
      const hasMomentumBoost = r.momentumScore >= 50 && (r.change || 0) > 0 && r.score >= 55;
      return hasTraditionalSignal || hasMomentumBoost;
    })
    .map(r => ({
      ...r,
      tomorrowPotential: isAfterHours ? calcTomorrowPotential(r) : 0,
      _alreadyHolding: false,
      _scanMode: isAfterHours ? 'afterHours' : 'intraday',
    }))
    .sort((a, b) => {
      if (isAfterHours) return (b.tomorrowPotential || 0) - (a.tomorrowPotential || 0);
      return ((b.score || 0) + ((b.momentumScore || 0) * 0.2)) - ((a.score || 0) + ((a.momentumScore || 0) * 0.2));
    })
    .slice(0, 10);

  const updatedAt = new Date().toISOString();
  return {
    ready: true,
    version: 1,
    updatedAt,
    ts: Date.parse(updatedAt),
    durationMs: Math.round(performance.now() - startedAt),
    universe: args.universe,
    scanMode,
    totalSymbols: symbols.length,
    scanned: results.length,
    failed: failures.length,
    topPicks,
    scanResults: results,
    marketSentiment: {
      sentiment,
      color,
      buys,
      sells,
      scanned: results.length,
      avgRSI,
      accumulations,
      sectorRotation,
    },
    sectorHeatmap: sectorMetrics,
    failures: failures.slice(0, 50),
  };
}

async function atomicWriteJson(path, payload) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, out);
}

async function writeProgress(args, patch) {
  if (!args.progress || args.dryRun) return;
  await atomicWriteJson(args.progress, {
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allSymbols = getStockList(args.universe);
  const symbols = args.maxSymbols === null ? allSymbols : allSymbols.slice(0, args.maxSymbols);
  const startedAt = performance.now();
  const scanMode = isMarketOpen() ? 'intraday' : 'afterHours';
  const results = [];
  const failures = [];
  const startedIso = new Date().toISOString();

  await writeProgress(args, {
    ready: false,
    running: true,
    phase: 'starting',
    universe: args.universe,
    scanMode,
    done: 0,
    total: symbols.length,
    ok: 0,
    failed: 0,
    pct: 0,
    startedAt: startedIso,
  });

  for (let i = 0; i < symbols.length; i += args.concurrency) {
    const chunk = symbols.slice(i, i + args.concurrency);
    await writeProgress(args, {
      ready: false,
      running: true,
      phase: 'scan',
      universe: args.universe,
      scanMode,
      done: i,
      total: symbols.length,
      ok: results.length,
      failed: failures.length,
      current: chunk,
      pct: symbols.length ? Math.round((i / symbols.length) * 1000) / 10 : 0,
      startedAt: startedIso,
    });
    const chunkResults = await Promise.all(chunk.map(async symbol => {
      try {
        return await scanSymbol(symbol, args.range, args.interval);
      } catch (error) {
        failures.push({ symbol, message: error?.message || String(error) });
        return null;
      }
    }));
    for (const result of chunkResults) {
      if (result) results.push(result);
    }
    const done = Math.min(symbols.length, i + chunk.length);
    await writeProgress(args, {
      ready: false,
      running: true,
      phase: 'scan',
      universe: args.universe,
      scanMode,
      done,
      total: symbols.length,
      ok: results.length,
      failed: failures.length,
      pct: symbols.length ? Math.round((done / symbols.length) * 1000) / 10 : 100,
      startedAt: startedIso,
    });
    if (i + args.concurrency < symbols.length && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  const payload = buildPayload(results, failures, symbols, args, startedAt, scanMode);
  if (!args.dryRun) {
    await atomicWriteJson(args.out, payload);
    await writeProgress(args, {
      ready: true,
      running: false,
      phase: 'done',
      universe: args.universe,
      scanMode,
      done: symbols.length,
      total: symbols.length,
      ok: results.length,
      failed: failures.length,
      pct: 100,
      topPicks: payload.topPicks.length,
      durationMs: payload.durationMs,
      startedAt: startedIso,
      finishedAt: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify({
    out: args.dryRun ? '<dry-run>' : resolve(args.out),
    universe: args.universe,
    scanMode,
    totalSymbols: symbols.length,
    scanned: payload.scanned,
    failed: payload.failed,
    topPicks: payload.topPicks.length,
    durationMs: payload.durationMs,
  }));
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
