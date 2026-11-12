// Общие части стенда: ключ, заглушки браузера, варианты кода приложения, звук, фразы.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', '..', 'js');

// Ключ — только из окружения или из .key рядом (он в .gitignore). В репозиторий не пишется.
function readKey() {
  if (process.env.CHAO_KEY) return process.env.CHAO_KEY.trim();
  try { return fs.readFileSync(path.join(HERE, '.key'), 'utf8').trim(); } catch {}
  console.error('Нет ключа Gemini: CHAO_KEY=… node <скрипт>  (или положить ключ в .tools/modeltest/.key)');
  process.exit(2);
}
export const KEY = readKey();

// --- заглушки браузера (до импорта кода приложения)
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
// navigator в node 22+ — встроенный getter, простым присваиванием не заменить
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, vibrate() {} }, configurable: true });
globalThis.document = { getElementById: () => null };
localStorage.setItem('chao.key', KEY);

// журнал приложения (log() пишет в console.log) собираем, а не печатаем
export const LOGS = [];
const origLog = console.log;
export function quiet() { console.log = (...a) => LOGS.push([Date.now(), a.join(' ')]); }
export const say = (...a) => origLog(...a);

// --- варианты gemini.js: копия НАСТОЯЩЕГО файла с точечными заменами.
// Если замена не нашла своё место (код поменялся) — падаем, а не тестируем не то.
export function makeVariant(name, { models, promptAdd, setupPatch, chainPhoto, chainDialog } = {}) {
  const dir = path.join(HERE, 'variants', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['store.js', 'util.js']) fs.copyFileSync(path.join(APP, f), path.join(dir, f));
  let src = fs.readFileSync(path.join(APP, 'gemini.js'), 'utf8');
  const must = (re, to, what) => {
    if (!re.test(src)) throw new Error(`вариант ${name}: не нашёл место для замены (${what}) — код приложения поменялся`);
    src = src.replace(re, to);
  };
  if (models) must(/export const LIVE_MODELS = \[[^\]]*\];/, `export const LIVE_MODELS = ${JSON.stringify(models.map(m => 'models/' + m))};`, 'LIVE_MODELS');
  if (promptAdd) must(/Если фраза настолько неразборчива, что смысл угадать нельзя — молчи\.`;/, m => m.slice(0, -2) + '\n\n' + promptAdd + '`;', 'LIVE_PROMPT');
  if (setupPatch) must(/ws\.send\(JSON\.stringify\(\{ setup \}\)\);/, `(${setupPatch})(setup);\n      ws.send(JSON.stringify({ setup }));`, 'setup');
  if (chainPhoto) must(/const CHAIN_PHOTO = \[[\s\S]*?\];/, `const CHAIN_PHOTO = ${JSON.stringify(chainPhoto)};`, 'CHAIN_PHOTO');
  if (chainDialog) must(/const CHAIN_DIALOG = \[[\s\S]*?\];/, `const CHAIN_DIALOG = ${JSON.stringify(chainDialog)};`, 'CHAIN_DIALOG');
  fs.writeFileSync(path.join(dir, 'gemini.js'), src);
  return path.join(dir, 'gemini.js') + `?t=${Date.now()}`;
}

