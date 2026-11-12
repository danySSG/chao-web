// Синтез тестовых фраз (только недостающих) → audio/<id>.pcm, PCM 16 кГц моно.
// Основной путь — gemini-3.8-flash-tts; у него маленькая квота (12.11 кончилась
// после 4 запросов), запасной — системный say: Linh (vi) / Milena (ru).
// Записи в репозитории намеренно постоянные: сравнивать модели во времени
// честно только на одном и том же звуке. p1–p2 — голос Gemini, p3–p4 — say.
//   node tts.mjs            — досинтезировать недостающее
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HERE, KEY, PIECES } from './common.mjs';

function resample24to16(i16) {
  const n = Math.floor(i16.length * 2 / 3), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * 1.5, j = Math.floor(x), f = x - j;
    out[i] = Math.round(i16[j] * (1 - f) + i16[Math.min(j + 1, i16.length - 1)] * f);
  }
  return out;
}
// тишину по краям срезаем: паузы внутри реплик задаёт сам тест
function trim(i16, thr = 300) {
  let a = 0, b = i16.length - 1;
  while (a < b && Math.abs(i16[a]) < thr) a++;
  while (b > a && Math.abs(i16[b]) < thr) b--;
  return i16.slice(Math.max(0, a - 800), Math.min(i16.length, b + 800));
}
async function gemTts(p) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: p.text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } } },
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${j.error?.message?.slice(0, 100)}`);
  const d = j.candidates?.[0]?.content?.parts?.find(x => x.inlineData)?.inlineData;
  if (!d) throw new Error('нет аудио в ответе');
  const b = Buffer.from(d.data, 'base64');
  return resample24to16(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
}
function macSay(p) {
  const wav = path.join(os.tmpdir(), `chao-tts-${process.pid}.wav`);
  execFileSync('say', ['-v', p.lang === 'vi' ? 'Linh' : 'Milena', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', wav, p.text]);
  const b = fs.readFileSync(wav); fs.rmSync(wav);
  let o = 12;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'data') { o += 8; break; } o += 8 + sz; }
  return new Int16Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + b.length - ((b.length - o) % 2)));
}

for (const [id, p] of Object.entries(PIECES)) {
  const file = path.join(HERE, 'audio', `${id}.pcm`);
  if (fs.existsSync(file)) { console.log(id, 'уже есть'); continue; }
  let a, src = 'gemini-tts';
  try { a = await gemTts(p); } catch (e) { console.log(id, 'TTS Gemini не вышел:', e.message, '→ say'); a = macSay(p); src = 'say'; }
  a = trim(a);
  fs.writeFileSync(file, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  console.log(id, src, (a.length / 16000).toFixed(2) + ' с');
}
