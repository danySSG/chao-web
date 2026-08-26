// Chào! — веб-версия. Диалог (живой перевод, запись, текст), фото, история, настройки.

import { store } from './store.js?v=202608261444';
import { gemini, LiveSession } from './gemini.js?v=202608261444';
import { Microphone, Player, speaker, compressImage, audioContext } from './audio.js?v=202608261444';
import { log, toast, isMostlyCyrillic, fmtDate, plural, haptic } from './util.js?v=202608261444';
import { iconSVG, renderIcons } from './icons.js?v=202608261444';
import { PHRASES } from './phrases.js?v=202608261444';

const $ = (id) => document.getElementById(id);
const VERSION = '202608261444';

const mic = new Microphone();
const player = new Player(onModelSpeaking);
let live = null;
let liveOn = false;
let recording = false;
let busy = false;
let wakeLock = null;
let messages = store.getCurrent();

// Текущее фото
let photo = { dataUrl: null, result: null, order: new Map() };

// ------------------------------------------------------------------ запуск

function boot() {
  $('version').textContent = VERSION;
  log(`старт · ${matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'приложение с домашнего экрана' : 'браузер'}`);

  if (store.hasKey()) showApp(); else showOnboarding();

  // онбординг
  $('obKey').addEventListener('input', (e) => {
    $('obSave').disabled = e.target.value.trim().length < 20;
  });
  $('obSave').addEventListener('click', () => {
    store.setKey($('obKey').value);
    showApp();
    toast('Ключ сохранён. Можно говорить!');
  });

  // вкладки
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // диалог
  $('liveBtn').addEventListener('click', toggleLive);
  $('micBtn').addEventListener('click', toggleRecording);
  $('sendBtn').addEventListener('click', sendText);
  $('textInput').addEventListener('input', (e) => {
    const has = e.target.value.trim().length > 0;
    $('sendBtn').classList.toggle('hidden', !has);
    $('micBtn').classList.toggle('hidden', has);
    $('liveBtn').classList.toggle('hidden', has);
  });
  $('textInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
  $('statusAction').addEventListener('click', () => { if (liveOn) stopLive(); else if (recording) cancelRecording(); });
  $('newBtn').addEventListener('click', newSession);
  $('histBtn').addEventListener('click', () => openHistory('dialogs'));
  $('phrasesBtn').addEventListener('click', openPhrases);
  $('phrasesClose').addEventListener('click', () => $('phrases').classList.add('hidden'));

  addEventListener('online', updateNetworkState);
  addEventListener('offline', updateNetworkState);
  updateNetworkState();
  registerServiceWorker();

  // фото
  $('cameraBtn').addEventListener('click', () => $('fileCamera').click());
  $('galleryBtn').addEventListener('click', () => $('fileGallery').click());
  $('fileCamera').addEventListener('change', (e) => handlePhoto(e.target.files[0]));
  $('fileGallery').addEventListener('change', (e) => handlePhoto(e.target.files[0]));
  $('orderBtn').addEventListener('click', showOrder);

  // история
  $('histClose').addEventListener('click', () => $('history').classList.add('hidden'));
  document.querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => openHistory(b.dataset.seg)));

  // полноэкранный показ
  $('bigClose').addEventListener('click', () => $('bigView').classList.add('hidden'));
  $('bigFlip').addEventListener('click', () => { $('bigInner').classList.toggle('flipped'); haptic(12); });

  // настройки
  $('setKey').value = store.getKey();
  $('setSave').addEventListener('click', () => {
    const v = $('setKey').value.trim();
    if (v.length < 20) { toast('Ключ выглядит слишком коротким'); return; }
    store.setKey(v);
    $('setStatus').textContent = 'Ключ сохранён.';
    toast('Ключ сохранён');
  });
  $('setCheck').addEventListener('click', checkKey);
  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('Удалить ключ и всю историю с этого устройства?')) return;
    store.wipe();
    messages = [];
    location.reload();
  });

  // фоновый режим: iOS всё равно отрежет микрофон — выключаем живой режим честно
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && liveOn) { stopLive(); toast('Живой перевод выключен: приложение свернули'); }
    if (!document.hidden) checkForUpdate();
  });

  $('updateBtn').addEventListener('click', () => checkForUpdate(true));

  renderIcons();
  checkForUpdate();
  renderFeed();
  updateStorageInfo();
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

