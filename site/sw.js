// Service worker: instant repeat visits and offline browsing.
// - Pages and the photo list: network first (always revalidated), cached copy when offline.
// - Hashed app files and previews: cache first (their URLs change when their content does).
// - Originals from raw.githubusercontent.com: cache first, keeping the most recent ones.
const PREVIEWS = 'previews-__PV__';
const CACHES = ['pages', 'assets', PREVIEWS, 'originals'];
const MAX_ORIGINALS = 40;
const scope = new URL(self.registration.scope).pathname;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const key of await caches.keys()) if (!CACHES.includes(key)) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return; // videos stream with Range requests
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(scope)) {
    const path = url.pathname.slice(scope.length);
    if (path === 'version.json') return;
    if (req.mode === 'navigate' || path === '' || path === 'index.html' || path === 'photos.json') {
      e.respondWith(networkFirst(req));
    } else if (path.startsWith('assets/')) {
      e.respondWith(cacheFirst(req, 'assets'));
    } else if (path.startsWith('m/')) {
      e.respondWith(cacheFirst(req, PREVIEWS));
    }
  } else if (url.hostname === 'raw.githubusercontent.com') {
    // Originals shown directly in <img> (Safari, JPEG) are left to the browser: routing them
    // through the worker is slow on iOS. Originals fetched for in-page decoding are kept.
    if (req.destination === 'image') return;
    e.respondWith(cacheFirst(req, 'originals', MAX_ORIGINALS));
  }
});

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
    cache.put(req, res.clone()).then(() => max && trim(cache, max)).catch(() => {});
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys(); // oldest first
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

async function networkFirst(req) {
  const cache = await caches.open('pages');
  try {
    const res = await fetch(req, { cache: 'no-cache' }); // revalidate: avoids GitHub Pages' 10-minute cache
    if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await cache.match(scope)));
    if (hit) return hit;
    throw err;
  }
}
