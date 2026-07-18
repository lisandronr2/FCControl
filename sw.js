// ── Incrementar CACHE_VERSION en cada nuevo deploy ────────────
const CACHE_VERSION = 'v8';
const CACHE_NAME    = 'fccontrol-' + CACHE_VERSION;
const SHELL = ['./index.html', './manifest.json', './icon.svg', './html5-qrcode.min.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
  // Sin skipWaiting: el nuevo SW espera hasta que el usuario confirme
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// La página envía SKIP_WAITING cuando el usuario hace clic en "Actualizar"
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  // Peticiones externas (Apps Script, Google Fonts) → directo a la red
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
