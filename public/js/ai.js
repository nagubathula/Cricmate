// Offline opponent. It talks the exact same message protocol as a network peer,
// so the game session code doesn't care whether it's playing a person or the CPU.
import { Match, resolveBall, DELIVERIES, LINES, RUNUP_MS, newSeed } from './engine.js';
import { getChar, matchupMods, deliveryTime } from './characters.js';

export const DIFFICULTY = {
  easy: { label: 'Easy', sigma: 115, wrong: 0.35, bowlSmart: 0.2 },
  medium: { label: 'Medium', sigma: 72, wrong: 0.18, bowlSmart: 0.5 },
  hard: { label: 'Hard', sigma: 44, wrong: 0.07, bowlSmart: 0.8 },
};

const pickW = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[0][0];
};
const gauss = () => {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export function chooseDelivery(level, match) {
  const cfg = DIFFICULTY[level] || DIFFICULTY.medium;
  const death = match && match.ballsLeft <= 6;
  const smart = Math.random() < cfg.bowlSmart;
  const type = pickW([
    ['fast', 20],
    ['medium', 20],
    ['slower', smart ? 16 : 10],
    ['yorker', death && smart ? 30 : 10],
    ['bouncer', 12],
    ['spin', 16],
  ]);
  const line = pickW([
    ['off', smart ? 50 : 35],
    ['middle', 35],
    ['leg', smart ? 15 : 30],
  ]);
  return { type, line };
}

export function chooseSwing(d, level) {
  const cfg = DIFFICULTY[level] || DIFFICULTY.medium;
  let shot;
  if (d.type === 'yorker') shot = Math.random() < 0.6 ? 'defend' : 'drive';
  else if (d.type === 'bouncer') shot = d.line === 'off' ? 'cut' : 'pull';
  else if (d.type === 'spin' || d.type === 'slower') shot = Math.random() < 0.35 ? 'loft' : d.line === 'off' ? 'cut' : d.line === 'leg' ? 'pull' : 'drive';
  else if (d.line === 'off') shot = Math.random() < 0.55 ? 'cut' : 'drive';
  else if (d.line === 'leg') shot = 'pull';
  else shot = pickW([['drive', 50], ['defend', 25], ['loft', 25]]);

  if (Math.random() < cfg.wrong) shot = pickW([['pull', 1], ['cut', 1], ['drive', 1], ['loft', 1], ['defend', 1], ['leave', 1]]);
  if (shot === 'leave') return { shot, err: null };

  let bias = 0;
  if (d.type === 'slower') bias = -cfg.sigma * 0.8; // fooled by the change of pace
  if (d.type === 'fast') bias = cfg.sigma * 0.3; // hurried
  return { shot, err: Math.round(gauss() * cfg.sigma + bias) };
}

export class AiPeer {
  constructor(level = 'medium') {
    this.level = level;
    this.me = 1;
    this.match = null;
    this.cur = null;
    this.timers = new Set();
    this.onMessage = () => {};
    this.onEvent = () => {};
    this.mode = 'offline';
  }

  // called by the session: a message from the human to the AI
  send(msg) {
    this._later(0, () => this._recv(msg));
  }
  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  _later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
  _emit(msg) {
    this._later(0, () => this.onMessage(msg));
  }

  _recv(m) {
    switch (m.t) {
      case 'setup':
        this.close();
        this.match = new Match(m.cfg, m.names);
        this.chars = (m.chars || []).map(getChar);
        this.cur = null;
        this._maybeBowl(2000);
        break;
      case 'deliver': {
        // human bowled to the AI
        if (!this.match || m.n !== this.match.seq) return;
        this.cur = m;
        const swing = chooseSwing(m.d, this.level);
        const travel = RUNUP_MS + deliveryTime(m.d.type, this.chars?.[this.match.bowlingSide]);
        const delay = travel + Math.max(0, Math.min(swing.err ?? 250, 250));
        this._later(delay, () => {
          this._emit({ t: 'swing', n: m.n, ...swing });
          this._apply(m, swing);
        });
        break;
      }
      case 'swing':
        // human batted against the AI's delivery
        if (!this.cur || m.n !== this.cur.n) return;
        this._apply(this.cur, m);
        break;
    }
  }

  _apply(del, swing) {
    const mods = matchupMods(this.chars?.[this.match.battingSide], this.chars?.[this.match.bowlingSide]);
    const res = resolveBall(del.d, { shot: swing.shot, err: swing.err }, del.seed, mods);
    const ev = this.match.applyBall(res);
    this.cur = null;
    if (ev === 'match') return;
    this._maybeBowl(ev === 'innings' ? 6200 : 3400);
  }

  _maybeBowl(delay) {
    if (!this.match || this.match.over || this.match.bowlingSide !== this.me) return;
    this._later(delay, () => {
      const d = chooseDelivery(this.level, this.match);
      if (!LINES[d.line] || !DELIVERIES[d.type]) return;
      this.cur = { t: 'deliver', n: this.match.seq, d, seed: newSeed() };
      this._emit(this.cur);
    });
  }
}
