// Chào! — веб-версия. Диалог (живой перевод, запись, текст), фото, история, настройки.

import { store } from './store.js?v=202611181730';
import { gemini, LiveSession } from './gemini.js?v=202611181730';
import { Microphone, Player, speaker, compressImage, audioContext, keepAudioRunning } from './audio.js?v=202611181730';
import { log, toast, isMostlyCyrillic, fmtDate, plural, haptic } from './util.js?v=202611181730';
import { iconSVG, renderIcons } from './icons.js?v=202611181730';
import { PHRASES } from './phrases.js?v=202611181730';
import { studioIllustration, shareIllustration, addHomeIllustration, androidInstallIllustration, featuresIllustration } from './illustrations.js?v=202611181730';

const $ = (id) => document.getElementById(id);
const VERSION = '202611181730';

let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

const mic = new Microphone();
const player = new Player(onModelSpeaking);
let live = null;
let liveOn = false;
let recording = false;
let busy = false;
// Экран не гаснет, пока он кому-то нужен: волна, показ собеседнику, запись.
// Владельцев несколько, замок один — отпускаем, когда не осталось никого.
const screenHolders = new Set();
let screenLock = null;
let messages = store.getCurrent();
// Последняя неудачная попытка перевода: держим исходник (запись или текст) в памяти,
// чтобы повторить БЕЗ просьбы сказать ещё раз — в разговоре это дорогого стоит.
// Повтор у каждой карточки неудачи свой: при сбоях сериями раньше держалась
// только последняя, и первая запись пропадала молча.
const retries = new Map();   // id карточки → { run, label, detail }
let newAfterBusy = false;    // ✎ нажали, пока шёл перевод: начнём, когда допишем

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
  // iOS разрешает речь только из нажатия: первое «пустое» высказывание внутри
  // тапа открывает озвучку до конца жизни страницы, иначе после перезапуска
  // автоозвучка перевода молчала до первого ручного «Озвучить».
  $('liveBtn').addEventListener('click', () => { speaker.unlock(); toggleLive(); });
  $('micBtn').addEventListener('click', () => { speaker.unlock(); toggleRecording(); });
  $('sendBtn').addEventListener('click', () => { speaker.unlock(); sendText(); });
  $('textInput').addEventListener('input', (e) => {
    const has = e.target.value.trim().length > 0;
    $('sendBtn').classList.toggle('hidden', !has);
    $('micBtn').classList.toggle('hidden', has);
    // Включённую волну должно быть чем выключить и во время набора
    $('liveBtn').classList.toggle('hidden', has && !liveOn);
    if (has) setTypingPause(true);
  });
  $('textInput').addEventListener('focus', () => setTypingPause(true));
  $('textInput').addEventListener('blur', () => { if (!$('textInput').value.trim()) setTypingPause(false); });
  // Enter посреди набора вьетнамской раскладкой (Telex) — это выбор буквы,
  // а не отправка; после отправки прячем клавиатуру — экран показывают собеседнику.
  const isSendKey = (e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
  $('textInput').addEventListener('keydown', (e) => {
    if (!isSendKey(e)) return;
    e.preventDefault();
    speaker.unlock();
    sendText();
    $('textInput').blur();
  });
  // iOS иногда оставляет страницу сдвинутой после клавиатуры — возвращаем на место
  addEventListener('focusout', () => requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) scrollTo(0, 0); }));
  $('cancelRecBtn').addEventListener('click', () => { cancelRecording(); toast('Запись отменена'); });
  $('statusAction').addEventListener('click', () => {
    if (statusFn) { const fn = statusFn; setStatus(''); fn(); }
    else if (liveOn) stopLive();
    else if (recording) cancelRecording();
  });
  $('newBtn').addEventListener('click', newSession);
  $('histBtn').addEventListener('click', () => openHistory('dialogs'));
  $('phrasesBtn').addEventListener('click', openPhrases);
  $('phrasesClose').addEventListener('click', () => $('phrases').classList.add('hidden'));

  addEventListener('online', updateNetworkState);
  // Сеть вернулась — не ждём, пока отсчитается пауза между попытками
  addEventListener('online', () => { if (liveOn && live && !live.ready) live.kick('сеть вернулась'); });
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
  $('photoAsk').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    askAboutPhoto();
    $('photoAsk').blur();
  });
  $('photoAsk').addEventListener('input', updatePhotoBar);
  $('photoSend').addEventListener('click', askAboutPhoto);
  $('photoReset').addEventListener('click', () => resetPhoto(true));
  $('photoHistBtn').addEventListener('click', () => openHistory('menus'));

  // история
  $('histClose').addEventListener('click', () => $('history').classList.add('hidden'));
  document.querySelectorAll('.seg').forEach(b => b.addEventListener('click', () => openHistory(b.dataset.seg)));

  // полноэкранный показ
  $('bigClose').addEventListener('click', closeBig);
  addEventListener('resize', () => { if (!$('bigView').classList.contains('hidden')) fitBig(); });
  $('bigClose2').addEventListener('click', closeBig);
  $('bigCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(bigText); toast('Скопировано — можно вставить в Zalo или сообщение'); haptic(12); }
    catch { toast('Не получилось скопировать'); }
  });
  if (navigator.share) {
    $('bigShare').classList.remove('hidden');
    $('bigShare').addEventListener('click', () => navigator.share({ text: bigText }).catch(() => {}));
  }
  $('bigFlip').addEventListener('click', () => { $('bigInner').classList.toggle('flipped'); haptic(12); });

  // настройки
  $('setKey').value = store.getKey();
  $('setSave').addEventListener('click', () => {
    const v = $('setKey').value.trim();
    const problem = v ? keyProblem(v) : 'Сначала вставьте ключ.';
    if (problem) { toast(problem); return; }
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
    // В фоне iOS отрежет микрофон — отправляем то, что успели записать
    if (document.hidden && recording) { log('запись: приложение свернули — отправляю записанное'); toggleRecording(); }
    if (!document.hidden) checkForUpdate();
    // В фоне система отпускает замок экрана — возвращаем, если он ещё нужен
    if (!document.hidden && screenHolders.size && !screenLock) holdScreen([...screenHolders][0]);
  });

  $('updateBtn').addEventListener('click', () => checkForUpdate(true));
  $('installHelpBtn')?.addEventListener('click', () => { $('app').classList.add('hidden'); showInstallGuide(); });

  renderIcons();
  checkForUpdate();
  renderFeed();
  restorePhotoDoc();
  renderPhoto();
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
    // Снимок с заказом переживает перезагрузку (chao.photo.current) — мешает
    // только то, что ещё в пути: разбор страницы или вопрос
    || photo.pages.some(p => p.analyzing) || photo.asking
    || !$('bigView').classList.contains('hidden')
    || $('textInput').value.trim() !== '' || $('photoAsk').value.trim() !== ''
    || messages.some(m => m.failed && retries.has(m.id));
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
  $('offlineBar').onclick = openPhrases;
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
const OB_LAST = 2;
// Шаг мастера переживает перезагрузку: iOS часто выгружает вкладку, пока
// человек получает ключ на сайте Google, — и раньше он возвращался на шаг 1.
const OB_STEP_KEY = 'chao.obstep';
let installFirstSkipped = false;

