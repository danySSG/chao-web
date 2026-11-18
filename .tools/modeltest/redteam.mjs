// Каверзные входы для текстового и голосового перевода (DIALOG_PROMPT) с проверками.
// Прогонять ДО и ПОСЛЕ каждой правки промпта: глоссарий «на глаз» легко делает
// хуже на обычных репликах, и это видно только в сравнении.
//   node redteam.mjs [real|цепочка] [прогонов=2] [только=id1,id2]
// need — обязано найтись в переводе (каждое выражение), forbid — не должно,
// src — каким должен выйти sourceLanguage ('!ru' — любым, кроме ru).
import fs from 'node:fs';
import path from 'node:path';
import { HERE, LOGS, quiet, say, makeVariant, noise, isCyr, isVi } from './common.mjs';

const [arg = 'real', nStr = '2', only, gapStr = '4500'] = process.argv.slice(2);
// Пауза между запросами — чтобы не упереться в минутный лимит и не съехать
// на другую модель посреди прогона (сравнение «до/после» тогда не честное).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chain = arg === 'real' ? null : arg.split(',');
const mod = await import(makeVariant(`rt-${chain ? chain.join('_') : 'real'}`, chain ? { chainDialog: chain } : {}));
quiet();

const CASES = [
  // Деньги и числа на слух
  { id: 'num-tram-hai', text: 'Cái này một trăm hai, lấy hai cái thì hai trăm rưỡi', to: 'ru',
    need: [/120[\s .]?000|сто двадцать тысяч|120 тыс/i, /250[\s .]?000|двести пятьдесят тысяч|250 тыс/i], forbid: [/\b102\b|сто два\b/i] },
  { id: 'num-lit', text: 'Hai lít rưỡi thôi anh', to: 'ru', need: [/250[\s .]?000|двести пятьдесят тысяч|250 тыс/i], forbid: [/литр/i, /брат/i] },
  { id: 'num-k', text: '50k không được anh ơi, 70k nha', to: 'ru', need: [/50[\s .]?000|50 тыс|пятьдесят тысяч/i, /70[\s .]?000|70 тыс|семьдесят тысяч/i], forbid: [/брат/i] },
  { id: 'time-kem', text: 'Ba giờ kém mười lăm em tới', to: 'ru', need: [/2:45|14:45|без пятнадцати три|без четверти три/i] },
  { id: 'dose', text: 'Ngày uống ba lần, mỗi lần nửa viên', to: 'ru', need: [/3|три/i, /половин|½|1\/2|пол-?таблет/i] },
  // Обращения
  { id: 'pron-p3', text: 'Dạ, anh đợi em năm phút nha.', to: 'ru', need: [/5|пят/i, /минут/i], forbid: [/брат|сестр/i] },
  { id: 'pron-chi', text: 'Chị ơi, chị muốn uống gì ạ?', to: 'ru', need: [/пить|выпить|напит/i], forbid: [/сестр|тётя|тетя/i] },
  // Английский и «ослышки»
  { id: 'english', text: 'Sorry, sold out today, chicken OK?', to: 'ru', src: '!ru', need: [/кур/i] },
  // Поручения переводчику
  { id: 'delegate', text: 'Скажи ему, что мы подождём минут десять', to: 'vi', need: [/đợi|chờ/i, /10|mười/i], forbid: [/nói với/i] },
  { id: 'how-to-say', text: 'Как по-вьетнамски будет «без сахара»?', to: 'vi', need: [/không đường/i], forbid: [/thế nào|như nào|tiếng Việt/i] },
  { id: 'ask-change', text: 'Спроси, есть ли у него сдача с пятисот', to: 'vi', need: [/500|năm trăm/i, /thối|thừa|lẻ|đổi/i], forbid: [/hỏi (giúp|xem|anh|ông|chị)/i] },
  // Чатовый вьетнамский без диакритики
  { id: 'chat-nodiac', text: 'a oi e toi r, a ra cong nha', to: 'ru', need: [/приех|на месте|подъех|я тут|я здесь|уже здесь|прибыл/i, /ворот|выход|выйд/i], forbid: [/брат/i] },
  { id: 'chat-k', text: 'mai 9h tho qua sua may lanh nha a', to: 'ru', need: [/9|девят/i, /кондиционер/i, /мастер/i] },
  // Центральный диалект (Дананг, Куангнам)
  { id: 'dial-mo', text: 'Anh đi mô rứa?', to: 'ru', need: [/куда/i] },
  { id: 'dial-ni', text: 'Cái ni bao nhiêu rứa chị?', to: 'ru', need: [/это|этот|эта/i, /сколько/i] },
  { id: 'dial-rang', text: 'Răng anh không ăn?', to: 'ru', need: [/почему|что же|отчего/i] },
  // Обычные реплики — не должны пострадать
  { id: 'plain-bill', text: 'Счёт, пожалуйста', to: 'vi', need: [/tính tiền|hóa đơn/i] },
  { id: 'plain-spicy', text: 'Как вы думаете, это блюдо очень острое?', to: 'vi', need: [/cay/i] },
  { id: 'plain-address', text: 'Отвезите меня на улицу Бах Данг, дом 12', to: 'vi', need: [/Bạch Đằng|Bach Dang/i, /12/] },
  // Запись без речи с контекстом — не выдумывать
  { id: 'audio-noise', audio: true, to: 'ru', context: '[vi] Cho em xin hóa đơn → Можно счёт\n[ru] Сколько с меня? → Bao nhiêu tiền?', forbidOrEmpty: [/сч[её]т|сколько/i] },
];

