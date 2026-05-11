#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calcBacktestStats, runBacktest } from '../../src/utils/backtestEngine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function toNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  let s = String(value).trim().replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function numberList(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map(v => toNumber(v.trim(), null))
    .filter(v => v != null);
}

function stringList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function absFromRoot(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(ROOT, value);
}

function symbolFromFile(file) {
  const base = path.basename(file, path.extname(file));
  return base.split('__')[0].replace(/\.IS$/i, '').toUpperCase();
}

function getGitMeta() {
  const runGit = args => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };

  const status = runGit(['status', '--porcelain']);
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (commitSha || branch) {
    return {
      commitSha: commitSha || 'unknown',
      shortSha: commitSha ? commitSha.slice(0, 7) : 'unknown',
      branch: branch || 'unknown',
      dirty: status.length > 0,
    };
  }

  const direct = readGitMetaDirect();
  if (direct.commitSha !== 'unknown' || direct.branch !== 'unknown') return direct;

  return {
    commitSha: 'unknown',
    shortSha: 'unknown',
    branch: 'unknown',
    dirty: 'unknown',
  };
}

function readGitMetaDirect() {
  try {
    const gitDir = path.join(ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) {
      return { commitSha: head || 'unknown', shortSha: head.slice(0, 7) || 'unknown', branch: 'detached', dirty: 'unknown' };
    }

    const ref = head.replace(/^ref:\s*/, '');
    const branch = ref.replace(/^refs\/heads\//, '');
    let commitSha = '';
    const refPath = path.join(gitDir, ...ref.split('/'));
    if (fs.existsSync(refPath)) {
      commitSha = fs.readFileSync(refPath, 'utf8').trim();
    } else {
      const packed = path.join(gitDir, 'packed-refs');
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
          if (line.endsWith(` ${ref}`)) {
            commitSha = line.split(' ')[0];
            break;
          }
        }
      }
    }

    return {
      commitSha: commitSha || 'unknown',
      shortSha: commitSha ? commitSha.slice(0, 7) : 'unknown',
      branch,
      dirty: 'unknown',
    };
  } catch {
    return { commitSha: 'unknown', shortSha: 'unknown', branch: 'unknown', dirty: 'unknown' };
  }
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeRng(seed) {
  let state = hashString(String(seed)).split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function splitDelimited(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  cells.push(current.trim());
  return cells;
}

function canonicalHeader(value) {
  return String(value || '')
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function indexFor(headers, aliases, fallback) {
  const normalized = headers.map(canonicalHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return fallback;
}

function parseCsv(text, symbol) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const first = lines[0];
  const delimiter = (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? ';' : ',';
  const firstCells = splitDelimited(first, delimiter);
  const hasHeader = firstCells.some(cell => /[a-zA-Z]/.test(cell));
  const headers = hasHeader ? firstCells : ['date', 'open', 'high', 'low', 'close', 'volume'];
  const startLine = hasHeader ? 1 : 0;

  const idx = {
    date: indexFor(headers, ['date', 'datetime', 'time', 'tarih'], 0),
    open: indexFor(headers, ['open', 'o', 'acilis'], 1),
    high: indexFor(headers, ['high', 'h', 'yuksek'], 2),
    low: indexFor(headers, ['low', 'l', 'dusuk'], 3),
    close: indexFor(headers, ['close', 'c', 'kapanis', 'last', 'adjclose'], 4),
    volume: indexFor(headers, ['volume', 'vol', 'v', 'hacim'], 5),
  };

  return lines.slice(startLine)
    .map(line => splitDelimited(line, delimiter))
    .map(row => normalizeBar({
      symbol,
      date: row[idx.date],
      open: row[idx.open],
      high: row[idx.high],
      low: row[idx.low],
      close: row[idx.close],
      volume: row[idx.volume],
    }))
    .filter(Boolean);
}

function normalizeBar(raw) {
  const close = toNumber(raw.close, null);
  if (close == null || close <= 0) return null;

  const open = toNumber(raw.open, close);
  const high = toNumber(raw.high, Math.max(open, close));
  const low = toNumber(raw.low, Math.min(open, close));

  return {
    symbol: raw.symbol,
    date: normalizeDate(raw.date),
    open,
    high,
    low,
    close,
    volume: Math.max(0, toNumber(raw.volume, 0)),
  };
}

function normalizeDate(value) {
  const s = String(value || '').trim();
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    if (!iso[4]) return date;
    return `${date}T${iso[4].padStart(2, '0')}:${iso[5]}:${iso[6] || '00'}`;
  }

  const tr = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (tr) {
    const date = `${tr[3]}-${tr[2].padStart(2, '0')}-${tr[1].padStart(2, '0')}`;
    if (!tr[4]) return date;
    return `${date}T${tr[4].padStart(2, '0')}:${tr[5]}:${tr[6] || '00'}`;
  }

  return s.slice(0, 10);
}

function loadPriceFile(file) {
  const ext = path.extname(file).toLowerCase();
  const symbol = symbolFromFile(file);
  const text = fs.readFileSync(file, 'utf8');
  let prices = [];

  if (ext === '.csv' || ext === '.txt') {
    prices = parseCsv(text, symbol);
  } else if (ext === '.json') {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? parsed : parsed.prices || parsed.data || [];
    prices = source.map(row => normalizeBar({ symbol, ...row })).filter(Boolean);
  }

  const byDate = new Map();
  for (const p of prices) {
    if (p.date) byDate.set(p.date, p);
  }

  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(csv|txt|json)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function makeFolds(prices, cfg) {
  const folds = [];

  if (cfg.randomTrials > 0) {
    const rng = makeRng(`${cfg.seed}:${prices[0]?.symbol || ''}:${prices[0]?.date || ''}`);
    const windowDays = Math.min(prices.length, cfg.windowDays);
    for (let i = 0; i < cfg.randomTrials; i++) {
      const maxStart = Math.max(0, prices.length - windowDays);
      const start = maxStart === 0 ? 0 : Math.floor(rng() * (maxStart + 1));
      const slice = prices.slice(start, start + windowDays);
      folds.push({
        name: `r${String(i + 1).padStart(4, '0')}`,
        prices: slice,
        startDate: slice[0]?.date || '',
        endDate: slice[slice.length - 1]?.date || '',
      });
    }
  } else if (cfg.fullHistory || prices.length <= cfg.foldDays) {
    folds.push({
      name: 'full',
      prices,
      startDate: prices[0]?.date || '',
      endDate: prices[prices.length - 1]?.date || '',
    });
  } else {
    for (let start = 0; start + cfg.foldDays <= prices.length; start += cfg.stepDays) {
      const slice = prices.slice(start, start + cfg.foldDays);
      folds.push({
        name: `f${folds.length + 1}`,
        prices: slice,
        startDate: slice[0]?.date || '',
        endDate: slice[slice.length - 1]?.date || '',
      });
    }

    const lastStart = Math.max(0, prices.length - cfg.foldDays);
    const last = folds[folds.length - 1];
    if (!last || last.startDate !== prices[lastStart]?.date) {
      const slice = prices.slice(lastStart);
      folds.push({
        name: `f${folds.length + 1}`,
        prices: slice,
        startDate: slice[0]?.date || '',
        endDate: slice[slice.length - 1]?.date || '',
      });
    }
  }

  if (cfg.oosDays > 0 && prices.length >= cfg.oosDays + 80) {
    const slice = prices.slice(prices.length - cfg.oosDays);
    folds.push({
      name: 'oos',
      prices: slice,
      startDate: slice[0]?.date || '',
      endDate: slice[slice.length - 1]?.date || '',
    });
  }

  return folds;
}

function makeVariants(cfg) {
  const variants = [];
  for (const strategy of cfg.strategies) {
    for (const maxHold of cfg.maxHolds) {
      for (const fallbackStopPct of cfg.stops) {
        for (const fallbackTargetPct of cfg.targets) {
          for (const costPct of cfg.costs) {
            if (strategy === 'signal') {
              for (const signalThreshold of cfg.thresholds) {
                for (const minRR of cfg.minRRs) {
                  variants.push({
                    name: `signal_s${signalThreshold}_rr${minRR}_h${maxHold}_sl${fallbackStopPct}_tp${fallbackTargetPct}_c${costPct}`,
                    id: hashString(`signal:${signalThreshold}:${minRR}:${maxHold}:${fallbackStopPct}:${fallbackTargetPct}:${costPct}`),
                    options: {
                      strategy,
                      signalThreshold,
                      minRR,
                      requireBuyClass: !cfg.looseSignal,
                      maxHold,
                      fallbackStopPct,
                      fallbackTargetPct,
                      costPct,
                    },
                  });
                }
              }
            } else if (strategy === 'rsi') {
              for (const rsiOversold of cfg.rsiLevels) {
                variants.push({
                  name: `rsi_${rsiOversold}_h${maxHold}_sl${fallbackStopPct}_tp${fallbackTargetPct}_c${costPct}`,
                  id: hashString(`rsi:${rsiOversold}:${maxHold}:${fallbackStopPct}:${fallbackTargetPct}:${costPct}`),
                  options: { strategy, rsiOversold, maxHold, fallbackStopPct, fallbackTargetPct, costPct },
                });
              }
            } else {
              variants.push({
                name: `${strategy}_h${maxHold}_sl${fallbackStopPct}_tp${fallbackTargetPct}_c${costPct}`,
                id: hashString(`${strategy}:${maxHold}:${fallbackStopPct}:${fallbackTargetPct}:${costPct}`),
                options: { strategy, maxHold, fallbackStopPct, fallbackTargetPct, costPct },
              });
            }
          }
        }
      }
    }
  }
  return variants;
}

function mean(values) {
  const xs = values.filter(v => Number.isFinite(Number(v))).map(Number);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(values) {
  const xs = values.filter(v => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function percentile(values, pct) {
  const xs = values.filter(v => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((pct / 100) * xs.length) - 1));
  return xs[idx];
}

function aggregateRows(rows, cfg) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.variantId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()].map(([variantId, group]) => {
    const eligible = group.filter(row => row.closedTrades >= cfg.minTrades);
    const sample = eligible.length ? eligible : group;
    const returns = sample.map(row => row.balanceReturnPct);
    const closed = sample.map(row => row.closedTrades);
    const pfs = sample.map(row => row.profitFactor).filter(v => Number.isFinite(v) && v < 90);
    const randomRows = sample.filter(row => String(row.fold).startsWith('r'));
    const rollingRows = sample.filter(row => String(row.fold).startsWith('f'));
    const oosRows = sample.filter(row => row.fold === 'oos');
    const positiveRows = sample.filter(row => row.balanceReturnPct > 0);
    const row0 = sample[0] || group[0] || {};

    const summary = {
      botId: cfg.botId,
      variantId,
      strategy: row0.strategy || '',
      variant: row0.variant || '',
      samples: sample.length,
      eligibleSamples: eligible.length,
      symbols: new Set(sample.map(row => row.symbol)).size,
      folds: new Set(sample.map(row => row.fold)).size,
      closedTrades: closed.reduce((a, b) => a + b, 0),
      avgClosedTrades: round(mean(closed), 2),
      avgWinRate: round(mean(sample.map(row => row.winRate))),
      avgPayoff: round(mean(sample.map(row => row.payoff))),
      avgExpectancy: round(mean(sample.map(row => row.expectancy))),
      avgProfitFactor: round(mean(pfs)),
      medianReturnPct: round(median(returns)),
      avgReturnPct: round(mean(returns)),
      p10ReturnPct: round(percentile(returns, 10)),
      p90ReturnPct: round(percentile(returns, 90)),
      positiveRatePct: round((positiveRows.length / Math.max(1, sample.length)) * 100),
      worstDrawdownPct: round(Math.max(...sample.map(row => row.balanceMaxDrawdownPct), 0)),
      avgDrawdownPct: round(mean(sample.map(row => row.balanceMaxDrawdownPct))),
      avgScore: round(mean(sample.map(row => row.score))),
      randomAvgReturnPct: round(mean(randomRows.map(row => row.balanceReturnPct))),
      rollingAvgReturnPct: round(mean(rollingRows.map(row => row.balanceReturnPct))),
      oosAvgReturnPct: round(mean(oosRows.map(row => row.balanceReturnPct))),
      randomSamples: randomRows.length,
      rollingSamples: rollingRows.length,
      oosSamples: oosRows.length,
    };

    summary.robustnessScore = round(
      summary.medianReturnPct * 2 +
      summary.avgExpectancy * 8 +
      Math.min(summary.avgProfitFactor, 5) * 8 +
      (summary.positiveRatePct - 50) * 0.4 -
      summary.worstDrawdownPct * 0.8 +
      Math.min(summary.avgClosedTrades, 20) * 0.6
    );
    return summary;
  }).sort((a, b) => b.robustnessScore - a.robustnessScore);
}

function qualityScore(stats, minTrades) {
  const closedCount = stats.closed.length;
  const tradePenalty = closedCount < minTrades ? (minTrades - closedCount) * 12 : 0;
  const pf = Math.min(Number.isFinite(stats.profitFactor) ? stats.profitFactor : 0, 5);
  const sharpe = clamp(Number.isFinite(stats.sharpeRatio) ? stats.sharpeRatio : 0, -5, 5);
  const sortino = clamp(Number.isFinite(stats.sortinoRatio) ? stats.sortinoRatio : 0, -5, 5);
  const calmar = clamp(Number.isFinite(stats.calmarRatio) ? stats.calmarRatio : 0, -5, 10);
  return (
    stats.expectancy * 12 +
    pf * 10 +
    (stats.winRate - 50) * 0.35 +
    sharpe * 4 +
    sortino * 2 +
    calmar * 3 -
    stats.maxDrawdown * 0.7 -
    tradePenalty
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function simulateBalance(trades, cfg) {
  const closed = trades
    .filter(t => t.result !== 'open')
    .sort((a, b) => String(a.exitDate || a.entryDate).localeCompare(String(b.exitDate || b.entryDate)));

  let balance = cfg.initialCash;
  let peak = balance;
  let maxDrawdownPct = 0;
  let maxDrawdownAmount = 0;
  let grossProfitAmount = 0;
  let grossLossAmount = 0;
  const equityCurve = [{ date: closed[0]?.entryDate || '', balance: round(balance, 2), drawdownPct: 0 }];
  const tradeLedger = [];

  for (const trade of closed) {
    const stake = Math.max(0, balance * cfg.positionPct);
    const pnlAmount = stake * (trade.pnl / 100);
    balance += pnlAmount;
    if (pnlAmount > 0) grossProfitAmount += pnlAmount;
    else grossLossAmount += Math.abs(pnlAmount);

    if (balance > peak) peak = balance;
    const drawdownAmount = peak - balance;
    const drawdownPct = peak > 0 ? (drawdownAmount / peak) * 100 : 0;
    maxDrawdownAmount = Math.max(maxDrawdownAmount, drawdownAmount);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);

    const ledgerRow = {
      entryDate: trade.entryDate,
      exitDate: trade.exitDate,
      result: trade.result,
      days: trade.days,
      pnlPct: round(trade.pnl),
      stake: round(stake, 2),
      pnlAmount: round(pnlAmount, 2),
      balance: round(balance, 2),
      drawdownPct: round(drawdownPct),
    };
    tradeLedger.push(ledgerRow);
    equityCurve.push({ date: trade.exitDate, balance: ledgerRow.balance, drawdownPct: ledgerRow.drawdownPct });
  }

  const netProfitAmount = balance - cfg.initialCash;
  return {
    finalBalance: round(balance, 2),
    netProfitAmount: round(netProfitAmount, 2),
    returnPct: cfg.initialCash > 0 ? round((netProfitAmount / cfg.initialCash) * 100) : 0,
    grossProfitAmount: round(grossProfitAmount, 2),
    grossLossAmount: round(grossLossAmount, 2),
    balanceProfitFactor: grossLossAmount > 0 ? round(grossProfitAmount / grossLossAmount) : grossProfitAmount > 0 ? 99 : 0,
    maxDrawdownAmount: round(maxDrawdownAmount, 2),
    maxDrawdownPct: round(maxDrawdownPct),
    equityCurve,
    tradeLedger,
  };
}

function rowFromResult({ symbol, sourceFile, fold, variant, trades, stats, cfg }) {
  const closedCount = stats.closed.length;
  const balance = simulateBalance(trades, cfg);
  const exposurePct = fold.prices.length > 0
    ? (stats.closed.reduce((a, t) => a + (t.days || 0), 0) / fold.prices.length) * 100
    : 0;

  return {
    runId: cfg.runId,
    botId: cfg.botId,
    variantId: `${cfg.botId}-${variant.id}`,
    commitSha: cfg.git.commitSha,
    branch: cfg.git.branch,
    gitDirty: cfg.git.dirty,
    dataSource: cfg.dataSource,
    symbol,
    sourceFile: path.relative(ROOT, sourceFile).replaceAll('\\', '/'),
    fold: fold.name,
    startDate: fold.startDate,
    endDate: fold.endDate,
    bars: fold.prices.length,
    strategy: variant.options.strategy,
    variant: variant.name,
    trades: trades.length,
    closedTrades: closedCount,
    wins: stats.wins.length,
    losses: stats.losses.length,
    winRate: round(stats.winRate),
    totalReturn: round(stats.totalReturn),
    expectancy: round(stats.expectancy),
    profitFactor: round(stats.profitFactor),
    avgWin: round(stats.avgWin),
    avgLoss: round(stats.avgLoss),
    payoff: round(stats.payoffRatio),
    maxDrawdown: round(stats.maxDrawdown),
    exposurePct: round(exposurePct),
    sharpe: round(stats.sharpeRatio),
    sortino: round(stats.sortinoRatio),
    calmar: round(stats.calmarRatio),
    maxConsWins: stats.maxConsWins,
    maxConsLosses: stats.maxConsLosses,
    initialCash: cfg.initialCash,
    positionPct: cfg.positionPct,
    finalBalance: balance.finalBalance,
    netProfitAmount: balance.netProfitAmount,
    balanceReturnPct: balance.returnPct,
    balanceProfitFactor: balance.balanceProfitFactor,
    balanceMaxDrawdownAmount: balance.maxDrawdownAmount,
    balanceMaxDrawdownPct: balance.maxDrawdownPct,
    score: round(qualityScore(stats, cfg.minTrades)),
    equityCurve: balance.equityCurve,
    tradeLedger: balance.tradeLedger,
  };
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, rows) {
  const headers = Object.keys(rows[0] || {
    runId: '', botId: '', variantId: '', commitSha: '', branch: '', gitDirty: '', dataSource: '',
    symbol: '', sourceFile: '', fold: '', startDate: '', endDate: '', bars: '',
    strategy: '', variant: '', trades: '', closedTrades: '', wins: '', losses: '',
    winRate: '', totalReturn: '', expectancy: '', profitFactor: '', avgWin: '',
    avgLoss: '', maxDrawdown: '', exposurePct: '', sharpe: '', sortino: '', calmar: '',
    payoff: '', maxConsWins: '', maxConsLosses: '', initialCash: '', positionPct: '', finalBalance: '',
    netProfitAmount: '', balanceReturnPct: '', balanceProfitFactor: '',
    balanceMaxDrawdownAmount: '', balanceMaxDrawdownPct: '', score: '',
  }).filter(h => h !== 'equityCurve' && h !== 'tradeLedger');
  const body = [headers.join(',')];
  for (const row of rows) body.push(headers.map(h => csvEscape(row[h])).join(','));
  fs.writeFileSync(file, `${body.join('\n')}\n`, 'utf8');
}

function bestBySymbol(rows, minTrades) {
  const best = new Map();
  for (const row of rows) {
    if (row.closedTrades < minTrades) continue;
    if (!best.has(row.symbol)) best.set(row.symbol, row);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function printHelp() {
  console.log(`
BorsaMan historical research runner

Usage:
  node scripts/research/backtest-batch.mjs --data data/historical

Useful options:
  --symbols THYAO,ASELS       Only run selected files
  --strategies signal,rsi     Defaults to signal,rsi,macd,ma
  --thresholds 55,60,65,70    Signal score thresholds
  --max-holds 15,25,35        Max holding days
  --stops 0.04,0.05,0.06      Fallback stop percentages
  --targets 0.04,0.06,0.08    Fallback target percentages
  --fold-days 252             Bars per walk-forward fold
  --step-days 63              Fold step size
  --random-trials 1000        Random windows per symbol
  --window-days 252           Bars per random window
  --oos-days 252              Add latest bars as out-of-sample fold
  --costs 0.001,0.003,0.006   Fee/slippage sensitivity
  --fee-bps 10                Fee in basis points, combined with slippage bps
  --slippage-bps 5            Slippage in basis points, combined with fee bps
  --initial-cash 100000       Virtual starting balance
  --position-pct 1            Fraction of balance used per trade
  --bot-id borsaman-v2        Bot identity written to reports
  --data-source bist-store    Data source label written to scoreboards
  --full-history              Run one full-history fold per symbol
  --limit 10                  Limit number of data files
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const git = getGitMeta();
  const feeBps = toNumber(args['fee-bps'], null);
  const slippageBps = toNumber(args['slippage-bps'], null);
  const bpsCost = feeBps != null || slippageBps != null
    ? [((feeBps || 0) + (slippageBps || 0)) / 10000]
    : null;
  const cfg = {
    runId: String(args['run-id'] || stamp),
    botId: String(args['bot-id'] || 'borsaman-v2'),
    git,
    dataDir: absFromRoot(args.data || 'data/historical'),
    outDir: absFromRoot(args.out || 'reports/research'),
    dataSource: String(args['data-source'] || args.data || 'data/historical'),
    symbols: stringList(args.symbols, null)?.map(s => s.replace(/\.IS$/i, '').toUpperCase()) || null,
    strategies: stringList(args.strategies, ['signal', 'rsi', 'macd', 'ma']),
    thresholds: numberList(args.thresholds, [55, 60, 65, 70, 75]),
    maxHolds: numberList(args['max-holds'], [15, 25, 35]),
    stops: numberList(args.stops, [0.04, 0.05, 0.06]),
    targets: numberList(args.targets, [0.04, 0.06, 0.08]),
    costs: numberList(args.costs, bpsCost || [0.003]),
    feeBps,
    slippageBps,
    minRRs: numberList(args['min-rrs'], [0, 1]),
    rsiLevels: numberList(args['rsi-levels'], [30, 35, 40]),
    foldDays: Math.max(80, toNumber(args['fold-days'], 252)),
    stepDays: Math.max(20, toNumber(args['step-days'], 63)),
    randomTrials: Math.max(0, toNumber(args['random-trials'], 0)),
    windowDays: Math.max(80, toNumber(args['window-days'], toNumber(args['fold-days'], 252))),
    oosDays: Math.max(0, toNumber(args['oos-days'], 0)),
    seed: String(args.seed || 'borsaman-research'),
    minTrades: Math.max(1, toNumber(args['min-trades'], 5)),
    initialCash: Math.max(1, toNumber(args['initial-cash'], 100000)),
    positionPct: Math.max(0, Math.min(1, toNumber(args['position-pct'], 1))),
    fullHistory: Boolean(args['full-history']),
    looseSignal: Boolean(args['loose-signal']),
    limit: Math.max(0, toNumber(args.limit, 0)),
  };

  let files = collectFiles(cfg.dataDir);
  if (cfg.symbols) {
    const allowed = new Set(cfg.symbols);
    files = files.filter(file => allowed.has(symbolFromFile(file)));
  }
  if (cfg.limit > 0) files = files.slice(0, cfg.limit);

  if (files.length === 0) {
    console.error(`No CSV/JSON files found in ${cfg.dataDir}`);
    process.exitCode = 1;
    return;
  }

  const variants = makeVariants(cfg);
  const rows = [];
  const failures = [];
  const startedAt = new Date();

  console.log(`Files: ${files.length}`);
  const dirtyLabel = cfg.git.dirty === true ? ' dirty' : cfg.git.dirty === 'unknown' ? ' dirty:unknown' : '';
  console.log(`Git: ${cfg.git.branch}@${cfg.git.shortSha}${dirtyLabel}`);
  console.log(`Data source: ${cfg.dataSource}`);
  console.log(`Variants per fold: ${variants.length}`);
  if (cfg.randomTrials > 0) console.log(`Random trials per symbol: ${cfg.randomTrials}, window: ${cfg.windowDays} bars, seed: ${cfg.seed}`);

  for (const file of files) {
    const symbol = symbolFromFile(file);
    try {
      const prices = loadPriceFile(file);
      if (prices.length < 80) {
        failures.push({ symbol, file: path.relative(ROOT, file), error: `not enough bars: ${prices.length}` });
        continue;
      }

      const folds = makeFolds(prices, cfg);
      console.log(`${symbol}: ${prices.length} bars, ${folds.length} folds, ${folds.length * variants.length} runs`);

      for (const fold of folds) {
        for (const variant of variants) {
          const trades = runBacktest(fold.prices, variant.options);
          const stats = calcBacktestStats(trades, fold.prices.length);
          rows.push(rowFromResult({ symbol, sourceFile: file, fold, variant, trades, stats, cfg }));
        }
      }
    } catch (error) {
      failures.push({ symbol, file: path.relative(ROOT, file), error: error.message });
    }
  }

  rows.sort((a, b) => b.score - a.score);
  const eligibleRows = rows.filter(row => row.closedTrades >= cfg.minTrades);
  const displayRows = eligibleRows.length > 0 ? eligibleRows : rows;
  const best = bestBySymbol(rows, cfg.minTrades);
  const variantSummary = aggregateRows(rows, cfg);

  fs.mkdirSync(cfg.outDir, { recursive: true });
  const jsonFile = path.join(cfg.outDir, `backtest-research-${stamp}.json`);
  const csvFile = path.join(cfg.outDir, `backtest-research-${stamp}.csv`);
  const scoreboardFile = path.join(cfg.outDir, `scoreboard-${cfg.botId}.json`);

  fs.writeFileSync(jsonFile, JSON.stringify({
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: {
      ...cfg,
      dataDir: path.relative(ROOT, cfg.dataDir).replaceAll('\\', '/'),
      outDir: path.relative(ROOT, cfg.outDir).replaceAll('\\', '/'),
    },
    totalRuns: rows.length,
    variantSummary,
    top: displayRows.slice(0, 200),
    bestBySymbol: best,
    failures,
  }, null, 2), 'utf8');
  writeCsv(csvFile, rows);
  fs.writeFileSync(scoreboardFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    runId: cfg.runId,
    botId: cfg.botId,
    commitSha: cfg.git.commitSha,
    branch: cfg.git.branch,
    gitDirty: cfg.git.dirty,
    dataSource: cfg.dataSource,
    config: {
      strategies: cfg.strategies,
      thresholds: cfg.thresholds,
      maxHolds: cfg.maxHolds,
      stops: cfg.stops,
      targets: cfg.targets,
      costs: cfg.costs,
      feeBps: cfg.feeBps,
      slippageBps: cfg.slippageBps,
      minRRs: cfg.minRRs,
      rsiLevels: cfg.rsiLevels,
      randomTrials: cfg.randomTrials,
      windowDays: cfg.windowDays,
      oosDays: cfg.oosDays,
      foldDays: cfg.foldDays,
      stepDays: cfg.stepDays,
      initialCash: cfg.initialCash,
      positionPct: cfg.positionPct,
      minTrades: cfg.minTrades,
    },
    variantSummary: variantSummary.slice(0, 50),
    top: displayRows.slice(0, 50).map(({ equityCurve, tradeLedger, ...row }) => row),
    bestBySymbol: best.map(({ equityCurve, tradeLedger, ...row }) => row),
  }, null, 2), 'utf8');

  console.log('');
  console.log(`Total runs: ${rows.length}`);
  console.log(`Report JSON: ${path.relative(ROOT, jsonFile)}`);
  console.log(`Report CSV:  ${path.relative(ROOT, csvFile)}`);
  console.log(`Scoreboard:  ${path.relative(ROOT, scoreboardFile)}`);
  console.log('');
  console.log('Top variant robustness:');
  console.table(variantSummary.slice(0, 5).map(row => ({
    strategy: row.strategy,
    variant: row.variant,
    samples: row.samples,
    trades: row.closedTrades,
    medRet: row.medianReturnPct,
    posRate: row.positiveRatePct,
    pf: row.avgProfitFactor,
    dd: row.worstDrawdownPct,
    robust: row.robustnessScore,
  })));
  console.log('');
  console.table(displayRows.slice(0, 10).map(row => ({
    botId: row.botId,
    symbol: row.symbol,
    strategy: row.strategy,
    fold: row.fold,
    closed: row.closedTrades,
    winRate: row.winRate,
    exp: row.expectancy,
    pf: row.profitFactor,
    dd: row.maxDrawdown,
    balance: row.finalBalance,
    score: row.score,
  })));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
