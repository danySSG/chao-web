// Длинный разговор в ОДНОЙ сессии: 17 реплик по очереди на двух языках, следующая —
// когда перевод договорён и прошло 2.5 с тишины. Переходит через плановое обновление
// сессии на 15-й реплике. Здесь раньше проявлялся дрейф (vi→vi, «испанский»).
//   node dialog.mjs <вариант> [прогонов=1]
import fs from 'node:fs';
import path from 'node:path';
import { HERE, quiet, say, makeVariant, liveVariant, utterance, noise, concat, judge } from './common.mjs';
import { openSession } from './sim.mjs';

const SEQ = ['p1', 'p2', 'p3', 'p4', 'p1a', 'p2a', 'p1b', 'p2b', 'p3', 'p4', 'p1', 'p2', 'p3', 'p4', 'p1a', 'p2a', 'p1b'];
const [spec = 'real', nStr = '1'] = process.argv.slice(2);
const V = liveVariant(spec);
const mod = await import(makeVariant('d-' + V.name, V.opts));
quiet();

const all = [];
for (let k = 0; k < +nStr; k++) {
  const s = await openSession(mod);
  if (!s.ready) { say(`[${spec}] ОТКАЗ ${s.errs[0] || 'нет сессии'}`); s.stop(); continue; }
  const res = [];
  for (const id of SEQ) {
    const from = s.turns.length;
    await s.speak(concat([noise(3200), utterance(id)]), (el, sp) =>
      (el > sp && s.turns.length > from && !s.speaking && Date.now() - s.lastMsg > 2500) || el > sp + 15000);
    const mine = s.turns.slice(from);
    res.push({ id, ...judge(id, mine.map(x => x.tr)), n: mine.length, text: mine.map(x => `«${x.t}» → «${x.tr}»`) });
  }
  s.stop();
  res.forEach((x, j) => say(`[${spec}] #${k + 1} ${String(j + 1).padStart(2)} ${x.id.padEnd(3)} ${x.full ? 'ок ' : x.n ? (x.okLang ? 'НЕПОЛНО' : 'ЯЗЫК!') : 'ПРОПУСК'} ${x.text.join(' | ').slice(0, 230)}`));
  for (const l of s.logs()) say('    · ' + l);
  say(`ИТОГ [${spec}] #${k + 1}: верно ${res.filter(x => x.full).length}/${res.length}`);
  all.push(res);
}
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', `dialog-${V.name}.json`), JSON.stringify(all, null, 1));
process.exit(0);
