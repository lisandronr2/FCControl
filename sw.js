const CACHE = 'fccontrol-v1';
const SHELL = ['./index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Solo cacheamos el "cascarón" de la app. Las búsquedas a Google Sheets
// siempre van directo a la red para no mostrar datos viejos.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (SHELL.some((p) => url.pathname.endsWith(p.replace('./', '')))) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
