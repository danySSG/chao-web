// Клиент Gemini: REST-цепочка с фолбэками + Live API по WebSocket.
// Логика перенесена из нативной версии (Swift), протокол проверен в поле.

import { store } from './store.js?v=202611121739';
import { log } from './util.js?v=202611121739';

const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Живые модели по порядку. Прежняя основная gemini-3.1-flash-live-preview
// закрывается 17.11.2026. Замер 12.11.2026 через этот самый код, синтезированная
// речь, ожидание ВСЕХ ходов:
//                       фраза с паузой 0.9 с   разговор из 17 реплик ×2
//   3.1-flash-live          12/12                  34/34
//   3.8-live                12/12                  34/34   ← задержка та же, ~1.5–1.7 с
//   3.8-live-extended-thinking (low) 12/12         34/34
// В сентябре 3.8 давала 3/6 — модель с тех пор подтянули под тем же именем.
// Просьба в промпте «переводи каждую речь» у 3.8 сделала хуже (33/34, служебное
// «(Vietnamese translation for …)» вместо перевода) — промпт оставлен прежним.
//
// gemini-3.5-live-translate-preview — синхронист: направление задаётся
// generationConfig.translationConfig.targetLanguageCode, две сессии (ru и vi,
// echoTargetLanguage: false) дают двусторонний перевод. Но говорить она начинает
// до конца фразы, а мы глушим микрофон на время ответа — хвост теряется.
// Годится только для режима в наушниках, без глушения.
export const LIVE_MODELS = ['models/gemini-3.8-live', 'models/gemini-3.8-live-extended-thinking'];

// extended-thinking без явного уровня размышлений сервер не принимает
// («Thinking level must be specified»), MINIMAL не поддерживает. Обычная 3.8-live,
// наоборот, отвергает любой thinkingConfig.
const LIVE_THINKING = { 'models/gemini-3.8-live-extended-thinking': 'low' };

// Цепочки разные, потому что задачи разные (замеры 28.08.2026 на одном наборе):
//
//   перевод реплики     разбор меню по фото
//   3.5-flash-lite 1.1с   2.1с   ← быстрее всех, формулировки живые
//   3.1-flash-lite 1.5с   4.0с
//   3-flash-preview 2.6с  5.8с   ← лучший русский на фото («тонкие ломтики…»)
//   gemma-4-31b    2.3с  10.4с   ← кальки с английского, но выручает по квоте
//
// В диалоге решает скорость: ответа ждёт живой человек напротив, а разница в
// качестве перевода коротких реплик между ярусами не улавливается. Поэтому
// впереди lite — они же ёмче по квоте (500/день против 20 у flash).
// На фото важнее формулировка и внимание к мелкому тексту, там впереди flash.
//
// 3.5-flash и 3.7-flash Google вывел 08.10.2026: запросы к ним молча уходят на
// 3.6-flash и 3.8-flash (видно по modelVersion в ответе), поэтому их здесь нет.
// 3.8-flash на бесплатном тарифе перегружена: 12.11 даже «привет» висел больше
// полутора минут или получал 503 через ~50 с. 3.6-flash то же меню — 13 блюд
// из 13 за 6–8 с.
const CHAIN_DIALOG = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.6-flash',
];
const CHAIN_PHOTO = [
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
];
const LAST_RESORT = 'gemma-4-31b-it'; // только текст и фото, аудио не принимает

// Модель, ответившая 429, помнится и пропускается: каждый заведомо провальный
// вызов — лишняя секунда ожидания на КАЖДОМ запросе.
//
// Пауза берётся из самого ответа, а не назначается вслепую. У free tier два
// разных 429: минутный (в живом разговоре реплики идут часто и упираются в него
// за минуту) и дневной. Ответ различает их полем quotaId и подсказывает
// retryDelay. Минутный стоит переждать секунды — банить модель на полчаса
// из-за него нельзя, иначе разговор скатывается по цепочке вниз на ровном месте.
const QUOTA_KEY = 'chao.quota';
const QUOTA_PAUSE_DAY = 15 * 60 * 1000;
const QUOTA_PAUSE_MINUTE = 60 * 1000;

