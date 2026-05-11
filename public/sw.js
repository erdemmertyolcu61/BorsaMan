// BIST AI Trading Terminal — Service Worker (PWA)
const CACHE_NAME = 'bist-ai-v3-auth-20260503';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon.svg',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: never serve authenticated pages from cache. API/data requests are
// network-first, static assets are cache-first.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and chrome-extension requests
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // API/data requests: network-first
  if (url.pathname.startsWith('/yahoo/') || url.pathname.startsWith('/api/') || url.hostname.includes('yahoo') || url.hostname.includes('anthropic')) {
    event.respondWith(
      fetch(event.request)
    );
    return;
  }

  // Static assets: cache-first, then network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
