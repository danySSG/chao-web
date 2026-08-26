// Клиент Gemini: REST-цепочка с фолбэками + Live API по WebSocket.
// Логика перенесена из нативной версии (Swift), протокол проверен в поле.

import { store } from './store.js?v=202608261815';
import { log } from './util.js?v=202608261815';

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

Заполняй только тот набор полей, который соответствует типу. Второй оставь пустым.`;

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

async function callModel(model, { system, parts, schema }) {
  const key = store.getKey();
  if (!key) throw new GeminiError('Не задан ключ Gemini. Добавьте его в Настройках.', 'nokey');

  const isGemma = model.startsWith('gemma');
  const generationConfig = { responseMimeType: 'application/json' };
  if (isGemma) generationConfig.responseJsonSchema = toStandardSchema(schema);
  else generationConfig.responseSchema = schema;

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
        contents: [{ role: 'user', parts }],
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
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  if (!text) {
    const reason = cand?.finishReason;
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(reason)) {
      throw new GeminiError('Gemini отказался отвечать: сработал фильтр контента.', 'blocked');
    }
    throw new GeminiError('Gemini вернул пустой ответ. Попробуйте ещё раз.', 'empty');
  }
  try { return JSON.parse(text); }
  catch { throw new GeminiError('Не удалось разобрать ответ Gemini.', 'parse'); }
}

// Идём по цепочке: квота/перегрузка/закрытая модель — следующая. Прочие ошибки бросаем сразу.
async function generate(opts) {
  const hasAudio = opts.parts.some(p => p.inlineData?.mimeType?.startsWith('audio/'));
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

  translatePhoto(base64Jpeg) {
    return generate({
      system: PHOTO_PROMPT,
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } }],
      schema: PHOTO_SCHEMA,
    });
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