/// Сколько ждать по мнению самого сервера: «Please retry in 28.69s» или RetryInfo.
function retryPause(message, isDaily) {
  const m = /retry in ([\d.]+)s/i.exec(message || '');
  const fromServer = m ? Math.ceil(parseFloat(m[1]) + 1) * 1000 : 0;
  const floor = isDaily ? QUOTA_PAUSE_DAY : QUOTA_PAUSE_MINUTE;
  return Math.max(fromServer, floor);
}

function quotaMap() {
  try { return JSON.parse(localStorage.getItem(QUOTA_KEY)) || {}; } catch { return {}; }
}
function isOutOfQuota(model) {
  const until = quotaMap()[model];
  return typeof until === 'number' && Date.now() < until;
}
function markOutOfQuota(model, pause) {
  try {
    const map = quotaMap();
    map[model] = Date.now() + pause;
    localStorage.setItem(QUOTA_KEY, JSON.stringify(map));
  } catch {}
}

const DIALOG_PROMPT = `Ты — профессиональный переводчик-синхронист между русским и вьетнамским языками, работаешь во Вьетнаме.
На вход приходит либо аудиозапись живой речи, либо текст.

1. Если это аудио — точно расшифруй сказанное и запиши в поле transcript. Если текст — скопируй его в transcript без изменений.
2. Определи язык источника: "ru" — русский, "vi" — вьетнамский, "other" — любой другой.
3. Переведи: русский → на естественный вежливый разговорный вьетнамский; вьетнамский или другой язык → на живой разговорный русский.

В этом разговоре существуют ровно два языка: русский и вьетнамский. Если речь звучит как испанская,
португальская или английская — ты, скорее всего, ослышался: определи по смыслу, какой из двух это был,
и переведи на противоположный. Если разобрать не удалось — оставь transcript и translation пустыми,
не выдумывай и не подставляй название языка.

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

/// Модель нередко дописывает после JSON пояснение или повторяет объект целиком
/// (Gemma делает это в большинстве ответов) — строгий JSON.parse на этом падает.
/// Берём первый сбалансированный объект и игнорируем хвост.
function parseLooseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export class GeminiError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

function friendly(status, message, quotaId = '') {
  if (status === 429) {
    return /PerDay/i.test(quotaId) || /PerDay|per day/i.test(message || '')
      // «Без лимита» было бы преувеличением: у Live своя квота — около шести
      // ОДНОВРЕМЕННЫХ сессий, а не число запросов. Одному человеку она недостижима,
      // и текстовые лимиты её не касаются — это и говорим.
      ? 'Дневной лимит текстовых запросов исчерпан. Живой перевод (кнопка-волна) считается отдельно и работает.'
      : 'Слишком много запросов подряд. Подождите минуту — или говорите через живой перевод, его это не касается.';
  }
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return 'Ключ не подошёл. Проверьте его в Настройках — если ключ старый, перевыпустите на aistudio.google.com.';
  }
  return message || `Ошибка сервера (HTTP ${status})`;
}

async function callModel(model, { system, parts, contents, schema, chain, maxTokens = 12288, temperature = 0.2, thinking = 'low' }) {
  const key = store.getKey();
  if (!key) throw new GeminiError('Не задан ключ Gemini. Добавьте его в Настройках.', 'nokey');

  const isGemma = model.startsWith('gemma');
  // Потолок по токенам обязателен: без него сорвавшаяся модель генерирует, пока
  // не упрётся в лимит контекста. Но и запас должен быть скромным: замеры дают
  // 1–2 тысячи токенов на страницу, а лишний простор при срыве оборачивается
  // минутами ожидания — модель молотит его весь, прежде чем вернуть ошибку.
  const generationConfig = { maxOutputTokens: maxTokens, temperature };
  // Без ограничения модель уходит в размышления на десятки тысяч токенов
  // (мелкий текст на фото провоцирует это надёжно) — минута ожидания и обрыв
  // по потолку вместо ответа. На качестве разбора меню «low» не сказывается.
  if (thinking && !isGemma) generationConfig.thinkingConfig = { thinkingLevel: thinking };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    if (isGemma) generationConfig.responseJsonSchema = toStandardSchema(schema);
    else generationConfig.responseSchema = schema;
  }

  if (!navigator.onLine) {
    throw new GeminiError('Нет интернета. Откройте «Готовые фразы» — они работают без сети.', 'offline');
  }

  // Перегруженная модель может не отвечать минутами (3.8-flash, 12.11.2026).
  // Без своего таймаута такое зависание выглядело как «нет интернета», и цепочка
  // обрывалась, не попробовав исправные модели. 12.11 так же повисла и 3.6-flash —
  // по таймауту цепочка ушла на 3-flash-preview, и меню разобралось за 6 с.
  // Обычный ответ: реплика 1–3 с, фото 6–8 с. Gemma медленнее всех (до ~30 с).
  const limit = isGemma ? 55000 : chain === 'photo' ? 30000 : 20000;
  let res, data;
  try {
    res = await fetch(`${REST_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents || [{ role: 'user', parts }],
        generationConfig,
      }),
      signal: AbortSignal.timeout?.(limit),
    });
    // Ответ без потоковой выдачи: тело приходит целиком в конце, и таймаут
    // должен охватывать и его чтение.
    if (res.ok) data = await res.json();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      markOutOfQuota(model, 3 * 60 * 1000);
      log(`${model}: нет ответа ${limit / 1000} с, пропускаю 3 мин`);
      throw new GeminiError('Gemini слишком долго не отвечает. Попробуйте ещё раз чуть позже.', 'timeout');
    }
    if (e?.name === 'SyntaxError') throw new GeminiError('Не удалось разобрать ответ Gemini.', 'parse');
    throw new GeminiError('Не удалось связаться с Gemini. Проверьте интернет.', 'offline');
  }

  if (!res.ok) {
    let msg = '', apiError = null;
    try { apiError = (await res.json())?.error || null; msg = apiError?.message || ''; } catch {}
    // Тип квоты (PerDay/PerMinute) лежит в error.details, а НЕ в message —
    // по одному message дневной лимит неотличим от минутного, и приложение
    // штурмовало исчерпанную модель раз в минуту вместо раза в четверть часа.
    const quotaId = JSON.stringify(apiError?.details || []).match(/"quotaId":"([^"]+)"/)?.[1] || '';
    if (res.status === 503 || /high demand|overloaded/i.test(msg)) {
      // Перегруженная модель отвечает отказом за пару секунд — но на каждом
      // запросе. Пара минут паузы дешевле, чем этот налог на всю цепочку.
      markOutOfQuota(model, 3 * 60 * 1000);
      log(`${model}: перегружена, пропускаю 3 мин`);
    }
    if (res.status === 429) {
      const isDaily = /PerDay/i.test(quotaId) || /PerDay|per day/i.test(msg);
      const pause = retryPause(msg, isDaily);
      markOutOfQuota(model, pause);
      log(`${model}: лимит ${isDaily ? 'на сутки' : 'на минуту'}, пропускаю ${Math.round(pause / 1000)} с`);
    }
    const err = new GeminiError(friendly(res.status, msg, quotaId), res.status === 429 ? 'quota' : 'api');
    err.status = res.status;
    err.raw = msg;
    throw err;
  }

  const cand = data?.candidates?.[0];
  const reason = cand?.finishReason;
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  if (!text) {
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(reason)) {
      throw new GeminiError('Gemini отказался отвечать: сработал фильтр контента.', 'blocked');
    }
    if (reason === 'MAX_TOKENS') {
      throw new GeminiError('Модель не справилась с этим фото — попробуйте ещё раз.', 'toolong');
    }
    throw new GeminiError('Gemini вернул пустой ответ. Попробуйте ещё раз.', 'empty');
  }
  if (!schema) return text;
  const parsed = parseLooseJSON(text);
  if (parsed) return parsed;
  if (reason === 'MAX_TOKENS') {
    // Обрыв по потолку почти всегда означает не «много текста», а срыв модели
    // в бесконечные рассуждения: повтор обычно проходит нормально.
    throw new GeminiError('Модель не справилась с этим фото — попробуйте ещё раз.', 'toolong');
  }
  throw new GeminiError('Не удалось разобрать ответ Gemini.', 'parse');
}

