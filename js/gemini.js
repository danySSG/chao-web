// Клиент Gemini: REST-цепочка с фолбэками + Live API по WebSocket.
// Логика перенесена из нативной версии (Swift), протокол проверен в поле.

import { store } from './store.js?v=202608281546';
import { log } from './util.js?v=202608281546';

const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';

// У каждой модели своя дневная квота free tier: flash по 20/день, lite по 500,
// Gemma 14 400. Мёртвые и перегруженные модели цепочка пропускает сама.
const CHAIN = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
];
const LAST_RESORT = 'gemma-4-31b-it'; // только текст и фото, аудио не принимает

const DIALOG_PROMPT = `Ты — профессиональный переводчик-синхронист между русским и вьетнамским языками, работаешь во Вьетнаме.
На вход приходит либо аудиозапись живой речи, либо текст.

1. Если это аудио — точно расшифруй сказанное и запиши в поле transcript. Если текст — скопируй его в transcript без изменений.
2. Определи язык источника: "ru" — русский, "vi" — вьетнамский, "other" — любой другой.
3. Переведи: русский → на естественный вежливый разговорный вьетнамский; вьетнамский или другой язык → на живой разговорный русский.

В этом разговоре существуют ровно два языка: русский и вьетнамский. Если речь звучит как испанская,
португальская или английская — это почти наверняка русский, произнесённый быстро или в шуме.

Сохраняй смысл, тон и числа (цены, время, адреса). Ничего не добавляй от себя.`;

const PHOTO_PROMPT = `Ты — эксперт по вьетнамской кухне и профессиональный переводчик. На вход приходит фотография из Вьетнама.

Сначала определи тип: меню/ценник (isMenu = true) или любой другой текст — документ, вывеска, инструкция, объявление (isMenu = false).

ЕСЛИ ЭТО МЕНЮ: заполни sections. Для каждого блюда:
- original: название как в меню (с вьетнамской диакритикой);
- translation: понятный и аппетитный перевод на русский;
- ingredients: кратко ключевые ингредиенты и способ приготовления; если состав не указан — назови типичный;
- price: цена как в меню (например "45.000đ"), если цены нет — пустая строка.
Сгруппируй по разделам меню; если разделов нет — одна секция с пустым title. Напитки тоже переводи.

ЕСЛИ ЭТО НЕ МЕНЮ: заполни summary (2–4 предложения: что это за документ и что от человека требуется — простыми словами)
и blocks — перевод по смысловым фрагментам: original (как в оригинале) и translation (по-русски).
Сохраняй все числа, даты, суммы и имена точно.

Заполняй только тот набор полей, который соответствует типу. Второй оставь пустым.

Если фотографий несколько — это страницы одного документа или меню. Разбери их как единое целое,
по порядку, не повторяя одно и то же дважды.

Все поля — только человеческий текст по-русски (кроме original — там язык оригинала).
НИКОГДА не пиши в них служебных пометок, рассуждений о формате, слов вроде JSON, output, parseable,
«Done», «OK», «Clean» и не повторяй одну и ту же фразу. summary — не длиннее 600 знаков.`;

const PHOTO_CHAT_PROMPT = `Ты помогаешь русскоязычному человеку во Вьетнаме разобраться с тем, что на фотографии.

Отвечай по-русски, коротко и по делу — 1–4 предложения, без вступлений и без повторения вопроса.
Опирайся на то, что видно на фото. Если спрашивают о том, чего на фото нет, честно скажи об этом
и подскажи, что можно сделать.
Если просят сказать или написать фразу по-вьетнамски — дай фразу вьетнамскими буквами, а следом
в скобках подсказку по произношению русскими буквами.
Если на фото меню — можешь советовать блюда, объяснять состав, остроту, предупреждать об аллергенах.

Никогда не описывай свои рассуждения, не пиши служебных пометок и не повторяй одну и ту же фразу.`;

const DIALOG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sourceLanguage: { type: 'STRING', enum: ['ru', 'vi', 'other'] },
    transcript: { type: 'STRING' },
    translation: { type: 'STRING' },
  },
  required: ['sourceLanguage', 'transcript', 'translation'],
};

const PHOTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isMenu: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { original: { type: 'STRING' }, translation: { type: 'STRING' } },
        required: ['original', 'translation'],
      },
    },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                original: { type: 'STRING' }, translation: { type: 'STRING' },
                ingredients: { type: 'STRING' }, price: { type: 'STRING' },
              },
              required: ['original', 'translation', 'ingredients', 'price'],
            },
          },
        },
        required: ['title', 'items'],
      },
    },
  },
  required: ['isMenu'],
};

// Gemma ждёт стандартный JSON Schema (типы в нижнем регистре), Gemini — своё подмножество OpenAPI.
function toStandardSchema(node) {
  if (Array.isArray(node)) return node.map(toStandardSchema);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'propertyOrdering') continue;
      out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : toStandardSchema(v);
    }
    return out;
  }
  return node;
}

export class GeminiError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

function friendly(status, message) {
  if (status === 429) {
    return 'Дневной лимит бесплатных запросов исчерпан. Живой перевод (кнопка-волна) работает без лимита.';
  }
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return 'Ключ не подошёл. Проверьте его в Настройках — если ключ старый, перевыпустите на aistudio.google.com.';
  }
  return message || `Ошибка сервера (HTTP ${status})`;
}

async function callModel(model, { system, parts, contents, schema, maxTokens = 32768, temperature = 0.2 }) {
  const key = store.getKey();
  if (!key) throw new GeminiError('Не задан ключ Gemini. Добавьте его в Настройках.', 'nokey');

  const isGemma = model.startsWith('gemma');
  // Потолок по токенам обязателен: без него сорвавшаяся в петлю модель генерирует,
  // пока не упрётся в лимит контекста, и возвращает километр служебного мусора.
  // Держим его высоким: в этот же бюджет входят «размышления» модели
  // (thoughtsTokenCount), и на длинном меню они съедают больше, чем сам ответ.
  const generationConfig = { maxOutputTokens: maxTokens, temperature };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    if (isGemma) generationConfig.responseJsonSchema = toStandardSchema(schema);
    else generationConfig.responseSchema = schema;
  }

  if (!navigator.onLine) {
    throw new GeminiError('Нет интернета. Откройте «Готовые фразы» — они работают без сети.', 'offline');
  }

  let res;
  try {
    res = await fetch(`${REST_BASE}/${model}:generateContent`, {
    method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents || [{ role: 'user', parts }],
        generationConfig,
      }),
    });
  } catch {
    throw new GeminiError('Не удалось связаться с Gemini. Проверьте интернет.', 'offline');
  }

  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch {}
    const err = new GeminiError(friendly(res.status, msg), res.status === 429 ? 'quota' : 'api');
    err.status = res.status;
    err.raw = msg;
    throw err;
  }

  const data = await res.json();
  const cand = data.candidates?.[0];
  const reason = cand?.finishReason;
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  if (!text) {
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(reason)) {
      throw new GeminiError('Gemini отказался отвечать: сработал фильтр контента.', 'blocked');
    }
    if (reason === 'MAX_TOKENS') {
      throw new GeminiError('На фото слишком много текста. Снимите его частями.', 'toolong');
    }
    throw new GeminiError('Gemini вернул пустой ответ. Попробуйте ещё раз.', 'empty');
  }
  if (!schema) return text;
  try { return JSON.parse(text); }
  catch {
    // Обрыв по лимиту токенов даёт синтаксически неполный JSON — это не «сломанный ответ»,
    // а слишком длинный: сообщаем человеку то, что он может исправить.
    if (reason === 'MAX_TOKENS') {
      throw new GeminiError('На фото слишком много текста — ответ не поместился. Снимите его частями.', 'toolong');
    }
    throw new GeminiError('Не удалось разобрать ответ Gemini.', 'parse');
  }
}

