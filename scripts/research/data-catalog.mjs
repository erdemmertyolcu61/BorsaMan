#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function absFromRoot(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(ROOT, value);
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
    } else if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function canonicalHeader(value) {
  return String(value || '').replace(/^\ufeff/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function indexFor(headers, aliases, fallback) {
  const normalized = headers.map(canonicalHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return fallback;
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
  return s.slice(0, 19);
}

function inferFromFileName(file) {
  const name = path.basename(file, path.extname(file));
  const parts = name.split('__');
  const meta = {
    symbol: '',
    source: '',
    interval: '',
    requestedRange: '',
    fileStart: '',
    fileEnd: '',
  };
  if (parts.length >= 5) {
    meta.symbol = parts[0].replace(/\.IS$/i, '');
    meta.source = parts[1];
    meta.interval = parts[2];
    meta.requestedRange = parts[3];
    const span = parts.slice(4).join('__').split('_to_');
    meta.fileStart = span[0] || '';
    meta.fileEnd = span[1] || '';
  } else {
    meta.symbol = name.replace(/\.IS$/i, '').split(/[_.-]/)[0].toUpperCase();
  }
  return meta;
}

function inferIntervalFromDates(dates) {
  if (dates.length < 2) return '';
  const samples = dates.slice(0, 20)
    .map(d => Date.parse(d))
    .filter(Number.isFinite);
  if (samples.length < 2) return '';
  const diffs = [];
  for (let i = 1; i < samples.length; i++) {
    const diff = samples[i] - samples[i - 1];
    if (diff > 0) diffs.push(diff);
  }
  if (diffs.length === 0) return '';
  diffs.sort((a, b) => a - b);
  const mid = diffs[Math.floor(diffs.length / 2)] / 60000;
  if (mid <= 1.5) return '1m';
  if (mid <= 6) return '5m';
  if (mid <= 20) return '15m';
  if (mid <= 35) return '30m';
  if (mid <= 100) return '1h';
  if (mid >= 900) return '1d';
  return `${Math.round(mid)}m`;
}

function readCsvSummary(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return { rows: 0, firstDate: '', lastDate: '', inferredInterval: '', columns: [] };

  const first = lines[0];
  const delimiter = (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? ';' : ',';
  const header = splitDelimited(first, delimiter);
  const hasHeader = header.some(cell => /[a-zA-Z]/.test(cell));
  const headers = hasHeader ? header : ['date', 'open', 'high', 'low', 'close', 'volume'];
  const dateIdx = indexFor(headers, ['date', 'datetime', 'time', 'timestamp', 'tarih'], 0);
  const startLine = hasHeader ? 1 : 0;
  const rows = lines.slice(startLine);
  const dates = rows
    .map(line => normalizeDate(splitDelimited(line, delimiter)[dateIdx]))
    .filter(Boolean);

  return {
    rows: dates.length,
    firstDate: dates[0] || '',
    lastDate: dates[dates.length - 1] || '',
    inferredInterval: inferIntervalFromDates(dates),
    columns: headers,
  };
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(csv|txt)$/i.test(entry.name) && !/^(DATA_CATALOG|DOWNLOAD_MANIFEST)\.(csv|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, rows) {
  const headers = Object.keys(rows[0] || {
    file: '', symbol: '', source: '', interval: '', inferredInterval: '',
    requestedRange: '', firstDate: '', lastDate: '', rows: '', sizeBytes: '',
    modifiedAt: '', columns: '',
  });
  const body = [headers.join(',')];
  for (const row of rows) body.push(headers.map(h => csvEscape(row[h])).join(','));
  fs.writeFileSync(file, `${body.join('\n')}\n`, 'utf8');
}

function catalog(dataDir) {
  return collectFiles(dataDir).map(file => {
    const nameMeta = inferFromFileName(file);
    const summary = readCsvSummary(file);
    const stat = fs.statSync(file);
    return {
      file: path.relative(ROOT, file).replaceAll('\\', '/'),
      symbol: nameMeta.symbol,
      source: nameMeta.source,
      interval: nameMeta.interval,
      inferredInterval: summary.inferredInterval,
      requestedRange: nameMeta.requestedRange,
      fileStart: nameMeta.fileStart,
      fileEnd: nameMeta.fileEnd,
      firstDate: summary.firstDate,
      lastDate: summary.lastDate,
      rows: summary.rows,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      columns: summary.columns.join('|'),
    };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

function printHelp() {
  console.log(`
BorsaMan data catalog

Usage:
  node scripts/research/data-catalog.mjs --data data/yahoo

Options:
  --data data/yahoo          Directory to scan
  --out data/yahoo           Directory for DATA_CATALOG files
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }
  const dataDir = absFromRoot(args.data || 'data/yahoo');
  const outDir = absFromRoot(args.out || args.data || 'data/yahoo');
  fs.mkdirSync(outDir, { recursive: true });
  const rows = catalog(dataDir);
  const jsonFile = path.join(outDir, 'DATA_CATALOG.json');
  const csvFile = path.join(outDir, 'DATA_CATALOG.csv');
  fs.writeFileSync(jsonFile, JSON.stringify({ updatedAt: new Date().toISOString(), dataDir: path.relative(ROOT, dataDir).replaceAll('\\', '/'), files: rows }, null, 2), 'utf8');
  writeCsv(csvFile, rows);
  console.log(`Cataloged files: ${rows.length}`);
  console.log(`JSON: ${path.relative(ROOT, jsonFile)}`);
  console.log(`CSV:  ${path.relative(ROOT, csvFile)}`);
  console.table(rows.slice(0, 15).map(row => ({
    symbol: row.symbol,
    interval: row.interval || row.inferredInterval,
    range: row.requestedRange,
    first: row.firstDate,
    last: row.lastDate,
    rows: row.rows,
  })));
}

main();
