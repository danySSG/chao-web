// Chào! — веб-версия. Диалог (живой перевод, запись, текст), фото, история, настройки.

import { store } from './store.js?v=202611181632';
import { gemini, LiveSession } from './gemini.js?v=202611181632';
import { Microphone, Player, speaker, compressImage, audioContext, keepAudioRunning } from './audio.js?v=202611181632';
import { log, toast, isMostlyCyrillic, fmtDate, plural, haptic } from './util.js?v=202611181632';
import { iconSVG, renderIcons } from './icons.js?v=202611181632';
import { PHRASES } from './phrases.js?v=202611181632';
import { studioIllustration, shareIllustration, addHomeIllustration, androidInstallIllustration, featuresIllustration } from './illustrations.js?v=202611181632';

const $ = (id) => document.getElementById(id);
const VERSION = '202611181632';

let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

const mic = new Microphone();
const player = new Player(onModelSpeaking);
let live = null;
let liveOn = false;
let recording = false;
let busy = false;
let wakeLock = null;
let messages = store.getCurrent();
// Последняя неудачная попытка перевода: держим исходник (запись или текст) в памяти,
// чтобы повторить БЕЗ просьбы сказать ещё раз — в разговоре это дорогого стоит.
let pendingRetry = null;

// Текущие фото: images — страницы одного меню/документа, chat — вопросы по ним
const MAX_PHOTOS = 6;
// Документ, с которым сейчас работаем: страницы со своим разбором у каждой,
// собранный по ним заказ и вопросы по документу целиком.
let photo = newPhotoDoc();
// Растёт только по «Новый снимок». Пачка, которая ещё сжимается, так отличает
// отмену от документа, опустевшего после крестика (это тоже новый объект).
let photoEpoch = 0;

// ------------------------------------------------------------------ запуск

function boot() {
  $('version').textContent = VERSION;
  $('installId').textContent = store.getInstallId();
  log(`старт · ${matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'приложение с домашнего экрана' : 'браузер'}`);

  if (store.hasKey()) showApp(); else showOnboarding();

  // онбординг — пошаговый мастер
  initOnboarding();

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
  requestPersistentStorage();

  // фото
  $('cameraBtn').addEventListener('click', () => $('fileCamera').click());
  $('cameraBtn2').addEventListener('click', () => $('fileCamera').click());
  $('galleryBtn').addEventListener('click', () => $('fileGallery').click());
  $('fileCamera').addEventListener('change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
  $('fileGallery').addEventListener('change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
  $('orderBtn').addEventListener('click', showOrder);
  $('photoAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter') askAboutPhoto(); });
  $('photoAsk').addEventListener('input', updatePhotoBar);
  $('photoSend').addEventListener('click', askAboutPhoto);
  $('photoReset').addEventListener('click', () => resetPhoto(true));
  $('photoHistBtn').addEventListener('click', () => openHistory('menus'));

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
  $('wipeBtn').addEventListener('click', async () => {
    const ok = await askConfirm('Удалить всё?', 'С этого устройства пропадут ключ, история разговоров и сохранённые фото. Отменить будет нельзя.');
    if (!ok) return;
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
  $('installHelpBtn')?.addEventListener('click', () => { $('app').classList.add('hidden'); showInstallGuide(); });

  renderIcons();
  checkForUpdate();
  renderFeed();
  updateStorageInfo();
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

/** Сверяет свою версию с серверной: iOS-кэш обновляет файлы вразнобой,
 *  поэтому при расхождении перезагружаемся принудительно со свежим адресом. */
/// Что уходит на сервер вместе с проверкой версии — ровно это и ничего больше.
/// Сервер пишет эти запросы в отдельный журнал без IP-адресов.
function usageParams() {
  const ua = navigator.userAgent;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  // iPad с iPadOS представляется Mac'ом — отличаем по сенсорному экрану
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const platform = ios ? 'i' : /Android/.test(ua) ? 'a' : 'd';
  return new URLSearchParams({
    i: store.getInstallId(),        // номер установки
    m: standalone ? 'a' : 'b',      // установлено на экран / открыто в браузере
    p: platform,                    // айфон / андроид / компьютер
    k: store.hasKey() ? '1' : '0',  // дошёл ли человек до работающего ключа
    v: VERSION,
  }).toString();
}

// Метка «перезагружались ради версии X тогда-то» переживает саму перезагрузку.
// Если после неё версия осталась старой (страница пришла из кэша), сразу ещё раз
// не перезагружаемся — иначе петля.
const RELOAD_MARK = 'chao.updateReload';
const RELOAD_PAUSE = 10 * 60 * 1000;
let reloading = false;

// Пишем в оба хранилища: localStorage бывает забит историей до предела квоты,
// а без метки петля вернётся. sessionStorage переживает location.replace.
function markReload(version) {
  const m = JSON.stringify({ v: version, ts: Date.now() });
  try { localStorage.setItem(RELOAD_MARK, m); } catch {}
  try { sessionStorage.setItem(RELOAD_MARK, m); } catch {}
}

function recentlyReloadedFor(version) {
  const recent = (storage) => {
    try {
      const m = JSON.parse(storage().getItem(RELOAD_MARK));
      return m?.v === version && Date.now() - m.ts < RELOAD_PAUSE;
    } catch { return false; }
  };
  return recent(() => localStorage) || recent(() => sessionStorage);
}

/// Идёт ли работа, которую сотрёт перезагрузка: всё это живёт только в памяти.
function workInProgress() {
  return liveOn || recording || busy
    || photo.pages.length > 0 || photo.order.size > 0 || photo.chat.length > 0 || photo.asking
    || !$('bigView').classList.contains('hidden')
    || $('textInput').value.trim() !== '' || $('photoAsk').value.trim() !== ''
    || (pendingRetry !== null && messages.some(m => m.id === pendingRetry.id));
}

async function checkForUpdate(manual) {
  if (reloading) return;
  let version = null;
  try {
    let usage = '';
    try { usage = '&' + usageParams(); } catch {}
    const res = await fetch(`version.json?t=${Date.now()}${usage}`, { cache: 'no-store' });
    // Верим только настоящему номеру сборки: нет сети, страница ошибки или
    // портал Wi-Fi — не повод перезагружаться.
    if (res.ok) version = (await res.json()).version;
  } catch {}
  // Пока ждали ответ, другая проверка (запуск, возврат из фона, второй тап)
  // уже могла начать перезагрузку
  if (reloading) return;
  if (typeof version !== 'string' || !/^\d{12}$/.test(version)) {
    if (manual) toast('Нет связи с сервером — проверьте позже');
    return;
  }
  if (version === VERSION) {
    if (manual) toast('У вас последняя версия');
    return;
  }
  // Сама по себе перезагрузка — только в покое; кнопка в настройках — сразу
  if (!manual) {
    if (workInProgress()) { log(`обновление до ${version} отложено: идёт работа`); return; }
    if (recentlyReloadedFor(version)) {
      log(`обновление до ${version} не применилось (осталась ${VERSION}) — повторю позже`);
      return;
    }
  }
  reloading = true;
  log(`обновление: ${VERSION} → ${version}`);
  // Тост держим долго: на медленной сети новая страница грузится до 20 с
  if (manual) toast('Обновляю…', 30000);
  // Пауза — чтобы журнал успел сохраниться, а тост мелькнуть
  const pause = new Promise(r => setTimeout(r, manual ? 400 : 900));
  // Кэши не трогаем: без сети страница осталась бы ни с чем. Новый SW сам
  // скачает оболочку, а старую уберёт при активации; update() лишь ускоряет это.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await Promise.race([reg.update(), new Promise(r => setTimeout(r, 3000))]);
  } catch {}
  await pause;
  // За эти секунды человек мог нажать микрофон или начать печатать — тогда
  // в другой раз. Метку ставим только сейчас: иначе отменённая попытка
  // заблокировала бы следующую на 10 минут.
  if (!manual && workInProgress()) {
    reloading = false;
    log(`обновление до ${version} отложено: идёт работа`);
    return;
  }
  markReload(version);
  toast('Обновляю…', 30000);
  location.replace(`index.html?v=${version}`);
}

/** Подтверждение в стиле приложения вместо системного окна. */
function askConfirm(title, text) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmBox').classList.remove('hidden');
    const close = (result) => {
      $('confirmBox').classList.add('hidden');
      $('confirmYes').onclick = $('confirmNo').onclick = null;
      resolve(result);
    };
    $('confirmYes').onclick = () => { haptic(16); close(true); };
    $('confirmNo').onclick = () => close(false);
  });
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

