const { app, BrowserWindow, screen, shell, Menu, Notification, ipcMain, safeStorage } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
if (isDev) process.env.NODE_ENV = 'development';

// Disable HTTP cache in dev so every :dev start shows the latest build
if (isDev) {
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // Disable quota database to avoid corruption errors in dev
  app.commandLine.appendSwitch('disable-quota-database');
}

// Allow Electron to ignore certificate errors — needed for CORS proxy fetches
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  const allowed = [
    'api.allorigins.win', 'corsproxy.io', 'corsproxy.org', 'api.codetabs.com',
    'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
    'nfs.faireconomy.media', 'web-paragaranti-pubsub.foreks.com',
  ];
  try {
    const urlObj = new URL(url);
    if (isDev || allowed.some(d => urlObj.hostname.includes(d))) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  } catch {
    callback(false);
  }
});
if (isDev) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let mainWindow = null;

function getIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (isDev) {
    return path.join(__dirname, '..', 'public', 'icons', iconName);
  }
  return path.join(__dirname, '..', 'dist', 'icons', iconName);
}

function getNotificationIcon() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (isDev) {
    return path.join(__dirname, '..', 'public', 'icons', iconName);
  }
  return path.join(__dirname, '..', 'dist', 'icons', iconName);
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: Math.min(1440, Math.round(width * 0.92)),
    height: Math.min(960, Math.round(height * 0.92)),
    minWidth: 1024,
    minHeight: 700,
    title: 'BIST AI Trading Terminal',
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#0a0e17',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    }
  });

  // Show window when ready to prevent white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Safety net — if ready-to-show never fires (renderer crash/hang) force-show after 4s
  const forceShowTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn('[Electron] ready-to-show timed out — force showing window');
      mainWindow.show();
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }, 4000);
  mainWindow.once('ready-to-show', () => clearTimeout(forceShowTimer));

  // Log renderer-side failures so a blank window can be diagnosed
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Electron] did-fail-load ${code} ${desc} -> ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Electron] render-process-gone:', details);
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[Electron] preload-error:', preloadPath, error);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[Renderer ${level}] ${message} (${source}:${line})`);
  });

  // Handle permission requests automatically for microphone
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    return permission === 'media';
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Desktop Notifications ──
function showNotification(options) {
  if (!Notification.isSupported()) {
    console.warn('[Electron] Notifications not supported on this system');
    return null;
  }

  const notificationOptions = {
    title: options.title || 'BIST AI Terminal',
    body: options.body || '',
    silent: options.silent || false,
    urgency: options.urgency || 'normal',
    timeoutType: options.timeoutType || 'default',
    icon: options.icon || getIconPath(),
  };

  // Add subtitle if provided
  if (options.subtitle) {
    notificationOptions.subtitle = options.subtitle;
  }

  // Add actions if provided
  if (options.actions && options.actions.length > 0) {
    notificationOptions.actions = options.actions;
  }

  const notification = new Notification(notificationOptions);

  // Click handler - focus window and optionally send event back
  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();

      // Send notification click event back to renderer
      mainWindow.webContents.send('notification-clicked', {
        id: options.id,
        tag: options.tag,
      });
    }
  });

  // Action click handler
  notification.on('action', (event, index) => {
    if (mainWindow) {
      mainWindow.webContents.send('notification-action', {
        id: options.id,
        tag: options.tag,
        actionIndex: index,
        action: options.actions?.[index],
      });
    }
  });

  // Close handler
  notification.on('close', () => {
    console.log('[Electron] Notification closed:', options.id);
  });

  notification.show();
  return notification;
}