/** Сверяет свою версию с серверной: iOS-кэш обновляет файлы вразнобой,
 *  поэтому при расхождении перезагружаемся принудительно со свежим адресом. */
async function checkForUpdate(manual) {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await res.json();
    if (!version || version === 'dev') return;
    if (version === VERSION) {
      if (manual) toast('У вас последняя версия');
      return;
    }
    log(`обновление: ${VERSION} → ${version}`);
    if (manual) toast('Обновляю…');
    // Сбрасываем всё, что мог закэшировать браузер, и грузим свежий index.html
    if (window.caches) { for (const k of await caches.keys()) await caches.delete(k); }
    setTimeout(() => location.replace(`index.html?v=${version}`), manual ? 400 : 900);
  } catch (e) {
    if (manual) toast('Не удалось проверить обновления');
  }
}

function updateNetworkState() {
  const off = !navigator.onLine;
  $('offlineBar').classList.toggle('hidden', !off);
  if (off) log('сеть пропала — доступен разговорник');
}

/** Оболочка приложения кладётся в кэш, чтобы оно открывалось без интернета. */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
    log('офлайн-режим готов');
  } catch (e) {
    log('service worker не зарегистрирован: ' + e.message);
  }
}

// ------------------------------------------------------------------ разговорник

function openPhrases() {
  const box = $('phrasesContent');
  box.innerHTML = '';
  for (const group of PHRASES) {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = group.title.toUpperCase();
    box.appendChild(title);
    for (const [ru, vi] of group.items) {
      const el = document.createElement('button');
      el.className = 'phrase';
      el.innerHTML = `<span class="ph-ru"></span><span class="ph-vi"></span><span class="ph-speak" data-icon="speaker" data-icon-size="18"></span>`;
      el.querySelector('.ph-ru').textContent = ru;
      el.querySelector('.ph-vi').textContent = vi;
      el.addEventListener('click', () => usePhrase(ru, vi));
      box.appendChild(el);
    }
  }
  renderIcons(box);
  $('phrases').classList.remove('hidden');
}

/** Фраза из разговорника: озвучиваем, кладём в ленту и открываем крупно. */
function usePhrase(ru, vi) {
  haptic(12);
  speaker.speak(vi, 'vi-VN');
  const message = { id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: 'ru', transcript: ru, translation: vi };
  addMessage(message);
  $('phrases').classList.add('hidden');
  openBig(message);
}

function showOnboarding() { $('onboarding').classList.remove('hidden'); $('app').classList.add('hidden'); }
function showApp() { $('onboarding').classList.add('hidden'); $('app').classList.remove('hidden'); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ['dialog', 'photo', 'settings'].forEach(t => $(`tab-${t}`).classList.toggle('hidden', t !== name));
  if (name === 'settings') updateStorageInfo();
}

// ------------------------------------------------------------------ диалог

function addMessage(msg) {
  messages.push(msg);
  store.setCurrent(messages);
  renderFeed();
}

function renderFeed() {
  const feed = $('feed');
  if (!messages.length) {
    feed.innerHTML = `<div class="empty">
      <div class="empty-icon">${iconSVG('chat', 52)}</div><h3>Chào!</h3>
      <p>Скажите фразу по-русски — озвучу её по-вьетнамски. Собеседник ответит в микрофон — вы прочтёте по-русски.</p>
      <div class="chip">Волна — живой перевод без пауз</div></div>`;
    return;
  }
  feed.innerHTML = '';
  for (const m of messages) {
    const el = document.createElement('div');
    el.className = `msg ${m.sourceLanguage === 'ru' ? 'mine' : 'theirs'}${m.pending ? ' pending' : ''}`;
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = m.transcript || 'живой перевод';
    const tr = document.createElement('div');
    tr.className = 'tr';
    tr.textContent = m.translation;
    el.append(src, tr);
    el.addEventListener('click', () => openBig(m));
    feed.appendChild(el);
  }
  feed.scrollTop = feed.scrollHeight;
}

function openBig(m) {
  $('bigInner').classList.remove('flipped');
  $('bigSrc').textContent = m.transcript || '';
  $('bigTr').textContent = m.translation;
  const lang = isMostlyCyrillic(m.translation) ? 'ru-RU' : 'vi-VN';
  $('bigSpeak').onclick = () => speaker.speak(m.translation, lang);
  $('bigView').classList.remove('hidden');
}