/** Просим систему не стирать наши данные при нехватке места: иначе iOS может
 *  молча убрать ключ, историю и журнал. Только с экрана «Домой» — там WebKit
 *  одобряет без вопросов, а браузеры вроде Firefox спросили бы человека. */
async function requestPersistentStorage() {
  try {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone || !navigator.storage?.persist) return;
    if (await navigator.storage.persisted?.()) return;
    const ok = await navigator.storage.persist();
    log(`хранилище: ${ok ? 'постоянное' : 'система может очистить при нехватке места'}`);
  } catch {}
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

let obStep = 0;
const OB_LAST = 3;

function initOnboarding() {
  $('obIllust1').innerHTML = featuresIllustration();
  $('obIllust2').innerHTML = studioIllustration();

  const dots = $('obSteps');
  dots.innerHTML = '';
  for (let i = 0; i <= OB_LAST; i++) {
    const d = document.createElement('span');
    d.className = 'ob-dot' + (i === 0 ? ' on' : '');
    dots.appendChild(d);
  }

  $('obNext').addEventListener('click', obNext);
  $('obBack').addEventListener('click', () => goStep(obStep - 1));
  $('obPaste').addEventListener('click', pasteKey);
  for (const ev of ['input', 'change', 'paste']) {
    $('obKey').addEventListener(ev, () => setTimeout(updateObNav, 0));
  }
  $('installSkip').addEventListener('click', () => { $('install').classList.add('hidden'); showApp(); });
  updateObNav();
}

function goStep(n) {
  obStep = Math.max(0, Math.min(OB_LAST, n));
  document.querySelectorAll('.ob-step').forEach(el => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== obStep);
  });
  document.querySelectorAll('.ob-dot').forEach((d, i) => d.classList.toggle('on', i === obStep));
  $('obInnerScroll')?.scrollTo(0, 0);
  $('onboarding').scrollTo({ top: 0, behavior: 'smooth' });
  updateObNav();
}

function updateObNav() {
  $('obBack').classList.toggle('hidden', obStep === 0);
  const isLast = obStep === OB_LAST;
  const keyOk = $('obKey').value.trim().length >= 20;
  $('obNext').textContent = isLast ? 'Готово' : 'Далее';
  $('obNext').disabled = isLast && !keyOk;
}

async function pasteKey() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('В буфере пусто — сначала скопируйте ключ'); return; }
    $('obKey').value = text.trim();
    updateObNav();
    haptic(12);
  } catch {
    toast('Не получилось — нажмите на поле и выберите «Вставить»');
  }
}

