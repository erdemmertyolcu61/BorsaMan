#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { calcAll } from '../../src/utils/indicators.js';
import { genSignal } from '../../src/utils/signals.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_CONFIG = {
  dataDir: 'data/yahoo',
  dailyDataDir: 'data/yahoo/1d_5y',
  reportsDir: 'reports/research',
  telegramReportsDir: 'reports/telegram',
  timezone: 'Europe/Istanbul',
  defaultCash: 100000,
  defaultPositionPct: 0.25,
};

function absFromRoot(value) {
  if (path.isAbsolute(value)) return value;
  return path.resolve(ROOT, value);
}

function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const configFile = process.env.TELEGRAM_BOT_CONFIG
    ? absFromRoot(process.env.TELEGRAM_BOT_CONFIG)
    : path.join(ROOT, 'config', 'telegram-bot.json');
  const fileConfig = loadJson(configFile, {});
  return { ...DEFAULT_CONFIG, ...fileConfig };
}

const config = loadConfig();
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const adminIds = new Set(String(process.env.TELEGRAM_ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));
const broadcastChatIds = String(process.env.TELEGRAM_BROADCAST_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const telegramDir = absFromRoot(config.telegramReportsDir);
const ledgerFile = path.join(telegramDir, 'recommendations.json');

function ensureDirs() {
  fs.mkdirSync(telegramDir, { recursive: true });
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

function symbolFromFile(file) {
  return path.basename(file, path.extname(file)).split('__')[0].replace(/\.IS$/i, '').toUpperCase();
}

function collectCsvFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCsvFiles(full));
    else if (/\.(csv|txt)$/i.test(entry.name) && !/^(DATA_CATALOG|DOWNLOAD_MANIFEST)\.(csv|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function loadPrices(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const delimiter = (lines[0].match(/;/g)?.length || 0) > (lines[0].match(/,/g)?.length || 0) ? ';' : ',';
  const firstCells = splitDelimited(lines[0], delimiter);
  const hasHeader = firstCells.some(cell => /[a-zA-Z]/.test(cell));
  const startLine = hasHeader ? 1 : 0;
  const symbol = symbolFromFile(file);
  return lines.slice(startLine).map(line => {
    const row = splitDelimited(line, delimiter);
    const close = toNumber(row[4], null);
    if (close == null || close <= 0) return null;
    const open = toNumber(row[1], close);
    const high = toNumber(row[2], Math.max(open, close));
    const low = toNumber(row[3], Math.min(open, close));
    return {
      symbol,
      date: normalizeDate(row[0]),
      open,
      high,
      low,
      close,
      volume: Math.max(0, toNumber(row[5], 0)),
    };
  }).filter(Boolean);
}

function findDailyFile(symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/\.IS$/i, '');
  const dir = absFromRoot(config.dailyDataDir);
  return collectCsvFiles(dir).find(file => symbolFromFile(file) === sym) || null;
}

function analyzeSymbol(symbol) {
  const file = findDailyFile(symbol);
  if (!file) return { error: `Veri dosyasi yok: ${symbol}` };
  const prices = loadPrices(file);
  if (prices.length < 60) return { error: `Yetersiz veri: ${symbol} (${prices.length} bar)` };
  const ind = calcAll(prices);
  const sig = genSignal(ind, prices);
  const last = prices[prices.length - 1];
  return { symbol: symbolFromFile(file), file, prices, ind, sig, last };
}

function scorePick(result) {
  if (!result || result.error) return -999;
  const sig = result.sig || {};
  const rr = Number(sig.rr) || 0;
  const score = Number(sig.score) || 0;
  const clsBonus = sig.cls === 'buy' ? 20 : sig.cls === 'sell' ? -20 : 0;
  return score + rr * 4 + clsBonus;
}

function getTopSignals(limit = 5) {
  const files = collectCsvFiles(absFromRoot(config.dailyDataDir));
  return files
    .map(file => analyzeSymbol(symbolFromFile(file)))
    .filter(r => !r.error)
    .sort((a, b) => scorePick(b) - scorePick(a))
    .slice(0, limit);
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '-';
}

function formatSignal(result) {
  if (result.error) return result.error;
  const { symbol, ind, sig, last } = result;
  const reasons = (sig.reasons || []).slice(0, 4).map(r => r.t || r.msg || '').filter(Boolean);
  const decisionEntry = resolveDecisionEntry(sig, last.close);
  const entryLabel = ['buy', 'sell'].includes(String(sig.cls || '')) ? 'Giris' : 'Izleme fiyati';
  return [
    `${symbol} analiz`,
    `Son fiyat: ${fmtPrice(last.close)} (${last.date})`,
    `Sinyal: ${sig.signal || '-'} / ${sig.cls || '-'}`,
    `Skor: ${fmtPrice(sig.score)}/100 | Guven: ${sig.conf || '-'} | R/R: ${fmtPrice(sig.rr)}`,
    `${entryLabel}: ${fmtPrice(decisionEntry)} | Stop: ${fmtPrice(sig.stop)} | H1: ${fmtPrice(sig.t1)} | H2: ${fmtPrice(sig.t2)}`,
    `RSI: ${fmtPrice(ind.lastRSI)} | ADX: ${fmtPrice(ind.adx)} | Hacim: ${fmtPrice(ind.volRatio)}x | OBV: ${ind.obvTrend || '-'}`,
    reasons.length ? `Nedenler: ${reasons.join(' | ')}` : '',
    `Not: Arastirma/simulasyon ciktisidir, yatirim tavsiyesi degildir.`,
  ].filter(Boolean).join('\n');
}

function loadLedger() {
  ensureDirs();
  const data = loadJson(ledgerFile, { recommendations: [] });
  return Array.isArray(data.recommendations) ? data.recommendations : [];
}

function saveLedger(recommendations) {
  ensureDirs();
  fs.writeFileSync(ledgerFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    recommendations,
  }, null, 2), 'utf8');
}