/// Где открыто приложение — от этого зависят установка и подсказки.
function detectEnv() {
  const ua = navigator.userAgent;
  // iPad с iPadOS выдаёт себя за Mac — узнаём по сенсорному экрану
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Встроенные браузеры мессенджеров (Telegram на iOS по UA не отличить)
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\/|Telegram|MicroMessenger/i.test(ua) || (/Android/.test(ua) && /; wv\)/.test(ua));
  const chromeIOS = ios && /CriOS/.test(ua);
  const safari = ios && !inApp && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA\//.test(ua);
  // iOS 26 заморозил версию системы в UA, а версия Safari по-прежнему честная
  const safariVersion = +(/Version\/(\d+)/.exec(ua)?.[1] || 0);
  return { ios, inApp, chromeIOS, safari, safariVersion, android: /Android/.test(ua) };
}
const ENV = detectEnv();

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

  if (ENV.inApp) {
    $('obInApp').classList.remove('hidden');
    $('obCopyLink').addEventListener('click', copyLink);
  }
  // Как вернуться из Google — своё для значка, Safari и остальных
  $('obBackHint').textContent = isInstalled() && ENV.ios
    ? 'Вернитесь в Chào! — «◀ Chào!» слева вверху экрана — и вставьте ключ в поле ниже.'
    : ENV.safari
      ? 'Вернитесь на вкладку с Chào! (список вкладок или смахивание по адресной строке) и вставьте ключ в поле ниже.'
      : 'Вернитесь сюда (кнопка «Назад» или переключение приложений) и вставьте ключ в поле ниже.';

  $('obNext').addEventListener('click', obNext);
  $('obBack').addEventListener('click', () => goStep(obStep - 1));
  $('obPaste').addEventListener('click', pasteKey);
  for (const ev of ['input', 'change', 'paste']) {
    $('obKey').addEventListener(ev, () => setTimeout(updateObNav, 0));
  }
  // Вернулись из Google — поле для ключа сразу на виду
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || $('onboarding').classList.contains('hidden') || obStep !== OB_LAST || $('obKey').value) return;
    $('obKey').scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  updateObNav();
}

async function copyLink() {
  try { await navigator.clipboard.writeText(location.origin + location.pathname); toast('Ссылка скопирована'); }
  catch { toast(location.origin + location.pathname); }
}

function goStep(n) {
  obStep = Math.max(0, Math.min(OB_LAST, n));
  try { localStorage.setItem(OB_STEP_KEY, String(obStep)); } catch {}
  document.querySelectorAll('.ob-step').forEach(el => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== obStep);
  });
  document.querySelectorAll('.ob-dot').forEach((d, i) => d.classList.toggle('on', i === obStep));
  $('obInnerScroll')?.scrollTo(0, 0);
  $('onboarding').scrollTo({ top: 0, behavior: 'smooth' });
  updateObNav();
}

/// Что не так со вставленной строкой — до похода в сеть. '' — похоже на ключ.
function keyProblem(key) {
  if (!key) return '';
  if (/\s/.test(key) || /https?:|www\.|@/.test(key)) return 'Похоже, это не ключ — скопируйте строку с сайта Google целиком.';
  if (key.length < 20) return 'Строка слишком короткая — ключ длинный, около 40 знаков.';
  return '';
}

function setKeyHint(text, cls) {
  const h = $('obKeyHint');
  h.textContent = text;
  h.className = `fine center${cls ? ' ob-key-' + cls : ''}`;
}

function updateObNav() {
  $('obBack').classList.toggle('hidden', obStep === 0);
  const isLast = obStep === OB_LAST;
  const key = $('obKey').value.trim();
  const problem = keyProblem(key);
  $('obNext').textContent = isLast ? 'Готово' : 'Далее';
  $('obNext').disabled = isLast && (key.length < 20 || !!problem);
  // Человек видит, что именно вставилось, — сам ключ при этом скрыт
  if (problem) setKeyHint(problem, 'bad');
  else if (key) setKeyHint(`${key.slice(0, 6)}…${key.slice(-4)} · ${plural(key.length, 'знак', 'знака', 'знаков')}`, '');
  else setKeyHint('Ключ сохранится только на этом устройстве.', '');
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
  // На айфоне в Safari сначала значок: он хранит данные отдельно от Safari,
  // и ключ, введённый здесь, пришлось бы вводить второй раз.
  if (obStep === 0 && ENV.safari && !isInstalled() && !installFirstSkipped) {
    $('onboarding').classList.add('hidden');
    showInstallGuide('first');
    return;
  }
  if (obStep < OB_LAST) { goStep(obStep + 1); return; }
  finishOnboarding();
}

/// Проверяем ключ сразу, а не на первой фразе перед официантом.
async function finishOnboarding() {
  const key = $('obKey').value.trim();
  if (key.length < 20 || keyProblem(key)) return;
  $('obNext').disabled = true;
  $('obNext').textContent = 'Проверяю ключ…';
  let note = '';
  try {
    await gemini.checkKey(key);
  } catch (e) {
    log(`ключ: проверка — ${e.kind}: ${e.message}`);
    if (e.kind === 'badkey') {
      updateObNav();
      setKeyHint('Ключ не подошёл — скопируйте строку с сайта Google ещё раз.', 'bad');
      return;
    }
    note = e.kind === 'region'
      ? 'Ключ сохранён. Переводить получится без российского VPN или за пределами России.'
      : 'Ключ сохранён — проверим его при первом переводе.';
  }
  store.setKey(key);
  try { localStorage.removeItem(OB_STEP_KEY); } catch {}
  $('onboarding').classList.add('hidden');
  updateObNav();
  if (isInstalled()) { showApp(); toast(note || 'Готово! Можно говорить', note ? 4500 : 2600); }
  else { showInstallGuide('after'); if (note) toast(note, 4500); }
}

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** Инструкция по установке — своя для каждой платформы.
 *  mode: 'first' — до ключа (айфон, Safari); 'after' — ключ уже введён в
 *  браузере; 'help' — из настроек. */
