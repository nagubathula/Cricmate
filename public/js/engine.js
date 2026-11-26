// Pure, deterministic cricket rules. Shared by the UI, the AI and the tests.
// Both peers resolve every ball locally from (delivery, swing, seed), so they always agree
// without one side having to be the authority.

export const RUNUP_MS = 700; // bowler run-up before release
export const LATE_WINDOW = 220; // ms after arrival before the ball is considered left alone

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

// time: ms from release to reaching the batter. pitch: where it bounces (0 = bowler, 1 = batter).
// height: how high it is at the batter. drift: spin turn. swing: lateral movement in the air.
export const DELIVERIES = {
  fast: { label: 'Fast', key: '1', time: 780, pitch: 0.7, height: 1.0, drift: 0, swing: 0.4, hint: 'Quick — less time to react' },
  medium: { label: 'Medium', key: '2', time: 980, pitch: 0.72, height: 0.9, drift: 0, swing: 0.8, hint: 'Swings in the air' },
  slower: { label: 'Slower', key: '3', time: 1320, pitch: 0.7, height: 0.85, drift: 0, swing: 0, hint: 'Deceives batters into swinging early' },
  yorker: { label: 'Yorker', key: '4', time: 860, pitch: 0.97, height: 0.35, drift: 0, swing: 0.3, hint: 'At the toes — hard to attack' },
  bouncer: { label: 'Bouncer', key: '5', time: 840, pitch: 0.42, height: 1.7, drift: 0, swing: 0, hint: 'Short & high — pull or get hurried' },
  spin: { label: 'Spin', key: '6', time: 1180, pitch: 0.76, height: 0.9, drift: 1, swing: 0, hint: 'Turns off the pitch' },
};

// x offset at the batter (screen +x = off side for a right-hander facing up the pitch)
export const LINES = {
  leg: { label: 'Leg', key: 'Z', x: -15 },
  middle: { label: 'Middle', key: 'X', x: 0 },
  off: { label: 'Off', key: 'C', x: 15 },
};

export const SHOTS = {
  pull: { label: 'Pull', keys: '← / A', word: 'pull', hint: 'Leg side — loves short & leg-line balls' },
  drive: { label: 'Drive', keys: '↑ / W', word: 'drive', hint: 'Straight / off side — great on full balls' },
  cut: { label: 'Cut', keys: '→ / D', word: 'cut', hint: 'Off side — for balls outside off' },
  loft: { label: 'Loft', keys: 'Space', word: 'lofted hit', hint: 'High risk, high reward — sixes or caught' },
  defend: { label: 'Block', keys: '↓ / S', word: 'defensive push', hint: 'Safe, few runs' },
};

export const TIER_LABELS = ['Perfect', 'Good', 'OK', 'Edge', 'Miss'];

// scale widens (>1) or tightens (<1) every window — used by character stats.
export function timingTier(err, scale = 1) {
  if (err == null) return 4;
  const a = Math.abs(err) / scale;
  return a <= 35 ? 0 : a <= 80 ? 1 : a <= 130 ? 2 : a <= 200 ? 3 : 4;
}

export function timingLabel(err, scale = 1) {
  if (err == null) return 'Left alone';
  const tier = timingTier(err, scale);
  if (tier === 0) return `Perfect timing (${err >= 0 ? '+' : ''}${err}ms)`;
  return `${TIER_LABELS[tier]} — ${Math.abs(err)}ms ${err < 0 ? 'early' : 'late'}`;
}

// How well the chosen shot suits the delivery. Positive = harder, negative = easier.
export function fitPenalty(shot, d) {
  const { type, line } = d;
  let p = 0;
  switch (shot) {
    case 'cut':
      p = line === 'off' ? 0 : line === 'middle' ? 1 : 2;
      if (type === 'yorker') p += 2;
      if (type === 'bouncer') p -= 1;
      break;
    case 'pull':
      p = line === 'leg' ? 0 : line === 'middle' ? 1 : 2;
      if (type === 'bouncer') p -= 1;
      if (type === 'yorker') p += 2;
      break;
    case 'drive':
      p = line === 'leg' ? 1 : 0;
      if (type === 'bouncer') p += 2;
      if (type === 'yorker') p += 1;
      break;
    case 'loft':
      p = type === 'yorker' ? 2 : type === 'bouncer' ? 1 : type === 'spin' || type === 'slower' ? -1 : 0;
      break;
    case 'defend':
      p = type === 'bouncer' ? 1 : 0;
      break;
  }
  return p;
}

