const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Platform detection
  platform: process.platform,
  isElectron: true,

  // Desktop Notifications API
  notifications: {
    show: (options) => ipcRenderer.invoke('notification:show', options),
    isSupported: () => ipcRenderer.invoke('notification:isSupported'),
    getSettings: () => ipcRenderer.invoke('notification:getSettings'),

    // Pre-built signal notification
    signal: (signal) => ipcRenderer.invoke('notification:signal', signal),

    // Pre-built alert notification
    alert: (alert) => ipcRenderer.invoke('notification:alert', alert),

    // Event listeners for notification interactions
    onClicked: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('notification-clicked', handler);
      return () => ipcRenderer.removeListener('notification-clicked', handler);
    },

    onAction: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('notification-action', handler);
      return () => ipcRenderer.removeListener('notification-action', handler);
    },
  },

  // Secure storage (OS keychain via safeStorage)
  security: {
    isAvailable: () => ipcRenderer.invoke('security:isAvailable'),
    set: (key, value) => ipcRenderer.invoke('security:set', { key, value }),
    get: (key) => ipcRenderer.invoke('security:get', { key }),
    delete: (key) => ipcRenderer.invoke('security:delete', { key }),
    list: () => ipcRenderer.invoke('security:list'),
  },

  // Window control (optional)
  window: {
    minimize: () => {
      const { getCurrentWindow } = require('electron');
      getCurrentWindow().minimize();
    },
    maximize: () => {
      const { getCurrentWindow } = require('electron');
      const win = getCurrentWindow();
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    },
    close: () => {
      const { getCurrentWindow } = require('electron');
      getCurrentWindow().close();
    },
    isMaximized: () => {
      const { getCurrentWindow } = require('electron');
      return getCurrentWindow().isMaximized();
    },
  },

  // App info
  getAppInfo: () => ({
    version: '2.0.0',
    platform: process.platform,
  }),
  
  // Remote Fetch bridge
  remoteFetch: (url, options) => ipcRenderer.invoke('remote:fetch', { url, options }),

  // ML Database bridge (better-sqlite3 in main process)
  mlDb: {
    insertSignals:   (signals)          => ipcRenderer.invoke('mldb:insertSignals', signals),
    updateOutcomes:  (outcomes)          => ipcRenderer.invoke('mldb:updateOutcomes', outcomes),
    getOpenSignals:  (limit)             => ipcRenderer.invoke('mldb:getOpenSignals', limit),
    getClosedSignals:(filters)           => ipcRenderer.invoke('mldb:getClosedSignals', filters),
    getStats:        ()                  => ipcRenderer.invoke('mldb:getStats'),
    getTopRules:     (limit, min)        => ipcRenderer.invoke('mldb:getTopRules', limit, min),
    upsertRules:     (rules)             => ipcRenderer.invoke('mldb:upsertRules', rules),
    getFeatureBuckets:(feat, bs, dir)    => ipcRenderer.invoke('mldb:getFeatureBuckets', feat, bs, dir),
    getFeatureImportance: ()             => ipcRenderer.invoke('mldb:getFeatureImportance'),
    updateFeatureImportance: (features)  => ipcRenderer.invoke('mldb:updateFeatureImportance', features),
    prune:           (months)            => ipcRenderer.invoke('mldb:prune', months),
  },

  // Paper Trading (SQLite-backed forward testing)
  paperDb: {
    getPortfolio:    ()                       => ipcRenderer.invoke('paper:getPortfolio'),
    updatePortfolio: (patch)                  => ipcRenderer.invoke('paper:updatePortfolio', patch),
    openTrade:       (trade)                  => ipcRenderer.invoke('paper:openTrade', trade),
    closeTrade:      (id, price, reason)      => ipcRenderer.invoke('paper:closeTrade', id, price, reason),
    getOpenTrades:   ()                       => ipcRenderer.invoke('paper:getOpenTrades'),
    getClosedTrades: (limit)                  => ipcRenderer.invoke('paper:getClosedTrades', limit),
    getStats:        ()                       => ipcRenderer.invoke('paper:getStats'),
    reset:           ()                       => ipcRenderer.invoke('paper:reset'),
  },

  // ML Autonomous Training (background worker management)
  mlTraining: {
    start:  (opts)    => ipcRenderer.invoke('ml-training:start', opts),
    status: ()        => ipcRenderer.invoke('ml-training:status'),
    stop:   ()        => ipcRenderer.invoke('ml-training:stop'),
    // Subscribe to training progress/completion events from main process
    onStatus: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('ml-training-status', handler);
      return () => ipcRenderer.removeListener('ml-training-status', handler);
    },
  },
});
