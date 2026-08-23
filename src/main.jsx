import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/globals.css';
import { runFreshRegimeResetSync } from './utils/resetStorage.js';

// v31.24: run the tracking reset BEFORE the first render. It used to live in an
// App effect, which runs AFTER render — so one malformed tracking record crashed
// the app on load and the reset that would have cleared it never executed. The
// in-memory and SQLite halves still finish inside App; this only guarantees no
// stale or corrupt tracking record is ever read by the first render.
runFreshRegimeResetSync();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA Service Worker registration — skip under file:// (Electron production)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('SW registered:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        });
      });
    }).catch(err => console.warn('SW registration failed:', err));
  });
}