// Идём по цепочке: квота/перегрузка/закрытая модель — следующая. Прочие ошибки бросаем сразу.
async function generate(opts) {
  const hasAudio = (opts.parts || []).some(p => p.inlineData?.mimeType?.startsWith('audio/'));
  const base = opts.chain === 'photo' ? CHAIN_PHOTO : CHAIN_DIALOG;
  const chain = hasAudio ? base : [...base, LAST_RESORT];
  let lastErr = null;

  for (const model of chain) {
    if (isOutOfQuota(model)) continue;  // уже помечена, о причине сказано при пометке
    try {
      const t0 = performance.now();
      let result;
      try {
        result = await callModel(model, opts);
      } catch (e) {
        // Формат thinkingConfig у Google периодически меняется — повторяем без него.
        if (/thinking|unknown name|invalid json/i.test(e.raw || e.message || '')) {
          log(`${model}: thinkingConfig не принят, повторяю без него`);
          result = await callModel(model, { ...opts, thinking: null });
        } else throw e;
      }
      log(`${model}: ответ за ${Math.round(performance.now() - t0)} мс`);
      return result;
    } catch (e) {
      if (e.kind === 'offline' || e.kind === 'nokey') throw e;
      const m = (e.raw || e.message || '').toLowerCase();
      const retriable =
        e.kind === 'quota' || e.kind === 'timeout' ||
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
    const res = await fetch(`${REST_BASE}/${CHAIN_DIALOG[0]}:generateContent`, {
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

  /// Разбирает одну страницу. `known` — что уже известно про документ из
  /// прежних страниц: тип и названия разделов. Модель придерживается тех же
  /// названий, чтобы страницы сошлись в один список, а не в набор дубликатов.
  async translatePhoto(images, known) {
    const list = Array.isArray(images) ? images : [images];
    const parts = list.map(data => ({ inlineData: { mimeType: 'image/jpeg', data } }));
    if (known?.sections?.length) {
      parts.unshift({ text: `Это следующая страница того же ${known.isMenu ? 'меню' : 'документа'}.
Разделы, уже разобранные на прошлых страницах: ${known.sections.join(', ')}.
Если блюда на этой странице относятся к одному из них — назови раздел ровно так же.
Разбирай ТОЛЬКО то, что видно на этой странице, ничего не повторяй с прошлых.` });
    }
    const opts = { system: PHOTO_PROMPT, parts, schema: PHOTO_SCHEMA, chain: 'photo' };
    let r;
    try {
      r = repairPhotoResult(await generate(opts));
    } catch (e) {
      // Обрыв по потолку — это сорвавшаяся модель, а не «сложное фото»:
      // повтор с другой температурой почти всегда проходит нормально.
      if (e.kind !== 'toolong') throw e;
      log('модель сорвалась в рассуждения — повторяю запрос');
      r = repairPhotoResult(await generate({ ...opts, temperature: 0.5 }));
    }
    if (photoIsEmpty(r)) {
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
      chain: 'photo',
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
Услышав реплику на вьетнамском — произнеси её перевод на живой разговорный русский.

Произноси ТОЛЬКО перевод: никаких приветствий, пояснений, вопросов или ответов от себя.
Ты переводчик, а не собеседник: даже если реплика обращена к тебе или содержит вопрос — просто переведи её.
Не переводи повторно предыдущие реплики. Числа, цены и время сохраняй точно.
Если фрагмент — шум или неразборчив, молчи.

ЖЕЛЕЗНОЕ ПРАВИЛО: язык твоего ответа всегда ПРОТИВОПОЛОЖЕН языку реплики.
Услышал вьетнамский — отвечаешь ТОЛЬКО по-русски. Услышал русский — ТОЛЬКО по-вьетнамски.
НИКОГДА не повторяй и не «улучшай» реплику на её же языке — это ошибка, а не перевод.

В этом разговоре существуют РОВНО ДВА языка: русский и вьетнамский.
Если реплика звучит как испанская, португальская, английская или любая другая — ты ослышался:
на самом деле это один из этих двух, произнесённый быстро, с акцентом или в шуме. Пойми по смыслу
и по ходу разговора, кто из двоих говорит, и переведи на язык собеседника.
Никогда не произноси название языка вместо перевода.
Если фраза настолько неразборчива, что смысл угадать нельзя — молчи.`;

// Профилактика дрейфа инструкции: на длинном контексте модель начинает «переводить»
// вьетнамский на вьетнамский — обновляем сессию с чистым контекстом каждые N реплик.
const MAX_TURNS_PER_SESSION = 15;

// Сколько тишины считать концом реплики. Замер 24.09.2026 на синтезированной
// вьетнамской речи с паузой посреди фразы: сервер закрывает ход раньше номинала,
// примерно на двух третях порога. 1000 мс держали лишь паузы до ~0.6 с и рвали
// раздумье в 0.9 с; 1500 держат 0.9 с, рвут 1.3 с; 2000 держат обе.
// 1500 — компромисс: раздумья посреди фразы целы, реакция ~1.6 с вместо ~1.1.
// На 3.1 при 1500 и 2000 полный перевод 6/6 одинаково, так что берём меньшую
// задержку. Если в поле раздумья всё же рвутся — поднимать до 2000 (держит 1.3 с).
// Склейки реплик двух людей бояться почти не нужно: между ними всегда звучит
// перевод, а микрофон на это время заглушён.
const LIVE_SILENCE_MS = 1500;

export class LiveSession {
  constructor(handlers) {
    this.h = handlers;               // { onTurn, onAudio, onInterrupted, onState, onError, getContext }
    this.ws = null;
    this.shouldRun = false;
    // Тонкие настройки (VAD, подсказка языков) могут быть не приняты будущей
    // версией модели. Один отказ — переподключаемся без них, а не гасим живой
    // режим посреди разговора в кафе.
    this.useExtras = true;
    this.sentAudio = false;
    this.modelIndex = 0;     // какая из LIVE_MODELS сейчас в работе
    this.setupOk = false;    // получен ли setupComplete на текущем соединении
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
    this.sentAudio = true;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } },
    }));
  }

  /// Микрофон глушится на всё время, пока звучит ответ, — это заведомо больше
  /// секунды. Без явного признака конца потока хвост речи остаётся в буфере
  /// сервера и после размьюта склеивается с новой репликой через дыру.
  endAudioStream() {
    if (!this.ready || !this.sentAudio) return;
    this.sentAudio = false;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  _resetTurn() { this.turnIn = ''; this.turnOut = ''; this.cutOff = false; }

  // ОТКЛЮЧЕНО 09.09.2026. Сессии подсеивалась история через clientContent, и на
  // пустой сессии это выглядело безобидно — модель принимала реплики молча.
  // Но у 3.x такой подсев поддерживается лишь вместе с флагом
  // historyConfig.initialHistoryInClientContent, а без него поведение не
  // определено: по спецификации clientContent прерывает текущую генерацию, то
  // есть вмешивается в работу детектора речи. Хронология совпала — первый же
  // разговор после этой правки посыпался на обрывки. Цена отката: свежая сессия
  // не помнит предыдущих реплик, ровно как было раньше.
  //
  // Отдельный изъян той же правки: при пустом транскрипте (обычное дело в живом
  // режиме) в историю уходила пара user/model с ОДИНАКОВЫМ текстом — то есть
  // модели показывали образец «повтори фразу на её же языке». Ровно тот дрейф,
  // с которым мы боремся промптом.

  _connect() {
    if (!this.shouldRun) return;
    const key = store.getKey();
    if (!key) { this.h.onError?.('Не задан ключ Gemini.'); return; }

    this.h.onState?.(this.resumeHandle ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setupOk = false;

    ws.onopen = () => {
      const model = LIVE_MODELS[this.modelIndex];
      log(`Live: соединение открыто (${model.replace('models/', '')}${this.useExtras ? '' : ', упрощённые настройки'})`);
      const setup = {
        model,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: LIVE_PROMPT }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        contextWindowCompression: { slidingWindow: {} },
      };
      // Обязательное поле для своей модели, а не тонкая настройка: без него
      // сессия не откроется, поэтому вне блока useExtras.
      if (LIVE_THINKING[model]) setup.generationConfig.thinkingConfig = { thinkingLevel: LIVE_THINKING[model] };
      if (this.useExtras) {
        // Без этого блока границы реплик определяет умолчание Google, рассчитанное
        // на диктовку: пауза-раздумье посреди фразы принимается за её конец, и одна
        // реплика собеседника разрывается на несколько огрызков. Огрызок в полсекунды
        // модель не может ни перевести, ни определить его язык — отсюда и мусор
        // вроде «Vietnamese Vietnamese», и вьетнамская речь, принятая за испанскую.
        setup.realtimeInputConfig = {
          automaticActivityDetection: {
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
            silenceDurationMs: LIVE_SILENCE_MS,
          },
        };
        // Подсказка распознавателю: языка ровно два. Это hint, а не гарантия,
        // но авто-определение перестаёт свободно выбирать испанский.
        setup.inputAudioTranscription = { languageCodes: ['vi-VN', 'ru-RU'] };
      }
      ws.send(JSON.stringify({ setup }));
    };

    ws.onmessage = async (ev) => {
      let raw = ev.data;
      if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      else if (raw instanceof Blob) raw = await raw.text();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.setupComplete) {
        this.setupOk = true;
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

      // Перебили — недоигранный звук выбрасываем, но уже прозвучавшую часть перевода
      // оставляем: иначе реплика исчезает из ленты молча, как будто её не было.
      if (sc.interrupted) { this.cutOff = true; this.h.onInterrupted?.(); }
      if (sc.inputTranscription?.text) this.turnIn += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) this.turnOut += sc.outputTranscription.text;

      for (const p of sc.modelTurn?.parts || []) {
        const d = p.inlineData;
        if (d?.mimeType?.startsWith('audio/pcm') && d.data) this.h.onAudio?.(d.data);
      }

      if (sc.turnComplete) {
        const transcript = this.turnIn.trim();
        // Оборванную реплику помечаем многоточием — видно, что фраза не целиком.
        const translation = this.turnOut.trim() + (this.cutOff && this.turnOut.trim() ? '…' : '');
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
      // Неверный, просроченный или отозванный ключ: ни упрощённые настройки, ни
      // другая модель тут не помогут. Раньше это стоило четырёх подключений
      // впустую и заканчивалось английским «API key not valid» — теперь сразу
      // то же объяснение по-русски, что и в текстовом переводе.
      // Только про ключ («API key not valid / expired», API_KEY_INVALID): отказ
      // в доступе к конкретной модели должен по-прежнему вести на запасную.
      if (/api.?key/i.test(e.reason || '')) {
        this.h.onError?.(friendly(403, e.reason));
        this.shouldRun = false;
        return;
      }
      // Отказ ещё до готовности сессии — это не обрыв связи, а «так нельзя»:
      // не принят setup, модель недоступна для ключа или исчерпана её квота.
      // Сначала пробуем без тонких настроек, потом следующую модель.
      const refused = !this.setupOk && [1002, 1007, 1008, 1011].includes(e.code);
      const rejected = [1002, 1007, 1008].includes(e.code);
      if (refused || rejected) {
        if (this.useExtras && rejected) {
          log(`Live: сервер отверг настройки${e.reason ? ' (' + e.reason.slice(0, 90) + ')' : ''}, переподключаюсь без них`);
          this.useExtras = false;
          this.attempts = 0;
          this._reconnect();
          return;
        }
        if (this.modelIndex < LIVE_MODELS.length - 1) {
          this.modelIndex++;
          this.useExtras = true;
          this.attempts = 0;
          log(`Live: модель недоступна, перехожу на ${LIVE_MODELS[this.modelIndex].replace('models/', '')}`);
          this._reconnect();
          return;
        }
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
