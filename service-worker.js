// Pokédex Binder — service worker
// Bump CACHE_VERSION on every deploy to roll out a fresh shell to installed devices.
const CACHE_VERSION = 'pokebinder-v1';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';
const IMAGE_CACHE   = CACHE_VERSION + '-images';

// Local app shell — paths are relative to this file's location (e.g. /recipe-app/).
// If your deployed HTML is named something other than pokemon-binder.html, change it here.
const SHELL = [
  './',
  './pokemon-binder.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Add individually so one missing asset doesn't fail the whole install.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* optional asset missing — ignore */ });
      }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf(CACHE_VERSION) !== 0) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch writes (Firestore .set, etc.)

  const url = new URL(req.url);

  // 1. Firestore + card API — always live network, never cached.
  //    Offline these fail gracefully (Firestore serves its own IndexedDB cache).
  if (url.hostname.indexOf('firestore.googleapis.com') !== -1 ||
      url.hostname.indexOf('firebaseio.com') !== -1 ||
      url.hostname.indexOf('googleapis.com') !== -1 ||
      url.hostname.indexOf('api.pokemontcg.io') !== -1) {
    return; // default browser handling
  }

  // 2. Card images — cache-first. URLs are immutable, so once seen they stay offline.
  if (url.hostname.indexOf('images.pokemontcg.io') !== -1) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // 3. CDN dependencies (Firebase SDK on gstatic, Google Fonts, Tesseract.js) —
  //    stale-while-revalidate so the app can boot offline after the first online load.
  if (url.hostname.indexOf('gstatic.com') !== -1 ||
      url.hostname.indexOf('fonts.googleapis.com') !== -1 ||
      url.hostname.indexOf('jsdelivr.net') !== -1) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // 4. App navigations (the HTML shell) — network-first, fall back to cache.
  //    Network-first means an online open always gets your latest deploy,
  //    while offline still loads the cached shell (no stale-version lock-in).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) {
          return m || caches.match('./pokemon-binder.html');
        });
      })
    );
    return;
  }

  // 5. Anything else same-origin (icons, manifest) — cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

function cacheFirst(req, cacheName) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(cacheName).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      const fetching = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          cache.put(req, res.clone());
        }
        return res;
      }).catch(function () { return hit; });
      return hit || fetching;
    });
  });
}
