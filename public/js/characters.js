// The CricMate roster: original cricketers with a look and four stats (1–5, 12 points each).
// Stats feed the engine through small, deterministic modifiers, so both peers in an online
// match compute identical results as long as they know each other's character id.
import { DELIVERIES } from './engine.js';

export const STATS = {
  timing: { label: 'Timing', hint: 'Wider timing windows when batting' },
  power: { label: 'Power', hint: 'More boundaries, fewer catches when batting' },
  pace: { label: 'Pace', hint: 'Faster seam deliveries when bowling' },
  craft: { label: 'Craft', hint: 'More swing & turn, tighter windows for the batter' },
};

// look.style: short | spiky | mohawk | curly | long | ponytail | bun | bald
// look.beard: null | stubble | full | moustache      look.headwear: cap | band | none
// look.build: [height, width] multipliers
export const CHARACTERS = [
  {
    id: 'rook', name: 'Rook Okafor', short: 'Okafor', nick: 'The Wall', num: 21, role: 'Opening batter',
    bio: 'Leaves anything wide, punishes anything loose. Bowlers get bored before Rook does.',
    stats: { timing: 5, power: 2, pace: 2, craft: 3 },
    look: { skin: '#5a3a24', hair: '#141414', style: 'short', beard: 'full', build: [1.03, 1.1], accent: '#facc15', headwear: 'cap' },
  },
  {
    id: 'thunder', name: 'Arjun Vale', short: 'Vale', nick: 'Thunder', num: 9, role: 'Power hitter',
    bio: 'Swings from the hips. When it connects, the crowd in the top tier needs a helmet.',
    stats: { timing: 2, power: 5, pace: 3, craft: 2 },
    look: { skin: '#a8714a', hair: '#1a1a1a', style: 'spiky', beard: 'stubble', build: [1.0, 1.16], accent: '#f97316', headwear: 'none' },
  },
  {
    id: 'whiplash', name: 'Kesh Ndlovu', short: 'Ndlovu', nick: 'Whiplash', num: 45, role: 'Express quick',
    bio: 'Long run, longer levers. The fastest arm in the roster, and it knows it.',
    stats: { timing: 2, power: 2, pace: 5, craft: 3 },
    look: { skin: '#3d2618', hair: '#0b0b0b', style: 'mohawk', beard: null, build: [1.08, 1.0], accent: '#ef4444', headwear: 'band' },
  },
  {
    id: 'silk', name: 'Mira Solberg', short: 'Solberg', nick: 'Silk', num: 14, role: 'Swing bowler',
    bio: 'Makes the ball talk both ways. Batters think they have it read, right up until the off stump goes.',
    stats: { timing: 3, power: 1, pace: 3, craft: 5 },
    look: { skin: '#f1c7a5', hair: '#d9a95b', style: 'ponytail', beard: null, build: [0.96, 0.92], accent: '#22d3ee', headwear: 'cap' },
  },
  {
    id: 'fox', name: 'Tobias Grieve', short: 'Grieve', nick: 'Old Fox', num: 66, role: 'Spin wizard',
    bio: 'Twenty seasons of tricks. Slow through the air and never the same ball twice.',
    stats: { timing: 4, power: 2, pace: 1, craft: 5 },
    look: { skin: '#e8b894', hair: '#bdbdbd', style: 'bald', beard: 'moustache', build: [0.98, 1.06], accent: '#a3e635', headwear: 'cap' },
  },
  {
    id: 'sparks', name: 'Jojo Banda', short: 'Banda', nick: 'Sparks', num: 3, role: 'All-rounder',
    bio: 'Bats, bowls, fields, chirps. Good at everything, loud about all of it.',
    stats: { timing: 3, power: 3, pace: 3, craft: 3 },
    look: { skin: '#7a4a2c', hair: '#24160b', style: 'curly', beard: null, build: [1.0, 1.0], accent: '#e879f9', headwear: 'none' },
  },
  {
    id: 'ace', name: 'Ana Reyes', short: 'Reyes', nick: 'Ace', num: 7, role: 'Finisher',
    bio: 'Calm with twelve needed off the last over. Times it, places it, walks off.',
    stats: { timing: 4, power: 4, pace: 2, craft: 2 },
    look: { skin: '#c68a5e', hair: '#3b2414', style: 'long', beard: null, build: [0.97, 0.95], accent: '#fb7185', headwear: 'band' },
  },
  {
    id: 'slingshot', name: 'Dex Huang', short: 'Huang', nick: 'Slingshot', num: 88, role: 'Skiddy quick',
    bio: 'Round-arm, low and nasty. Hits the deck hard and can clear the rope when it is their turn to bat.',
    stats: { timing: 1, power: 4, pace: 4, craft: 3 },
    look: { skin: '#e9c39b', hair: '#0f0f0f', style: 'bun', beard: 'stubble', build: [1.0, 1.02], accent: '#60a5fa', headwear: 'none' },
  },
];

const BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
// Unknown ids (e.g. from an older client) fall back to the balanced all-rounder.
export const getChar = (id) => BY_ID[id] || BY_ID.sparks;
export const randomChar = (exceptId) => {
  const pool = CHARACTERS.filter((c) => c.id !== exceptId);
  return pool[Math.floor(Math.random() * pool.length)];
};

// ---------- gameplay modifiers (pure, deterministic) ----------
const PACE_TYPES = new Set(['fast', 'medium', 'yorker', 'bouncer']);

// What the engine needs for one batter-vs-bowler matchup. A stat of 3 is neutral.
export function matchupMods(bat, bowl) {
  const t = bat?.stats.timing ?? 3;
  const p = bat?.stats.power ?? 3;
  const c = bowl?.stats.craft ?? 3;
  return {
    window: +((0.865 + 0.045 * t) * (1.06 - 0.02 * c)).toFixed(4), // ×timing windows
    power: +(0.7 + 0.1 * p).toFixed(4), // ×boundary weights, ÷catch weights
  };
}

// Milliseconds from release to the batter for this bowler.
export function deliveryTime(type, bowl) {
  const base = DELIVERIES[type].time;
  if (!PACE_TYPES.has(type)) return base;
  return Math.round(base * (1.09 - 0.03 * (bowl?.stats.pace ?? 3)));
}

// Visual multiplier on swing and turn (craft 3 = 1.0).
export const movement = (bowl) => 0.55 + 0.15 * (bowl?.stats.craft ?? 3);

