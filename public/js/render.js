// Canvas renderer: top-down ground with a zooming camera.
// World units: 640 x 760. Bowler at the top, batter at the bottom, facing up.
// Screen +x is the off side for the (right-handed) batter.
import { DELIVERIES, LINES, RUNUP_MS, mulberry32 } from './engine.js';

const W = 640;
const H = 760;
const CX = 320;
const CY = 380;
const RX = 300;
const RY = 360;
const PITCH_TOP = 250; // bowling crease
const PITCH_BOT = 510; // batting crease
const STUMPS_TOP = 232;
const STUMPS_BOT = 528;
const KEEPER_Y = 592;
const HOLD_P = 1.07; // ball waits here until the outcome is known

const FIELD = [
  { x: CX + 2, y: KEEPER_Y, keeper: true },
  { x: CX + 44, y: 572 }, // slip
  { x: CX + 175, y: 485 }, // point
  { x: CX + 165, y: 300 }, // cover
  { x: CX + 70, y: 150 }, // mid-off
  { x: CX - 70, y: 150 }, // mid-on
  { x: CX - 170, y: 320 }, // mid-wicket
  { x: CX - 195, y: 500 }, // square leg
  { x: CX - 120, y: 665 }, // fine leg
  { x: CX + 150, y: 668 }, // third man
];

export const TEAM_COLORS = ['#3b82f6', '#ef4444'];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - (1 - t) * (1 - t);

