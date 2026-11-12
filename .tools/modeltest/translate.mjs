// gemini-3.5-live-translate-preview (синхронист): две сессии на один «микрофон» —
// одна переводит на русский, другая на вьетнамский, echoTargetLanguage:false
// (речь на целевом языке не повторять). Своё подключение, не код приложения.
//   node translate.mjs [фразы=p1,p2,p3,p4] [прогонов=2] [--nomute]
// По умолчанию микрофон глушится на время ответа, как в приложении — тогда
// синхронист обрезает хвост фразы. --nomute — как в наушниках, без глушения.
// 12.11.2026: «чужая» сессия молчит 10/10; с глушением полных 2/8, без — 2/2.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, KEY, utterance, noise, concat, b64, judge, PHRASES, sleep } from './common.mjs';

const WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const args = process.argv.slice(2), NOMUTE = args.includes('--nomute');
const [plist = 'p1,p2,p3,p4', nStr = '2'] = args.filter(a => !a.startsWith('--'));

function open(target) {
  return new Promise((resolve) => {
    const s = { target, out: '', inp: '', audioAt: null, playEnd: 0, closed: null, ready: false, last: 0 };
    const ws = new WebSocket(`${WS}?key=${encodeURIComponent(KEY)}`);
    s.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ setup: {
      model: 'models/gemini-3.5-live-translate-preview',
      generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: target, echoTargetLanguage: false } },
      inputAudioTranscription: {}, outputAudioTranscription: {},
    } }));
    ws.onmessage = async (ev) => {
      let raw = ev.data; if (raw instanceof Blob) raw = await raw.text(); else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      const m = JSON.parse(raw);
      if (m.setupComplete) { s.ready = true; resolve(s); return; }
      s.last = Date.now();
      const sc = m.serverContent; if (!sc) return;
      if (sc.outputTranscription?.text) s.out += sc.outputTranscription.text;
      if (sc.inputTranscription?.text) s.inp += sc.inputTranscription.text;
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) {
        if (s.audioAt === null) s.audioAt = Date.now();
        s.playEnd = Math.max(Date.now(), s.playEnd) + Buffer.from(p.inlineData.data, 'base64').length / 48;
      }
    };
    ws.onclose = (e) => { s.closed = `${e.code} ${e.reason}`; resolve(s); };
  });
}

const results = [];
for (const pid of plist.split(',')) for (let k = 0; k < +nStr; k++) {
  const P = PHRASES[pid];
  const speech = concat([noise(4800), utterance(pid)]), speechMs = speech.length / 16;
  const [ru, vi] = await Promise.all([open('ru'), open('vi')]);
  if (!ru.ready || !vi.ready) { console.log('ОТКАЗ', ru.closed, vi.closed); process.exit(1); }
  const start = Date.now(); let i = 0, muted = false;
  for (;;) {
    const now = Date.now();
    const speaking = !NOMUTE && now < Math.max(ru.playEnd, vi.playEnd) + 150;
    if (!muted && speaking) for (const s of [ru, vi]) s.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    muted = speaking;
    const due = Math.floor((now - start) / 100);
    while (i < due) {
      const off = i * 1600; let ch = off < speech.length ? speech.slice(off, off + 1600) : noise(1600);
      if (ch.length < 1600) ch = concat([ch, noise(1600 - ch.length)]);
      if (!muted) for (const s of [ru, vi]) s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(ch), mimeType: 'audio/pcm;rate=16000' } } }));
      i++;
    }
    const lastAny = Math.max(ru.last, vi.last, start);
    const playing = now < Math.max(ru.playEnd, vi.playEnd);
    if ((now - start > speechMs + 4000 && !playing && now - lastAny > 5000) || now - start > speechMs + 30000) break;
    await sleep(20);
  }
  for (const s of [ru, vi]) try { s.ws.close(1000); } catch {}
  const want = P.to === 'ru' ? ru : vi, other = P.to === 'ru' ? vi : ru;
  const j = judge(pid, want.out.trim() ? [want.out.trim()] : []);
  const r = { pid, ...j, lat: want.audioAt ? want.audioAt - (start + speechMs) : null, want: want.out.trim(), wantIn: want.inp.trim(), other: other.out.trim() };
  results.push(r);
  console.log(`[translate${NOMUTE ? ' без глушения' : ''}] ${pid} #${k + 1}: ${r.full ? 'ПОЛНЫЙ' : 'неполный'} задержка=${r.lat == null ? '—' : Math.round(r.lat) + ' мс'} (минус — заговорила до конца фразы)`);
  console.log(`    нужная (${P.to}): «${r.wantIn}» → «${r.want}»`);
  console.log(`    вторая сессия: ${r.other ? '«' + r.other + '»  ← ЛИШНИЙ ГОЛОС' : 'молчит — хорошо'}`);
  await sleep(800);
}
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', `translate-${plist}${NOMUTE ? '-nomute' : ''}.json`), JSON.stringify(results, null, 1));
for (const p of plist.split(',')) { const rs = results.filter(r => r.pid === p); console.log(`ИТОГ ${p}: полных ${rs.filter(r => r.full).length}/${rs.length}, вторая молчит ${rs.filter(r => !r.other).length}/${rs.length}`); }
process.exit(0);