// ── IPC Handlers for Notifications ──
ipcMain.handle('notification:show', async (event, options) => {
  try {
    const notification = showNotification(options);
    return { success: true, id: notification?.id };
  } catch (error) {
    console.error('[Electron] Notification error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('notification:isSupported', async () => {
  return Notification.isSupported();
});

// URL-aware referer/origin: each upstream rejects requests with the wrong Referer.
// BigPara → Hurriyet, Yahoo → finance.yahoo.com, IsYatirim → kendi domain'i, vb.
function _refererFor(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('yahoo'))               return 'https://finance.yahoo.com/';
    if (host.includes('bigpara'))             return 'https://bigpara.hurriyet.com.tr/';
    if (host.includes('isyatirim'))           return 'https://www.isyatirim.com.tr/';
    if (host.includes('kap.org'))             return 'https://www.kap.org.tr/';
    if (host.includes('borsa') || host.includes('borsajs')) return 'https://www.borsajs.com/';
    if (host.includes('foreks'))              return 'https://www.foreks.com/';
    if (host.includes('mynet'))               return 'https://finans.mynet.com/';
    if (host.includes('bloomberght'))         return 'https://www.bloomberght.com/';
    if (host.includes('tcmb') || host.includes('evds')) return 'https://www.tcmb.gov.tr/';
    return u.origin + '/';
  } catch { return undefined; }
}

const FETCH_TIMEOUT_MS = 9000;

ipcMain.handle('remote:fetch', async (event, { url, options = {} }) => {
  // Tek deneme + 1 retry (geçici network glitchlerine karşı)
  const attempt = async (attemptNo = 1) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        ...((_refererFor(url) ? { 'Referer': _refererFor(url) } : {})),
        ...options.headers
      };
      const response = await fetch(url, {
        ...options,
        headers,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await response.text();
      return {
        success: response.ok,
        status: response.status,
        text,
      };
    } catch (error) {
      // 429/timeout/network hatasi -> 1x retry (300ms backoff)
      if (attemptNo < 2 && (error.name === 'AbortError' || /network|fetch|timeout|socket/i.test(error.message || ''))) {
        await new Promise(r => setTimeout(r, 300));
        return attempt(attemptNo + 1);
      }
      return { success: false, error: error.message };
    } finally {
      clearTimeout(timer);
    }
  };

  return attempt();
});

// ── Signal Notification Presets ──
ipcMain.handle('notification:signal', async (event, signal) => {
  const typeEmoji = {
    buy: '🟢',
    sell: '🔴',
    strong_buy: '💚',
    strong_sell: '💔',
    watch: '👀',
  };

  const urgencyMap = {
    strong_buy: 'critical',
    strong_sell: 'critical',
    buy: 'normal',
    sell: 'normal',
    watch: 'low',
  };

  const notification = showNotification({
    id: signal.id || `signal-${signal.symbol}-${Date.now()}`,
    tag: `signal-${signal.signal}`,
    title: `${typeEmoji[signal.signal] || '📊'} ${signal.signal.toUpperCase()} — ${signal.symbol}`,
    body: signal.message || `${signal.symbol}: ${signal.signal} sinyal`,
    subtitle: signal.subtitle,
    urgency: urgencyMap[signal.signal] || 'normal',
    silent: signal.silent || false,
    icon: signal.icon,
    data: signal,
  });

  return { success: true, id: notification?.id };
});

ipcMain.handle('notification:alert', async (event, alert) => {
  const typeEmoji = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '🚨',
    critical: '🔴',
  };

  const notification = showNotification({
    id: alert.id || `alert-${Date.now()}`,
    tag: `alert-${alert.type}`,
    title: `${typeEmoji[alert.type] || '🔔'} ${alert.title || 'Alert'}`,
    body: alert.message || alert.body,
    subtitle: alert.subtitle,
    urgency: alert.type === 'critical' || alert.type === 'error' ? 'critical' : 'normal',
    silent: alert.silent || false,
    icon: alert.icon,
    data: alert,
  });

  return { success: true, id: notification?.id };
});

// ── Secure storage (safeStorage → OS keychain) ────────────────────────────
function getSecretsPath() {
  return path.join(app.getPath('userData'), 'secrets.bin');
}
function readSecretsFile() {
  try {
    if (!fs.existsSync(getSecretsPath())) return {};
    const raw = fs.readFileSync(getSecretsPath());
    if (!raw || !raw.length) return {};
    if (!safeStorage.isEncryptionAvailable()) return {};
    const decrypted = safeStorage.decryptString(raw);
    return JSON.parse(decrypted || '{}');
  } catch { return {}; }
}
function writeSecretsFile(obj) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(obj || {}));
    fs.writeFileSync(getSecretsPath(), enc);
    return true;
  } catch { return false; }
}