function showInstallGuide(mode = 'help') {
  const steps = $('installSteps');
  steps.innerHTML = '';
  steps.parentElement.querySelectorAll('.install-extra').forEach(el => el.remove());
  $('installNow').classList.add('hidden');
  $('installCopyKey').classList.add('hidden');
  $('installLead').textContent = 'Добавьте Chào! на домашний экран — будет открываться как обычное приложение, во весь экран.';
  $('installTitle').textContent = mode === 'first' ? 'Сначала — значок' : mode === 'help' ? 'Значок на экране «Домой»' : 'Последний шаг';
  $('installSkip').textContent = mode === 'help' ? 'Назад' : 'Пропустить — пользоваться так';
  $('installSkip').onclick = () => { $('install').classList.add('hidden'); showApp(); };

  const put = (html) => { const li = document.createElement('li'); li.innerHTML = html; steps.appendChild(li); };
  const extraButton = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ghost install-extra';
    b.textContent = label;
    b.addEventListener('click', fn);
    steps.after(b);
  };

  if (ENV.ios && ENV.safari) {
    if (ENV.safariVersion >= 26) {
      // В iOS 26 кнопки «Поделиться» внизу по умолчанию нет — она за «•••»
      $('installIllust').innerHTML = addHomeIllustration();
      put('Нажмите <b>«•••»</b> рядом с адресной строкой. Если внизу видна кнопка <b>«Поделиться»</b> — квадрат со стрелкой, — можно сразу её.');
      put('Выберите <b>«Поделиться»</b> и пролистайте вниз до <b>«На экран „Домой“»</b>.');
      put('Проверьте, что включено <b>«Открыть как веб-приложение»</b>, и нажмите <b>«Добавить»</b>.');
    } else {
      $('installIllust').innerHTML = shareIllustration() + addHomeIllustration();
      put('Нажмите кнопку <b>«Поделиться»</b> внизу экрана — квадрат со стрелкой вверх.');
      put('Пролистайте список вниз до пункта <b>«На экран „Домой“»</b> и нажмите его.');
      put('Нажмите <b>«Добавить»</b> справа вверху.');
    }
    put('Закройте браузер и запускайте Chào! с домашнего экрана — по значку с флагом.');
    if (mode === 'first') {
      $('installLead').textContent = 'Сначала добавьте Chào! на экран «Домой», а ключ введёте уже в значке: Safari и значок хранят данные раздельно — введённое здесь значок не увидит.';
      $('installSkip').textContent = 'Пропустить — настроить в браузере';
      $('installSkip').onclick = () => {
        installFirstSkipped = true;
        $('install').classList.add('hidden');
        $('onboarding').classList.remove('hidden');
        goStep(1);
      };
    } else if (mode === 'after') {
      $('installLead').textContent = 'Добавьте Chào! на экран «Домой» — будет открываться как обычное приложение. В значке ключ спросят ещё раз: Safari и значок хранят данные раздельно. Скопируйте ключ сейчас — в значке останется нажать «Вставить из буфера».';
      $('installCopyKey').classList.remove('hidden');
      $('installCopyKey').onclick = async () => {
        try { await navigator.clipboard.writeText(store.getKey()); toast('Ключ скопирован'); haptic(12); }
        catch { toast('Не получилось скопировать — ключ можно взять на сайте Google ещё раз'); }
      };
    }
  } else if (ENV.chromeIOS) {
    $('installIllust').innerHTML = addHomeIllustration();
    put('Нажмите <b>«Поделиться»</b> — квадрат со стрелкой справа в адресной строке.');
    put('Выберите <b>«На экран „Домой“»</b> (если пункта нет — пролистайте список).');
    put('Нажмите <b>«Добавить»</b>.');
    put('Если не получилось — откройте эту ссылку в Safari и добавьте значок оттуда.');
    extraButton('Скопировать ссылку', copyLink);
  } else if (ENV.ios) {
    $('installLead').textContent = 'Чтобы значок появился на домашнем экране, эту страницу нужно открыть в Safari — этот браузер так не умеет.';
    $('installIllust').innerHTML = shareIllustration();
    put('Скопируйте ссылку этой страницы (кнопка ниже).');
    put('Откройте <b>Safari</b> — стандартный браузер с синим компасом.');
    put('Вставьте ссылку в адресную строку и откройте.');
    put('Нажмите <b>«Поделиться»</b> → <b>«На экран „Домой“»</b>.');
    extraButton('Скопировать ссылку', copyLink);
  } else if (ENV.android && ENV.inApp) {
    $('installLead').textContent = 'Ссылка открыта внутри мессенджера — отсюда приложение не установить. Откройте её в Chrome.';
    $('installIllust').innerHTML = androidInstallIllustration();
    put('Нажмите <b>«•••»</b> справа вверху и выберите <b>«Открыть в браузере»</b> — или скопируйте ссылку и вставьте в Chrome.');
    put('В Chrome: три точки → <b>«Установить приложение»</b>.');
    extraButton('Скопировать ссылку', copyLink);
  } else if (ENV.android) {
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
    $('installIllust').innerHTML = '';
    put(`Откройте на телефоне <b>${escapeHtml(location.host)}</b>.`);
    put('iPhone: Safari → «Поделиться» (в iOS 26 — за «•••») → «На экран „Домой“».');
    put('Android: Chrome → три точки → «Установить приложение».');
  }
  $('install').classList.remove('hidden');
}

function showOnboarding() {
  $('onboarding').classList.remove('hidden');
  $('app').classList.add('hidden');
  let saved = 0;
  try { saved = Number(localStorage.getItem(OB_STEP_KEY)) || 0; } catch {}
  goStep(saved);
}
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
  // Дописываем одну реплику, а не перерисовываем ленту: иначе в волне она
  // моргала целиком на каждой реплике и выдёргивала того, кто листает вверх.
  const feed = $('feed');
  if (messages.length === 1 || !feed.querySelector('.msg, .msg-failed')) { renderFeed(); return; }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.insertBefore(messageEl(msg), $('typingBubble'));
  if (atBottom) feed.scrollTop = feed.scrollHeight;
  maybeHintBig();
}