function obNext() {
  if (obStep < OB_LAST) { goStep(obStep + 1); return; }
  const key = $('obKey').value.trim();
  if (key.length < 20) return;
  store.setKey(key);
  $('onboarding').classList.add('hidden');
  if (isInstalled()) { showApp(); toast('Готово! Можно говорить'); }
  else showInstallGuide();
}

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** Инструкция по установке — своя для каждой платформы. */
function showInstallGuide() {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const steps = $('installSteps');
  steps.innerHTML = '';

  const put = (html) => { const li = document.createElement('li'); li.innerHTML = html; steps.appendChild(li); };

  if (isIOS && isSafari) {
    $('installIllust').innerHTML = shareIllustration() + addHomeIllustration();
    put('Нажмите кнопку <b>«Поделиться»</b> внизу экрана — квадрат со стрелкой вверх.');
    put('Пролистайте список вниз до пункта <b>«На экран „Домой“»</b> и нажмите его.');
    put('Нажмите <b>«Добавить»</b> справа вверху.');
    put('Закройте браузер и запускайте Chào! с домашнего экрана — по значку с флагом.');
  } else if (isIOS) {
    $('installLead').textContent = 'Чтобы значок появился на домашнем экране, эту страницу нужно открыть в Safari — другие браузеры на iPhone так не умеют.';
    $('installIllust').innerHTML = shareIllustration();
    put('Скопируйте ссылку этой страницы (кнопка ниже).');
    put('Откройте <b>Safari</b> — стандартный браузер с синим компасом.');
    put('Вставьте ссылку в адресную строку и откройте.');
    put('Нажмите <b>«Поделиться»</b> → <b>«На экран „Домой“»</b>.');
    const copy = document.createElement('button');
    copy.className = 'btn ghost';
    copy.textContent = 'Скопировать ссылку';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Ссылка скопирована'); }
      catch { toast(location.href); }
    });
    steps.after(copy);
  } else if (isAndroid) {
    $('installIllust').innerHTML = androidInstallIllustration();
    if (deferredInstall) {
      $('installNow').classList.remove('hidden');
      $('installNow').onclick = async () => {
        deferredInstall.prompt();
        await deferredInstall.userChoice;
        deferredInstall = null;
        $('install').classList.add('hidden');
        showApp();
      };
      put('Нажмите кнопку <b>«Установить приложение»</b> ниже и подтвердите.');
    } else {
      put('Нажмите на <b>три точки</b> справа вверху браузера.');
      put('Выберите <b>«Установить приложение»</b> (или «Добавить на главный экран»).');
      put('Подтвердите — значок появится на рабочем столе.');
    }
  } else {
    $('installLead').textContent = 'Приложение уже работает. На телефоне его можно добавить на домашний экран и открывать как обычное приложение.';
    put('В браузере на телефоне откройте эту же ссылку.');
    put('iPhone: «Поделиться» → «На экран „Домой“».');
    put('Android: меню браузера → «Установить приложение».');
  }
  $('install').classList.remove('hidden');
}

function showOnboarding() { $('onboarding').classList.remove('hidden'); $('app').classList.add('hidden'); goStep(0); }
function showApp() { $('onboarding').classList.add('hidden'); $('install').classList.add('hidden'); $('app').classList.remove('hidden'); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ['dialog', 'photo', 'settings'].forEach(t => $(`tab-${t}`).classList.toggle('hidden', t !== name));
  if (name === 'settings') updateStorageInfo();
}

// ------------------------------------------------------------------ диалог

function addMessage(msg) {
  messages.push(msg);
  // Карточки неудач живут только до перезагрузки: повторить их всё равно нельзя,
  // запись хранится в памяти.
  store.setCurrent(messages.filter(m => !m.failed));
  renderFeed();
}

