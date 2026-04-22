const { app, BrowserWindow, screen, shell, Menu, Notification, ipcMain, safeStorage } = require('electron');
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

ipcMain.handle('remote:fetch', async (event, { url, options = {} }) => {
  try {
    // Merge standard browser headers to bypass strict firewalls (BigPara/Yahoo)
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': 'https://bigpara.hurriyet.com.tr/',
      ...options.headers
    };

    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    
    return {
      success: response.ok,
      status: response.status,
      text: text,
    };
  } catch (error) {
    console.error('[Electron Main] Remote fetch error:', error);
    return { success: false, error: error.message };
  }
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
