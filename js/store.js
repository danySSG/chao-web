// Хранилище: ключ, текущий диалог, архив сессий, сохранённые фото.
// Всё в localStorage — у Safari лимит ~5 МБ, поэтому превью фото сильно сжаты,
// а при переполнении вытесняем самые старые записи.

const K_KEY = 'chao.key';
const K_CURRENT = 'chao.current';
const K_SESSIONS = 'chao.sessions';
const K_PHOTOS = 'chao.photos';

const MAX_CURRENT = 300;
const MAX_SESSIONS = 60;
const MAX_PHOTOS = 30;

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
  setKey(k) { localStorage.setItem(K_KEY, k.trim()); },
  hasKey() { return this.getKey().length > 10; },

  // --- текущий диалог
  getCurrent() { return read(K_CURRENT, []); },
  setCurrent(messages) { write(K_CURRENT, messages.slice(-MAX_CURRENT)); },

  // --- архив диалогов
  getSessions() { return read(K_SESSIONS, []); },
  archiveCurrent() {
    const msgs = this.getCurrent();
    if (!msgs.length) return;
    const sessions = this.getSessions();
    sessions.unshift({ id: crypto.randomUUID(), startedAt: msgs[0].ts || Date.now(), messages: msgs });
    write(K_SESSIONS, sessions.slice(0, MAX_SESSIONS));
    this.setCurrent([]);
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

  // --- обслуживание
  usageKB() {
    let total = 0;
    for (const k of [K_CURRENT, K_SESSIONS, K_PHOTOS]) {
      total += (localStorage.getItem(k) || '').length;
    }
    return Math.round(total / 1024);
  },
  wipe() {
    [K_KEY, K_CURRENT, K_SESSIONS, K_PHOTOS].forEach(k => localStorage.removeItem(k));
  },
};
