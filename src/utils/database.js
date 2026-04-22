import initSqlJs from 'sql.js';

let db = null;
let SQL = null;
const DB_KEY = 'bist_terminal_db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_top10 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rank INTEGER NOT NULL,
    change_pct REAL,
    volume INTEGER,
    price REAL,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS daily_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rsi REAL,
    macd REAL,
    macd_signal REAL,
    macd_hist REAL,
    bb_upper REAL,
    bb_middle REAL,
    bb_lower REAL,
    bb_width REAL,
    rsi_divergence TEXT,
    obv REAL,
    obv_change_pct REAL,
    mfi REAL,
    adx REAL,
    atr REAL,
    sma_20 REAL,
    sma_50 REAL,
    sma_200 REAL,
    volume_ratio REAL,
    price_vs_sma200 REAL,
    wyckoff_phase TEXT,
    in_top10_next_day INTEGER,
    next_day_change_pct REAL,
    momentum5d REAL,
    momentum20d REAL,
    roc REAL,
    volume_accum_ratio REAL,
    price_vs_vwap REAL,
    atr_percent REAL,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    strategy TEXT NOT NULL,
    symbol TEXT NOT NULL,
    entry_price REAL,
    exit_price REAL,
    roi_pct REAL,
    holding_days INTEGER,
    stop_hit INTEGER,
    target_hit INTEGER,
    indicators TEXT,
    UNIQUE(date, strategy, symbol)
  );

  CREATE TABLE IF NOT EXISTS rule_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,
    rule_params TEXT NOT NULL,
    occurrences INTEGER DEFAULT 0,
    successes INTEGER DEFAULT 0,
    avg_roi_pct REAL DEFAULT 0,
    success_rate REAL DEFAULT 0,
    last_updated TEXT,
    UNIQUE(rule_name, rule_params)
  );

  CREATE INDEX IF NOT EXISTS idx_top10_date ON daily_top10(date);
  CREATE INDEX IF NOT EXISTS idx_indicators_date ON daily_indicators(date);
  CREATE INDEX IF NOT EXISTS idx_indicators_symbol ON daily_indicators(symbol);
  CREATE INDEX IF NOT EXISTS idx_backtest_date ON backtest_results(date);
  CREATE INDEX IF NOT EXISTS idx_rules_name ON rule_performance(rule_name);
`;

export async function initDatabase() {
  if (db) return db;

  try {
    SQL = await initSqlJs({
      locateFile: file => `https://sql.js.org/dist/${file}`
    });

    const savedData = localStorage.getItem(DB_KEY);
    if (savedData) {
      const data = new Uint8Array(JSON.parse(savedData));
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }

    db.run(SCHEMA);
    saveDatabase();

    console.log('[DB] SQLite initialized successfully');
    return db;
  } catch (e) {
    console.error('[DB] Init failed:', e);
    throw e;
  }
}

export function saveDatabase() {
  if (!db) return;
  try {
    const data = db.export();
    const arr = Array.from(data);
    localStorage.setItem(DB_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('[DB] Save failed:', e);
  }
}

export function getDatabase() {
  return db;
}

export async function closeDatabase() {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
  }
}

export function clearDatabase() {
  if (db) {
    db.run('DELETE FROM daily_top10');
    db.run('DELETE FROM daily_indicators');
    db.run('DELETE FROM backtest_results');
    db.run('DELETE FROM rule_performance');
    saveDatabase();
  }
}

export function getDbSize() {
  try {
    const data = localStorage.getItem(DB_KEY);
    return data ? JSON.parse(data).length : 0;
  } catch { return 0; }
}

export { SCHEMA };