/// Один раз за жизнь установки — что пузырь нажимается.
function maybeHintBig() {
  try {
    if (localStorage.getItem('chao.hintBig') || messages.filter(m => !m.failed).length < 1) return;
    localStorage.setItem('chao.hintBig', '1');
  } catch { return; }
  setTimeout(() => toast('Тап по реплике — показать её собеседнику крупно', 3500), 1200);
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
  for (const m of messages) feed.appendChild(messageEl(m));
  feed.scrollTop = feed.scrollHeight;
}

let lastSay = { id: null, at: 0 };

function messageEl(m) {
    if (m.failed) {
      const box = document.createElement('div');
      box.className = 'msg-failed';
      box.innerHTML = `<div class="mf-text"></div>`;
      box.querySelector('.mf-text').textContent = m.error || 'Не удалось перевести.';
      if (m.detail) {
        const d = document.createElement('div');
        d.className = 'mf-detail';
        d.textContent = m.detail;
        box.appendChild(d);
      }
      const r = retries.get(m.id);
      if (r) {
        const again = document.createElement('button');
        again.className = 'mf-retry';
        again.textContent = r.label;
        again.addEventListener('click', () => retryFailed(m.id));
        box.appendChild(again);
      }
      return box;
    }
    const el = document.createElement('div');
    el.className = `msg ${m.sourceLanguage === 'ru' ? 'mine' : 'theirs'}${m.pending ? ' pending' : ''}`;
    const trIsRu = isMostlyCyrillic(m.translation);
    const src = document.createElement('div');
    src.className = 'src';
    src.lang = trIsRu ? 'vi' : 'ru';
    src.textContent = (m.transcript || 'живой перевод') + (m.via === 'text' ? ' · переведено текстом' : '');
    const tr = document.createElement('div');
    tr.className = 'tr';
    tr.lang = trIsRu ? 'ru' : 'vi';
    tr.textContent = m.translation;
    // Не расслышали — повторить вслух прямо из ленты; второй тап подряд — медленнее
    const say = document.createElement('button');
    say.className = 'msg-say';
    say.setAttribute('aria-label', 'Озвучить ещё раз');
    say.innerHTML = iconSVG('speaker', 18);
    say.addEventListener('click', (e) => {
      e.stopPropagation();
      speaker.unlock();
      const again = lastSay.id === m.id && Date.now() - lastSay.at < 6000;
      lastSay = { id: m.id, at: Date.now() };
      speaker.speak(m.translation, trIsRu ? 'ru-RU' : 'vi-VN', again ? 0.7 : undefined);
    });
    el.append(src, tr, say);
    el.addEventListener('click', () => openBig(m));
    return el;
}

let bigText = '';   // что копировать и чем делиться с экрана показа

function openBig(m) {
  $('bigInner').classList.remove('flipped');
  $('bigSrc').textContent = m.transcript || '';
  $('bigTr').textContent = m.translation;
  $('bigTr').lang = isMostlyCyrillic(m.translation) ? 'ru' : 'vi';
  const lang = isMostlyCyrillic(m.translation) ? 'ru-RU' : 'vi-VN';
  $('bigSpeak').onclick = () => speaker.speak(m.translation, lang);
  bigText = m.translation;
  showBig();
}

function showBig() {
  $('bigView').classList.remove('hidden');
  // Официант переписывает заказ в блокнот — экран не должен погаснуть
  holdScreen('big');
  fitBig();
}

function closeBig() {
  $('bigView').classList.add('hidden');
  releaseScreen('big');
}

/// Размер текста под объём: короткое «Không đá» — видно издалека, длинный
/// заказ — целиком, без прокрутки, пока хватает места.
function fitBig() {
  const tr = $('bigTr'), box = $('bigInner');
  let size = 72;
  tr.style.fontSize = size + 'px';
  while (size > 24 && box.scrollHeight > box.clientHeight + 1) {
    size -= 4;
    tr.style.fontSize = size + 'px';
  }
  box.scrollTop = 0;
}

async function holdScreen(who) {
  screenHolders.add(who);
  if (screenLock || document.hidden || !navigator.wakeLock) return;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!screenHolders.size || screenLock) { l.release().catch(() => {}); return; }
    screenLock = l;
    l.addEventListener?.('release', () => { if (screenLock === l) screenLock = null; });
  } catch {}
}

function releaseScreen(who) {
  screenHolders.delete(who);
  if (screenHolders.size || !screenLock) return;
  const l = screenLock;
  screenLock = null;
  l.release().catch(() => {});
}

function contextSnippet() {
  // Пары «оригинал = перевод» (неудачи, непереведённое) модели в пример не даём:
  // это ровно тот повтор на своём языке, с которым боремся.
  return messages.filter(m => !m.failed && m.translation && m.transcript !== m.translation).slice(-6).map(m => `[${m.sourceLanguage}] ${m.transcript} → ${m.translation}`).join('\n');
}

/// actionFn — что делает кнопка справа; без неё — выключает волну или запись.
let statusFn = null;
function setStatus(text, cls, actionLabel, actionFn) {
  const line = $('statusLine');
  statusFn = actionFn || null;
  if (!text) { line.classList.add('hidden'); return; }
  line.className = `statusline ${cls || ''}`;
  $('statusText').textContent = text;
  $('statusAction').textContent = actionLabel || 'Выключить';
  $('statusAction').classList.toggle('hidden', !actionLabel);
}

/// Статус «как в покое»: в волне — её состояние, иначе пусто.
function idleStatus() {
  if (liveOn) renderLive(); else setStatus('');
}

// Баннер читает собеседник — поэтому крупно по-вьетнамски, мелко по-русски.
const BANNER = {
  listen: ['Xin mời nói! • Говорите!', 'Nói tiếng Việt, máy sẽ dịch • Я сразу переведу'],
  wait: ['Xin chờ chút • Подождите', 'Đang dịch, xin nghe xong đã • Идёт перевод — дослушайте'],
  rec: ['Xin mời nói! • Говорите!', 'Nói xong, máy sẽ dịch • Я переведу, когда закончите'],
};

/// mode: 'listen' — микрофон открыт и сессия слушает; 'wait' — звучит перевод,
/// микрофон на паузе; 'rec' — запись фразы; false — спрятать.
function showBanner(mode) {
  const b = $('speakBanner');
  b.classList.toggle('on', !!mode);
  b.classList.toggle('rec', mode === 'rec');
  b.classList.toggle('wait', mode === 'wait');
  if (!mode || b.dataset.mode === mode) return;
  b.dataset.mode = mode;
  const [big, small] = BANNER[mode];
  b.textContent = big;
  const s = document.createElement('small');
  s.textContent = small;
  b.appendChild(s);
}

// --- живой режим

