/* =============================================
   Trip Planner — Service Worker
   Caches the app shell for offline use, and serves the core trip-data API
   endpoints network-first with a cache fallback so the planner, budget,
   and wishlist stay browsable with no connection. Third-party-backed data
   (weather, recommendations, map tiles) is deliberately not cached — see
   docs/superpowers/specs/2026-07-08-offline-support-design.md.
   ============================================= */

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/i18n.js',
  '/js/offline.js',
  '/js/app.js',
  '/js/timeline.js',
  '/js/recommendations.js',
  '/js/today.js',
  '/js/map.js',
  '/js/budget.js',
  '/js/wishlist.js',
  '/locales/en.json',
  '/locales/es.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const DATA_PATHS = [
  '/api/trip',
  '/api/accommodations',
  '/api/flights',
  '/api/airports',
  '/api/config',
  '/api/budget',
  '/api/wishlist',
];

const DATA_CACHE = 'data-v1';

// Templated server-side (see server.js's /sw.js route) so this file's own
// bytes change on every deploy — that's what makes the browser's SW update
// check (a byte comparison against the previously registered script) fire
// install/activate on the next deploy. The placeholder below only survives
// if this file is ever served as a raw static asset instead of through
// that route.
const COMMIT = '__COMMIT__';
const SHELL_CACHE = `shell-${COMMIT === '__COMMIT__' ? 'dev' : COMMIT}`;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith('shell-') && key !== SHELL_CACHE)
        .map(key => caches.delete(key))
    );
    self.clients.claim();
  })());
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('offline and no cached data for ' + request.url);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (DATA_PATHS.includes(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