function contextSnippet() {
  return messages.slice(-6).map(m => `[${m.sourceLanguage}] ${m.transcript} → ${m.translation}`).join('\n');
}

function setStatus(text, cls, actionLabel) {
  const line = $('statusLine');
  if (!text) { line.classList.add('hidden'); return; }
  line.className = `statusline ${cls || ''}`;
  $('statusText').textContent = text;
  $('statusAction').textContent = actionLabel || 'Выключить';
  $('statusAction').classList.toggle('hidden', !actionLabel);
}

function showBanner(on, rec) {
  const b = $('speakBanner');
  b.classList.toggle('on', on);
  b.classList.toggle('rec', !!rec);
}

// --- живой режим

async function toggleLive() {
  if (liveOn) { stopLive(); return; }
  if (recording) return;

  $('liveBtn').disabled = true;
  setStatus('подключаюсь…', 'busy');
  try {
    await mic.start();
  } catch (e) {
    log(`микрофон отказ: ${e.name} — ${e.message}`);
    setStatus('нет доступа к микрофону', 'err', null);
    toast('Разрешите доступ к микрофону');
    $('liveBtn').disabled = false;
    return;
  }

  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  player.reset();
  speaker.stop();
  mic.muted = false;

  live = new LiveSession({
    onTurn: handleLiveTurn,
    onAudio: (b64) => player.enqueue(b64),
    onInterrupted: () => player.flush(),
    onState: (s) => {
      if (s === 'listening') { setStatus('слушаю — говорите на любом языке', 'live'); showBanner(!mic.muted); }
      else if (s === 'reconnecting') { setStatus('переподключаюсь…', 'busy'); showBanner(false); }
      else if (s === 'connecting') setStatus('подключаюсь…', 'busy');
    },
    onError: (msg) => { toast(msg); stopLive(); },
  });
  live.start();
  mic.onChunk = (b64) => live?.sendAudio(b64);

  liveOn = true;
  haptic([10, 40, 10]);
  $('liveBtn').disabled = false;
  $('liveBtn').classList.add('on');
  $('micBtn').disabled = true;
}

function stopLive() {
  liveOn = false;
  live?.stop();
  live = null;
  mic.onChunk = null;
  mic.stop();
  player.reset();
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
  $('liveBtn').classList.remove('on');
  $('micBtn').disabled = false;
  showBanner(false);
  setStatus('');
}

function onModelSpeaking(speaking) {
  mic.muted = speaking;
  if (liveOn) showBanner(!speaking);
}

function handleLiveTurn(transcript, translation) {
  const text = translation.trim();
  if (!text) return;
  const translationIsRu = isMostlyCyrillic(text);
  const transcriptIsRu = transcript ? isMostlyCyrillic(transcript) : !translationIsRu;

  // Дрейф модели: «перевод» на языке оригинала — чиним через REST.
  if (transcript && transcriptIsRu === translationIsRu) {
    log('дрейф: перевод на языке оригинала, отправляю в REST');
    repairTurn(transcript);
    return;
  }
  addMessage({
    id: crypto.randomUUID(), ts: Date.now(),
    sourceLanguage: translationIsRu ? 'vi' : 'ru',
    transcript: transcript || '', translation: text,
  });
}

async function repairTurn(transcript) {
  try {
    const r = await gemini.translateText(transcript, contextSnippet());
    addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: r.sourceLanguage, transcript: r.transcript, translation: r.translation });
    if (r.sourceLanguage === 'ru') speaker.speak(r.translation, 'vi-VN');
  } catch (e) {
    addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: isMostlyCyrillic(transcript) ? 'ru' : 'vi', transcript, translation: transcript });
  }
}

// --- запись фразы (обычный режим)

async function toggleRecording() {
  if (liveOn) return;
  if (recording) {
    haptic(14);
    recording = false;
    $('micBtn').classList.remove('rec');
    $('micBtn').innerHTML = iconSVG('mic', 25);
    showBanner(false);
    const wav = mic.stopRecording();
    mic.stop();
    setStatus('');
    if (!wav) { toast('Слишком коротко — скажите фразу целиком'); return; }
    await translateAndAdd(() => gemini.translateAudio(wav, contextSnippet()));
    return;
  }
  try {
    await mic.start();
  } catch (e) {
    toast('Разрешите доступ к микрофону');
    return;
  }
  mic.startRecording();
  haptic(14);
  recording = true;
  $('micBtn').classList.add('rec');
  $('micBtn').innerHTML = iconSVG('stop', 24);
  showBanner(true, true);
  setStatus('идёт запись — нажмите ещё раз, когда закончите', '', 'Отмена');
}

