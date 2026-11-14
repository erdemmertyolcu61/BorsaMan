/**
 * proxyEngine.js - Proxy status and configuration
 */

export function isElectron() {
  return typeof window !== 'undefined' && window.electronAPI;
}

