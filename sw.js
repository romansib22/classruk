/*
 * Service worker: кэширует приложение целиком, работает офлайн.
 * При изменении файлов — поднять номер версии CACHE.
 */
const CACHE = 'classruk-v2';
const ASSETS = [
  './',
  './index.html',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      // Навигация без кэша (офлайн первый заход) — отдаём оболочку
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html').then((shell) => shell || fetch(event.request));
      }
      return fetch(event.request);
    }),
  );
});
