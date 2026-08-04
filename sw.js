// Service worker de butterfly — mode hors-ligne léger.
// Met en cache la « coquille » de l'app (pages + icônes) pour qu'elle s'ouvre
// sans réseau. Les cours (/api/*) ne sont PAS mis en cache ici : l'appli garde
// elle-même les derniers résultats dans le navigateur (localStorage).
const CACHE = 'butterfly-v1';
const SHELL = ['/', '/guide', '/manifest.webmanifest', '/favicon.svg',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // cours : réseau uniquement

  // Navigations (/, /guide) : réseau d'abord, cache en secours (jamais de HTML périmé en ligne).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match('/')))
    );
    return;
  }

  // Autres ressources du même domaine : cache d'abord, réseau en secours.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((m) => m || fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => m))
    );
  }
});