function recordRecommendation(symbol, meta = {}) {
  const result = analyzeSymbol(symbol);
  if (result.error) return { error: result.error };
  const { sig, last } = result;
  const entry = resolveDecisionEntry(sig, last.close);
  const item = {
    id: `${result.symbol}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: result.symbol,
    source: meta.source || 'telegram',
    chatId: meta.chatId || '',
    signal: sig.signal || '',
    cls: sig.cls || '',
    score: Number(sig.score) || 0,
    confidence: Number(sig.conf) || 0,
    entry,
    stop: Number(sig.stop) || null,
    target: Number(sig.t1) || null,
    rr: Number(sig.rr) || null,
    priceAtDecision: last.close,
    decisionDate: last.date,
    status: 'OPEN',
    outcome: 'OPEN',
    lastPrice: last.close,
    lastCheckedAt: new Date().toISOString(),
    pnlPct: 0,
  };
  const list = loadLedger();
  list.unshift(item);
  saveLedger(list.slice(0, 500));
  return { item, result };
}

function resolveDecisionEntry(sig, fallbackPrice) {
  const px = Number(fallbackPrice);
  const entry = Number(sig?.entry);
  const cls = String(sig?.cls || '');
  if (!Number.isFinite(px) || px <= 0) return Number.isFinite(entry) ? entry : 0;
  if (!['buy', 'sell'].includes(cls)) return px;
  if (!Number.isFinite(entry) || entry <= 0) return px;
  const distance = Math.abs(entry - px) / px;
  return distance <= 0.2 ? entry : px;
}

function evaluateRecommendation(item) {
  const result = analyzeSymbol(item.symbol);
  if (result.error) return { ...item, error: result.error };
  const price = result.last.close;
  const entry = Number(item.entry || item.priceAtDecision);
  const pnlPct = entry > 0 ? ((price - entry) / entry) * 100 : 0;
  let outcome = 'OPEN';
  if (item.cls === 'buy') {
    if (item.target && price >= item.target) outcome = 'TARGET_HIT';
    else if (item.stop && price <= item.stop) outcome = 'STOP_HIT';
    else if (pnlPct >= 3) outcome = 'WIN';
    else if (pnlPct <= -3) outcome = 'LOSS';
  }
  return {
    ...item,
    lastPrice: price,
    lastDataDate: result.last.date,
    pnlPct,
    outcome,
    status: outcome === 'OPEN' ? 'OPEN' : 'CLOSED',
    lastCheckedAt: new Date().toISOString(),
  };
}

function updateLedgerOutcomes() {
  const updated = loadLedger().map(evaluateRecommendation);
  saveLedger(updated);
  return updated;
}

function latestScoreboard() {
  const dir = absFromRoot(config.reportsDir);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(name => /^scoreboard-.*\.json$/i.test(name))
    .map(name => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ? loadJson(files[0], null) : null;
}

function catalogSummary() {
  const file = path.join(absFromRoot(config.dataDir), 'DATA_CATALOG.json');
  const data = loadJson(file, null);
  if (!data?.files?.length) return 'Data katalogu yok. Once npm run data:catalog calistir.';
  const byInterval = {};
  for (const row of data.files) {
    const key = row.interval || row.inferredInterval || 'unknown';
    byInterval[key] = byInterval[key] || { count: 0, rows: 0, first: row.firstDate, last: row.lastDate };
    byInterval[key].count += 1;
    byInterval[key].rows += Number(row.rows) || 0;
    if (row.firstDate && (!byInterval[key].first || row.firstDate < byInterval[key].first)) byInterval[key].first = row.firstDate;
    if (row.lastDate && (!byInterval[key].last || row.lastDate > byInterval[key].last)) byInterval[key].last = row.lastDate;
  }
  const lines = Object.entries(byInterval)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([interval, v]) => `${interval}: ${v.count} dosya, ${v.rows} satir, ${v.first} -> ${v.last}`);
  return [`Veri katalogu`, `Toplam dosya: ${data.files.length}`, ...lines].join('\n');
}

function buildTopReport() {
  const top = getTopSignals(8);
  if (!top.length) return 'Top sinyal uretilemedi. Gunluk veri klasorunu kontrol et.';
  return [
    'BorsaMan top adaylar',
    ...top.map((r, i) => `${i + 1}. ${r.symbol} | ${r.sig.signal} | skor ${fmtPrice(r.sig.score)} | R/R ${fmtPrice(r.sig.rr)} | fiyat ${fmtPrice(r.last.close)}`),
    'Not: Arastirma/simulasyon ciktisidir.',
  ].join('\n');
}

function buildPreMarketReport() {
  const board = latestScoreboard();
  const boardLine = board ? `Son skor: ${board.botId} / ${board.dataSource} / ${board.runId}` : 'Son skor yok';
  return [
    'BorsaMan gun oncesi',
    boardLine,
    buildTopReport(),
  ].join('\n\n');
}

function buildEndDayReport() {
  const updated = updateLedgerOutcomes();
  const today = new Date().toISOString().slice(0, 10);
  const recent = updated.filter(x => String(x.createdAt || '').slice(0, 10) === today);
  const list = recent.length ? recent : updated.slice(0, 10);
  const wins = list.filter(x => ['TARGET_HIT', 'WIN'].includes(x.outcome)).length;
  const losses = list.filter(x => ['STOP_HIT', 'LOSS'].includes(x.outcome)).length;
  const open = list.filter(x => x.outcome === 'OPEN').length;
  const avg = list.length ? list.reduce((a, x) => a + (Number(x.pnlPct) || 0), 0) / list.length : 0;
  return [
    'BorsaMan gun sonu',
    `Kayitli oneriler: ${list.length}`,
    `Hedef/kazanc: ${wins} | Stop/kayip: ${losses} | Acik: ${open}`,
    `Ortalama P/L: ${fmtPct(avg)}`,
    ...list.slice(0, 8).map(x => `${x.symbol}: ${x.outcome} ${fmtPct(x.pnlPct)} (${fmtPrice(x.entry)} -> ${fmtPrice(x.lastPrice)})`),
  ].join('\n');
}

function buildWeeklyReport(cash = config.defaultCash) {
  const list = updateLedgerOutcomes().filter(x => Date.now() - new Date(x.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000);
  if (!list.length) return 'Son 7 gunde kayitli Telegram onerisi yok. /kaydet THYAO ile onerileri kaydetmeye basla.';
  const allocation = cash / list.length;
  let finalCash = cash;
  for (const item of list) finalCash += allocation * ((Number(item.pnlPct) || 0) / 100);
  const wins = list.filter(x => (Number(x.pnlPct) || 0) > 0).length;
  const losses = list.filter(x => (Number(x.pnlPct) || 0) <= 0).length;
  const grossWin = list.reduce((a, x) => a + Math.max(0, allocation * ((Number(x.pnlPct) || 0) / 100)), 0);
  const grossLoss = Math.abs(list.reduce((a, x) => a + Math.min(0, allocation * ((Number(x.pnlPct) || 0) / 100)), 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  return [
    'BorsaMan haftalik simule P/L',
    `Baslangic: ${cash.toFixed(0)} TL`,
    `Final: ${finalCash.toFixed(0)} TL`,
    `Net: ${(finalCash - cash).toFixed(0)} TL (${fmtPct(((finalCash - cash) / cash) * 100)})`,
    `Oneri: ${list.length} | Kazanan: ${wins} | Kaybeden: ${losses} | PF: ${fmtPrice(pf)}`,
    ...list.slice(0, 12).map(x => `${x.symbol}: ${fmtPct(x.pnlPct)} ${x.outcome}`),
  ].join('\n');
}

function buildScoreboardReport() {
  const board = latestScoreboard();
  if (!board) return 'Scoreboard bulunamadi.';
  const top = board.top || [];
  return [
    `Scoreboard: ${board.botId}`,
    `Run: ${board.runId} | Kaynak: ${board.dataSource}`,
    `Commit: ${String(board.commitSha || '').slice(0, 7)} | Branch: ${board.branch}`,
    ...top.slice(0, 8).map((r, i) => `${i + 1}. ${r.symbol} ${r.strategy}/${r.fold} score ${fmtPrice(r.score)} balance ${fmtPrice(r.finalBalance)} closed ${r.closedTrades}`),
  ].join('\n');
}

function helpText() {
  return [
    'BorsaMan Telegram komutlari',
    '/durum - sistem ve veri durumu',
    '/katalog - indirilen veri ozeti',
    '/top - gunluk veriden top adaylar',
    '/sor THYAO - tek hisse analizi',
    '/kaydet THYAO - oneriyi deftere yaz',
    '/oneriler - kayitli oneriler',
    '/sonuc - kayitli onerileri guncelle',
    '/hafta 100000 - haftalik sanal P/L',
    '/skor - son backtest scoreboard',
    '/gun_oncesi - acilis oncesi rapor',
    '/gun_sonu - kapanis raporu',
    '/admin - admin durumu',
  ].join('\n');
}

function isAdmin(msg) {
  if (!adminIds.size) return false;
  return adminIds.has(String(msg.from?.id || ''));
}

async function handleCommand(text, msg = {}) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const arg = parts[1];
  if (!cmd || cmd === '/start' || cmd === '/help') return helpText();
  if (cmd === '/durum') {
    const files = collectCsvFiles(absFromRoot(config.dailyDataDir));
    const board = latestScoreboard();
    return [
      'BorsaMan durum',
      `Gunluk veri dosyasi: ${files.length}`,
      `Ledger: ${loadLedger().length} oneriler`,
      board ? `Son scoreboard: ${board.botId} / ${board.runId}` : 'Scoreboard yok',
      `Admin tanimli: ${adminIds.size}`,
    ].join('\n');
  }
  if (cmd === '/katalog') return catalogSummary();
  if (cmd === '/top') return buildTopReport();
  if (cmd === '/sor') return arg ? formatSignal(analyzeSymbol(arg)) : 'Kullanim: /sor THYAO';
  if (cmd === '/kaydet') {
    if (!arg) return 'Kullanim: /kaydet THYAO';
    const out = recordRecommendation(arg, { chatId: msg.chat?.id, source: 'telegram' });
    if (out.error) return out.error;
    return [`Kaydedildi: ${out.item.symbol}`, formatSignal(out.result)].join('\n\n');
  }
  if (cmd === '/oneriler') {
    const list = loadLedger().slice(0, 12);
    if (!list.length) return 'Kayitli oneri yok.';
    return ['Son oneriler', ...list.map(x => `${x.symbol}: ${x.signal} skor ${fmtPrice(x.score)} ${fmtPct(x.pnlPct)} ${x.outcome}`)].join('\n');
  }
  if (cmd === '/sonuc' || cmd === '/gun_sonu') return buildEndDayReport();
  if (cmd === '/hafta' || cmd === '/rapor') return buildWeeklyReport(toNumber(arg, config.defaultCash));
  if (cmd === '/skor') return buildScoreboardReport();
  if (cmd === '/gun_oncesi') return buildPreMarketReport();
  if (cmd === '/admin') {
    return [
      `Admin misin: ${isAdmin(msg) ? 'evet' : 'hayir'}`,
      `Admin ID sayisi: ${adminIds.size}`,
      `Broadcast chat sayisi: ${broadcastChatIds.length}`,
      `Furkan/Erdem numeric Telegram ID girilince aktiflesir.`,
    ].join('\n');
  }
  if (cmd === '/broadcast') {
    if (!isAdmin(msg)) return 'Bu komut admin gerektirir.';
    const payload = parts[1] === 'hafta' ? buildWeeklyReport(config.defaultCash) : buildPreMarketReport();
    await broadcast(payload);
    return `Broadcast gonderildi: ${broadcastChatIds.length} chat`;
  }
  return helpText();
}

async function telegram(method, payload) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN yok');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || `Telegram ${method} failed`);
  return json.result;
}

async function sendMessage(chatId, text) {
  const chunks = chunkText(text, 3800);
  for (const chunk of chunks) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

function chunkText(text, limit) {
  const s = String(text || '');
  if (s.length <= limit) return [s];
  const chunks = [];
  for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit));
  return chunks;
}

async function broadcast(text) {
  for (const chatId of broadcastChatIds) {
    try { await sendMessage(chatId, text); } catch (error) { console.error(`[broadcast ${chatId}]`, error.message); }
  }
}

async function poll() {
  let offset = 0;
  console.log('BorsaMan Telegram bot polling started.');
  while (true) {
    try {
      const updates = await telegram('getUpdates', { timeout: 30, offset });
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.chat?.id || !msg.text) continue;
        const reply = await handleCommand(msg.text, msg);
        await sendMessage(msg.chat.id, reply);
      }
    } catch (error) {
      console.error('[poll]', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function cli() {
  ensureDirs();
  const args = process.argv.slice(2);
  if (args[0] === '--once') {
    const text = args.slice(1).join(' ') || '/durum';
    console.log(await handleCommand(text, { from: { id: 'cli' }, chat: { id: 'cli' } }));
    return;
  }
  if (!token) {
    console.log('TELEGRAM_BOT_TOKEN yok. Lokal test icin:');
    console.log('node scripts/telegram/telegram-bot.mjs --once "/top"');
    return;
  }
  await poll();
}

cli().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
