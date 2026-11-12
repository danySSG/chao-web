// «Микрофон» и «динамик» вокруг настоящего LiveSession приложения.
// Звук уходит в реальном темпе чанками по 100 мс (иначе детектор речи ведёт себя
// не как в жизни); пока «звучит» ответ модели, микрофон заглушён и серверу
// уходит audioStreamEnd — ровно как refreshMicMute в app.js.
import { LOGS, noise, concat, b64, sleep } from './common.mjs';

const CH = 1600; // 100 мс при 16 кГц

export async function openSession(mod) {
  const st = { ready: false, errs: [], turns: [], playEnd: 0, speaking: false, muted: false, lastMsg: Date.now(), firstAudioAt: null, logFrom: LOGS.length };
  const live = new mod.LiveSession({
    onTurn: (t, tr) => st.turns.push({ t, tr, at: Date.now() }),
    onAudio: (d) => {
      st.lastMsg = Date.now();
      if (st.firstAudioAt === null) st.firstAudioAt = Date.now();
      st.playEnd = Math.max(Date.now(), st.playEnd) + Buffer.from(d, 'base64').length / 48; // 24 кГц s16 → мс
      st.speaking = true;
    },
    onInterrupted: () => { st.playEnd = Date.now(); },
    onState: (s) => { if (s === 'listening') st.ready = true; },
    onError: (m) => st.errs.push(m),
  });
  const t0 = Date.now();
  live.start();
  while (!st.ready && !st.errs.length && Date.now() - t0 < 15000) await sleep(50);
  st.connectMs = Date.now() - t0;

  /// Говорит speech, потом тишину, пока done(elapsedMs, speechMs) не скажет «хватит».
  st.speak = async (speech, done) => {
    const start = Date.now(), speechMs = speech.length / 16;
    st.firstAudioAt = null;
    let i = 0;
    for (;;) {
      const now = Date.now();
      if (st.speaking && now >= st.playEnd + 150) st.speaking = false;
      if (!st.muted && st.speaking) live.endAudioStream();
      st.muted = st.speaking;
      const due = Math.floor((now - start) / 100);
      while (i < due) {
        const off = i * CH;
        let ch = off < speech.length ? speech.slice(off, off + CH) : noise(CH);
        if (ch.length < CH) ch = concat([ch, noise(CH - ch.length)]);
        if (!st.muted) live.sendAudio(b64(ch));
        i++;
      }
      if (done(now - start, speechMs)) break;
      await sleep(20);
    }
    return { start, speechMs, lat: st.firstAudioAt ? st.firstAudioAt - (start + speechMs) : null };
  };
  st.logs = () => LOGS.slice(st.logFrom).map(x => x[1]).filter(l => !/соединение открыто|сессия готова/.test(l));
  st.stop = () => live.stop();
  return st;
}