function cancelRecording() {
  if (!recording) return;
  recording = false;
  mic.stopRecording();
  mic.stop();
  $('micBtn').classList.remove('rec');
  $('micBtn').innerHTML = iconSVG('mic', 25);
  showBanner(false);
  setStatus('');
}

async function sendText() {
  const text = $('textInput').value.trim();
  if (!text || busy) return;
  $('textInput').value = '';
  $('sendBtn').classList.add('hidden');
  $('micBtn').classList.remove('hidden');
  $('liveBtn').classList.remove('hidden');
  await translateAndAdd(() => gemini.translateText(text, contextSnippet()));
}

async function translateAndAdd(fn) {
  busy = true;
  setStatus('перевожу…', 'busy', null);
  try {
    const r = await fn();
    addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: r.sourceLanguage, transcript: r.transcript, translation: r.translation });
    if (r.sourceLanguage === 'ru') speaker.speak(r.translation, 'vi-VN');
    setStatus('');
  } catch (e) {
    setStatus('');
    toast(e.message);
    log(`перевод не удался: ${e.message}`);
  } finally {
    busy = false;
  }
}

function newSession() {
  if (!messages.length) return;
  speaker.stop();
  store.setCurrent(messages);
  store.archiveCurrent();
  messages = [];
  renderFeed();
  toast('Разговор сохранён в историю');
}

// ------------------------------------------------------------------ фото

async function handlePhoto(file) {
  if (!file) return;
  photo = { dataUrl: null, result: null, order: new Map() };
  $('orderBtn').classList.add('hidden');
  $('photoResult').innerHTML = `<div class="loading"><div class="spinner"></div>Готовлю снимок…</div>`;

  try {
    const { dataUrl, base64 } = await compressImage(file);
    photo.dataUrl = dataUrl;
    renderPhoto();
    const result = await gemini.translatePhoto(base64);
    photo.result = result;
    savePhotoToHistory(dataUrl, result);
    renderPhoto();
  } catch (e) {
    log(`фото: ${e.message}`);
    $('photoResult').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
  }
}

async function savePhotoToHistory(dataUrl, result) {
  try {
    // Для истории — маленькое превью, чтобы не выесть хранилище.
    const blob = await (await fetch(dataUrl)).blob();
    const { dataUrl: thumb } = await compressImage(blob, 420, 0.55);
    store.addPhoto({ id: crypto.randomUUID(), ts: Date.now(), thumb, result });
  } catch {}
}

function renderPhoto() {
  const box = $('photoResult');
  box.innerHTML = '';
  if (!photo.dataUrl && !photo.result) {
    box.innerHTML = `<div class="empty"><div class="empty-icon">${iconSVG('scan', 52)}</div>
      <h3>Что тут написано?</h3>
      <p>Снимите меню — разберу блюда и помогу собрать заказ.<br>Снимите документ или вывеску — переведу и объясню суть.</p></div>`;
    return;
  }
  if (photo.dataUrl) {
    const img = document.createElement('img');
    img.className = 'preview';
    img.src = photo.dataUrl;
    box.appendChild(img);
  }
  const r = photo.result;
  if (!r) {
    box.insertAdjacentHTML('beforeend', `
      <div class="reading"><span class="pulse-dot"></span>Читаю текст на фото…</div>
      <div class="skeleton-card"><span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>
      <div class="skeleton-card"><span class="sk sk-title"></span><span class="sk sk-line"></span></div>
      <div class="skeleton-card"><span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>`);
    return;
  }
  box.insertAdjacentHTML('beforeend', renderResultHTML(r, true));
  bindDishHandlers(box);
  updateOrderBar();
}