// Идём по цепочке: квота/перегрузка/закрытая модель — следующая. Прочие ошибки бросаем сразу.
async function generate(opts) {
  const hasAudio = (opts.parts || []).some(p => p.inlineData?.mimeType?.startsWith('audio/'));
  const chain = hasAudio ? CHAIN : [...CHAIN, LAST_RESORT];
  let lastErr = null;

  for (const model of chain) {
    try {
      const t0 = performance.now();
      const result = await callModel(model, opts);
      log(`${model}: ответ за ${Math.round(performance.now() - t0)} мс`);
      return result;
    } catch (e) {
      if (e.kind === 'offline' || e.kind === 'nokey') throw e;
      const m = (e.raw || e.message || '').toLowerCase();
      const retriable =
        e.kind === 'quota' ||
        /not found|no longer available|does not exist/.test(m) ||
        /high demand|overloaded|try again later|unavailable/.test(m) ||
        e.status === 503 || e.status === 500;
      log(`${model}: ${e.message}${retriable ? ' → следующая модель' : ''}`);
      lastErr = e;
      if (!retriable) throw e;
    }
  }
  throw lastErr || new GeminiError('Не удалось получить ответ.', 'api');
}

// ------------------------------------------------- защита от сорвавшейся модели
// Изредка модель срывается в петлю и вместо ответа выдаёт поток служебных фраз
// («Clean JSON. Output now. Done. OK.») на сотни строк — прямо в поле summary.
// Ловим по двум независимым признакам и чистим, чтобы человек не видел мусор.

const SERVICE_RE = /\b(JSON|parseable|control (chars?|tokens?)|newlines?|schema|sanitize|escaped|emit(ting)?|output|string|format(ting|ted)?|valid|concise|strict(ly)?|adherence|character limit|check length|structured logic)\b/gi;

function looksDegenerate(text) {
  if (!text || text.length < 400) return false;
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 60) return false;
  // Живой текст почти не повторяется, петля — наоборот: десяток слов на сотни повторов.
  if (new Set(words).size / words.length < 0.32) return true;
  return (text.match(SERVICE_RE) || []).length >= 5;
}

