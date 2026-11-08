import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/globals.css';
import { runFreshRegimeResetSync } from './utils/resetStorage.js';
import { initEngine, engineStats } from './engine/engineCore.js';

// v31.24: run the tracking reset BEFORE the first render. It used to live in an
// App effect, which runs AFTER render — so one malformed tracking record crashed
// the app on load and the reset that would have cleared it never executed. The
// in-memory and SQLite halves still finish inside App; this only guarantees no
// stale or corrupt tracking record is ever read by the first render.
runFreshRegimeResetSync();

// v31.42: Rust/WASM hesap motoru (calcAll + genSignal cekirdegi). Asenkron yuklenir;
// hazir olana kadar ayni sonucu veren JS motoru calisir. Tani: window.__bistEngine()
initEngine().then(() => { window.__bistEngine = engineStats; });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA Service Worker registration — skip under file:// (Electron production)
// v31.48: the old flow reloaded only when a new worker reached 'activated', which
// never happened: the worker had no skipWaiting and sat in 'waiting' while the PWA
// stayed open. Now the worker activates on install, the page checks for updates
// whenever it comes to the foreground, and reloads on controllerchange — but not
// in the middle of a scan (useAIAdvisor sets window.__bistScanActive); then the
// reload waits for the scan to finish.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloadScheduled = false;
  const reloadWhenIdle = () => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    const tryReload = () => {
      if (window.__bistScanActive) { setTimeout(tryReload, 5000); return; }
      window.location.reload();
    };
    tryReload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install (no controller before) is not an update — no reload.
    if (hadController) reloadWhenIdle();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('SW registered:', reg.scope);
      if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      let lastCheck = Date.now();
      const checkForUpdate = () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastCheck < 10 * 60 * 1000) return;
        lastCheck = Date.now();
        reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', checkForUpdate);
      setInterval(checkForUpdate, 30 * 60 * 1000);
    }).catch(err => console.warn('SW registration failed:', err));
  });
}