function wav(i16, rate = 16000) {
  const b = Buffer.alloc(44 + i16.byteLength);
  b.write('RIFF', 0); b.writeUInt32LE(36 + i16.byteLength, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(i16.byteLength, 40); Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).copy(b, 44);
  return b.toString('base64');
}

const results = [];
for (const c of CASES) {
  if (only && only !== 'all' && !only.split(',').includes(c.id)) continue;
  for (let k = 0; k < +nStr; k++) {
    if (results.length) await sleep(+gapStr);
    const from = LOGS.length, t0 = Date.now();
    let r = null, err = null;
    try {
      r = c.audio ? await mod.gemini.translateAudio(wav(noise(16000 * 1.5, 60)), c.context) : await mod.gemini.translateText(c.text, c.context || '');
    } catch (e) { err = e.message; }
    const tr = (r?.translation || '').trim();
    const fails = [];
    if (err) fails.push('ошибка: ' + err);
    else if (c.forbidOrEmpty) { if (tr && c.forbidOrEmpty.some(re => re.test(tr))) fails.push('выдумал по контексту'); }
    else {
      if (!tr) fails.push('пусто');
      if (tr && c.to === 'ru' && !isCyr(tr)) fails.push('не по-русски');
      if (tr && c.to === 'vi' && !isVi(tr)) fails.push('не по-вьетнамски');
      (c.need || []).forEach((re, i) => { if (!re.test(tr)) fails.push(`нет ${re.source.slice(0, 30)}`); });
      (c.forbid || []).forEach(re => { if (re.test(tr)) fails.push(`есть запрещённое ${re.source.slice(0, 30)}`); });
      if (c.src === '!ru' && r?.sourceLanguage === 'ru') fails.push('sourceLanguage=ru');
    }
    const model = LOGS.slice(from).map(l => l[1]).find(l => /ответ за/.test(l))?.split(':')[0] || '?';
    results.push({ id: c.id, k, ok: !fails.length, tr, src: r?.sourceLanguage, fails, model, ms: Date.now() - t0 });
    say(`${fails.length ? 'FAIL' : 'ok  '} ${c.id.padEnd(15)} [${model}, ${r?.sourceLanguage || '-'}] «${tr.slice(0, 90)}»${fails.length ? '  ← ' + fails.join('; ') : ''}`);
  }
}
const pass = results.filter(r => r.ok).length;
say(`ИТОГ [${arg}]: ${pass}/${results.length}`);
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', `redteam-${arg.replace(/[^a-z0-9.,-]/gi, '_')}-${Date.now()}.json`), JSON.stringify(results, null, 1));
