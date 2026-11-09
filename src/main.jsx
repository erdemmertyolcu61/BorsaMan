import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/globals.css';
import { runFreshRegimeResetSync } from './utils/resetStorage.js';
import { initEngine, engineStats } from './engine/engineCore.js';
import { BUILD } from './utils/buildInfo.js';
import { markUpdateCheckDone, setUpdatePending, announceUpdate, isNewerBuild } from './utils/appUpdate.js';

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
// v31.48: the worker activates on install (skipWaiting) and the page reloads on
// controllerchange, deferring while a scan runs.
// v31.52 ("mobilde direkt güncellenmedi"): the auto-scan started at mount, BEFORE the
// worker found the new build, so every update waited for a 10-20 min scan. Now the
// auto-scans wait for this startup check (utils/appUpdate gate), the page checks on
// every return to the foreground (was: at most every 10 min), a pending update is
// shown as a banner instead of waiting silently, and /version.json catches a worker
// that never picks the new build up.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloadScheduled = false;
  const reloadWhenIdle = () => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    setUpdatePending(true);
    const tryReload = () => {
      if (window.__bistScanActive) { announceUpdate('scan'); setTimeout(tryReload, 5000); return; }
      window.location.reload();
    };
    tryReload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install (no controller before) is not an update — no reload.
    if (hadController) reloadWhenIdle();
  });

  // A new worker found: mark the update pending so no new auto-scan starts, and
  // resolve once it has activated (→ controllerchange → reload) or failed.
  const followNewWorker = (reg) => new Promise((resolve) => {
    const w = reg.installing || reg.waiting;
    if (!w) { resolve(false); return; }
    if (hadController) {
      setUpdatePending(true);
      // A worker that never finishes installing must not block auto-scans for good.
      setTimeout(() => { if (!reloadScheduled) setUpdatePending(false); }, 60 * 1000);
    }
    if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    const done = () => {
      if (w.state === 'activated') resolve(true);
      else if (w.state === 'redundant') { setUpdatePending(false); resolve(false); }
      // Installed but not active: an older worker busy with a running scan's requests
      // (pre-v31.52 workers intercepted them) holds it back. Say so instead of
      // waiting silently; "Şimdi yenile" ends the scan and lets it activate.
      else if (w.state === 'installed' && hadController && window.__bistScanActive) announceUpdate('scan');
    };
    w.addEventListener('statechange', done);
    done();
  });

  let beaconTimer = null;
  const checkBeacon = async () => {
    if (!import.meta.env.PROD) return;
    try {
      const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const remote = await r.json();
      if (!isNewerBuild(remote, BUILD)) return;
      // Normal path: the worker update below installs it and the page reloads. If
      // nothing has happened 25 s later, the worker is stuck — offer a hard refresh.
      clearTimeout(beaconTimer);
      beaconTimer = setTimeout(() => { if (!reloadScheduled) announceUpdate('stuck', remote); }, 25000);
    } catch { /* çevrimdışı */ }
  };

  navigator.serviceWorker.register('/sw.js').then(async (reg) => {
    console.log('SW registered:', reg.scope);
    // Startup: an explicit fresh check; auto-scans wait for it (max ~10 s).
    try { await reg.update(); } catch { /* çevrimdışı */ }
    reg.addEventListener('updatefound', () => { followNewWorker(reg); });
    await Promise.race([followNewWorker(reg), new Promise((r) => setTimeout(r, 8000))]);
    markUpdateCheckDone();
    checkBeacon();

    let lastCheck = Date.now();
    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < 60 * 1000) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});
      checkBeacon();
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
    setInterval(checkForUpdate, 15 * 60 * 1000);
  }).catch((err) => {
    console.warn('SW registration failed:', err);
    markUpdateCheckDone();
  });
} else {
  markUpdateCheckDone();
}
