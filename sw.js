// FCControl Service Worker — auto-actualización
// El shell (HTML + assets base) se sirve network-first: si hay conexión,
// siempre se trae la versión más nueva del servidor y se refresca la
// caché; si no hay red, se usa la última copia guardada (modo offline).
// No depende de bumpear una versión a mano: cada visita con conexión
// revisa el servidor.

const CACHE_NAME = 'fccontrol-shell';
const SHELL = ['./index.html', './manifest.json', './icon.svg', './html5-qrcode.min.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting(); // activa la nueva versión de inmediato, sin esperar confirmación
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

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Peticiones externas (Apps Script, Google Fonts, etc.) → directo a la red
  if (url.origin !== self.location.origin) return;

  const isNavigation = req.mode === 'navigate';
  const isShellAsset = SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')));

  if (isNavigation || isShellAsset) {
    // Network-first: intenta traer la versión más nueva; si falla, usa caché
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(isNavigation ? './index.html' : req, clone));
          }
          return res;
        })
        .catch(() => caches.match(isNavigation ? './index.html' : req))
    );
    return;
  }
  // El resto (imágenes, fuentes locales, etc.) → cache-first
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
