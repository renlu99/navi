const CACHE_NAME = 'personal-shortcuts-shell-v2';
const ICON_CACHE_NAME = 'personal-shortcuts-icons-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => ![CACHE_NAME, ICON_CACHE_NAME].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith('/api.php') && url.searchParams.get('action') === 'icon') {
    event.respondWith(caches.open(ICON_CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }).catch(() => fetch(event.request)));
    return;
  }
  if (url.pathname.endsWith('/api.php')) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html'))));
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'prune-icon-cache') return;
  const activeUrls = new Set(event.data.urls || []);
  event.waitUntil(caches.open(ICON_CACHE_NAME).then(async (cache) => {
    const requests = await cache.keys();
    await Promise.all(requests.filter((request) => !activeUrls.has(request.url)).map((request) => cache.delete(request)));
  }));
});