function boundaryDist(x0, y0, dx, dy) {
  const ax = dx / RX;
  const ay = dy / RY;
  const bx = (x0 - CX) / RX;
  const by = (y0 - CY) / RY;
  const A = ax * ax + ay * ay;
  const B = 2 * (ax * bx + ay * by);
  const C = bx * bx + by * by - 1;
  return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: CX, y: CY, z: 1 };
    this.camTarget = { x: CX, y: CY, z: 1 };
    this.batColor = TEAM_COLORS[0];
    this.bowlColor = TEAM_COLORS[1];
    this.fielders = FIELD.map((f) => ({ ...f, hx: f.x, hy: f.y, tx: f.x, ty: f.y, speed: 160 }));
    const rng = mulberry32(42);
    this.crowd = [];
    while (this.crowd.length < 900) {
      const x = -520 + rng() * (W + 1040);
      const y = -160 + rng() * (H + 320);
      const e = ((x - CX) / (RX + 18)) ** 2 + ((y - CY) / (RY + 18)) ** 2;
      if (e > 1) this.crowd.push({ x, y, c: `hsl(${Math.floor(rng() * 360)},55%,${45 + rng() * 25}%)`, p: rng() * 6.28 });
    }
    this.reset();
    this._resize();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(canvas);
    const loop = (t) => {
      this._frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  setView() {}
  setCharacters() {}

  setTeams(batSide) {
    this.batColor = TEAM_COLORS[batSide];
    this.bowlColor = TEAM_COLORS[1 - batSide];
  }

  reset() {
    this.del = null;
    this.hit = null;
    this.bat = null;
    this.banners = [];
    this.floats = [];
    this.stumpsHit = 0;
    this.bowler = { x: CX + 8, y: 110 };
    this.camTarget = { x: CX, y: CY, z: 1 };
    for (const f of this.fielders) {
      f.tx = f.hx;
      f.ty = f.hy;
      f.speed = 260;
    }
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.cw = Math.max(1, r.width);
    this.ch = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.dpr = dpr;
  }

  // ---------- public API used by the session ----------

  playDelivery(d, seed, { time, move = 1, startAt = performance.now() } = {}) {
    const spec = { ...DELIVERIES[d.type] };
    if (time) spec.time = time;
    const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const release = startAt + RUNUP_MS;
    const arrive = release + spec.time;
    const endX = CX + LINES[d.line].x;
    this.reset();
    this.del = {
      d,
      spec,
      start: startAt,
      release,
      arrive,
      startX: CX + 7,
      endX,
      turn: spec.drift ? (rng() < 0.5 ? -1 : 1) * 24 * move : 0,
      swing: spec.swing ? (rng() < 0.5 ? -1 : 1) * spec.swing * 14 * move : 0,
      miss: null,
    };
    this.camTarget = { x: CX, y: 405, z: 1.75 };
    return { release, arrive };
  }

  swing(shot, at = performance.now()) {
    this.bat = { shot, at };
  }

  banner(text, color = '#fff', sub = '', ms = 1600) {
    this.banners.push({ text, color, sub, start: performance.now(), ms });
  }

  float(text, color = '#fff') {
    this.floats.push({ text, color, start: performance.now() });
  }

  // Animate the outcome of the current ball. Resolves when it's done.
  playResult(res, rng = Math.random) {
    const now = performance.now();
    const del = this.del;
    if (!del) return Promise.resolve();

    if (res.kind !== 'hit') {
      const stopY = res.out === 'bowled' ? STUMPS_BOT - 2 : res.out === 'lbw' ? PITCH_BOT + 4 : KEEPER_Y - 6;
      const p0 = this._progress(now);
      const stopP = (stopY - PITCH_TOP) / (PITCH_BOT - PITCH_TOP);
      del.miss = { at: now, p0: Math.min(p0, stopP), stopP, res };
      const travel = Math.max(0, ((stopP - Math.min(p0, stopP)) * del.spec.time) / 1);
      return new Promise((done) =>
        setTimeout(() => {
          if (res.out === 'bowled') this.stumpsHit = performance.now();
          if (res.out) this.banner('OUT!', '#ff5a5a', res.out.toUpperCase(), 1800);
          setTimeout(done, res.out ? 1500 : 650);
        }, travel),
      );
    }

    const b = this._ballPos(now) || { x: del.endX, y: PITCH_BOT };
    const x0 = b.x;
    const y0 = Math.min(b.y, PITCH_BOT + 6);
    const dx = Math.sin(res.angle);
    const dy = -Math.cos(res.angle);
    const B = boundaryDist(x0, y0, dx, dy);
    let dist;
    if (res.out === 'caught behind') dist = Math.hypot(this.fielders[1].hx - x0, this.fielders[1].hy - y0);
    else if (res.out) dist = B * (0.6 + rng() * 0.2);
    else if (res.runs === 6) dist = B * 1.13;
    else if (res.runs === 4) dist = B * 0.985;
    else if (res.runs === 3) dist = B * 0.84;
    else if (res.runs === 2) dist = B * 0.66;
    else if (res.runs === 1) dist = B * 0.42;
    else dist = res.shot === 'defend' ? 22 + rng() * 26 : Math.min(B * 0.38, 150);

    const aerial = res.aerial || res.runs === 6;
    const dur = aerial ? 650 + dist * 2.3 : 350 + dist * 2.7;
    const x1 = x0 + dx * dist;
    const y1 = y0 + dy * dist;
    const peak = res.runs === 6 ? 150 : res.out ? 95 : aerial ? 70 : 0;
    this.hit = { start: now, dur, x0, y0, x1, y1, peak, aerial, res };
    this.camTarget = { x: CX, y: CY, z: 1 };

    // the nearest fielder chases the ball (or settles under the catch)
    let best = null;
    let bestD = Infinity;
    for (const f of this.fielders) {
      if (f.keeper && res.out !== 'caught behind') continue;
      const dd = Math.hypot(f.hx - x1, f.hy - y1);
      if (dd < bestD) {
        bestD = dd;
        best = f;
      }
    }
    if (best && res.shot !== 'defend') {
      const reach = res.out ? 1 : res.runs >= 4 ? 0.75 : 1;
      best.tx = lerp(best.hx, x1, reach);
      best.ty = lerp(best.hy, y1, reach);
      best.speed = res.out ? Math.max(60, bestD / (dur / 1000)) : 175;
    }

    return new Promise((done) =>
      setTimeout(() => {
        if (res.out) this.banner('OUT!', '#ff5a5a', res.out.toUpperCase(), 1800);
        else if (res.runs === 6) this.banner('SIX!', '#c084fc', '', 1700);
        else if (res.runs === 4) this.banner('FOUR!', '#facc15', '', 1500);
        else if (res.runs > 0) this.float(`+${res.runs}`, '#fff');
        else this.float('•', '#ddd');
        setTimeout(done, res.out || res.runs >= 4 ? 1400 : 650);
      }, dur),
    );
  }

  // ---------- simulation ----------

  _progress(t) {
    const del = this.del;
    if (!del || t < del.release) return -1;
    if (del.miss) {
      const p = del.miss.p0 + (t - del.miss.at) / del.spec.time;
      return Math.min(p, del.miss.stopP);
    }
    if (this.hit) return 1;
    return Math.min((t - del.release) / (del.arrive - del.release), HOLD_P);
  }

  _ballPos(t) {
    const del = this.del;
    const p = this._progress(t);
    if (p < 0) return null;
    const f = del.spec.pitch;
    const bounceX = del.endX - del.turn;
    let x;
    let z;
    if (p < f) {
      const q = p / f;
      x = lerp(del.startX, bounceX, q) + del.swing * Math.sin(Math.PI * q);
      z = 40 * (1 - q) + 10 * Math.sin(Math.PI * q);
    } else {
      const q = (p - f) / (1 - f);
      x = lerp(bounceX, del.endX, q);
      z = 34 * del.spec.height * Math.sin(Math.min(q, 1) * Math.PI * 0.5);
      if (q > 1) x += (q - 1) * (del.endX - bounceX) * 0.5;
    }
    const y = PITCH_TOP + p * (PITCH_BOT - PITCH_TOP);
    if (del.miss && p >= del.miss.stopP && del.miss.res.out === 'lbw') z = 0;
    return { x, y, z };
  }

  _frame(t) {
    const dt = Math.min(0.05, (t - (this._last || t)) / 1000);
    this._last = t;

    // camera
    const k = 1 - Math.pow(0.002, dt);
    this.cam.x = lerp(this.cam.x, this.camTarget.x, k);
    this.cam.y = lerp(this.cam.y, this.camTarget.y, k);
    this.cam.z = lerp(this.cam.z, this.camTarget.z, k);

    // bowler run-up
    const del = this.del;
    if (del) {
      const now = performance.now();
      if (now < del.release) {
        const q = clamp((now - del.start) / RUNUP_MS, 0, 1);
        this.bowler.y = lerp(110, PITCH_TOP - 8, q);
      } else {
        const q = clamp((now - del.release) / 500, 0, 1);
        this.bowler.y = lerp(PITCH_TOP - 8, PITCH_TOP + 28, easeOut(q));
        this.bowler.x = lerp(CX + 8, CX + 26, easeOut(q));
      }
    }

    // fielders
    for (const f of this.fielders) {
      const dx = f.tx - f.x;
      const dy = f.ty - f.y;
      const d = Math.hypot(dx, dy);
      const step = f.speed * dt;
      if (d > step) {
        f.x += (dx / d) * step;
        f.y += (dy / d) * step;
      } else {
        f.x = f.tx;
        f.y = f.ty;
      }
    }
    this._draw(performance.now());
  }

  // ---------- drawing ----------

  _draw(now) {
    const { ctx, cam } = this;
    const s = Math.min(this.cw / W, this.ch / H) * cam.z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#16241a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(
      this.dpr * s,
      0,
      0,
      this.dpr * s,
      this.dpr * (this.cw / 2 - cam.x * s),
      this.dpr * (this.ch / 2 - cam.y * s),
    );

    this._drawCrowd(now);
    this._drawGround();
    this._drawStumps(STUMPS_TOP, 0);
    this._drawStumps(STUMPS_BOT, this.stumpsHit ? now - this.stumpsHit : 0);

    // hit zone hint while the ball is coming
    if (this.del && !this.hit && !this.del.miss && now > this.del.release) {
      const a = 0.18 + 0.1 * Math.sin(now / 90);
      ctx.fillStyle = `rgba(255,255,140,${a})`;
      ctx.fillRect(CX - 24, PITCH_BOT - 7, 48, 14);
    }

    for (const f of this.fielders) this._person(f.x, f.y, this.bowlColor, f.keeper ? 8.5 : 8);
    this._person(this.bowler.x, this.bowler.y, this.bowlColor, 8.5);
    this._person(CX - 22, PITCH_TOP - 6, this.batColor, 8); // non-striker
    this._drawBatter(now);
    this._drawBall(now);

    // screen-space overlays
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawBanners(now);
  }

  _drawCrowd(now) {
    const { ctx } = this;
    ctx.fillStyle = '#223527';
    ctx.fillRect(-600, -200, W + 1200, H + 400);
    const cheer = this.banners.some((b) => now - b.start < b.ms && b.text !== 'OUT!');
    for (const c of this.crowd) {
      const bob = cheer ? Math.sin(now / 70 + c.p) * 2.2 : 0;
      ctx.fillStyle = c.c;
      ctx.fillRect(c.x, c.y + bob, 5, 5);
    }
  }

  _drawGround() {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(CX, CY, RX + 14, RY + 14, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#2c7a34';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(CX, CY, RX, RY, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#35963f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2f8a39';
    for (let y = 0; y < H; y += 56) ctx.fillRect(0, y, W, 28);
    ctx.restore();

    // boundary rope & inner circle
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(CX, CY, RX, RY, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(CX, CY, 170, 210, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // pitch
    ctx.fillStyle = '#d9c48c';
    ctx.fillRect(CX - 24, STUMPS_TOP - 14, 48, STUMPS_BOT - STUMPS_TOP + 28);
    ctx.fillStyle = 'rgba(160,130,70,0.35)';
    ctx.fillRect(CX - 10, PITCH_TOP + 60, 20, PITCH_BOT - PITCH_TOP - 120);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    for (const y of [PITCH_TOP, PITCH_BOT]) {
      ctx.beginPath();
      ctx.moveTo(CX - 30, y);
      ctx.lineTo(CX + 30, y);
      ctx.stroke();
    }
    for (const y of [STUMPS_TOP, STUMPS_BOT]) {
      ctx.beginPath();
      ctx.moveTo(CX - 15, y);
      ctx.lineTo(CX + 15, y);
      ctx.moveTo(CX - 15, y - 6);
      ctx.lineTo(CX - 15, y + 6);
      ctx.moveTo(CX + 15, y - 6);
      ctx.lineTo(CX + 15, y + 6);
      ctx.stroke();
    }
  }

  _drawStumps(y, hitAge) {
    const { ctx } = this;
    const k = hitAge ? Math.min(hitAge / 400, 1) : 0;
    ctx.fillStyle = '#f5e6c8';
    for (const i of [-1, 0, 1]) {
      const ox = i * 4 + i * k * 6;
      const oy = k * (8 + Math.abs(i) * 3);
      ctx.fillRect(CX + ox - 1.2, y + oy - 1.6, 2.4, 3.2);
    }
    if (hitAge) {
      // bails flying
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(CX - 8 - k * 18, y + k * 26, 5, 1.6);
      ctx.fillRect(CX + 3 + k * 16, y + k * 30, 5, 1.6);
    } else {
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(CX - 5, y - 0.6, 10, 1.2);
    }
  }

  _person(x, y, color, r) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 3, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f1c9a5';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawBatter(now) {
    const { ctx } = this;
    const bx = CX - 13;
    const by = PITCH_BOT + 5;
    this._person(bx, by, this.batColor, 8.5);
    const hx = bx + 6;
    const hy = by - 2;
    // bat angle: 0 = pointing up the pitch, + = clockwise
    let ang = 2.5;
    if (this.bat) {
      const ends = { drive: [2.9, -0.3], cut: [2.9, 1.0], pull: [2.6, -2.0], loft: [3.4, -0.9], defend: [2.6, 0.2] };
      const [a0, a1] = ends[this.bat.shot] || [2.5, 2.5];
      const q = clamp((now - (this.bat.at - 110)) / 220, 0, 1);
      ang = lerp(a0, a1, easeOut(q));
    }
    const len = 20;
    ctx.strokeStyle = '#8b5a2b';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx + Math.sin(ang) * len, hy - Math.cos(ang) * len);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _drawBall(now) {
    const { ctx } = this;
    let pos = null;
    if (this.hit) {
      const h = this.hit;
      const q = clamp((now - h.start) / h.dur, 0, 1);
      const e = h.aerial ? q : easeOut(q);
      pos = { x: lerp(h.x0, h.x1, e), y: lerp(h.y0, h.y1, e), z: 4 * h.peak * q * (1 - q) };
      if (h.res.out && q >= 1) {
        // caught: ball sits with the fielder
        const f = this.fielders.reduce((a, b) => (Math.hypot(a.x - h.x1, a.y - h.y1) < Math.hypot(b.x - h.x1, b.y - h.y1) ? a : b));
        pos = { x: f.x + 4, y: f.y - 2, z: 4 };
      }
    } else if (this.del) {
      pos = this._ballPos(now);
    }
    if (!pos) return;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(pos.x + pos.z * 0.15, pos.y + pos.z * 0.1, 3, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    const r = 3.2 + pos.z * 0.03;
    ctx.fillStyle = '#d62828';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y - pos.z * 0.55, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(pos.x - r * 0.35, pos.y - pos.z * 0.55 - r * 0.35, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawBanners(now) {
    const { ctx } = this;
    this.banners = this.banners.filter((b) => now - b.start < b.ms);
    for (const b of this.banners) {
      const q = (now - b.start) / b.ms;
      const scale = q < 0.15 ? 0.6 + (q / 0.15) * 0.4 : 1;
      const alpha = q > 0.75 ? (1 - q) / 0.25 : 1;
      const size = Math.min(this.cw, 700) * 0.14 * scale;
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.font = `900 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = size * 0.08;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(b.text, this.cw / 2, this.ch * 0.32);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, this.cw / 2, this.ch * 0.32);
      if (b.sub) {
        ctx.font = `700 ${size * 0.32}px system-ui, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(b.sub, this.cw / 2, this.ch * 0.32 + size * 0.5);
      }
      ctx.globalAlpha = 1;
    }
    this.floats = this.floats.filter((f) => now - f.start < 1000);
    for (const f of this.floats) {
      const q = (now - f.start) / 1000;
      ctx.globalAlpha = 1 - q;
      ctx.textAlign = 'center';
      ctx.font = `800 ${Math.min(this.cw, 700) * 0.08}px system-ui, sans-serif`;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, this.cw / 2, this.ch * 0.4 - q * 40);
      ctx.globalAlpha = 1;
    }
  }
}