function renderResultHTML(r, interactive) {
  let html = '';
  if (r.isMenu) {
    if (interactive) html += `<div class="hint-tap">Тапните блюда, чтобы собрать заказ</div>`;
    for (const section of r.sections || []) {
      if (section.title) html += `<div class="section-title">${escapeHtml(section.title.toUpperCase())}</div>`;
      for (const dish of section.items || []) {
        html += dishHTML(dish, interactive);
      }
    }
    if (!(r.sections || []).length) html += `<div class="error">Не удалось разобрать меню. Попробуйте снять ближе.</div>`;
  } else {
    if (r.summary) html += `<div class="summary-card"><h4>Суть</h4>${escapeHtml(r.summary)}</div>`;
    for (const b of r.blocks || []) {
      html += `<div class="block-card"><div class="orig">${escapeHtml(b.original)}</div>${escapeHtml(b.translation)}</div>`;
    }
    if (!(r.blocks || []).length && !r.summary) html += `<div class="error">Текст не распознан.</div>`;
  }
  return html;
}

function dishHTML(dish, interactive) {
  const key = dish.original + '|' + dish.translation;
  const count = photo.order.get(key) || 0;
  return `<div class="dish${count ? ' on' : ''}" data-key="${escapeHtml(key)}">
    <div class="dish-top">
      <div class="dish-name">${count ? iconSVG('check', 17) : ''}${escapeHtml(dish.translation)}</div>
      ${dish.price ? `<div class="dish-price">${escapeHtml(dish.price)}</div>` : ''}
    </div>
    <div class="dish-orig">${escapeHtml(dish.original)}</div>
    ${dish.ingredients ? `<div class="dish-ing">${escapeHtml(dish.ingredients)}</div>` : ''}
    ${count && interactive ? `<div class="counter"><button data-act="minus" aria-label="меньше">${iconSVG('minus', 26)}</button><b>${count}</b><button data-act="plus" aria-label="больше">${iconSVG('plus', 26)}</button></div>` : ''}
  </div>`;
}

function bindDishHandlers(box) {
  box.querySelectorAll('.dish').forEach(el => {
    el.addEventListener('click', (e) => {
      const key = el.dataset.key;
      const act = e.target.dataset?.act;
      const cur = photo.order.get(key) || 0;
      if (act === 'plus') photo.order.set(key, Math.min(cur + 1, 20));
      else if (act === 'minus') { if (cur <= 1) photo.order.delete(key); else photo.order.set(key, cur - 1); }
      else if (cur) photo.order.delete(key);
      else { photo.order.set(key, 1); haptic(10); }
      renderPhoto();
    });
  });
}

function updateOrderBar() {
  const total = [...photo.order.values()].reduce((a, b) => a + b, 0);
  $('orderBtn').classList.toggle('hidden', total === 0);
  $('orderLabel').textContent = `Показать заказ официанту · ${total}`;
}

function showOrder() {
  const items = [];
  for (const section of photo.result?.sections || []) {
    for (const dish of section.items || []) {
      const key = dish.original + '|' + dish.translation;
      const n = photo.order.get(key);
      if (n) items.push({ dish, n });
    }
  }
  if (!items.length) return;
  $('bigInner').classList.remove('flipped');
  $('bigSrc').textContent = 'Cho tôi gọi món:';
  $('bigTr').innerHTML = items.map(i =>
    `<div style="margin-bottom:18px">${i.n} × ${escapeHtml(i.dish.original)}
      <div style="font-size:14px;font-weight:600;opacity:.65;margin-top:2px">${escapeHtml(i.dish.translation)}${i.dish.price ? ' · ' + escapeHtml(i.dish.price) : ''}</div>
    </div>`).join('');
  const phrase = 'Cho tôi ' + items.map(i => `${i.n} ${i.dish.original}`).join(', ');
  $('bigSpeak').onclick = () => speaker.speak(phrase, 'vi-VN');
  $('bigView').classList.remove('hidden');
}

// ------------------------------------------------------------------ история

