/**
 * Service worker: makes the app installable and keeps the shell loading fast on
 * a phone. Deliberately conservative - the shell is cached, API calls never are,
 * so a tech is never shown stale ticket data.
 */
const SHELL_CACHE = 'repairs-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache data or auth: always the network, and fail honestly when offline.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth2/')) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')))
  );
});