ipcMain.handle('security:isAvailable', async () => {
  return { available: !!safeStorage?.isEncryptionAvailable?.() };
});
ipcMain.handle('security:set', async (_e, { key, value }) => {
  if (!key) return { success: false, error: 'key required' };
  const data = readSecretsFile();
  data[key] = value;
  return { success: writeSecretsFile(data) };
});
ipcMain.handle('security:get', async (_e, { key }) => {
  const data = readSecretsFile();
  return { value: data[key] ?? null };
});
ipcMain.handle('security:delete', async (_e, { key }) => {
  const data = readSecretsFile();
  delete data[key];
  return { success: writeSecretsFile(data) };
});
ipcMain.handle('security:list', async () => {
  return { keys: Object.keys(readSecretsFile()) };
});

// ── ML Database IPC Bridge ──
// DatabaseManager.js is ESM → must use dynamic import() from CJS
// better-sqlite3 runs in main process; renderer accesses via IPC
import('../src/utils/DatabaseManager.js')
  .then(async ({ registerMLDbIPC }) => {
    await registerMLDbIPC(ipcMain);
  })
  .catch(err => {
    // better-sqlite3 may not be installed yet — graceful degradation
    console.warn('[Electron] ML Database init skipped:', err?.message);
  });

// ── Autonomous ML Training CRON — Friday 20:00 (BIST kapanisindan sonra) ──
// Native JS scheduler — no node-cron dependency needed.
// Runs the full ML pipeline in a forked child_process so the UI never freezes.
// The worker communicates progress + results via IPC messages.

let _mlTrainingWorker = null;
let _lastTrainingDate = null; // "YYYY-MM-DD" — prevent double-runs on same day

function getMLDbPath() {
  try {
    return path.join(app.getPath('userData'), 'bist_ml_engine.db');
  } catch {
    return path.join(process.cwd(), 'data', 'bist_ml_engine.db');
  }
}

function startMLTraining(opts = {}) {
  if (_mlTrainingWorker) {
    console.log('[CRON] ML training already in progress — skipping');
    return false;
  }

  const workerPath = path.join(__dirname, 'ml-training-worker.cjs');
  if (!fs.existsSync(workerPath)) {
    console.error('[CRON] ML training worker not found:', workerPath);
    return false;
  }

  const dbPath = opts.dbPath || getMLDbPath();
  console.log(`[CRON] Starting autonomous ML training (DB: ${dbPath})...`);

  // Notify renderer that training started
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('ml-training-status', {
      status: 'started',
      ts: Date.now(),
      message: '🧠 Otonom Öğrenme başladı...',
    });
  }

  _mlTrainingWorker = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'production' },
  });

  // Capture stdout/stderr for logging
  _mlTrainingWorker.stdout?.on('data', (data) => {
    console.log(`[MLWorker stdout] ${data.toString().trim()}`);
  });
  _mlTrainingWorker.stderr?.on('data', (data) => {
    console.error(`[MLWorker stderr] ${data.toString().trim()}`);
  });

  // Handle messages from worker
  _mlTrainingWorker.on('message', (msg) => {
    if (!msg?.type) return;

    if (msg.type === 'progress') {
      console.log(`[CRON] Phase ${msg.phase}: ${msg.pct}% — ${msg.msg}`);
      if (mainWindow?.webContents) {
        mainWindow.webContents.send('ml-training-status', {
          status: 'progress',
          phase: msg.phase,
          pct: msg.pct,
          message: msg.msg,
        });
      }
    }

    if (msg.type === 'complete') {
      console.log(`[CRON] ML training complete: ${msg.newRules} rules, ${msg.elapsed}s elapsed`);
      _mlTrainingWorker = null;
      _lastTrainingDate = new Date().toISOString().slice(0, 10);

      // Notify renderer
      if (mainWindow?.webContents) {
        mainWindow.webContents.send('ml-training-status', {
          status: 'complete',
          newRules: msg.newRules,
          totalSignals: msg.totalSignals,
          elapsed: msg.elapsed,
          message: `🧠 Otonom Öğrenme Tamamlandı: ${msg.newRules} kural hafızaya eklendi.`,
        });
      }

      // Desktop notification
      showNotification({
        id: `ml-training-${Date.now()}`,
        tag: 'ml-training',
        title: '🧠 Otonom Öğrenme Tamamlandı',
        body: `${msg.newRules} kural keşfedildi/güncellendi (${msg.totalSignals} sinyal, ${msg.elapsed}s)`,
        urgency: 'normal',
      });
    }

    if (msg.type === 'error') {
      console.error('[CRON] ML training error:', msg.message);
      _mlTrainingWorker = null;

      if (mainWindow?.webContents) {
        mainWindow.webContents.send('ml-training-status', {
          status: 'error',
          message: `ML Eğitim hatası: ${msg.message}`,
        });
      }
    }
  });

  _mlTrainingWorker.on('exit', (code) => {
    console.log(`[CRON] ML worker exited with code ${code}`);
    _mlTrainingWorker = null;
  });

  _mlTrainingWorker.on('error', (err) => {
    console.error('[CRON] ML worker spawn error:', err?.message);
    _mlTrainingWorker = null;
  });

  // Send start command to worker
  _mlTrainingWorker.send({
    type: 'start',
    dbPath,
    range: opts.range || '1y',
    interSymbolMs: opts.interSymbolMs || 2000,
    batchSize: opts.batchSize || 10,
  });

  return true;
}

