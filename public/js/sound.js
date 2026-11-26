// Tiny synthesized sound effects (no audio files → nothing to download, works offline).
let ctx = null;
let muted = localStorage.getItem('cricmate.muted') === '1';

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(duration, { freq = 1000, q = 1, gain = 0.3, type = 'bandpass' } = {}) {
  const c = ac();
  if (!c || muted) return;
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start();
}

function tone(freq, duration, { gain = 0.2, type = 'sine', slide = 0 } = {}) {
  const c = ac();
  if (!c || muted) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), c.currentTime + duration);
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + duration);
}

export const sfx = {
  unlock: () => ac(),
  get muted() {
    return muted;
  },
  toggle() {
    muted = !muted;
    localStorage.setItem('cricmate.muted', muted ? '1' : '0');
    return muted;
  },
  bat: (strength = 1) => {
    tone(900, 0.07, { gain: 0.25 * strength, type: 'triangle', slide: -500 });
    noise(0.05, { freq: 2500, q: 2, gain: 0.35 * strength });
  },
  thud: () => tone(160, 0.12, { gain: 0.25, slide: -60 }),
  stumps: () => {
    noise(0.25, { freq: 1800, q: 4, gain: 0.4 });
    tone(1400, 0.15, { gain: 0.1, type: 'square', slide: -800 });
  },
  cheer: (big = false) => noise(big ? 1.6 : 1.0, { freq: 1200, q: 0.4, gain: big ? 0.28 : 0.18 }),
  groan: () => tone(220, 0.6, { gain: 0.12, type: 'sawtooth', slide: -120 }),
  click: () => tone(600, 0.04, { gain: 0.08, type: 'square' }),
};
