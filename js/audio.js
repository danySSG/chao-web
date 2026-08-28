// Аудио: микрофон (стрим для Live и запись фразы), проигрывание ответа модели, TTS.

import { bytesToBase64, base64ToBytes, log } from './util.js?v=202608281720';

const IN_RATE = 16000;
const OUT_RATE = 24000;

let ctx = null;

export function audioContext() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

function downsample(input, fromRate) {
  if (fromRate === IN_RATE) return input;
  const ratio = fromRate / IN_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function floatToPCM16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Захват микрофона: отдаёт чанки PCM16 16 кГц в onChunk и/или копит их для записи. */
export class Microphone {
  constructor() {
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.muted = false;
    this.onChunk = null;
    this.recording = null; // массив Int16Array, когда идёт запись фразы
  }

  get active() { return !!this.processor; }

  async start() {
    if (this.processor) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ac = audioContext();
    await ac.resume();
    log(`микрофон: ${ac.sampleRate} Гц, состояние ${ac.state}`);

    this.source = ac.createMediaStreamSource(this.stream);
    this.processor = ac.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const pcm = floatToPCM16(downsample(e.inputBuffer.getChannelData(0), ac.sampleRate));
      if (this.recording) this.recording.push(pcm);
      if (!this.muted && this.onChunk) this.onChunk(bytesToBase64(new Uint8Array(pcm.buffer)));
    };
    // Глушим выход процессора, иначе микрофон уйдёт в динамик.
    const silent = ac.createGain();
    silent.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(ac.destination);
  }

  stop() {
    try { if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); } } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    this.processor = this.source = this.stream = null;
    this.recording = null;
    this.muted = false;
  }

  startRecording() { this.recording = []; }

  /** Останавливает запись и отдаёт WAV в base64 (или null, если слишком коротко). */
  stopRecording() {
    const chunks = this.recording || [];
    this.recording = null;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < IN_RATE * 0.4) return null; // меньше 0.4 с
    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) { pcm.set(c, off); off += c.length; }
    return bytesToBase64(wavFromPCM16(pcm, IN_RATE));
  }
}

function wavFromPCM16(pcm, rate) {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);   // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits
  str(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(new Uint8Array(pcm.buffer), 44);
  return bytes;
}

/** Очередь воспроизведения ответа модели (PCM 24 кГц кусками). */
export class Player {
  constructor(onSpeakingChange) {
    this.onSpeakingChange = onSpeakingChange;
    this.head = 0;
    this.pending = 0;
    this.speaking = false;
    this.unmuteTimer = null;
    this.generation = 0;
  }

  enqueue(base64) {
    const ac = audioContext();
    const bytes = base64ToBytes(base64);
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!int16.length) return;

    const buf = ac.createBuffer(1, int16.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);

    const now = ac.currentTime;
    if (this.head < now) this.head = now + 0.06;
    src.start(this.head);
    this.head += buf.duration;

    const gen = this.generation;
    this.pending++;
    this._setSpeaking(true);
    src.onended = () => {
      if (gen !== this.generation) return;
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this._scheduleUnmute();
    };
  }

  /** Собеседник перебил модель — выбрасываем недоигранный хвост. */
  flush() {
    this.generation++;
    this.pending = 0;
    this.head = ctx ? ctx.currentTime : 0;
    this._setSpeaking(false);
  }

  reset() { this.flush(); }

  _setSpeaking(v) {
    if (v && this.unmuteTimer) { clearTimeout(this.unmuteTimer); this.unmuteTimer = null; }
    if (this.speaking === v) return;
    this.speaking = v;
    this.onSpeakingChange?.(v);
  }

  // Пауза перед размьютом: пережидаем сетевой джиттер и хвост звука из динамика.
  _scheduleUnmute() {
    clearTimeout(this.unmuteTimer);
    this.unmuteTimer = setTimeout(() => {
      this.unmuteTimer = null;
      if (this.pending === 0) this._setSpeaking(false);
    }, 400);
  }
}

/** Системная озвучка (для кнопки «🔊» и показа собеседнику). */
export const speaker = {
  speak(text, lang) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    const voices = speechSynthesis.getVoices().filter(v => v.lang?.replace('_', '-').startsWith(lang.slice(0, 2)));
    const best = voices.find(v => /enhanced|premium|siri/i.test(v.name)) || voices[0];
    if (best) u.voice = best;
    speechSynthesis.speak(u);
  },
  stop() { try { speechSynthesis.cancel(); } catch {} },
};

/** Сжатие фото перед отправкой: длинная сторона до maxSide, JPEG. */
export function compressImage(file, maxSide = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ dataUrl, base64: dataUrl.split(',')[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать фото')); };
    img.src = url;
  });
}
