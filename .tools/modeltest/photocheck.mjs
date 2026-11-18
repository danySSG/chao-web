// Разбор меню с проверками полей — до и после правки PHOTO_PROMPT.
//   node photocheck.mjs [real|цепочка] [прогонов=1]
// menu.jpg — 13 блюд Дананга без состава (ждём «обычно:», bún chả cá — рыбный);
// menu2.jpg — морепродукты: номера позиций, английские дубли, цена за кг,
// «Thời giá», размеры, сноска про НДС и сбор.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, LOGS, quiet, say, makeVariant } from './common.mjs';

const [arg = 'real', nStr = '1', onlyFile] = process.argv.slice(2);
const chain = arg === 'real' ? null : arg.split(',');
const mod = await import(makeVariant(`pc-${chain ? chain.join('_') : 'real'}`, chain ? { chainPhoto: chain } : {}));
quiet();

const img = (f) => fs.readFileSync(path.join(HERE, 'audio', f)).toString('base64');
const items = (r) => (r?.sections || []).flatMap(s => (s.items || []).map(it => ({ sec: s.title, ...it })));
const find = (list, re) => list.find(it => re.test(it.original));

const CHECKS = {
  'menu.jpg': (r) => {
    const L = items(r), out = [];
    out.push(['13 блюд', L.length === 13, L.length]);
    const typical = L.filter(it => /^обычно/i.test((it.ingredients || '').trim())).length;
    out.push(['состав блюд не из меню помечен «обычно» (напитки можно без)', typical >= 9, `${typical}/${L.length}`]);
    const bcc = find(L, /chả cá/i);
    out.push(['bún chả cá — рыбный, без свинины', !!bcc && /рыб/i.test(bcc.translation + bcc.ingredients) && !/свин/i.test(bcc.translation), bcc && `${bcc.translation} | ${bcc.ingredients}`]);
    return out;
  },
  'menu2.jpg': (r) => {
    const L = items(r), out = [];
    out.push(['7–8 позиций', L.length >= 7 && L.length <= 8, L.length]);
    const eng = L.filter(it => /\/\s*[A-Z][a-z]|\b(grilled|crab|juice|rice|snails|lobster)\b/i.test(it.original));
    out.push(['в original нет английских дублей', !eng.length, eng.map(it => it.original).join(' ; ')]);
    const num = L.filter(it => /^0?\d{1,2}[.)]?\s/.test(it.original)).length;
    out.push(['номер позиции в начале original', num >= 6, `${num}/${L.length}`]);
    const lob = find(L, /tôm hùm/i);
    out.push(['лобстер — цена за кг', !!lob && /кг|kg/i.test(lob.price), lob?.price]);
    const crab = find(L, /cua/i);
    out.push(['краб — «по рыночной цене»', !!crab && /рыночн|по весу|уточн/i.test(crab.price), crab?.price]);
    const blocks = (r?.blocks || []).map(b => b.translation).join(' | ');
    out.push(['сноска про НДС и сбор', /НДС|VAT/i.test(blocks) && /сбор|обслуж/i.test(blocks), blocks.slice(0, 160)]);
    out.push(['«только наличные»', /наличн/i.test(blocks), '']);
    const cane = L.filter(it => /mía/i.test(it.original));
    out.push(['сок двух размеров не потерян', cane.length === 2 || cane.some(it => /15/.test(it.price) && /25/.test(it.price)), cane.map(it => `${it.original}: ${it.price}`).join(' ; ')]);
    return out;
  },
};

let pass = 0, total = 0;
for (let k = 0; k < +nStr; k++) {
  for (const [file, check] of Object.entries(CHECKS)) {
    if (onlyFile && file !== onlyFile) continue;
    const t = Date.now(), from = LOGS.length;
    let r, err;
    try { r = await mod.gemini.translatePhoto([img(file)]); } catch (e) { err = e.message; }
    const model = LOGS.slice(from).map(l => l[1]).find(l => /ответ за/.test(l))?.split(':')[0] || '?';
    say(`== ${file} #${k + 1} [${model}] ${err ? 'ОШИБКА ' + err : ((Date.now() - t) / 1000).toFixed(1) + ' с'}`);
    if (!r) continue;
    for (const [name, ok, info] of check(r)) { total++; if (ok) pass++; say(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined && info !== '' ? ' — ' + info : ''}`); }
    if (k === 0) for (const it of items(r)) say(`   · ${it.original} → ${it.translation} | ${it.price} | ${(it.ingredients || '').slice(0, 60)}`);
  }
}
say(`ИТОГ [${arg}]: ${pass}/${total}`);
