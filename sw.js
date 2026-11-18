// Service worker: приложение открывается и работает без сети.
// Оболочка (страница, стили, скрипты, иконка) живёт в кэше; запросы к Gemini
// и проверка версии всегда идут в сеть.
const VERSION = '202611181805';
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
  './js/illustrations.js',
  './icon.png',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Версионированные адреса модулей — кэшируем их же, иначе офлайн не соберётся
    const versioned = SHELL.map(p => (p.endsWith('.js') || p.endsWith('.css')) ? `${p}?v=${VERSION}` : p);
    // По одному, а не addAll: иконка или манифест, не скачавшиеся с первого раза,
    // не должны валить установку. Но без страницы, стилей и модулей этой сборки
    // установку проваливаем: иначе activate сотрёт полный старый кэш, а новый
    // останется дырявым — и следующий запуск без сети не откроется. Браузер
    // повторит установку сам при следующей проверке. Что все файлы SHELL
    // существуют, сверяет build.sh.
    const failed = [];
    await Promise.all([...SHELL, ...versioned].map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(() => failed.push(u))));
    const essential = failed.filter(u => u === './index.html' || u.includes('?v='));
    if (essential.length) {
      await caches.delete(CACHE);
      throw new Error(`оболочка не скачалась: ${essential.join(', ')}`);
    }
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

  // Проверка версии идёт мимо SW, прямо в сеть: без сети она должна честно
  // упасть. Подставной ответ приложение принимало за новую версию.
  if (url.pathname.endsWith('version.json')) return;

  // Навигация: свежая страница из сети, но ждём её недолго — при «сеть есть,
  // данных нет» fetch висит до минуты, хотя оболочка лежит в кэше.
  if (e.request.mode === 'navigate') {
    const network = fetch(e.request);
    // В кэш — только удачный ответ и только сама оболочка: страница ошибки
    // сервера не должна стать офлайн-версией. Ответ, пришедший после таймера,
    // тоже сохраняем — пригодится при следующем запуске.
    const isShell = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    e.waitUntil(network.then(async (fresh) => {
      if (!fresh.ok || !isShell) return;
      const copy = fresh.clone(), probe = fresh.clone();
      // И только страницу своей сборки: страница новой ссылается на модули,
      // которых в этом кэше нет, — без сети открылся бы пустой экран.
      if (!(await probe.text()).includes(`?v=${VERSION}`)) return;
      return (await caches.open(CACHE)).put('./index.html', copy);
    }).catch(() => {}));
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      // Первый запуск: в кэше ничего нет — ждём сеть сколько потребуется
      if (!cached) return network.catch(() => Response.error());
      // ?v= с чужой версией — перезагрузка ради обновления: нужна именно новая
      // страница. Своя версия (адрес остаётся и после обновления) — она уже в кэше.
      const v = url.searchParams.get('v');
      const wait = v && v !== VERSION ? 20000 : 2500;
      const timer = new Promise((r) => setTimeout(r, wait, null));
      try {
        const fresh = await Promise.race([network, timer]);
        return fresh && (fresh.ok || fresh.type === 'opaqueredirect') ? fresh : cached;
      } catch {
        return cached;
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
