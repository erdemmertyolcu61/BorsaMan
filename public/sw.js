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
