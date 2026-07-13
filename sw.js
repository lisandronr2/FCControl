// FCControl Service Worker
// Auto-update: compara el ETag/Last-Modified de index.html para detectar cambios
// No necesita CACHE_VERSION manual — se actualiza solo en cada deploy.

const CACHE_NAME = 'fccontrol-shell';
const SHELL = ['./index.html', './manifest.json', './icon.svg', './html5-qrcode.min.js'];

// ── Install: precachear el shell ──────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))
  );
  self.skipWaiting(); // activa inmediatamente
});

// ── Activate: borrar cachés viejas ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first para el shell, cache-first para el resto ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Peticiones externas (Apps Script, Fonts) → directo a la red
  if (!url.origin.startsWith(self.location.origin.split('//')[0] + '//' + self.location.hostname)) return;

  const isShell = SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')));

  if (isShell) {
    // Network-first: intenta traer la versión más nueva; si falla, usa caché
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
  // El resto (imágenes, fuentes locales, etc.) → cache-first
});

// ── Mensaje SKIP_WAITING (compatibilidad con banner manual) ──
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
