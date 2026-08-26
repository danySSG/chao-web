// Мелкие утилиты: журнал диагностики, base64, тосты.

const LOG_LIMIT = 200;
const lines = [];

export function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  lines.push(`[${t}] ${msg}`);
  if (lines.length > LOG_LIMIT) lines.shift();
  const el = document.getElementById('log');
  if (el) { el.textContent = lines.join('\n'); el.scrollTop = el.scrollHeight; }
  console.log(msg);
}

export function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// Преобладание кириллицы: так определяем, на какой язык сделан перевод.
export function isMostlyCyrillic(text) {
  const letters = [...String(text)].filter(c => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const cyr = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length;
  return cyr * 2 >= letters.length;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `сегодня, ${time}`;
  return `${d.toLocaleDateString('ru', { day: 'numeric', month: 'short' })}, ${time}`;
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Короткая вибрация как подтверждение действия (Android; iOS игнорирует). */
export function haptic(pattern = 12) {
  try { navigator.vibrate?.(pattern); } catch {}
}