function renderFeed() {
  const feed = $('feed');
  if (!messages.length) {
    feed.innerHTML = `<div class="empty">
      <div class="empty-icon">${iconSVG('chat', 52)}</div><h3>Chào!</h3>
      <p>Скажите фразу по-русски — озвучу её по-вьетнамски. Собеседник ответит в микрофон — вы прочтёте по-русски.</p>
      <div class="modes">
        <div class="mode"><span class="mode-ico mic">${iconSVG('mic', 19)}</span>
          <b>Микрофон — по очереди</b>Нажали, сказали фразу, нажали ещё раз. Перевод придёт следом. Годится, когда шумно или нужна одна фраза.</div>
        <div class="mode"><span class="mode-ico wave">${iconSVG('wave', 19)}</span>
          <b>Волна — живой разговор</b>Включили один раз и говорите по очереди с собеседником: переводит на лету, нажимать между репликами не нужно.</div>
      </div>
      <div class="quick" id="quickPhrases"></div></div>`;
    const quick = [
      ['Здравствуйте', 'Xin chào'],
      ['Сколько стоит?', 'Bao nhiêu tiền?'],
      ['Спасибо', 'Cảm ơn'],
      ['Где туалет?', 'Nhà vệ sinh ở đâu?'],
    ];
    const box = $('quickPhrases');
    for (const [ru, vi] of quick) {
      const b = document.createElement('button');
      b.textContent = ru;
      b.addEventListener('click', () => usePhrase(ru, vi));
      box.appendChild(b);
    }
    return;
  }
  feed.innerHTML = '';
  for (const m of messages) {
    if (m.failed) {
      const box = document.createElement('div');
      box.className = 'msg-failed';
      box.innerHTML = `<div class="mf-text"></div>`;
      box.querySelector('.mf-text').textContent = m.error || 'Не удалось перевести.';
      if (pendingRetry && pendingRetry.id === m.id) {
        const again = document.createElement('button');
        again.className = 'mf-retry';
        again.textContent = pendingRetry.label;
        again.addEventListener('click', () => retryFailed(m.id));
        box.appendChild(again);
      }
      feed.appendChild(box);
      continue;
    }
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
  modelSpeaking = ttsSpeaking = false;
  mic.muted = false;

  live = new LiveSession({
    // Чтобы живой режим знал, о чём уже говорили — в том числе текстом.
    getContext: () => messages.slice(-6),
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
  keepAudioRunning(true);
  updateMicIndicator();
  haptic([10, 40, 10]);
  $('liveBtn').disabled = false;
  $('liveBtn').classList.add('on');
  $('micBtn').disabled = true;
}

function stopLive() {
  liveOn = false;
  keepAudioRunning(false);
  updateMicIndicator();
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

/// Микрофон может слушать, когда открыта другая вкладка: статусная строка живёт
/// в диалоге и там не видна. Точка на кнопке «Диалог» показывает это всегда.
function updateMicIndicator() {
  $('micLiveDot').classList.toggle('hidden', !(liveOn || recording));
}

// Микрофон должен молчать, пока звучит динамик — и когда переводит сама
// модель (её аудио), и когда читает системный голос. Источников два,
// поэтому состояние сводим в одном месте.
let modelSpeaking = false;
let ttsSpeaking = false;

function refreshMicMute() {
  const busySpeaking = modelSpeaking || ttsSpeaking;
  const wasMuted = mic.muted;
  mic.muted = busySpeaking;
  // Ровно на переходе «начали глушить» сообщаем серверу, что поток прервался:
  // под мьютом чанки выбрасываются, и без этого признака хвост речи склеится
  // с началом следующей реплики.
  if (!wasMuted && busySpeaking && liveOn) live?.endAudioStream();
  if (liveOn) showBanner(!busySpeaking);
}

function onModelSpeaking(speaking) {
  modelSpeaking = speaking;
  refreshMicMute();
}

speaker.onSpeakingChange = (speaking) => {
  ttsSpeaking = speaking;
  refreshMicMute();
};

// Распознаватель иногда возвращает вместо содержания НАЗВАНИЕ языка —
// «Vietnamese», «Español». Такую реплику незачем показывать и тем более
// тащить в контекст следующих. Сверяем целиком, а не по вхождению: «Вьетнамский
// банк закрыт» — законная фраза.
// Повтор названия («Vietnamese Vietnamese», «Вьетнамский, вьетнамский») — тот же
// мусор, поэтому допускаем до трёх повторений и ничего кроме них.
const LANGUAGE_NAME_ONLY = /^((vietnamese|tiếng việt|spanish|español|english|russian|русский|вьетнамский|испанский|английский)[\s,.!?…]*){1,3}$/i;

function handleLiveTurn(transcript, translation) {
  const text = translation.trim();
  if (!text) return;
  if (LANGUAGE_NAME_ONLY.test(text) || (transcript && LANGUAGE_NAME_ONLY.test(transcript.trim()))) {
    log(`пропускаю самоописание распознавателя: «${(transcript || text).slice(0, 40)}»`);
    return;
  }
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
    updateMicIndicator();
    $('micBtn').classList.remove('rec');
    $('micBtn').innerHTML = iconSVG('mic', 25);
    showBanner(false);
    const wav = mic.stopRecording();
    mic.stop();
    setStatus('');
    if (!wav) { toast('Слишком коротко — скажите фразу целиком'); return; }
    // Запись остаётся в замыкании: повтор не требует говорить снова — в разговоре это важно
    const again = () => gemini.translateAudio(wav, contextSnippet());
    await translateAndAdd(again, again, 'Повторить — запись сохранена');
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
  updateMicIndicator();
  $('micBtn').classList.add('rec');
  $('micBtn').innerHTML = iconSVG('stop', 24);
  showBanner(true, true);
  setStatus('идёт запись — нажмите ещё раз, когда закончите', '', 'Отмена');
}

function cancelRecording() {
  if (!recording) return;
  recording = false;
  updateMicIndicator();
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
  const again = () => gemini.translateText(text, contextSnippet());
  await translateAndAdd(again, again, 'Повторить перевод');
}

/// fn — сам перевод, retry — как повторить его же, если не выйдет.
async function translateAndAdd(fn, retry, retryLabel) {
  busy = true;
  $('sendBtn').disabled = true;
  $('micBtn').disabled = true;
  showTyping(true);
  // Если ответ подзатянулся — честно говорим об этом, чтобы не казалось, что зависло
  const slowTimer = setTimeout(() => setStatus('модель думает дольше обычного…', 'busy', null), 6000);
  try {
    const r = await fn();
    const translation = (r.translation || '').trim();
    if (!translation) {
      // Пустой перевод — тоже неудача: пустой пузырь в ленте ничем не лучше молчания.
      log('перевод пустой — показываю как неудачу');
      addFailure('Не разобрал речь. Попробуйте ещё раз или поднесите телефон ближе.', retry, retryLabel);
    } else {
      addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: r.sourceLanguage, transcript: r.transcript, translation });
      if (r.sourceLanguage === 'ru') speaker.speak(translation, 'vi-VN');
    }
    setStatus('');
  } catch (e) {
    setStatus('');
    log(`перевод не удался: ${e.message}`);
    // Тост исчезает через секунду, а человек стоит перед собеседником с пустым
    // экраном. Неудача остаётся в ленте — вместе с кнопкой повтора той же записи.
    addFailure(e.message, retry, retryLabel);
  } finally {
    clearTimeout(slowTimer);
    showTyping(false);
    busy = false;
    $('sendBtn').disabled = false;
    $('micBtn').disabled = liveOn;   // в живом режиме запись всё равно недоступна
  }
}

/// Неудача попадает в ленту как карточка с кнопкой «Повторить»: исходник
/// (запись или текст) сохранён, повторять вслух не нужно.
function addFailure(text, retry, retryLabel) {
  const id = crypto.randomUUID();
  if (retry) pendingRetry = { id, run: retry, label: retryLabel || 'Повторить' };
  addMessage({ id, ts: Date.now(), failed: true, error: text, sourceLanguage: 'ru', transcript: '', translation: '' });
}

async function retryFailed(id) {
  if (!pendingRetry || pendingRetry.id !== id || busy) return;
  const { run, label } = pendingRetry;
  pendingRetry = null;
  messages = messages.filter(m => m.id !== id);   // карточку убираем, место займёт результат
  renderFeed();
  await translateAndAdd(run, run, label);
}

/** Пузырь с точками в ленте, пока идёт перевод. */
function showTyping(on) {
  const feed = $('feed');
  const existing = $('typingBubble');
  if (!on) { existing?.remove(); return; }
  if (existing) return;
  const el = document.createElement('div');
  el.className = 'typing';
  el.id = 'typingBubble';
  el.innerHTML = '<i></i><i></i><i></i>';
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
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

/// queue — очередь разборов страниц этого документа (см. queueAnalysis).
function newPhotoDoc() {
  return { pages: [], order: new Map(), chat: [], asking: false, historyId: null, queue: Promise.resolve() };
}

async function addPhotos(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  // Если за время сжатия нажали «Новый снимок», страницы старого документа
  // не должны попасть в новый.
  const epoch = photoEpoch;

  const free = MAX_PHOTOS - photo.pages.length;
  if (free <= 0) { toast(`Больше ${MAX_PHOTOS} страниц за раз не получится`); return; }
  if (list.length > free) toast(`Возьму первые ${plural(free, 'страницу', 'страницы', 'страниц')} — это предел`);

  const picked = list.slice(0, free);
  const added = [];
  let broken = 0;
  for (const file of picked) {
    let img;
    // Нечитаемый файл пропускаем: раньше на нём обрывалась вся пачка,
    // и следующие страницы молча терялись.
    try {
      img = await compressImage(file);
    } catch (e) {
      broken++;
      log(`фото: не открылся файл (${file.type || 'тип неизвестен'}, ${Math.round((file.size || 0) / 1024)} КБ): ${e.message}`);
      continue;
    }
    if (epoch !== photoEpoch) return;
    // Пишем в текущий документ: если крестиком убрали все страницы, пока
    // остальные сжимались, это не отмена — иначе выбранные фото пропали бы молча.
    const page = { dataUrl: img.dataUrl, base64: img.base64, result: null, analyzing: true, error: null };
    photo.pages.push(page);
    added.push(page);
    renderPhoto();
  }
  if (epoch !== photoEpoch) return;
  if (broken) toast(picked.length === 1 ? 'Не удалось прочитать фото' : `Не открылось ${broken} из ${picked.length} фото`);
  // Убранные крестиком страницы очередь пропустит сама (analyzePage).
  for (const page of added) queueAnalysis(photo, page);
}

/// Страницы разбираются по очереди: каждая знает разделы предыдущих и
/// дописывается к общему списку, поэтому готовое с экрана не пропадает.
/// Очередь общая на документ, а не на пачку: страница из «Снять ещё» или
/// повтора иначе уходила в модель вслепую, пока предыдущая ещё разбиралась.
function queueAnalysis(doc, page) {
  page.analyzing = true;
  page.error = null;
  // catch: сбой на одной странице не должен навсегда остановить очередь
  doc.queue = doc.queue.then(() => analyzePage(doc, page)).catch(e => log(`фото: ${e.message}`));
}

/// Что уже известно о документе — подсказка модели, чтобы разделы совпали.
function knownSoFar(doc) {
  const titles = new Set();
  let isMenu = false;
  for (const p of doc.pages) {
    if (!p.result) continue;
    if (p.result.isMenu) isMenu = true;
    for (const sec of p.result.sections || []) if (sec.title) titles.add(sec.title);
  }
  return { isMenu, sections: [...titles] };
}

async function analyzePage(doc, page) {
  // Пока страница ждала очереди, её убрали крестиком или начали новый
  // снимок — запрос не тратим.
  if (doc !== photo || !doc.pages.includes(page)) { page.analyzing = false; return; }
  let result = null, error = null;
  try {
    result = await gemini.translatePhoto([page.base64], knownSoFar(doc));
  } catch (e) {
    log(`фото: ${e.message}`);
    error = e.message;
  }
  page.analyzing = false;
  // Убрали, пока ждали ответ, — результат выбрасываем.
  if (!doc.pages.includes(page)) return;
  if (error) page.error = error; else page.result = result;
  // Документ сменили — разбор остаётся в нём, на экран чужого не выводим.
  if (doc !== photo) return;
  renderPhoto();
  if (doc.pages.some(p => p.result)) savePhotoToHistory(doc);
}

/// Повтор неудачных страниц — через ту же очередь, чтобы и они знали разделы.
function retryPages(pages) {
  pages.forEach(p => queueAnalysis(photo, p));
  renderPhoto();
}

/// Общий вид документа — склейка разборов всех страниц. Разделы с одинаковым
/// названием объединяются, поэтому меню на трёх листах читается одним списком.
function mergedResult(doc = photo) {
  const done = doc.pages.filter(p => p.result);
  if (!done.length) return null;
  const merged = { isMenu: done.some(p => p.result.isMenu), summary: '', blocks: [], sections: [] };
  const byTitle = new Map();
  for (const p of done) {
    const r = p.result;
    if (r.summary && !merged.summary) merged.summary = r.summary;
    for (const b of r.blocks || []) merged.blocks.push(b);
    for (const sec of r.sections || []) {
      const key = (sec.title || '').trim().toLowerCase();
      const existing = byTitle.get(key);
      if (existing) existing.items.push(...(sec.items || []));
      else {
        const copy = { title: sec.title, items: [...(sec.items || [])] };
        byTitle.set(key, copy);
        merged.sections.push(copy);
      }
    }
  }
  return merged;
}

function removePhotoAt(index) {
  photo.pages.splice(index, 1);
  if (!photo.pages.length) { resetPhoto(); return; }
  // Разбор каждой страницы хранится отдельно — убрать её можно без запроса.
  renderPhoto();
  savePhotoToHistory();
}

/// announce — это «Новый снимок» по кнопке, а не опустевший после крестика документ.
function resetPhoto(announce) {
  const saved = announce && photo.historyId;
  if (announce) photoEpoch++;
  photo = newPhotoDoc();
  $('photoAsk').value = '';
  renderPhoto();
  if (saved) toast('Снимок сохранён в историю');
}

/// doc — свой документ, а не текущий: пока сжималось превью, могли нажать
/// «Новый снимок», и номер записи ушёл бы в чужой документ.
async function savePhotoToHistory(doc = photo) {
  const result = mergedResult(doc);
  const first = doc.pages.find(p => p.result);
  if (!result || !first) return;
  try {
    // Для истории — маленькое превью, чтобы не выесть хранилище.
    const blob = await (await fetch(first.dataUrl)).blob();
    const { dataUrl: thumb } = await compressImage(blob, 420, 0.55);
    if (doc.historyId) store.removePhoto(doc.historyId);
    doc.historyId = crypto.randomUUID();
    store.addPhoto({ id: doc.historyId, ts: Date.now(), thumb, result });
  } catch {}
}

// ------------------------------------------------------- вопросы по фото

async function askAboutPhoto() {
  const input = $('photoAsk');
  const text = input.value.trim();
  // Ответ пишем в документ, о котором спрашивали: пока ждали, могли начать
  // новый снимок, и ответ про старое меню оказался бы в чужом чате.
  const doc = photo;
  if (!text || doc.asking || !doc.pages.length) return;

  input.value = '';
  doc.chat.push({ role: 'user', text });
  doc.asking = true;
  renderPhoto({ toChat: true });
  updatePhotoBar();

  // Основная модель периодически перегружена, и ответ занимает до минуты —
  // без этой подписи человек решает, что приложение зависло.
  const slow = setTimeout(() => {
    const label = doc === photo && $('askingLabel');
    if (label) label.textContent = 'Всё ещё думаю — иногда это занимает до минуты';
  }, 12000);

  try {
    const answer = await gemini.askPhoto(doc.pages.map(p => p.base64), doc.chat);
    doc.chat.push({ role: 'model', text: answer });
  } catch (e) {
    log(`вопрос по фото: ${e.message}`);
    doc.chat.push({ role: 'model', text: e.message, failed: true });
  }
  clearTimeout(slow);
  doc.asking = false;
  if (doc !== photo) return;
  renderPhoto({ toChat: true });
  updatePhotoBar();
}

/// Модель отвечает с markdown-разметкой. Жирным она выделяет как раз то,
/// что нужно показать или произнести вслух, — вьетнамские куски делаем озвучиваемыми.
function richText(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, (_, t) => {
    const plain = t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    if (isMostlyCyrillic(plain)) return `<b>${t}</b>`;
    return `<b class="say" data-say="${t}">${t}${iconSVG('speaker', 14)}</b>`;
  });
  html = html.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, (_, before, t) => `${before}<i>${t}</i>`);
  return html;
}

/// Готовые вопросы под то, что на фото: иначе поле ввода легко не заметить.
function quickQuestions(result) {
  if (result?.isMenu) return ['Что тут острое?', 'Есть блюда без мяса?', 'Что посоветуешь?'];
  if (result) return ['Что мне делать?', 'Есть тут сроки или даты?', 'Объясни попроще'];
  return ['Что тут написано?', 'Что мне делать?'];
}

function chatHTML(result) {
  if (!photo.pages.length) return '';
  let html = '<div class="qa">';
  if (!photo.chat.length) {
    html += `<div class="qa-hint">${iconSVG('chat', 18)}Что-то непонятно? Спросите об этом фото — прямо словами, как у знакомого.</div>
      <div class="qa-chips">${quickQuestions(result).map(q => `<button class="chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div>`;
  }
  for (const m of photo.chat) {
    const body = m.role === 'user' || m.failed ? escapeHtml(m.text) : richText(m.text);
    html += `<div class="qa-msg ${m.role === 'user' ? 'you' : 'ai'}${m.failed ? ' failed' : ''}">${body}</div>`;
  }
  if (photo.asking) html += `<div class="qa-msg ai typing"><span class="pulse-dot"></span><span id="askingLabel">Думаю…</span></div>`;
  return html + '</div>';
}

/// toChat — в чате появилось новое (вопрос, «Думаю…», ответ): показать его.
/// fromDish — тап по блюду или «+»/«−» ({ index, top }: какое по счёту и где
/// было на экране): на месте должно остаться само блюдо.
function renderPhoto({ toChat = false, fromDish = false } = {}) {
  const box = $('photoResult');
  // Экран собирается заново целиком, поэтому прокрутку держим сами: иначе тап
  // по блюду уводил экран к чату, а ленту страниц — в начало.
  const scroller = $('photoContent');
  const top = scroller.scrollTop;
  const left = box.querySelector('.strip')?.scrollLeft || 0;
  // Ответ, который сейчас читают, держим на том же месте экрана: дочитанная
  // страница добавляет блюда выше чата и иначе вытеснила бы его вниз.
  const msgTop = fromDish ? null : readingTop(box.querySelector('.qa > .qa-msg:last-child'), scroller);
  box.innerHTML = '';
  updatePhotoBar();

  if (!photo.pages.length) {
    box.innerHTML = `<div class="empty"><div class="empty-icon">${iconSVG('scan', 52)}</div>
      <h3>Что тут написано?</h3>
      <p>Снимите меню — разберу блюда и помогу собрать заказ.<br>Снимите документ или вывеску — переведу и объясню суть.</p>
      <p class="empty-note">Многостраничное меню снимайте целиком: отметьте в галерее все страницы разом — разберу их как одно меню.</p></div>`;
    return;
  }

  // Лента страниц: миниатюры с крестиком + плитка «добавить»
  let strip = '<div class="strip">';
  photo.pages.forEach((page, i) => {
    strip += `<div class="strip-item${page.analyzing ? ' busy' : ''}${page.error ? ' failed' : ''}">
      <img src="${page.dataUrl}" alt="страница ${i + 1}">
      ${page.analyzing ? '<span class="strip-spin"></span>' : ''}
      <button class="strip-del" data-del="${i}" aria-label="убрать страницу ${i + 1}">${iconSVG('close', 15)}</button></div>`;
  });
  if (photo.pages.length < MAX_PHOTOS) {
    strip += `<button class="strip-add" id="stripAdd" aria-label="добавить страницу">${iconSVG('plus', 24)}<span>ещё</span></button>`;
  }
  strip += '</div>';
  box.insertAdjacentHTML('beforeend', strip);
  box.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => removePhotoAt(Number(b.dataset.del))));
  const add = box.querySelector('#stripAdd');
  if (add) add.addEventListener('click', () => $('fileGallery').click());

  const result = mergedResult();
  const busy = photo.pages.filter(p => p.analyzing).length;
  const failed = photo.pages.filter(p => p.error);

  // Разобранное остаётся на экране: новая страница дописывается к нему,
  // а не начинает всё заново.
  if (busy) {
    box.insertAdjacentHTML('beforeend',
      `<div class="reading"><span class="pulse-dot"></span>${result ? 'Дополняю разбор' : `Читаю текст ${photo.pages.length > 1 ? 'на страницах' : 'на фото'}`}…</div>`);
  }
  if (result) {
    box.insertAdjacentHTML('beforeend', renderResultHTML(result, true));
    bindDishHandlers(box);
    updateOrderBar();  // после перерисовки блюд счётчик мог измениться
  } else if (!busy && failed.length) {
    box.insertAdjacentHTML('beforeend',
      `<div class="error">${escapeHtml(failed[0].error)}</div>
       <button class="btn ghost retry" id="photoRetry">Попробовать ещё раз</button>`);
    box.querySelector('#photoRetry').addEventListener('click', () => retryPages(failed));
  } else if (!busy && !result) {
    box.insertAdjacentHTML('beforeend',
      `<div class="skeleton-card"><span class="sk sk-title"></span><span class="sk sk-line"></span></div>`);
  }
  if (result && failed.length && !busy) {
    box.insertAdjacentHTML('beforeend',
      `<div class="page-failed">${plural(failed.length, 'Страницу', 'Страницы', 'Страниц')} не удалось разобрать —
       <button class="linkish" id="retryFailed">попробовать ещё раз</button></div>`);
    box.querySelector('#retryFailed').addEventListener('click', () => retryPages(failed));
  }

  // Вопросы доступны всегда, пока есть снимки — даже если разбор не удался.
  box.insertAdjacentHTML('beforeend', chatHTML(result));
  box.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => {
    $('photoAsk').value = b.dataset.q;
    askAboutPhoto();
  }));
  box.querySelectorAll('.say').forEach(el => el.addEventListener('click', () => {
    speaker.speak(el.dataset.say, 'vi-VN');
    haptic(10);
  }));
  box.querySelector('.strip').scrollLeft = left;
  const msg = box.querySelector('.qa > .qa-msg:last-child');
  // Тапнутое блюдо — на том же месте экрана: у блюда-дубля (тот же ключ в двух
  // разделах) раскрывается и верхняя копия и иначе сдвигала бы его вниз.
  const dish = fromDish && box.querySelectorAll('.dish')[fromDish.index];
  const want = dish ? scroller.scrollTop + dish.getBoundingClientRect().top - fromDish.top
    : !toChat && msgTop != null && msg ? scroller.scrollTop + msg.getBoundingClientRect().top - msgTop : top;
  // Пишем, только если сбилось, — чтобы не мешать прокрутке, которую ведёт палец.
  if (Math.abs(scroller.scrollTop - want) >= 1) scroller.scrollTop = want;
  if (toChat && msg) msg.scrollIntoView({ block: 'nearest' });
}

