// Service Worker for RemoteCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
// Bump when the caching rules change: `activate` deletes every other cache, which also
// purges entries poisoned by an older worker.
const CACHE_NAME = 'claude-ui-v4';
const urlsToCache = [
  '/manifest.json'
];

// An update replaces the build directory in place, so an asset the current page (or a
// newly opened Remote tab) asks for can answer 404 for a moment. Retry for ~2.5s instead
// of handing that failure to the page. Only a 200 is ever cached; retries bypass the HTTP
// cache so a previously cached 404 cannot win.
const ASSET_RETRY_DELAYS_MS = [300, 700, 1500];
const fetchAsset = (request) => {
  const attempt = (index, bypassHttpCache) => {
    const init = bypassHttpCache ? { cache: 'no-store' } : undefined;
    return fetch(request, init).then(response => {
      // An older server answers a missing asset with the SPA HTML at 200. Treat that as
      // a failure too: caching it as JS would raise a MIME error on every later load.
      const htmlFallback = response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || '');
      const retryable = response.status === 404 || response.status >= 500 || htmlFallback;
      if (!retryable || index >= ASSET_RETRY_DELAYS_MS.length) return response;
      return new Promise(resolve => setTimeout(resolve, ASSET_RETRY_DELAYS_MS[index]))
        .then(() => attempt(index + 1, true));
    });
  };
  return attempt(0, false);
};

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching. `no-store`
  // also bypasses the HTTP cache, so a normal reload picks up a new build instead
  // of a cached document that points at the previous bundle.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build.
  // Only a 200 is cached; a transient 404/5xx is retried by fetchAsset above.
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetchAsset(event.request).then(response => {
          const htmlFallback = /text\/html/i.test(response.headers.get('content-type') || '');
          if (response.status === 200 && !htmlFallback) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first. When the network fails and nothing is cached, answer with a
  // proper network error: `respondWith(undefined)` raises "Failed to convert value to 'Response'".
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(cached => cached || Response.error())
    )
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'RemoteCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'RemoteCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