// Weighted outcome tables per timing tier (perfect, good, ok, edge). Values: runs or 'caught'.
const TABLES = {
  attack: [
    [[4, 50], [6, 12], [2, 20], [3, 10], [1, 8]],
    [[4, 28], [2, 25], [1, 27], [3, 10], [0, 8], ['caught', 2]],
    [[1, 42], [0, 30], [2, 18], [4, 5], ['caught', 5]],
    [[0, 35], [1, 22], [4, 12], ['caught', 26], [2, 5]],
  ],
  loft: [
    [[6, 75], [4, 25]],
    [[6, 35], [4, 30], [2, 15], ['caught', 20]],
    [['caught', 40], [1, 25], [2, 20], [6, 15]],
    [['caught', 60], [0, 20], [1, 15], [4, 5]],
  ],
  defend: [
    [[0, 55], [1, 45]],
    [[0, 70], [1, 30]],
    [[0, 90], [1, 10]],
    [[0, 85], ['caught', 15]],
  ],
};

function pick(table, rng) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of table) {
    if ((r -= w) < 0) return v;
  }
  return table[table.length - 1][0];
}

const SHOT_ANGLES = {
  // radians from straight down the ground (toward the bowler); + = off side, - = leg side
  drive: [-0.3, 0.75],
  cut: [1.25, 1.95],
  pull: [-1.95, -1.15],
  loft: [-0.6, 0.6],
  defend: [-0.4, 0.4],
};

const PHRASES = {
  6: ['Launched! That is out of the ground — SIX!', 'Massive! Into the crowd for SIX!', 'Clean as you like — SIX!'],
  4: ['Pierces the gap — FOUR!', 'Races away to the rope — FOUR!', 'Timed to perfection, FOUR!'],
  3: ['Great running, they come back for three.', 'Into the deep, three taken.'],
  2: ['Placed into the gap, they come back for two.', 'Good running — two.'],
  1: ['Worked away for a single.', 'Quick single taken.', 'Nudged for one.'],
  0: ['No run.', 'Straight to the fielder. Dot ball.', 'Well fielded, no run.'],
  leave: ['Left alone.', 'Shoulders arms, no shot offered.'],
  beaten: ['Beaten! Swing and a miss.', 'Played and missed!'],
  bowled: ['BOWLED HIM! The stumps are rattled!', 'Clean bowled! Timber!'],
  lbw: ['Big appeal... and that is OUT! LBW.', 'Trapped in front — LBW!'],
  caught: ['Up in the air... and TAKEN! Caught!', 'Straight down the fielder’s throat. OUT!'],
  'caught behind': ['Edged and taken behind! OUT!', 'Feathered through to the keeper — OUT!'],
};
const phrase = (key, rng) => {
  const list = PHRASES[key];
  return list[Math.floor(rng() * list.length)];
};

function missResult(d, shot, err, rng) {
  const swung = shot !== 'leave';
  const r = rng();
  let out = null;
  if (d.type === 'bouncer') {
    if (swung && r < 0.1) out = 'caught behind';
  } else if (d.line === 'middle') {
    const pBowled = d.type === 'yorker' ? 0.72 : 0.5;
    if (r < pBowled) out = 'bowled';
    else if (r < pBowled + 0.2) out = 'lbw';
  } else if (d.line === 'leg') {
    if (r < (d.type === 'yorker' ? 0.3 : 0.14)) out = 'lbw';
  } else {
    // off
    if (swung && r < 0.16) out = 'caught behind';
    else if (d.type === 'yorker' && r < 0.3) out = 'bowled';
  }
  return {
    runs: 0,
    out,
    shot,
    err,
    tier: 4,
    kind: swung ? 'miss' : 'leave',
    angle: 0,
    aerial: false,
    text: phrase(out || (swung ? 'beaten' : 'leave'), rng),
  };
}

// Power hitters turn some ones and twos into boundaries and clear fielders more often.
function empower(table, power) {
  if (power === 1) return table;
  return table.map(([v, w]) => [v, v === 4 || v === 6 ? w * power : v === 'caught' ? w / power : w]);
}

