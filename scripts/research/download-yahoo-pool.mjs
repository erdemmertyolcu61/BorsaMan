#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BIST30, QUICK_STOCKS, getStockList } from '../../src/utils/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LAYERS = {
  '1d_5y': { interval: '1d', range: '5y', folder: '1d_5y', label: '5 years daily OHLCV' },
  '1h_730d': { interval: '1h', range: '2y', folder: '1h_730d', label: 'about 2 years hourly OHLCV' },
  '15m_60d': { interval: '15m', range: '60d', folder: '15m_60d', label: '60 days 15-minute OHLCV' },
  '5m_60d': { interval: '5m', range: '60d', folder: '5m_60d', label: '60 days 5-minute OHLCV' },
  '1m_7d': { interval: '1m', range: '7d', folder: '1m_7d', label: '7 days 1-minute OHLCV' },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function stringList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function absFromRoot(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(ROOT, value);
}

function symbolsFromArgs(args) {
  if (args.symbols) return stringList(args.symbols, []).map(cleanSymbol);
  const list = String(args.list || 'quick').toLowerCase();
  if (list === 'quick') return QUICK_STOCKS.map(cleanSymbol);
  if (list === 'bist30') return BIST30.map(cleanSymbol);
  if (['bist50', 'bist100', 'bistall'].includes(list)) return getStockList(list).map(cleanSymbol);
  return QUICK_STOCKS.map(cleanSymbol);
}

function cleanSymbol(symbol) {
  return String(symbol).trim().toUpperCase().replace(/\.IS$/i, '');
}

function yahooSymbol(symbol) {
  return `${cleanSymbol(symbol)}.IS`;
}

function layerList(value) {
  if (!value || value === 'max' || value === 'all') return Object.keys(LAYERS);
  return stringList(value, []).filter(layer => LAYERS[layer]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTimestamp(seconds, interval, timezone = 'Europe/Istanbul') {
  const date = new Date(seconds * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (interval.endsWith('d') || interval.endsWith('wk') || interval.endsWith('mo')) return day;
  return `${day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`;
}

function safeStamp(value) {
  return String(value || '').replace(/[^0-9A-Za-z]+/g, '').slice(0, 20) || 'na';
}

function buildCsv(rows) {
  const lines = ['date,open,high,low,close,volume'];
  for (const row of rows) {
    lines.push([row.date, row.open, row.high, row.low, row.close, row.volume].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseYahooChart(payload, symbol, layer) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    const error = payload?.chart?.error?.description || payload?.chart?.error?.code || 'empty Yahoo result';
    throw new Error(error);
  }
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const timezone = result.meta?.exchangeTimezoneName || 'Europe/Istanbul';
  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close?.[i];
    if (!Number.isFinite(close)) continue;
    const open = Number.isFinite(quote.open?.[i]) ? quote.open[i] : close;
    const high = Number.isFinite(quote.high?.[i]) ? quote.high[i] : Math.max(open, close);
    const low = Number.isFinite(quote.low?.[i]) ? quote.low[i] : Math.min(open, close);
    rows.push({
      symbol,
      date: formatTimestamp(timestamps[i], layer.interval, timezone),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(quote.volume?.[i]) ? quote.volume[i] : 0,
    });
  }
  return rows;
}

async function fetchLayer(symbol, layer, timeoutMs) {
  const ticker = yahooSymbol(symbol);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
  url.searchParams.set('range', layer.range);
  url.searchParams.set('interval', layer.interval);
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div,splits');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 BorsaMan research downloader' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    return parseYahooChart(payload, symbol, layer);
  } finally {
    clearTimeout(timer);
  }
}

function writeRows(outRoot, symbol, layerName, layer, rows, replace) {
  const dir = path.join(outRoot, layer.folder);
  fs.mkdirSync(dir, { recursive: true });
  const first = rows[0]?.date || 'empty';
  const last = rows[rows.length - 1]?.date || 'empty';
  const prefix = `${yahooSymbol(symbol)}__yahoo__${layer.interval}__${layerName}__`;
  if (replace) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix) && entry.endsWith('.csv')) {
        fs.unlinkSync(path.join(dir, entry));
      }
    }
  }
  const file = path.join(dir, `${prefix}${safeStamp(first)}_to_${safeStamp(last)}.csv`);
  fs.writeFileSync(file, buildCsv(rows), 'utf8');
  return file;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeManifest(outRoot, rows) {
  fs.mkdirSync(outRoot, { recursive: true });
  const jsonFile = path.join(outRoot, 'DOWNLOAD_MANIFEST.json');
  const csvFile = path.join(outRoot, 'DOWNLOAD_MANIFEST.csv');
  fs.writeFileSync(jsonFile, JSON.stringify({ updatedAt: new Date().toISOString(), files: rows }, null, 2), 'utf8');
  const headers = Object.keys(rows[0] || {
    symbol: '', yahooSymbol: '', dataSource: '', layer: '', interval: '', requestedRange: '', label: '',
    firstDate: '', lastDate: '', rows: '', file: '', status: '', error: '',
  });
  const body = [headers.join(',')];
  for (const row of rows) body.push(headers.map(h => csvEscape(row[h])).join(','));
  fs.writeFileSync(csvFile, `${body.join('\n')}\n`, 'utf8');
}

