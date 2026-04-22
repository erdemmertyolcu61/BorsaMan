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
});