// ── CRON Check: Every 60s, check if it's Friday 20:00 (Turkey time) ──
// BIST closes at 18:00 Turkish time. We train at 20:00 to ensure all data settles.
let _cronInterval = null;

function startCRONScheduler() {
  if (_cronInterval) return;

  _cronInterval = setInterval(() => {
    const now = new Date();
    // Turkey is UTC+3
    const turkeyOffset = 3 * 60; // minutes
    const localMinutes = now.getUTCMinutes() + now.getUTCHours() * 60 + turkeyOffset;
    const turkeyHour = Math.floor((localMinutes % 1440) / 60);
    const turkeyMinute = localMinutes % 60;
    const turkeyDay = now.getUTCDay(); // 0=Sun, 5=Fri

    // Adjust day if Turkey time rolls over midnight
    const turkeyDate = new Date(now.getTime() + turkeyOffset * 60 * 1000);
    const dateStr = turkeyDate.toISOString().slice(0, 10);

    // Friday (day=5), hour=20, first check within the 20:00 window
    if (turkeyDate.getUTCDay() === 5 && turkeyHour === 20 && turkeyMinute < 2) {
      // Prevent double-run on same day
      if (_lastTrainingDate === dateStr) return;

      console.log(`[CRON] Friday 20:00 TR triggered — starting autonomous ML training`);
      startMLTraining();
    }
  }, 60_000); // check every 60 seconds

  console.log('[CRON] ML training scheduler active — Friday 20:00 (TR time)');
}

// ── IPC Handlers for ML Training (manual trigger from renderer) ──
ipcMain.handle('ml-training:start', async (_event, opts = {}) => {
  const started = startMLTraining(opts);
  return { started, message: started ? 'Eğitim başlatıldı' : 'Eğitim zaten devam ediyor' };
});

ipcMain.handle('ml-training:status', async () => {
  return {
    isRunning: _mlTrainingWorker !== null,
    lastTrainingDate: _lastTrainingDate,
  };
});

ipcMain.handle('ml-training:stop', async () => {
  if (_mlTrainingWorker) {
    _mlTrainingWorker.kill('SIGTERM');
    _mlTrainingWorker = null;
    return { stopped: true };
  }
  return { stopped: false, message: 'Aktif eğitim yok' };
});

// Remove default menu in production
if (!isDev) {
  Menu.setApplicationMenu(null);
}

app.whenReady().then(async () => {
  // Always clear code/HTTP cache on startup so stale renderer bundles never linger
  try {
    const { session } = require('electron');
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ['shadercache', 'serviceworkers', 'cachestorage'],
    });
  } catch (err) {
    console.warn('[Electron] cache clear failed:', err?.message);
  }

  createWindow();

  // Start the autonomous ML training CRON scheduler
  startCRONScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