/// Верх последнего сообщения на экране, если его сейчас читают: оно видно
/// целиком или занимает середину экрана. Краешек снизу не в счёт — тогда
/// человек смотрит на блюда выше.
function readingTop(msg, scroller) {
  if (!msg) return null;
  const c = scroller.getBoundingClientRect();
  if (!c.height) return null;  // вкладка «Фото» скрыта
  const r = msg.getBoundingClientRect();
  const mid = c.top + c.height / 2;
  const whole = r.top >= c.top && r.bottom <= c.bottom;
  return whole || (r.top <= mid && r.bottom >= mid) ? r.top : null;
}

/// Показываем всё, что разобралось, а не только «профильную» половину:
/// у многостраничного меню обложка с адресом — уже документ, и её перевод
/// попадает во фрагменты. Раньше он молча пропадал с экрана.
function renderResultHTML(r, interactive) {
  const dishes = (r.sections || []).reduce((n, sec) => n + (sec.items || []).length, 0);
  let html = '';

  if (dishes) {
    if (interactive) html += `<div class="hint-tap">Тапните блюда, чтобы собрать заказ</div>`;
    for (const section of r.sections || []) {
      if (section.title) html += `<div class="section-title">${escapeHtml(section.title.toUpperCase())}</div>`;
      for (const dish of section.items || []) html += dishHTML(dish, interactive);
    }
  }

  if (r.summary) html += `<div class="summary-card"><h4>Суть</h4>${escapeHtml(r.summary)}</div>`;
  if ((r.blocks || []).length) {
    // Заголовок нужен только рядом с блюдами — иначе и так понятно, что это перевод.
    if (dishes) html += `<div class="section-title">ОСТАЛЬНОЕ НА ФОТО</div>`;
    for (const b of r.blocks || []) {
      html += `<div class="block-card"><div class="orig">${escapeHtml(b.original)}</div>${escapeHtml(b.translation)}</div>`;
    }
  }

  if (!html) {
    html = r.isMenu
      ? `<div class="error">Не удалось разобрать меню. Попробуйте снять ближе.</div>`
      : `<div class="error">Текст не распознан.</div>`;
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
      // closest: тап по иконке внутри «+»/«−» приходит от svg, у которого нет data-act
      const act = e.target.closest('[data-act]')?.dataset.act;
      // Промах мимо «+»/«−» — по цифре или в зазор — не должен снимать блюдо
      // со всеми порциями, как тап по карточке.
      if (!act && e.target.closest('.counter')) return;
      const cur = photo.order.get(key) || 0;
      if (act === 'plus') photo.order.set(key, Math.min(cur + 1, 20));
      else if (act === 'minus') { if (cur <= 1) photo.order.delete(key); else photo.order.set(key, cur - 1); }
      else if (cur) photo.order.delete(key);
      else { photo.order.set(key, 1); haptic(10); }
      const index = [...box.querySelectorAll('.dish')].indexOf(el);
      renderPhoto({ fromDish: { index, top: el.getBoundingClientRect().top } });
    });
  });
}