function openHistory(seg) {
  document.querySelectorAll('.seg').forEach(b => b.classList.toggle('active', b.dataset.seg === seg));
  const box = $('histContent');
  box.innerHTML = '';
  $('history').classList.remove('hidden');

  if (seg === 'dialogs') {
    const sessions = store.getSessions();
    if (!sessions.length) {
      box.innerHTML = `<div class="empty"><p>Прошлых разговоров пока нет.<br>Кнопка ✎ в диалоге начинает новый, а текущий уезжает сюда.</p></div>`;
      return;
    }
    box.insertAdjacentHTML('beforeend', '<div class="hint-swipe">Тап — открыть, свайп влево — удалить</div>');
    for (const s of sessions) {
      const first = s.messages[0];
      const title = first?.transcript || first?.translation || 'Разговор';
      const preview = s.messages.slice(0, 2).map(m => m.translation).join(' · ');
      const el = swipeRow(
        `<div class="info"><b></b><small>${fmtDate(s.startedAt)} · ${plural(s.messages.length, 'реплика', 'реплики', 'реплик')}</small>
         <span class="preview"></span></div>`,
        () => { store.removeSession(s.id); openHistory('dialogs'); },
        () => {
          const restored = store.resumeSession(s.id);
          if (restored) { messages = restored; renderFeed(); $('history').classList.add('hidden'); switchTab('dialog'); toast('Разговор продолжен'); }
        }
      );
      el.querySelector('b').textContent = title;
      el.querySelector('.preview').textContent = preview;
      box.appendChild(el);
    }
  } else {
    const photos = store.getPhotos();
    if (!photos.length) {
      box.innerHTML = `<div class="empty"><p>Сохранённых фото пока нет.<br>Каждый перевод по фото попадает сюда автоматически.</p></div>`;
      return;
    }
    box.insertAdjacentHTML('beforeend', '<div class="hint-swipe">Тап — открыть, свайп влево — удалить</div>');
    for (const p of photos) {
      const count = p.result.isMenu
        ? plural((p.result.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0), 'блюдо', 'блюда', 'блюд')
        : `документ · ${plural((p.result.blocks || []).length, 'фрагмент', 'фрагмента', 'фрагментов')}`;
      const el = swipeRow(
        `<img class="thumb" src="${p.thumb}" alt=""><div class="info"><b>${p.result.isMenu ? 'Меню' : 'Документ'}</b><small>${fmtDate(p.ts)} · ${count}</small></div>`,
        () => { store.removePhoto(p.id); openHistory('menus'); },
        () => { box.innerHTML = `<img class="preview" src="${p.thumb}" alt="">` + renderResultHTML(p.result, false); }
      );
      box.appendChild(el);
    }
  }
}

/** Строка списка: тап открывает, свайп влево показывает «Удалить». */
function swipeRow(innerHTML, onDelete, onOpen) {
  const wrap = document.createElement('div');
  wrap.className = 'swipe-wrap';
  wrap.innerHTML = `<button class="swipe-delete">${iconSVG('trash', 20)}<span>Удалить</span></button>
                    <div class="swipe-card">${innerHTML}</div>`;
  const card = wrap.querySelector('.swipe-card');
  const del = wrap.querySelector('.swipe-delete');
  let startX = 0, dx = 0, open = false, dragging = false;

  const setX = (x) => { card.style.transform = `translateX(${x}px)`; };

  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; dragging = true; card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX + (open ? -96 : 0);
    setX(Math.max(-110, Math.min(0, dx)));
  }, { passive: true });

  card.addEventListener('touchend', () => {
    dragging = false;
    card.style.transition = 'transform .22s cubic-bezier(.22,.9,.3,1)';
    open = dx < -48;
    setX(open ? -96 : 0);
  });

  card.addEventListener('click', () => {
    if (open) { open = false; card.style.transition = 'transform .22s'; setX(0); return; }
    onOpen();
  });
  del.addEventListener('click', (e) => { e.stopPropagation(); haptic(16); onDelete(); });
  return wrap;
}

// ------------------------------------------------------------------ настройки

async function checkKey() {
  const key = $('setKey').value.trim() || store.getKey();
  if (!key) { toast('Сначала вставьте ключ'); return; }
  $('setStatus').textContent = 'Проверяю…';
  try {
    await gemini.checkKey(key);
    $('setStatus').innerHTML = `<span class="status-icon ok">${iconSVG('check', 17)}</span>Работает!`;
  } catch (e) {
    $('setStatus').innerHTML = `<span class="status-icon bad">${iconSVG('close', 15)}</span>${escapeHtml(e.message)}`;
  }
}

function updateStorageInfo() {
  const kb = store.usageKB();
  const sessions = store.getSessions().length;
  const photos = store.getPhotos().length;
  $('storageInfo').textContent = `Занято ${kb} КБ · ${plural(sessions, 'разговор', 'разговора', 'разговоров')} · ${plural(photos, 'фото', 'фото', 'фото')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', boot);