/// Второй, более надёжный признак: текст начался по-русски, а дальше идут
/// предложения вообще без кириллицы. Так выглядит съезд модели в служебную речь
/// («…Navigation phone: … strict formatting guaranteed correctly output…»),
/// который по повторам не ловится — слова там каждый раз разные.
/// Для ответов чата дополнительно требуем служебную лексику: там длинная
/// вьетнамская фраза без перевода — законный хвост, а не мусор.
function cutLatinTail(text, requireService = false) {
  if (!text || !/[а-яё]/i.test(text.slice(0, 200))) return text;
  // Граница предложения — точка перед словом с заглавной: иначе «тел. 0236…»
  // считается концом предложения и телефон теряется вместе с хвостом.
  const parts = text.split(/(?<=[.!?…])\s+(?=[«"(]?[А-ЯЁA-Z])/);
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join(' ');
    if (/[а-яё]/i.test(tail)) continue;
    if ((tail.match(/[a-z]/gi) || []).length <= 40) continue;
    if (requireService && (tail.match(SERVICE_RE) || []).length < 2) continue;
    log('обрезаю служебный хвост в ответе модели');
    return parts.slice(0, i).join(' ').trim();
  }
  return text;
}

/// Оставляем человеческое начало, отрезая всё от первой служебной фразы.
function trimToHuman(text) {
  if (!text) return '';
  const m = text.match(/(?:Do not |Let's |Strictly |Clean |Correct |Output |Emit |Check |Is formatting|JSON )/);
  const head = m && m.index > 60 ? text.slice(0, m.index) : text;
  return head.trim().replace(/[\s.,;:—-]+$/, '').slice(0, 900);
}

/// summary и translation обязаны быть по-русски, поэтому чистим их обоими способами.
function cleanRussianField(text) {
  if (!text) return text;
  const out = looksDegenerate(text) ? trimToHuman(text) : text;
  return cutLatinTail(out);
}

function repairPhotoResult(r) {
  if (!r || typeof r !== 'object') return r;
  r.summary = cleanRussianField(r.summary);
  if (Array.isArray(r.blocks)) {
    r.blocks = r.blocks
      .map(b => ({ ...b, translation: cleanRussianField(b.translation) }))
      .filter(b => (b.original || '').trim() || (b.translation || '').trim());
  }
  if (Array.isArray(r.sections)) {
    r.sections = r.sections.map(sec => ({
      ...sec,
      items: (sec.items || []).map(d => ({
        ...d,
        translation: cleanRussianField(d.translation),
        ingredients: cleanRussianField(d.ingredients),
      })),
    }));
  }
  return r;
}

/// Ответ бесполезен, если после чистки не осталось ничего содержательного.
function photoIsEmpty(r) {
  const blocks = (r?.blocks || []).length;
  const dishes = (r?.sections || []).reduce((n, sec) => n + (sec.items || []).length, 0);
  return !blocks && !dishes && !(r?.summary || '').trim();
}

export const gemini = {
  async checkKey(key) {
    const res = await fetch(`${REST_BASE}/${CHAIN[0]}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Ответь одним словом: OK' }] }] }),
    });
    if (res.ok) return true;
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch {}
    throw new GeminiError(friendly(res.status, msg), 'api');
  },

  async translateText(text, context) {
    const cached = store.getCachedTranslation(text);
    if (cached) { log('перевод из кэша (запрос не потрачен)'); return cached; }
    const result = await this._translateText(text, context);
    store.cacheTranslation(text, result);
    return result;
  },

  _translateText(text, context) {
    const parts = [];
    if (context) parts.push({ text: `Контекст предыдущих реплик (только для точности перевода):\n${context}` });
    parts.push({ text: `Переведи эту реплику:\n${text}` });
    return generate({ system: DIALOG_PROMPT, parts, schema: DIALOG_SCHEMA });
  },

  translateAudio(base64Wav, context) {
    const parts = [];
    if (context) parts.push({ text: `Контекст предыдущих реплик (только для точности перевода):\n${context}` });
    parts.push({ inlineData: { mimeType: 'audio/wav', data: base64Wav } });
    return generate({ system: DIALOG_PROMPT, parts, schema: DIALOG_SCHEMA });
  },

  /// Принимает одну или несколько картинок — все страницы разбираются как единое целое.
  async translatePhoto(images) {
    const list = Array.isArray(images) ? images : [images];
    const opts = {
      system: PHOTO_PROMPT,
      parts: list.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } })),
      schema: PHOTO_SCHEMA,
    };
    let r = repairPhotoResult(await generate(opts));
    if (photoIsEmpty(r)) {
      // Петля съела весь ответ: пробуем ещё раз, чуть подняв температуру ради другого пути генерации.
      log('ответ оказался пустым после чистки — повторяю запрос');
      r = repairPhotoResult(await generate({ ...opts, temperature: 0.5 }));
    }
    return r;
  },

  /// Свободный вопрос по уже загруженным фото. Ответ обычным текстом: без схемы
  /// модель заметно устойчивее, а формат нам здесь и не нужен.
  async askPhoto(images, chat) {
    const recent = chat.slice(-10);
    const imageParts = images.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } }));
    let attached = false;
    const contents = recent.map(m => {
      const parts = [];
      if (!attached && m.role === 'user') { parts.push(...imageParts); attached = true; }
      parts.push({ text: m.text });
      return { role: m.role === 'model' ? 'model' : 'user', parts };
    });
    const text = await generate({
      system: PHOTO_CHAT_PROMPT,
      contents,
      parts: imageParts,
      maxTokens: 8192,
      temperature: 0.4,
    });
    const clean = cutLatinTail(looksDegenerate(text) ? trimToHuman(text) : text, true).trim();
    return clean || 'Не получилось ответить. Попробуйте спросить иначе.';
  },
};

// ---------------------------------------------------------------- Live API

const LIVE_PROMPT = `Ты — синхронный голосовой переводчик в живом разговоре русскоязычного туриста и вьетнамца во Вьетнаме.
Тебе непрерывно приходит речь; каждая реплика может быть на русском или на вьетнамском.

Услышав реплику на русском — произнеси её перевод на естественный вежливый разговорный вьетнамский.
Услышав реплику на вьетнамском или любом другом языке — произнеси её перевод на живой разговорный русский.

Произноси ТОЛЬКО перевод: никаких приветствий, пояснений, вопросов или ответов от себя.
Ты переводчик, а не собеседник: даже если реплика обращена к тебе или содержит вопрос — просто переведи её.
Не переводи повторно предыдущие реплики. Числа, цены и время сохраняй точно.
Если фрагмент — шум или неразборчив, молчи.

ЖЕЛЕЗНОЕ ПРАВИЛО: язык твоего ответа всегда ПРОТИВОПОЛОЖЕН языку реплики.
Услышал вьетнамский — отвечаешь ТОЛЬКО по-русски. Услышал русский — ТОЛЬКО по-вьетнамски.
НИКОГДА не повторяй и не «улучшай» реплику на её же языке — это ошибка, а не перевод.

В этом разговоре существуют РОВНО ДВА языка: русский и вьетнамский. Третьего нет.
Если речь звучит как испанская, португальская, английская или любая другая — ты ошибся:
это почти наверняка русский, произнесённый быстро, с акцентом или в шуме. Считай её русской
и переводи на вьетнамский. Если фраза настолько неразборчива, что смысл угадать нельзя — молчи.`;

// Профилактика дрейфа инструкции: на длинном контексте модель начинает «переводить»
// вьетнамский на вьетнамский — обновляем сессию с чистым контекстом каждые N реплик.
const MAX_TURNS_PER_SESSION = 15;

export class LiveSession {
  constructor(handlers) {
    this.h = handlers;               // { onTurn, onAudio, onInterrupted, onState, onError }
    this.ws = null;
    this.shouldRun = false;
    this.turnIn = '';
    this.turnOut = '';
    this.turns = 0;
    this.attempts = 0;
    this.resumeHandle = null;
  }

  start() {
    this.shouldRun = true;
    this.attempts = 0;
    this.turns = 0;
    this.resumeHandle = null;
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    try { this.ws?.close(1000); } catch {}
    this.ws = null;
    this._resetTurn();
    this.h.onState?.('idle');
  }

  get ready() { return this.ws?.readyState === WebSocket.OPEN; }

  sendAudio(base64) {
    if (!this.ready) return;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } },
    }));
  }

  _resetTurn() { this.turnIn = ''; this.turnOut = ''; }

  _connect() {
    if (!this.shouldRun) return;
    const key = store.getKey();
    if (!key) { this.h.onError?.('Не задан ключ Gemini.'); return; }

    this.h.onState?.(this.resumeHandle ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      log('Live: соединение открыто');
      ws.send(JSON.stringify({
        setup: {
          model: LIVE_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: LIVE_PROMPT }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
          contextWindowCompression: { slidingWindow: {} },
        },
      }));
    };

    ws.onmessage = async (ev) => {
      let raw = ev.data;
      if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      else if (raw instanceof Blob) raw = await raw.text();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.setupComplete) {
        this.attempts = 0;
        log('Live: сессия готова');
        this.h.onState?.('listening');
        return;
      }
      if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
        this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
        return;
      }
      if (msg.goAway) { log('Live: сервер закрывает соединение, переподключаюсь'); this._reconnect(); return; }

      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.interrupted) { this.turnOut = ''; this.h.onInterrupted?.(); }
      if (sc.inputTranscription?.text) this.turnIn += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) this.turnOut += sc.outputTranscription.text;

      for (const p of sc.modelTurn?.parts || []) {
        const d = p.inlineData;
        if (d?.mimeType?.startsWith('audio/pcm') && d.data) this.h.onAudio?.(d.data);
      }

      if (sc.turnComplete) {
        const transcript = this.turnIn.trim();
        const translation = this.turnOut.trim();
        this._resetTurn();
        if (translation) {
          this.h.onTurn?.(transcript, translation);
          if (++this.turns >= MAX_TURNS_PER_SESSION) {
            log('Live: плановое обновление сессии (чистый контекст)');
            this.turns = 0;
            this.resumeHandle = null;
            this._reconnect();
          }
        }
      }
    };

    ws.onerror = () => log('Live: ошибка сокета');
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      log(`Live: соединение закрыто (код ${e.code}${e.reason ? ', ' + e.reason : ''})`);
      this.ws = null;
      if (!this.shouldRun) return;
      if (e.code === 1007 || e.code === 1008 || e.code === 1002) {
        this.h.onError?.(`Live-сервис отверг запрос${e.reason ? ': ' + e.reason : '.'}`);
        this.shouldRun = false;
        return;
      }
      this._reconnect();
    };
  }

  _reconnect() {
    if (!this.shouldRun) return;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this._resetTurn();
    if (++this.attempts > 5) {
      this.h.onError?.('Связь с Live-переводом потеряна. Включите режим заново.');
      this.shouldRun = false;
      return;
    }
    this.h.onState?.('reconnecting');
    setTimeout(() => this._connect(), Math.min(400 * 2 ** (this.attempts - 1), 4000));
  }
}