/// Вариант живого режима по имени из командной строки:
///   real                      — код приложения как есть;
///   fall                      — первая модель «закрыта», проверка перехода на запасную;
///   gemini-3.8-live           — одна указанная модель (через запятую — цепочка);
///   …+prompt=<файл>           — дописать к LIVE_PROMPT текст из файла.
export function liveVariant(spec) {
  if (spec === 'real') return { name: 'real', opts: {} };
  if (spec === 'fall') return { name: 'fall', opts: { models: ['gemini-0-retired-live-preview', ...currentLiveModels().slice(1)] } };
  const [models, ...mods] = spec.split('+');
  const opts = { models: models.split(',') };
  for (const m of mods) {
    const [k, v] = m.split('=');
    if (k === 'prompt') opts.promptAdd = fs.readFileSync(v, 'utf8').trim();
  }
  return { name: spec.replace(/[^a-z0-9.,+-]/gi, '_').slice(0, 80), opts };
}
function currentLiveModels() {
  const src = fs.readFileSync(path.join(APP, 'gemini.js'), 'utf8');
  return JSON.parse(src.match(/export const LIVE_MODELS = (\[[^\]]*\]);/)[1].replace(/'/g, '"')).map(m => m.replace('models/', ''));
}

// --- звук: сырой PCM 16 кГц моно s16le, как шлёт микрофон приложения
export function readPcm16(file) {
  const b = fs.readFileSync(file);
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1);
}
// тихий шум вместо цифрового нуля — так ведёт себя настоящий микрофон
export function noise(samples, amp = 40) {
  const a = new Int16Array(samples);
  for (let i = 0; i < samples; i++) a[i] = Math.round((Math.random() * 2 - 1) * amp);
  return a;
}
export function concat(arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Int16Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
export const pcm = (id) => readPcm16(path.join(HERE, 'audio', id + '.pcm'));

/// Реплика: части через паузу pauseMs (пауза-раздумье посреди фразы).
export function utterance(id, pauseMs = 900) {
  const segs = [];
  PHRASES[id].parts.forEach((p, i) => { if (i) segs.push(noise(Math.round(pauseMs * 16))); segs.push(pcm(p)); });
  return concat(segs);
}

// Латиницу считать именно так: диапазон [à-ỹ] захватывает и кириллицу (U+0400 внутри него).
export const isCyr = (s) => { const c = (s.match(/[а-яё]/gi) || []).length, l = (s.match(/[a-zÀ-ɏḀ-ỿ]/gi) || []).length; return c > l; };
export const isVi = (s) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùý]/i.test(s) && !isCyr(s);

// --- тестовые фразы. Записи лежат в audio/*.pcm (см. tts.mjs).
// need — что обязано быть в переводе: по одному признаку на каждую часть фразы,
// иначе потерянная половина не будет замечена.
export const PIECES = {
  p1a: { lang: 'vi', voice: 'Kore', text: 'Mấy chai nước lớn này thường bán ba mươi nghìn một chai,' },
  p1b: { lang: 'vi', voice: 'Kore', text: 'nhưng nếu anh lấy cả thùng thì em tính hai trăm năm mươi nghìn thôi.' },
  p2a: { lang: 'ru', voice: 'Charon', text: 'Подскажите, пожалуйста, сколько стоит такси до аэропорта,' },
  p2b: { lang: 'ru', voice: 'Charon', text: 'и можно ли расплатиться картой?' },
  p3:  { lang: 'vi', voice: 'Kore', text: 'Dạ, anh đợi em năm phút nha.' },
  p4:  { lang: 'ru', voice: 'Charon', text: 'Как вы думаете, это блюдо очень острое?' },
};
export const PHRASES = {
  p1: { parts: ['p1a', 'p1b'], to: 'ru', need: [/30|тридцат/i, /250|двести\s*пятьдесят/i] },
  p2: { parts: ['p2a', 'p2b'], to: 'vi', need: [/sân bay/i, /thẻ/i] },
  p3: { parts: ['p3'], to: 'ru', need: [/5|пят/i, /минут/i] },
  p4: { parts: ['p4'], to: 'vi', need: [/cay/i] },   // вопрос «переводчику» — должен перевести, а не ответить
  p1a: { parts: ['p1a'], to: 'ru', need: [/30|тридцат/i] },
  p1b: { parts: ['p1b'], to: 'ru', need: [/250|двести\s*пятьдесят/i] },
  p2a: { parts: ['p2a'], to: 'vi', need: [/sân bay/i] },
  p2b: { parts: ['p2b'], to: 'vi', need: [/thẻ/i] },
};
export function judge(id, translations) {
  const P = PHRASES[id], all = translations.join(' ');
  const okLang = translations.length > 0 && translations.every(t => (P.to === 'ru' ? isCyr(t) : isVi(t)));
  const got = P.need.map(re => re.test(all));
  return { okLang, got, full: okLang && got.every(Boolean) };
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
