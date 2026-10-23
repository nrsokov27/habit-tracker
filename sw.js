/* Сначала сеть (чтобы обновления приходили сразу), при отсутствии интернета — кэш. */
var CACHE = 'tracker-v8';
var ASSETS = ['./', './index.html', './style.css', './app.js', './sync.js', './notify.js','./firebase-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // Google/Firebase не трогаем
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(function (res) { // не брать устаревшее из HTTP-кэша (Pages даёт 10 минут)
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () { return caches.match(e.request); })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (list) {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
