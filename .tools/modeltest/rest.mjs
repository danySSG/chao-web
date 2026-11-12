// REST: каталог, куда на деле уходит модель, разбор меню и перевод реплик через настоящий код.
//   node rest.mjs catalog                         — все модели ключа (Live — bidiGC)
//   node rest.mjs route [модели через запятую]    — кто отвечает на деле (modelVersion), время, тип отказа
//   node rest.mjs photo [real|цепочка] [прогонов] — translatePhoto на audio/menu.jpg (13 блюд)
//   node rest.mjs text  [real|цепочка]            — translateText двух реплик
//   node rest.mjs probe <модель> [фото]           — потоковый запрос: время до первого байта, зависает ли
// Цепочка: модели через запятую; Gemma (последний рубеж) приложение добавляет само.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, KEY, LOGS, quiet, say, makeVariant } from './common.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const [cmd = 'route', arg, nStr = '2'] = process.argv.slice(2);

// Видно, что делает сеть под кодом приложения: статус, время, таймауты.
const realFetch = globalThis.fetch, NET = [];
globalThis.fetch = async (url, opts = {}) => {
  const t = Date.now(), m = String(url).match(/models\/([^:?]+)/)?.[1] || String(url);
  try {
    const r = await realFetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(150000) });
    NET.push(`${m}: HTTP ${r.status} через ${((Date.now() - t) / 1000).toFixed(1)} с`);
    return r;
  } catch (e) { NET.push(`${m}: запрос упал через ${((Date.now() - t) / 1000).toFixed(1)} с — ${e.name}`); throw e; }
};

if (cmd === 'catalog') {
  const j = await (await fetch(`${BASE}?pageSize=300`, { headers: { 'x-goog-api-key': KEY } })).json();
  if (j.error) { say(j.error.message); process.exit(1); }
  for (const m of j.models) say(m.name.replace('models/', '').padEnd(48), (m.supportedGenerationMethods || []).join(','));
  say(`${j.models.length} моделей`);
}

if (cmd === 'route') {
  const models = (arg || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.6-flash,gemini-3.8-flash,gemini-flash-latest,gemma-4-31b-it').split(',');
  for (const model of models) {
    const t = Date.now();
    try {
      const res = await fetch(`${BASE}/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Переведи на вьетнамский: «Сколько стоит?» Ответь только переводом.' }] }] }),
      });
      const j = await res.json();
      if (!res.ok) {
        const q = JSON.stringify(j.error?.details || []).match(/"quotaId":"([^"]+)"/g)?.map(s => s.slice(11, -1)).join(', ');
        say(`${model}: ${res.status} за ${Date.now() - t} мс — ${q || j.error?.message?.slice(0, 110)}`);
      } else say(`${model}: отвечает ${j.modelVersion} за ${Date.now() - t} мс → «${j.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim().slice(0, 50)}»`);
    } catch (e) { say(`${model}: нет ответа за ${((Date.now() - t) / 1000).toFixed(0)} с (${e.name})`); }
  }
}

if (cmd === 'photo' || cmd === 'text') {
  const chain = !arg || arg === 'real' ? null : arg.split(',');
  const opts = chain ? (cmd === 'photo' ? { chainPhoto: chain } : { chainDialog: chain }) : {};
  const mod = await import(makeVariant(`${cmd}-${chain ? chain.join('_') : 'real'}`, opts));
  quiet();
  if (cmd === 'photo') {
    const img = fs.readFileSync(path.join(HERE, 'audio', 'menu.jpg')).toString('base64');
    for (let k = 0; k < +nStr; k++) {
      const from = LOGS.length, nf = NET.length, t = Date.now();
      let r, err;
      try { r = await mod.gemini.translatePhoto([img]); } catch (e) { err = e.message; }
      const items = (r?.sections || []).flatMap(s => (s.items || []).map(it => ({ sec: s.title, ...it })));
      say(`[фото ${arg || 'real'}] #${k + 1}: ${err ? 'ОШИБКА ' + err : `${items.length} блюд из 13 за ${((Date.now() - t) / 1000).toFixed(1)} с`}`);
      for (const l of NET.slice(nf)) say('   ⇄ ' + l);
      for (const l of LOGS.slice(from)) say('   · ' + l[1]);
      if (r && k === 0) for (const it of items) say(`   - ${it.original} → ${it.translation} | ${it.price} | ${(it.ingredients || '').slice(0, 70)}`);
    }
  } else {
    for (const t of ['Сколько стоит доехать до моста Дракона?', 'Anh ơi, cho em xin thêm hai ly trà đá nha.']) {
      const from = LOGS.length, t0 = Date.now();
      let r; try { r = await mod.gemini.translateText(t, []); } catch (e) { r = 'ОШИБКА ' + e.message; }
      say(`${((Date.now() - t0) / 1000).toFixed(1)} с: «${t}» → ${typeof r === 'string' ? r : '«' + r.translation + '»'}`);
      for (const l of LOGS.slice(from)) say('   · ' + l[1]);
    }
  }
}

if (cmd === 'probe') {
  const model = arg || 'gemini-3.6-flash', withPhoto = process.argv[4] === 'фото' || process.argv[4] === 'photo';
  const parts = withPhoto
    ? [{ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(path.join(HERE, 'audio', 'menu.jpg')).toString('base64') } }, { text: 'Переведи названия блюд на русский, кратко, списком.' }]
    : [{ text: 'Скажи «привет» по-вьетнамски.' }];
  const t = Date.now(); let first = null, text = '', usage = null;
  try {
    const r = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }),
    });
    if (!r.ok) say(`${model}: HTTP ${r.status} за ${Date.now() - t} мс — ${(await r.text()).slice(0, 160)}`);
    else {
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        if (first === null) first = Date.now() - t;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) if (l.startsWith('data: ')) { const j = JSON.parse(l.slice(6)); usage = j.usageMetadata || usage; text += (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''); }
      }
      say(`${model}: первый байт ${first} мс, всего ${Date.now() - t} мс, мыслей ${usage?.thoughtsTokenCount ?? 0} ток → «${text.slice(0, 80).replace(/\n/g, ' ')}»`);
    }
  } catch (e) { say(`${model}: ${e.name} через ${Date.now() - t} мс — модель зависла или перегружена`); }
}
process.exit(0);
