// BIST AI Trading Terminal — Service Worker (PWA)
import { precacheAndRoute } from 'workbox-precaching';

// Workbox otomatik olarak tüm build asset'lerini buraya inject eder
precacheAndRoute(self.__WB_MANIFEST);

const CACHE_NAME = 'bist-ai-v3';

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && !k.startsWith('workbox-')).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, stale-while-revalidate for non-precached assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // API/data requests: network-first, no cache fallback for financial data
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('yahoo') ||
    url.hostname.includes('anthropic') ||
    url.hostname.includes('bigpara') ||
    url.hostname.includes('isyatirim')
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // HTML navigation: network-first (always get latest SPA shell)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Non-precached assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ── WEB PUSH (v31.27) ──────────────────────────────────────────────────────
// A mobile WebView freezes JS the moment the app is backgrounded — that is an OS
// limit, not something the app can work around. So "notify me when a target is
// hit while the app is closed" cannot be done in the page; it needs a push that
// the OS delivers to the service worker. The payload is produced server-side by
// the scheduled tracking job (scripts/track-signals.mjs).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON body should still surface rather than vanish.
    data = { title: 'BIST Terminal', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'BIST Terminal';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'bist-alert',      // same tag replaces, avoids stacking dupes
    renotify: !!data.renotify,
    data: { url: data.url || '/', symbol: data.symbol || null },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focus an existing window instead of opening a second copy of the app.
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', data: event.notification.data });
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