function printHelp() {
  console.log(`
BorsaMan Yahoo data pool downloader

Usage:
  node scripts/research/download-yahoo-pool.mjs --list quick --layers max

Options:
  --list quick|bist30|bist50|bist100|bistall
  --symbols THYAO,ASELS,GARAN
  --layers 1d_5y,1h_730d,15m_60d,5m_60d,1m_7d
  --out data/yahoo
  --limit 10
  --sleep-ms 500
  --dry-run

Notes:
  Yahoo/yfinance-style intraday data is limited. This script requests the
  practical maximum layers: 5y daily, about 2y hourly, 60d 15m/5m, 7d 1m.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const outRoot = absFromRoot(args.out || 'data/yahoo');
  const dataSource = String(args['data-source'] || 'yahoo');
  const selectedLayers = layerList(args.layers || 'max');
  let symbols = symbolsFromArgs(args);
  const limit = Number(args.limit || 0);
  if (limit > 0) symbols = symbols.slice(0, limit);
  const sleepMs = Number(args['sleep-ms'] || 500);
  const timeoutMs = Number(args.timeout || 30000);
  const replace = args.replace !== false && args.replace !== 'false';

  console.log(`Symbols: ${symbols.length} (${symbols.slice(0, 10).join(', ')}${symbols.length > 10 ? ', ...' : ''})`);
  console.log(`Layers: ${selectedLayers.join(', ')}`);
  console.log(`Out: ${path.relative(ROOT, outRoot)}`);

  if (args['dry-run']) {
    for (const symbol of symbols) {
      for (const layerName of selectedLayers) {
        const layer = LAYERS[layerName];
        console.log(`${yahooSymbol(symbol)} -> ${layer.folder} (${layer.interval}, ${layer.range})`);
      }
    }
    return;
  }

  const manifest = [];
  fs.mkdirSync(outRoot, { recursive: true });
  for (const symbol of symbols) {
    for (const layerName of selectedLayers) {
      const layer = LAYERS[layerName];
      process.stdout.write(`${yahooSymbol(symbol)} ${layerName} ... `);
      try {
        const rows = await fetchLayer(symbol, layer, timeoutMs);
        if (rows.length === 0) throw new Error('no rows returned');
        const file = writeRows(outRoot, symbol, layerName, layer, rows, replace);
        const item = {
          symbol,
          yahooSymbol: yahooSymbol(symbol),
          dataSource,
          layer: layerName,
          interval: layer.interval,
          requestedRange: layer.range,
          label: layer.label,
          firstDate: rows[0].date,
          lastDate: rows[rows.length - 1].date,
          rows: rows.length,
          file: path.relative(ROOT, file).replaceAll('\\', '/'),
          status: 'ok',
          error: '',
        };
        manifest.push(item);
        console.log(`${rows.length} rows`);
      } catch (error) {
        manifest.push({
          symbol,
          yahooSymbol: yahooSymbol(symbol),
          dataSource,
          layer: layerName,
          interval: layer.interval,
          requestedRange: layer.range,
          label: layer.label,
          firstDate: '',
          lastDate: '',
          rows: 0,
          file: '',
          status: 'error',
          error: error.message,
        });
        console.log(`ERROR: ${error.message}`);
      }
      writeManifest(outRoot, manifest);
      if (sleepMs > 0) await sleep(sleepMs);
    }
  }

  writeManifest(outRoot, manifest);
  const ok = manifest.filter(row => row.status === 'ok').length;
  const failed = manifest.length - ok;
  console.log(`Done. ok=${ok}, failed=${failed}`);
  console.log(`Manifest: ${path.relative(ROOT, path.join(outRoot, 'DOWNLOAD_MANIFEST.csv'))}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
