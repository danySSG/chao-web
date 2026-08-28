// Хранилище: ключ, текущий диалог, архив сессий, сохранённые фото.
// Всё в localStorage — у Safari лимит ~5 МБ, поэтому превью фото сильно сжаты,
// а при переполнении вытесняем самые старые записи.

const K_KEY = 'chao.key';
const K_CURRENT = 'chao.current';
const K_SESSIONS = 'chao.sessions';
const K_PHOTOS = 'chao.photos';
const K_TRCACHE = 'chao.trcache';
const K_LIVEMODEL = 'chao.livemodel';

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

export const store = {
  // --- ключ
  getKey() { return localStorage.getItem(K_KEY) || ''; },
  getLiveModel() { return localStorage.getItem(K_LIVEMODEL) || ''; },
  setLiveModel(v) { if (v) localStorage.setItem(K_LIVEMODEL, v); else localStorage.removeItem(K_LIVEMODEL); },
  setKey(k) { localStorage.setItem(K_KEY, k.trim()); },
  hasKey() { return this.getKey().length > 10; },

  // --- текущий диалог
  getCurrent() { return read(K_CURRENT, []); },
  /// Разговор дороже кэша и старых снимков: если места не хватило, сначала
  /// выбрасываем восстановимое, и только в крайнем случае режем сам диалог.
  setCurrent(messages) {
    let list = messages.slice(-MAX_CURRENT);
    if (write(K_CURRENT, list)) return true;
    localStorage.removeItem(K_TRCACHE);
    if (write(K_CURRENT, list)) return true;
    const photos = read(K_PHOTOS, []);
    for (let keep = photos.length - 1; keep >= 0; keep--) {
      write(K_PHOTOS, photos.slice(0, keep));
      if (write(K_CURRENT, list)) return true;
    }
    while (list.length > 10) {
      list = list.slice(Math.ceil(list.length / 2));
      if (write(K_CURRENT, list)) return true;
    }
    return false;
  },

  // --- архив диалогов
  getSessions() { return read(K_SESSIONS, []); },
  archiveCurrent() {
    const msgs = this.getCurrent();
    if (!msgs.length) return;
    const sessions = this.getSessions();
    sessions.unshift({ id: crypto.randomUUID(), startedAt: msgs[0].ts || Date.now(), messages: msgs });
    // Текущий диалог очищаем ТОЛЬКО после того, как архив реально записан:
    // иначе при переполнении хранилища разговор исчезал бы безвозвратно.
    let list = sessions.slice(0, MAX_SESSIONS);
    let saved = write(K_SESSIONS, list);
    while (!saved && list.length > 1) {
      list = list.slice(0, list.length - 1);   // вытесняем самые старые сессии
      saved = write(K_SESSIONS, list);
    }
    if (saved) this.setCurrent([]);
    return saved;
  },
  removeSession(id) {
    write(K_SESSIONS, this.getSessions().filter(s => s.id !== id));
  },
  resumeSession(id) {
    const s = this.getSessions().find(x => x.id === id);
    if (!s) return null;
    this.archiveCurrent();
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
    // При нехватке места выбрасываем самые старые, пока не влезет.
    while (list.length && !write(K_PHOTOS, list)) list = list.slice(0, list.length - 1);
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

  // --- обслуживание
  usageKB() {
    let total = 0;
    for (const k of [K_CURRENT, K_SESSIONS, K_PHOTOS, K_TRCACHE]) {
      total += (localStorage.getItem(k) || '').length;
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
