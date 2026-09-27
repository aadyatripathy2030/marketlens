// ChartGauge service worker.
//
// Deliberately minimal. Its only jobs are to make the app installable and to
// show something other than the browser's error page when the connection
// drops. It caches NOTHING that can go stale and be wrong: no API responses,
// no prices, no HTML. Serving a cached chart would be indistinguishable from a
// live one, which is the failure mode this project keeps having to remove.
const CACHE = 'chartgauge-shell-v1';
const SHELL = ['/offline.html', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // never touch third parties
  if (url.pathname.startsWith('/api/')) return;         // never cache or replay data

  // Everything goes to the network. Only a navigation that fails falls back,
  // and only to a page that says plainly that you are offline.
  e.respondWith(
    fetch(req).catch(() => {
      if (req.mode === 'navigate') return caches.match('/offline.html');
      return caches.match(req);
    })
  );
});
