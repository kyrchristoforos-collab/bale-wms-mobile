
const CACHE = 'bale-wms-mobile-v3';

const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon.svg',
  './suppliers.txt'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(key => key.startsWith('bale-wms-mobile-') && key !== CACHE)
          .map(key => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }

          return response;
        } catch (error) {
          const cached = await caches.match(request);

          if (cached) return cached;

          // Επιστρέφουμε index.html μόνο για σελίδες,
          // ποτέ για suppliers.txt ή άλλα αρχεία.
          if (request.mode === 'navigate') {
            const page = await caches.match('./index.html');
            if (page) return page;
          }

          return new Response('Offline - αρχείο μη διαθέσιμο', {
            status: 503,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8'
            }
          });
        }
      })()
    );
    return;
  }

  if (
    url.hostname === 'unpkg.com' ||
    url.hostname === 'www.gstatic.com'
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;

        return fetch(request).then(async response => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }

          return response;
        });
      })
    );
  }
});
