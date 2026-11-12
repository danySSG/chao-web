// Одиночные реплики, каждая в новой сессии — как будто живой режим только что включили.
//   node live.mjs <вариант> [фразы=p1,p2,p3,p4] [прогонов=3] [пауза_мс=900]
// Вариант: real | fall | gemini-3.8-live | модель1,модель2 | …+prompt=файл.txt (см. common.mjs)
// Ждём ВСЕ ходы модели: тест, выходящий после первого ответа, не видит потерянный хвост.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, quiet, say, makeVariant, liveVariant, utterance, noise, concat, judge, sleep } from './common.mjs';
import { openSession } from './sim.mjs';

const [spec = 'real', plist = 'p1,p2,p3,p4', nStr = '3', pauseStr = '900'] = process.argv.slice(2);
const V = liveVariant(spec);
const mod = await import(makeVariant(V.name, V.opts));
quiet();

async function run(pid) {
  const P_ONE = utterance(pid, +pauseStr);
  const speech = concat([noise(4800), P_ONE]);
  const s = await openSession(mod);
  if (!s.ready) { s.stop(); return { pid, fail: s.errs[0] || 'таймаут подключения', logs: s.logs() }; }
  const r = await s.speak(speech, (el, sp) => (el > sp + 4000 && !s.speaking && Date.now() - s.lastMsg > 5000) || el > sp + 30000);
  s.stop();
  const j = judge(pid, s.turns.map(x => x.tr));
  return { pid, ...j, turns: s.turns.length, lat: r.lat, connectMs: s.connectMs, text: s.turns.map(x => `«${x.t}» → «${x.tr}»`), logs: s.logs() };
}

const out = [];
for (const pid of plist.split(',')) for (let k = 0; k < +nStr; k++) {
  const r = await run(pid);
  out.push(r);
  say(`[${spec}] ${pid} #${k + 1}: ${r.fail ? 'ОТКАЗ ' + r.fail : `${r.full ? 'ПОЛНЫЙ' : r.okLang ? 'неполный' : 'ЯЗЫК/ПУСТО'} ходов=${r.turns} задержка=${r.lat == null ? '—' : Math.round(r.lat) + ' мс'}`}`);
  for (const t of r.text || []) say('    ' + t);
  for (const l of r.logs || []) say('    · ' + l);
  await sleep(800);
}
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', `live-${V.name}-${plist}-${pauseStr}.json`), JSON.stringify(out, null, 1));
for (const p of plist.split(',')) {
  const rs = out.filter(r => r.pid === p), lats = rs.filter(r => r.lat != null).map(r => r.lat).sort((a, b) => a - b);
  say(`ИТОГ [${spec}] ${p}: полных ${rs.filter(r => r.full).length}/${rs.length}, медиана задержки ${lats.length ? Math.round(lats[lats.length >> 1]) + ' мс' : '—'}`);
}
process.exit(0);