// Что сейчас с волной. Баннер зовёт говорить только тогда, когда сессия
// действительно слушает и микрофон открыт: раньше он горел и во время
// переподключения, и пока звучал перевод, — а сказанное в это время терялось.
const liveUi = { conn: 'connecting', heard: false, micProblem: null };
let typingPause = false;     // пишут текст — волна молчит и не переводит вслух
let micStarting = false;     // идёт запуск микрофона — вторые нажатия не нужны
let liveTimer = null;
let lastLiveActivity = 0;
let micFix = { stage: 0, at: 0 };
let stallMark = { server: 0, loud: 0 };
// Экран не гаснет, только пока идёт разговор; забытая волна сама выключится.
const WAKE_HOLD_MS = 150_000;
const LIVE_IDLE_STOP_MS = 300_000;

function renderLive() {
  if (!liveOn) return;
  const speaking = modelSpeaking || ttsSpeaking;
  const off = 'Выключить';
  if (liveUi.micProblem) { setStatus(liveUi.micProblem, 'err', 'Перезапустить', restartLive); showBanner(false); return; }
  if (typingPause) { setStatus('волна на паузе, пока вы пишете', 'busy', off); showBanner(false); return; }
  if (speaking) { setStatus('перевожу вслух — микрофон на паузе', 'busy', off); showBanner('wait'); return; }
  if (liveUi.conn === 'connecting') { setStatus('подключаюсь…', 'busy', off); showBanner(false); return; }
  if (liveUi.conn === 'reconnecting') { setStatus('переподключаюсь…', 'busy', off); showBanner(false); return; }
  if (liveUi.conn === 'slow') { setStatus('слабая связь — перевод запаздывает, надёжнее микрофон', 'busy', off); showBanner(false); return; }
  if (liveUi.heard) { setStatus('слышу — переведу, когда договорите', 'live', off); showBanner('listen'); return; }
  setStatus('слушаю: русский или вьетнамский', 'live', off);
  showBanner('listen');
}