// ---------- 2D portrait (menu, cards) ----------
export function drawPortrait(canvas, ch, kit = '#3b82f6') {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const s = W / 100;
  const L = ch.look;
  g.clearRect(0, 0, W, H);
  // backdrop
  const bg = g.createRadialGradient(50 * s, 40 * s, 5 * s, 50 * s, 50 * s, 70 * s);
  bg.addColorStop(0, L.accent);
  bg.addColorStop(1, '#0d1a12');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const wide = L.build[1];

  // shoulders + shirt
  g.fillStyle = kit;
  g.beginPath();
  g.ellipse(50 * s, 104 * s, 40 * s * wide, 30 * s, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = L.accent;
  g.fillRect(50 * s - 40 * s * wide, 92 * s, 80 * s * wide, 3 * s);
  g.fillStyle = '#fff';
  g.font = `900 ${13 * s}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText(String(ch.num), 50 * s, 99 * s);
  // neck
  g.fillStyle = shade(L.skin, -0.12);
  g.fillRect(43 * s, 64 * s, 14 * s, 12 * s);

  const hx = 50 * s;
  const hy = 45 * s;
  const hr = 21 * s;
  // hair behind the head
  g.fillStyle = L.hair;
  if (L.style === 'long') g.fillRect(hx - hr * 1.02, hy - 4 * s, hr * 2.04, 32 * s);
  if (L.style === 'ponytail') {
    g.beginPath();
    g.ellipse(hx + hr * 0.95, hy + 10 * s, 6 * s, 15 * s, -0.4, 0, Math.PI * 2);
    g.fill();
  }
  // head
  g.fillStyle = L.skin;
  g.beginPath();
  g.ellipse(hx, hy, hr * 0.92, hr, 0, 0, Math.PI * 2);
  g.fill();
  // ears
  g.beginPath();
  g.arc(hx - hr * 0.92, hy + 2 * s, 4 * s, 0, Math.PI * 2);
  g.arc(hx + hr * 0.92, hy + 2 * s, 4 * s, 0, Math.PI * 2);
  g.fill();

  // beard
  if (L.beard === 'full' || L.beard === 'stubble') {
    g.fillStyle = L.beard === 'full' ? L.hair : hexA(L.hair, 0.35);
    g.beginPath();
    g.ellipse(hx, hy + 6 * s, hr * 0.9, hr * 0.85, 0, 0.1 * Math.PI, 0.9 * Math.PI);
    g.lineTo(hx - hr * 0.8, hy + 4 * s);
    g.fill();
  }
  // eyes, brows, mouth
  g.fillStyle = '#111';
  for (const dx of [-7, 7]) {
    g.beginPath();
    g.arc(hx + dx * s, hy + 1 * s, 2.1 * s, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = shade(L.hair, 0.05);
  g.lineWidth = 2 * s;
  g.beginPath();
  g.moveTo(hx - 11 * s, hy - 5 * s);
  g.lineTo(hx - 4 * s, hy - 6 * s);
  g.moveTo(hx + 4 * s, hy - 6 * s);
  g.lineTo(hx + 11 * s, hy - 5 * s);
  g.stroke();
  if (L.beard === 'moustache') {
    g.fillStyle = L.hair;
    g.beginPath();
    g.ellipse(hx, hy + 10 * s, 8 * s, 2.6 * s, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = L.beard === 'full' ? shade(L.skin, 0.2) : shade(L.skin, -0.35);
  g.lineWidth = 1.6 * s;
  g.beginPath();
  g.arc(hx, hy + 9 * s, 5 * s, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();

  // hair on top
  g.fillStyle = L.hair;
  const top = () => {
    g.beginPath();
    g.ellipse(hx, hy - 6 * s, hr * 0.97, hr * 0.72, 0, Math.PI * 1.02, Math.PI * 1.98);
    g.fill();
  };
  switch (L.style) {
    case 'short':
    case 'long':
    case 'ponytail':
      top();
      break;
    case 'curly':
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * (1.05 + (i / 8) * 0.9);
        g.beginPath();
        g.arc(hx + Math.cos(a) * hr * 0.85, hy - 4 * s + Math.sin(a) * hr * 0.85, 7 * s, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case 'spiky':
      top();
      for (let i = 0; i < 6; i++) {
        const x = hx - 15 * s + i * 6 * s;
        g.beginPath();
        g.moveTo(x - 4 * s, hy - 18 * s);
        g.lineTo(x + 1 * s, hy - 30 * s);
        g.lineTo(x + 5 * s, hy - 17 * s);
        g.fill();
      }
      break;
    case 'mohawk':
      g.fillRect(hx - 4 * s, hy - 31 * s, 8 * s, 16 * s);
      break;
    case 'bun':
      top();
      g.beginPath();
      g.arc(hx, hy - 25 * s, 7 * s, 0, Math.PI * 2);
      g.fill();
      break;
    case 'bald':
      g.fillStyle = hexA(L.hair, 0.8);
      g.fillRect(hx - hr * 0.95, hy - 2 * s, 4 * s, 7 * s);
      g.fillRect(hx + hr * 0.95 - 4 * s, hy - 2 * s, 4 * s, 7 * s);
      break;
  }

  // headwear
  if (L.headwear === 'cap') {
    g.fillStyle = shade(kit, -0.35);
    g.beginPath();
    g.ellipse(hx, hy - 10 * s, hr * 1.0, hr * 0.62, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = L.accent;
    g.fillRect(hx - hr * 1.05, hy - 11 * s, hr * 2.4, 4 * s);
  } else if (L.headwear === 'band') {
    g.fillStyle = L.accent;
    g.fillRect(hx - hr * 0.92, hy - 13 * s, hr * 1.84, 5 * s);
  }
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
