// Хранилище: ключ, текущий диалог, архив сессий, сохранённые фото.
// Всё в localStorage — у Safari лимит ~5 МБ, поэтому превью фото сильно сжаты,
// а при переполнении вытесняем самые старые записи.

const K_KEY = 'chao.key';
const K_CURRENT = 'chao.current';
const K_SESSIONS = 'chao.sessions';
const K_PHOTOS = 'chao.photos';
const K_TRCACHE = 'chao.trcache';
const K_LIVEMODEL = 'chao.livemodel';
const K_INSTALL = 'chao.install';

const MAX_CURRENT = 300;
const MAX_SESSIONS = 60;
const MAX_PHOTOS = 30;
const MAX_CACHED_TRANSLATIONS = 150;

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false; // скорее всего QuotaExceededError — вызывающий вытеснит старое
  }
}

/// Записать, освобождая место по общему порядку: сначала кэш переводов
/// (восстановим), потом самые старые снимки, потом самые старые разговоры.
/// Раньше «Новый разговор» при забитом хранилище молча стирал старые
/// разговоры, хотя рядом лежали десятки снимков меню.
/// keepPhotos / keepSessions — не трогать свой же список (его режет вызывающий).
/// Сколько пришлось выбросить ради места — чтобы сказать об этом, а не молча.
const evicted = { photos: 0, sessions: 0 };

function writeWithRoom(key, value, { keepPhotos = false, keepSessions = false } = {}) {
  if (write(key, value)) return true;
  if (localStorage.getItem(K_TRCACHE) !== null) {
    localStorage.removeItem(K_TRCACHE);
    if (write(key, value)) return true;
  }
  if (!keepPhotos) {
    const photos = read(K_PHOTOS, []);
    while (photos.length) {
      photos.pop();   // новые в начале списка — убираем с конца
      evicted.photos++;
      write(K_PHOTOS, photos);
      if (write(key, value)) return true;
    }
  }
  if (!keepSessions) {
    const sessions = read(K_SESSIONS, []);
    while (sessions.length) {
      sessions.pop();
      evicted.sessions++;
      write(K_SESSIONS, sessions);
      if (write(key, value)) return true;
    }
  }
  return false;
}

export const store = {
  // --- ключ
  getKey() { return localStorage.getItem(K_KEY) || ''; },
  /// Случайный номер установки — только чтобы посчитать, сколько людей пользуется
  /// приложением. Придуман на этом устройстве, ни с чем не связан; «Удалить всё»
  /// стирает и его (wipe чистит все ключи chao.*).
  getInstallId() {
    let id = '';
    try { id = localStorage.getItem(K_INSTALL) || ''; } catch {}
    if (!/^[0-9a-f]{12}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      try { localStorage.setItem(K_INSTALL, id); } catch {}
    }
    return id;
  },
  getLiveModel() { return localStorage.getItem(K_LIVEMODEL) || ''; },
  setLiveModel(v) { if (v) localStorage.setItem(K_LIVEMODEL, v); else localStorage.removeItem(K_LIVEMODEL); },
  /// Новый ключ — новые лимиты: паузы моделей от старого ключа к нему не относятся.
  setKey(k) {
    if (k.trim() !== this.getKey()) localStorage.removeItem('chao.quota');
    localStorage.setItem(K_KEY, k.trim());
  },
  hasKey() { return this.getKey().length > 10; },

  // --- текущий диалог
  getCurrent() { return read(K_CURRENT, []); },
  /// Разговор дороже кэша и старых снимков: если места не хватило, сначала
  /// выбрасываем восстановимое, и только в крайнем случае режем сам диалог.
  setCurrent(messages) {
    // Неудачи — состояние экрана, а не часть разговора
    let list = messages.filter(m => !m.failed).slice(-MAX_CURRENT);
    if (writeWithRoom(K_CURRENT, list)) return true;
    while (list.length > 10) {
      list = list.slice(Math.ceil(list.length / 2));
      if (write(K_CURRENT, list)) return true;
    }
    return false;
  },

  // --- архив диалогов
  getSessions() { return read(K_SESSIONS, []); },
  /// true — разговор в архиве (или архивировать нечего), false — не хватило места.
  archiveCurrent() {
    const msgs = this.getCurrent().filter(m => !m.failed);
    if (!msgs.length) return true;
    const sessions = this.getSessions();
    sessions.unshift({ id: crypto.randomUUID(), startedAt: msgs[0].ts || Date.now(), messages: msgs });
    // Текущий диалог очищаем ТОЛЬКО после того, как архив реально записан:
    // иначе при переполнении хранилища разговор исчезал бы безвозвратно.
    let list = sessions.slice(0, MAX_SESSIONS);
    let saved = writeWithRoom(K_SESSIONS, list, { keepSessions: true });
    while (!saved && list.length > 1) {
      list = list.slice(0, list.length - 1);   // вытесняем самые старые сессии
      evicted.sessions++;
      saved = write(K_SESSIONS, list);
    }
    if (saved) this.setCurrent([]);
    return saved;
  },
  removeSession(id) {
    write(K_SESSIONS, this.getSessions().filter(s => s.id !== id));
  },
  /// null — разговора нет или текущий некуда сохранить (тогда его не трогаем).
  resumeSession(id) {
    const s = this.getSessions().find(x => x.id === id);
    if (!s) return null;
    if (this.archiveCurrent() === false) return null;
    this.removeSession(id);
    this.setCurrent(s.messages);
    return s.messages;
  },

  // --- фото (меню и документы)
  getPhotos() { return read(K_PHOTOS, []); },
  addPhoto(entry) {
    const photos = this.getPhotos();
    photos.unshift(entry);
    let list = photos.slice(0, MAX_PHOTOS);
    // Снимок дешевле разговора: место берём у кэша и у самых старых снимков,
    // разговоры не трогаем.
    while (list.length && !writeWithRoom(K_PHOTOS, list, { keepPhotos: true, keepSessions: true })) list = list.slice(0, list.length - 1);
  },
  removePhoto(id) {
    write(K_PHOTOS, this.getPhotos().filter(p => p.id !== id));
  },

  // --- кэш переводов: повторную фразу не переводим заново
  getCachedTranslation(text) {
    const key = text.trim().toLowerCase();
    return read(K_TRCACHE, {})[key] || null;
  },
  cacheTranslation(text, result) {
    const cache = read(K_TRCACHE, {});
    cache[text.trim().toLowerCase()] = result;
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHED_TRANSLATIONS) {
      for (const k of keys.slice(0, keys.length - MAX_CACHED_TRANSLATIONS)) delete cache[k];
    }
    write(K_TRCACHE, cache);
  },

  /// Что выброшено ради места с прошлого вызова: { photos, sessions }.
  takeEvicted() {
    const r = { ...evicted };
    evicted.photos = evicted.sessions = 0;
    return r;
  },

  // --- обслуживание
  /// Сколько занято из ~5 МБ Safari. Safari считает строки в UTF-16 —
  /// по два байта на знак, поэтому длина ×2.
  usageKB() {
    let total = 0;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('chao.')) total += (k.length + (localStorage.getItem(k) || '').length) * 2;
    }
    return Math.round(total / 1024);
  },
  wipe() {
    // Включая служебное: метки исчерпанных квот и выбор живой модели —
    // кнопка обещает «удалить всё», значит и следов остаться не должно.
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('chao.')) localStorage.removeItem(k);
    }
  },
};
