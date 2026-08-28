// Service worker: приложение открывается и работает без сети.
// Оболочка (страница, стили, скрипты, иконка) живёт в кэше; запросы к Gemini
// и проверка версии всегда идут в сеть.
const VERSION = '202608281639';
const CACHE = `chao-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/gemini.js',
  './js/audio.js',
  './js/store.js',
  './js/util.js',
  './js/icons.js',
  './js/phrases.js',
  './icon.png',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Версионированные адреса модулей — кэшируем их же, иначе офлайн не соберётся
    const versioned = SHELL.map(p => (p.endsWith('.js') || p.endsWith('.css')) ? `${p}?v=${VERSION}` : p);
    await cache.addAll([...SHELL, ...versioned].map(u => new Request(u, { cache: 'reload' })))
      .catch(() => {}); // офлайн-установка не должна валить SW целиком
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Чужие домены (Gemini API) — только сеть, никогда не кэшируем
  if (url.origin !== self.location.origin) return;

  // Проверка версии — только сеть, иначе обновления не будут находиться
  if (url.pathname.endsWith('version.json')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"version":"offline"}', {
      headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }

  // Навигация: сначала сеть (свежая версия), при её отсутствии — кэш
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Остальное: из кэша мгновенно, параллельно обновляем
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: false });
    const network = fetch(e.request).then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