// mods: { window, power } from the batter/bowler characters (see characters.js). 1 = neutral.
export function resolveBall(d, swing, seed, mods = {}) {
  const rng = mulberry32(seed);
  const shot = swing.shot;
  const err = swing.err;
  const win = mods.window > 0 ? mods.window : 1;
  const power = mods.power > 0 ? mods.power : 1;
  if (shot === 'leave' || !SHOTS[shot]) return missResult(d, 'leave', null, rng);

  let tier = timingTier(err, win);
  if (tier < 4) {
    const pen = fitPenalty(shot, d);
    // a good matchup can sharpen a decent connection, but never rescue an edge
    tier = pen < 0 ? (tier >= 1 && tier <= 2 ? tier - 1 : tier) : Math.min(4, tier + pen);
  }
  if (tier === 4) return missResult(d, shot, err, rng);

  const group = shot === 'defend' ? 'defend' : shot === 'loft' ? 'loft' : 'attack';
  let table = TABLES[group][tier];
  if (shot === 'pull' && tier === 0) table = [[6, 30], [4, 50], [2, 15], [1, 5]];
  if (group !== 'defend') table = empower(table, power);
  const v = pick(table, rng);
  const out = v === 'caught' ? (tier === 3 && rng() < 0.6 ? 'caught behind' : 'caught') : null;
  const runs = out ? 0 : v;

  let angle;
  if (tier === 3) {
    // edges fly behind square
    angle = (err >= 0 ? 1 : -1) * (2.45 + rng() * 0.5);
  } else {
    const [a, b] = SHOT_ANGLES[shot];
    angle = a + (b - a) * rng() + Math.max(-0.5, Math.min(0.5, (err || 0) * 0.004));
  }
  const aerial = runs === 6 || out === 'caught' || (shot === 'loft' && rng() < 0.7);

  let text;
  if (out) text = phrase(out, rng);
  else if (runs >= 4) text = phrase(runs, rng);
  else text = `${cap(SHOTS[shot].word)}. ${phrase(runs, rng)}`;

  return { runs, out, shot, err, tier, kind: 'hit', angle, aerial, text };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const oversStr = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

const newInnings = (bat) => ({ bat, runs: 0, wkts: 0, balls: 0, fours: 0, sixes: 0, thisOver: [], log: [] });

export class Match {
  constructor(cfg, names) {
    this.cfg = { overs: cfg.overs, wickets: cfg.wickets, firstBat: cfg.firstBat };
    this.names = names;
    this.innings = [newInnings(cfg.firstBat)];
    this.cur = 0;
    this.over = false;
    this.result = null;
  }
  get inn() {
    return this.innings[this.cur];
  }
  get battingSide() {
    return this.inn.bat;
  }
  get bowlingSide() {
    return 1 - this.inn.bat;
  }
  get target() {
    return this.cur === 1 ? this.innings[0].runs + 1 : null;
  }
  get seq() {
    return this.innings.reduce((s, i) => s + i.balls, 0);
  }
  get ballsLeft() {
    return this.cfg.overs * 6 - this.inn.balls;
  }

  applyBall(res) {
    const inn = this.inn;
    if (inn.balls % 6 === 0) inn.thisOver = [];
    inn.balls++;
    inn.runs += res.runs;
    if (res.out) inn.wkts++;
    if (res.runs === 4) inn.fours++;
    if (res.runs === 6) inn.sixes++;
    const sym = res.out ? 'W' : String(res.runs);
    inn.thisOver.push(sym);
    inn.log.push(sym);

    const done =
      inn.wkts >= this.cfg.wickets || inn.balls >= this.cfg.overs * 6 || (this.cur === 1 && inn.runs >= this.target);
    if (!done) return 'ball';
    if (this.cur === 0) {
      this.innings.push(newInnings(1 - inn.bat));
      this.cur = 1;
      return 'innings';
    }
    this.over = true;
    this.result = this._result();
    return 'match';
  }

  _result() {
    const [a, b] = this.innings;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (b.runs > a.runs) {
      return { winner: b.bat, text: `${this.names[b.bat]} won by ${plural(this.cfg.wickets - b.wkts, 'wicket')}` };
    }
    if (b.runs === a.runs) return { winner: null, text: 'Match tied!' };
    return { winner: a.bat, text: `${this.names[a.bat]} won by ${plural(a.runs - b.runs, 'run')}` };
  }
}