async function toggleLive() {
  if (liveOn) { stopLive(); return; }
  if (recording || micStarting) return;
  if (!navigator.onLine) {
    setStatus('нет сети — живому переводу нужен интернет', 'err', 'Включить снова', toggleLive);
    return;
  }

  micStarting = true;
  $('liveBtn').disabled = true;
  $('micBtn').disabled = true;
  setStatus('подключаюсь…', 'busy');
  try {
    await mic.start();
  } catch (e) {
    if (!e.cancelled) {
      log(`микрофон отказ: ${e.name} — ${e.message}`);
      setStatus('нет доступа к микрофону', 'err', null);
      toast('Разрешите доступ к микрофону');
    }
    $('liveBtn').disabled = false;
    $('micBtn').disabled = false;
    return;
  } finally {
    micStarting = false;
  }

  player.reset();
  speaker.stop();
  modelSpeaking = ttsSpeaking = false;
  mic.muted = false;
  typingPause = false;
  Object.assign(liveUi, { conn: 'connecting', heard: false, micProblem: null });
  micFix = { stage: 0, at: 0 };
  stallMark = { server: 0, loud: mic.loudFrames || 0 };
  quietSince = performance.now();

  live = new LiveSession({
    onTurn: handleLiveTurn,
    onSilentTurn: handleSilentTurn,
    onHeard: (on) => { liveUi.heard = on; if (on) liveActivity(); renderLive(); },
    onAudio: (b64) => player.enqueue(b64),
    onInterrupted: () => player.flush(),
    onState: (s) => {
      if (s === 'idle') return;
      liveUi.conn = s;
      if (s !== 'listening') liveUi.heard = false;
      renderLive();
    },
    onError: (msg) => {
      stopLive();
      toast(msg);
      // Тост исчезает за пару секунд, а человек смотрит на собеседника —
      // причина остаётся в строке статуса вместе с кнопкой.
      setStatus(msg, 'err', 'Включить снова', toggleLive);
      haptic([30, 60, 30]);
    },
    // Тихо ли сейчас: goAway можно отработать сразу, никого не оборвав
    isQuiet: () => !(modelSpeaking || ttsSpeaking) && performance.now() - (mic.lastLoudAt || 0) > 1500,
    micInfo: () => mic.info(),
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
  lastLiveActivity = 0;
  liveActivity();
  clearInterval(liveTimer);
  liveTimer = setInterval(liveWatch, 1000);
  renderLive();
}

function stopLive() {
  liveOn = false;
  clearInterval(liveTimer);
  liveTimer = null;
  keepAudioRunning(false);
  updateMicIndicator();
  live?.stop();
  live = null;
  mic.onChunk = null;
  mic.stop();
  player.reset();
  releaseScreen('live');
  typingPause = false;
  $('liveBtn').classList.remove('on');
  $('micBtn').disabled = false;
  showBanner(false);
  setStatus('');
}

function restartLive() {
  stopLive();
  toggleLive();
}

/// Реплика, речь или текст — разговор идёт: держим экран и откладываем автостоп.
function liveActivity() {
  lastLiveActivity = Date.now();
  if (liveOn) holdScreen('live');
}

/// Раз в секунду, пока включена волна: жив ли микрофон, не встала ли связь,
/// не забыли ли волну включённой.
function liveWatch() {
  if (!liveOn) return;
  const idle = Date.now() - lastLiveActivity;
  if (idle > LIVE_IDLE_STOP_MS) {
    log('волна: 5 минут без реплик — выключаю');
    stopLive();
    haptic([20, 60, 20]);
    setStatus('Волна выключилась: 5 минут тишины', '', 'Включить снова', toggleLive);
    return;
  }
  if (screenHolders.has('live') && idle > WAKE_HOLD_MS) {
    log('волна: 2,5 минуты без реплик — экран снова гаснет сам');
    releaseScreen('live');
  }

  // Микрофон: кадры не идут или дорожку заглушила система (звонок, Siri,
  // диктовка) — раньше это выглядело как «слушаю», а перевода не было.
  if (mic.active && !micStarting) {
    const now = performance.now();
    const t = mic.stream?.getAudioTracks()[0];
    const speaking = modelSpeaking || ttsSpeaking;
    const zeroFor = now - Math.max(mic.lastSignalAt || 0, quietSince);
    const noFrames = now - mic.lastFrameAt > 2500;
    const dead = noFrames || t?.readyState === 'ended' || (!!t?.muted && !speaking && zeroFor > 3500);
    if (dead) micTrouble(noFrames ? 'нет кадров' : t?.readyState === 'ended' ? 'дорожка закрыта' : 'дорожка заглушена', true);
    // Ровный ноль без признака заглушки — подозрительно, но не повод пугать:
    // одна мягкая попытка, без сообщения об ошибке.
    else if (!speaking && zeroFor > 20000) micTrouble('ровный ноль 20 с', false);
    else if (micFix.stage && now - (mic.lastSignalAt || 0) < 1500) {
      log('микрофон снова слышит');
      micFix = { stage: 0, at: 0 };
      if (liveUi.micProblem) { liveUi.micProblem = null; renderLive(); }
    }
  }

  // Связь: микрофон слышит речь, а сервер полминуты не отвечает ничем.
  if (live?.ready && !mic.muted) {
    if (live.lastServerAt !== stallMark.server) stallMark = { server: live.lastServerAt, loud: mic.loudFrames };
    else if (Date.now() - live.lastServerAt > 30000 && mic.loudFrames - stallMark.loud > 40) {
      stallMark = { server: live.lastServerAt, loud: mic.loudFrames };
      live.kick('сервер молчит 30 с, хотя микрофон слышит речь');
    }
  }
}

/// canGiveUp — можно ли дойти до сообщения «микрофон отключила система».
async function micTrouble(kind, canGiveUp) {
  const now = performance.now();
  if (now - micFix.at < 3000) return;   // даём прошлой попытке время
  if (!canGiveUp && micFix.stage >= 2) return;
  micFix.at = now;
  if (micFix.stage === 0) {
    micFix.stage = 1;
    log(`микрофон молчит (${kind}): ${mic.info()} — возобновляю звук`);
    try { await audioContext().resume(); } catch {}
  } else if (micFix.stage === 1) {
    micFix.stage = 2;
    log(`микрофон молчит (${kind}) — перезапускаю захват`);
    const onChunk = mic.onChunk;
    mic.stop();
    try {
      await mic.start();
      if (!liveOn) { mic.stop(); return; }
      mic.onChunk = onChunk;
      quietSince = performance.now();
      refreshMicMute();
    } catch (e) {
      log(`микрофон: перезапуск не удался — ${e.name}`);
    }
  } else if (micFix.stage === 2) {
    micFix.stage = 3;
    log(`микрофон так и не ожил: ${mic.info()}`);
    liveUi.micProblem = 'микрофон отключила система — нажмите «Перезапустить»';
    renderLive();
    haptic([30, 60, 30]);
  }
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
// Когда динамик замолчал: эхоподавление глушит вход, пока он говорит, —
// ровная тишина до этого момента не признак сломанного микрофона.
let quietSince = 0;

function refreshMicMute() {
  const busySpeaking = modelSpeaking || ttsSpeaking;
  const wasMuted = mic.muted;
  mic.muted = busySpeaking || (liveOn && typingPause);
  if (wasMuted && !busySpeaking) quietSince = performance.now();
  // Ровно на переходе «начали глушить» сообщаем серверу, что поток прервался:
  // под мьютом чанки выбрасываются, и без этого признака хвост речи склеится
  // с началом следующей реплики.
  if (!wasMuted && mic.muted && liveOn) live?.endAudioStream();
  renderLive();
}

/// Пока пишут текст, волна на паузе: иначе она переводит вслух всё, что
/// говорят рядом, а диктовка с клавиатуры прозвучала бы дважды.
function setTypingPause(on) {
  if (typingPause === on) return;
  typingPause = on;
  if (!liveOn) return;
  log(on ? 'волна: пауза — пишут текст' : 'волна: пауза снята');
  refreshMicMute();
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

const wordsOf = (t) => t.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/// Доля общих слов: настоящий дрейф — это повтор фразы на её же языке.
function overlap(a, b) {
  const A = new Set(wordsOf(a)), B = new Set(wordsOf(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function handleLiveTurn(transcript, translation) {
  liveActivity();
  const text = translation.trim();
  if (!text) return;
  if (LANGUAGE_NAME_ONLY.test(text) || (transcript && LANGUAGE_NAME_ONLY.test(transcript.trim()))) {
    log(`пропускаю самоописание распознавателя: «${(transcript || text).slice(0, 40)}»`);
    return;
  }
  const translationIsRu = isMostlyCyrillic(text);
  const transcriptIsRu = transcript ? isMostlyCyrillic(transcript) : !translationIsRu;

  if (transcript && transcriptIsRu === translationIsRu) {
    // Дрейф модели — «перевод» повторяет фразу на её же языке: чиним через REST.
    // Короткое «Dạ» распознаватель пишет кириллицей «Да», и верный перевод «Да»
    // выглядит так же, — поэтому короткие реплики не трогаем.
    if (wordsOf(transcript).length >= 3 && overlap(transcript, text) > 0.5) {
      log('дрейф: перевод повторяет реплику, отправляю в REST');
      repairTurn(transcript);
      return;
    }
    // Не повтор: транскрипт опоздал или записан не тем алфавитом. Перевод
    // верим, а транскрипт парой к нему не показываем — он от другой реплики.
    log('Live: транскрипт и перевод на одном языке, но это не повтор — оставляю перевод');
    addMessage({
      id: crypto.randomUUID(), ts: Date.now(),
      sourceLanguage: translationIsRu ? 'vi' : 'ru', transcript: '', translation: text,
    });
    return;
  }
  addMessage({
    id: crypto.randomUUID(), ts: Date.now(),
    sourceLanguage: translationIsRu ? 'vi' : 'ru',
    transcript: transcript || '', translation: text,
  });
}

/// Модель промолчала, хотя распознаватель услышал связную фразу (шумный
/// рынок, цена): переводим распознанное текстом — молчание без следа хуже.
function handleSilentTurn(transcript) {
  liveActivity();
  const t = transcript.trim();
  if (wordsOf(t).length < 3 || LANGUAGE_NAME_ONLY.test(t)) return;
  const hasCyr = /[а-яё]/i.test(t), hasLat = /[a-z]/i.test(t.normalize('NFD'));
  if (hasCyr && hasLat) return;   // смесь алфавитов — скорее мусор распознавателя
  log('Live: модель промолчала — перевожу распознанное текстом');
  repairTurn(t);
}

/// Перевод реплики волны через обычный текстовый перевод.
async function repairTurn(transcript) {
  const fail = (why) => {
    log(`волна: перевод текстом не удался — ${why}`);
    addFailure(`Не удалось перевести: «${transcript.length > 90 ? transcript.slice(0, 90) + '…' : transcript}»`,
      () => gemini.translateText(transcript, contextSnippet()), 'Повторить перевод');
  };
  try {
    const r = await gemini.translateText(transcript, contextSnippet());
    const translation = (r.translation || '').trim();
    if (!translation) { fail('пустой ответ'); return; }
    addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: r.sourceLanguage, transcript: r.transcript || transcript, translation, via: 'text' });
    if (r.sourceLanguage === 'ru') speaker.speak(translation, 'vi-VN');
  } catch (e) {
    // Раньше в ленту молча ложился оригинал под видом перевода.
    fail(e.message);
  }
}

// --- запись фразы (обычный режим)

async function toggleRecording() {
  if (liveOn || micStarting) return;
  if (recording) {
    haptic(14);
    recording = false;
    updateMicIndicator();
    $('micBtn').classList.remove('rec');
    $('micBtn').innerHTML = iconSVG('mic', 25);
    $('cancelRecBtn').classList.add('hidden');
    $('liveBtn').classList.remove('hidden');
    showBanner(false);
    const wav = mic.stopRecording();
    mic.stop();
    keepAudioRunning(false);
    releaseScreen('rec');
    setStatus('');
    if (!wav) { toast('Слишком коротко — скажите фразу целиком'); return; }
    // Запись остаётся в замыкании: повтор не требует говорить снова — в разговоре это важно
    const again = () => gemini.translateAudio(wav, contextSnippet());
    const sec = Math.max(1, Math.round((wav.length * 3 / 4 - 44) / 32000));
    await translateAndAdd(again, again, 'Повторить — запись сохранена', `запись · ${sec} с`);
    return;
  }
  micStarting = true;
  $('liveBtn').disabled = true;
  try {
    await mic.start();
  } catch (e) {
    if (!e.cancelled) toast('Разрешите доступ к микрофону');
    return;
  } finally {
    micStarting = false;
    $('liveBtn').disabled = false;
  }
  mic.startRecording();
  // iOS ставит звук на паузу (уведомление, Siri, наушники) — без этого запись
  // молча переставала копить звук, а на экране «идёт запись».
  keepAudioRunning(true);
  holdScreen('rec');
  haptic(14);
  recording = true;
  updateMicIndicator();
  $('micBtn').classList.add('rec');
  $('micBtn').innerHTML = iconSVG('stop', 24);
  $('cancelRecBtn').classList.remove('hidden');
  $('liveBtn').classList.add('hidden');
  showBanner('rec');
  setStatus('идёт запись — нажмите ещё раз, когда закончите', '', 'Отмена');
}

function cancelRecording() {
  if (!recording) return;
  recording = false;
  updateMicIndicator();
  mic.stopRecording();
  mic.stop();
  keepAudioRunning(false);
  releaseScreen('rec');
  $('micBtn').classList.remove('rec');
  $('micBtn').innerHTML = iconSVG('mic', 25);
  $('cancelRecBtn').classList.add('hidden');
  $('liveBtn').classList.remove('hidden');
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
  setTypingPause(false);
  if (liveOn) liveActivity();
  const again = () => gemini.translateText(text, contextSnippet());
  await translateAndAdd(again, again, 'Повторить перевод', `«${text.length > 80 ? text.slice(0, 80) + '…' : text}»`);
}

/// fn — сам перевод, retry — как повторить его же, если не выйдет;
/// detail — что повторится («запись · 4 с», набранный текст).
async function translateAndAdd(fn, retry, retryLabel, detail) {
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
      addFailure(detail?.startsWith('«') ? 'Не понял текст — попробуйте написать иначе.' : 'Не разобрал речь. Попробуйте ещё раз или поднесите телефон ближе.', retry, retryLabel, detail);
    } else {
      addMessage({ id: crypto.randomUUID(), ts: Date.now(), sourceLanguage: r.sourceLanguage, transcript: r.transcript, translation });
      if (r.sourceLanguage === 'ru') speaker.speak(translation, 'vi-VN');
    }
    idleStatus();
  } catch (e) {
    idleStatus();
    log(`перевод не удался: ${e.message}`);
    // Тост исчезает через секунду, а человек стоит перед собеседником с пустым
    // экраном. Неудача остаётся в ленте — вместе с кнопкой повтора той же записи.
    addFailure(e.message, retry, retryLabel, detail);
  } finally {
    clearTimeout(slowTimer);
    showTyping(false);
    busy = false;
    $('sendBtn').disabled = false;
    $('micBtn').disabled = liveOn;   // в живом режиме запись всё равно недоступна
    if (newAfterBusy) { newAfterBusy = false; newSession(); }
  }
}

/// Неудача попадает в ленту как карточка с кнопкой «Повторить»: исходник
/// (запись или текст) сохранён, повторять вслух не нужно.
function addFailure(text, retry, retryLabel, detail) {
  const id = crypto.randomUUID();
  if (retry) retries.set(id, { run: retry, label: retryLabel || 'Повторить', detail });
  addMessage({ id, ts: Date.now(), failed: true, error: text, detail: detail || '', sourceLanguage: 'ru', transcript: '', translation: '' });
}

async function retryFailed(id) {
  const r = retries.get(id);
  if (!r || busy) return;
  retries.delete(id);
  messages = messages.filter(m => m.id !== id);   // карточку убираем, место займёт результат
  renderFeed();
  await translateAndAdd(r.run, r.run, r.label, r.detail);
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
  if (recording) { cancelRecording(); toast('Запись отменена'); }
  if (!messages.length) return;
  // Перевод ещё идёт — иначе он лёг бы в новый разговор и прозвучал там
  if (busy) { newAfterBusy = true; toast('Перевод ещё идёт — допишу его и начну новый разговор'); return; }
  speaker.stop();
  store.takeEvicted();
  if (!store.setCurrent(messages) || !store.archiveCurrent()) {
    log('новый разговор: не хватило места для архива');
    toast('Не хватает места — удалите старые фото в Истории');
    return;
  }
  messages = [];
  retries.clear();
  renderFeed();
  // Модель волны помнит прошлого собеседника — новому разговору нужна чистая сессия
  if (liveOn) live?.fresh();
  const ev = store.takeEvicted();
  if (ev.photos || ev.sessions) {
    const what = [ev.sessions && plural(ev.sessions, 'старый разговор', 'старых разговора', 'старых разговоров'), ev.photos && plural(ev.photos, 'старое фото', 'старых фото', 'старых фото')].filter(Boolean).join(' и ');
    log(`место: удалено ${what}`);
    toast(`Разговор сохранён. Не хватало места — пришлось удалить ${what}`, 4000);
  } else toast('Разговор сохранён в историю');
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
    // У восстановленных страниц самих снимков нет — модели достаётся текст разбора
    const images = doc.pages.map(p => p.base64).filter(Boolean);
    const partial = images.length < doc.pages.length;
    const answer = await gemini.askPhoto(images, doc.chat, partial ? JSON.stringify(mergedResult(doc)) : null);
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
// Текущий снимок с заказом и вопросами переживает выгрузку приложения: iOS
// закрывает PWA, пока человек платит по QR в банковском приложении, — и раньше
// «Фото» оказывалось пустым. Сами страницы большие, храним только маленькие превью.
const PHOTO_KEY = 'chao.photo.current';
let photoSaveTimer = null;

function schedulePhotoSave() {
  clearTimeout(photoSaveTimer);
  photoSaveTimer = setTimeout(savePhotoDoc, 400);
}

async function savePhotoDoc() {
  const doc = photo;
  const pages = doc.pages.filter(p => p.result);
  if (!pages.length) { try { localStorage.removeItem(PHOTO_KEY); } catch {} return; }
  for (const p of pages) if (p.thumb === undefined) p.thumb = await smallThumb(p.dataUrl);
  if (doc !== photo) return;
  const data = {
    ts: Date.now(), historyId: doc.historyId,
    pages: pages.map(p => ({ result: p.result, thumb: p.thumb })),
    order: [...doc.order], chat: doc.chat.filter(m => !m.failed),
  };
  try { localStorage.setItem(PHOTO_KEY, JSON.stringify(data)); }
  catch { log('фото: не хватило места сохранить текущий снимок'); }
}

async function smallThumb(dataUrl) {
  if (!dataUrl || dataUrl.length < 30000) return dataUrl || '';
  try { return (await compressImage(await (await fetch(dataUrl)).blob(), 200, 0.5)).dataUrl; }
  catch { return ''; }
}

/// Страница без самого снимка: результат, превью; вопросы — по тексту разбора.
const restoredPage = (result, thumb) => ({ dataUrl: thumb || '', thumb: thumb || '', base64: null, result, analyzing: false, error: null, restored: true });

function restorePhotoDoc() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(PHOTO_KEY)); } catch {}
  if (!d?.pages?.length) return;
  // Вчерашнее меню в «Фото» не нужно — оно есть в истории
  if (Date.now() - d.ts > 12 * 3600 * 1000) { try { localStorage.removeItem(PHOTO_KEY); } catch {} return; }
  photo = newPhotoDoc();
  photo.historyId = d.historyId || null;
  photo.pages = d.pages.map(p => restoredPage(p.result, p.thumb));
  photo.order = new Map(d.order || []);
  photo.chat = d.chat || [];
  log(`фото: восстановлен снимок — ${plural(photo.pages.length, 'страница', 'страницы', 'страниц')}, в заказе ${photo.order.size}`);
}

/// Меню из истории — не только посмотреть: по нему можно снова собрать заказ.
function openPhotoFromHistory(p) {
  photoEpoch++;   // пачка, которая ещё сжимается, в этот документ не попадёт
  photo = newPhotoDoc();
  photo.historyId = p.id;
  photo.pages = [restoredPage(p.result, p.thumb)];
  $('photoAsk').value = '';
  $('history').classList.add('hidden');
  switchTab('photo');
  renderPhoto();
  toast(p.result.isMenu ? 'Меню открыто — можно собрать заказ' : 'Документ открыт');
}

function renderPhoto({ toChat = false, fromDish = false } = {}) {
  const box = $('photoResult');
  schedulePhotoSave();
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
      <p class="fine">Паспорт и банковские бумаги лучше не снимать: на бесплатном тарифе Google может прочитать присланное.</p>
      <p class="empty-note">Многостраничное меню снимайте целиком: отметьте в галерее все страницы разом — разберу их как одно меню.</p></div>`;
    return;
  }

  // Лента страниц: миниатюры с крестиком + плитка «добавить»
  let strip = '<div class="strip">';
  photo.pages.forEach((page, i) => {
    strip += `<div class="strip-item${page.analyzing ? ' busy' : ''}${page.error ? ' failed' : ''}">
      ${page.dataUrl ? `<img src="${page.dataUrl}" alt="страница ${i + 1}">` : `<span class="strip-ph">${iconSVG('image', 26)}</span>`}
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
  $('bigTr').lang = 'vi';
  $('bigTr').innerHTML = items.map(i =>
    `<div class="big-item">${i.n} × ${escapeHtml(i.dish.original)}
      <div class="big-sub" lang="ru">${escapeHtml(i.dish.translation)}${i.dish.price ? ' · ' + escapeHtml(i.dish.price) : ''}</div>
    </div>`).join('');
  const phrase = 'Cho tôi ' + items.map(i => `${i.n} ${i.dish.original}`).join(', ');
  $('bigSpeak').onclick = () => speaker.speak(phrase, 'vi-VN');
  bigText = 'Cho tôi gọi món:\n' + items.map(i => `${i.n} × ${i.dish.original}`).join('\n');
  showBig();
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
          if (busy || recording) { toast('Дождитесь перевода — он ещё идёт'); return; }
          const restored = store.resumeSession(s.id);
          if (!restored) { toast('Не хватило места — сначала удалите старые фото в Истории'); return; }
          if (restored) { messages = restored; retries.clear(); renderFeed(); if (liveOn) live?.fresh(); $('history').classList.add('hidden'); switchTab('dialog'); toast('Разговор продолжен'); }
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
        () => openPhotoFromHistory(p)
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
  let startX = 0, startY = 0, dx = 0, open = false, dragging = false, axis = null;

  const setX = (x) => { card.style.transform = `translateX(${x}px)`; };

  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    // От того положения, где карточка сейчас: иначе после закрытия «Удалить»
    // старое смещение снова открывало её, и тап больше не открывал запись.
    dx = open ? -96 : 0;
    dragging = true; axis = null; card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const mx = e.touches[0].clientX - startX, my = e.touches[0].clientY - startY;
    // Вертикальная прокрутка списка не должна двигать карточки вбок
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    }
    if (axis !== 'x') return;
    dx = mx + (open ? -96 : 0);
    setX(Math.max(-110, Math.min(0, dx)));
  }, { passive: true });

  card.addEventListener('touchend', () => {
    dragging = false;
    if (axis !== 'x') return;
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
  $('storageInfo').textContent = `Занято ${kb} КБ из ~5 МБ · ${plural(sessions, 'разговор', 'разговора', 'разговоров')} · ${plural(photos, 'фото', 'фото', 'фото')}`;
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