function updateOrderBar() {
  // Считаем только по блюдам, которые сейчас в документе: убрали страницу —
  // её отметки перестают учитываться, хотя и остаются на случай возврата.
  const alive = new Set();
  for (const sec of mergedResult()?.sections || []) {
    for (const d of sec.items || []) alive.add(d.original + '|' + d.translation);
  }
  const total = [...photo.order.entries()].reduce((a, [k, n]) => a + (alive.has(k) ? n : 0), 0);
  $('orderBtn').classList.toggle('hidden', total === 0);
  $('orderLabel').textContent = `Показать заказ официанту · ${total}`;
}

/// Пока фото нет — крупные «Камера» и «Галерея»; как появилось — строка вопроса.
function updatePhotoBar() {
  const has = photo.pages.length > 0;
  // Кнопка заказа обновляется здесь, а не только рядом с разобранным меню:
  // иначе после сброса на пустом экране висел счётчик прошлого документа.
  updateOrderBar();
  $('pickers').classList.toggle('hidden', has);
  $('pickNote').classList.toggle('hidden', has);
  $('askRow').classList.toggle('hidden', !has);
  $('photoResetWrap').classList.toggle('hidden', !has);
  $('photoSend').disabled = photo.asking || !$('photoAsk').value.trim();
  $('photoAsk').disabled = photo.asking;
}

function showOrder() {
  const items = [];
  // Одно и то же блюдо встречается дважды (блок «Best seller», перекрытие
  // снимков), а заказ у него один — иначе официант увидит и услышит его дважды.
  const seen = new Set();
  for (const section of mergedResult()?.sections || []) {
    for (const dish of section.items || []) {
      const key = dish.original + '|' + dish.translation;
      const n = photo.order.get(key);
      if (n && !seen.has(key)) { seen.add(key); items.push({ dish, n }); }
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
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await askConfirm('Удалить запись?', 'Её нельзя будет вернуть.')) onDelete();
  });
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

document.addEventListener('DOMContentLoaded', () => {
  try {
    boot();
  } catch (e) {
    // Интерфейс не должен оставаться полупустым из-за одной ошибки
    log('ошибка запуска: ' + e.message);
    try { renderIcons(); renderFeed(); } catch {}
    toast('Что-то пошло не так при запуске. Загляните в журнал в настройках.');
  }
});
