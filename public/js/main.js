import { Match, resolveBall, DELIVERIES, LINES, SHOTS, LATE_WINDOW, oversStr, newSeed, timingLabel, timingTier } from './engine.js';
import { Renderer } from './render.js';
import { Renderer3D, webglAvailable } from './render3d.js';
import { Net } from './net.js';
import { AiPeer, DIFFICULTY } from './ai.js';
import { sfx } from './sound.js';
import { CHARACTERS, STATS, getChar, randomChar, matchupMods, deliveryTime, movement, drawPortrait } from './characters.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['menu', 'lobby', 'game'];
const show = (id) => SCREENS.forEach((s) => $(s).classList.toggle('active', s === id));

let renderer = null;
let rendererKind = null;
let session = null;

// Creates (or swaps) the renderer. A canvas can only ever have one context type,
// so switching between 3D (WebGL) and 2D replaces the <canvas> element.
function ensureRenderer() {
  let kind = $('opt-gfx').value;
  if (kind === '3d' && !webglAvailable()) kind = '2d';
  if (renderer && kind === rendererKind) return renderer;
  renderer?.dispose();
  const fresh = $('canvas').cloneNode();
  $('canvas').replaceWith(fresh);
  try {
    renderer = kind === '3d' ? new Renderer3D(fresh) : new Renderer(fresh);
  } catch (e) {
    console.warn('3D renderer failed, falling back to 2D', e);
    kind = '2d';
    const c2 = $('canvas').cloneNode();
    $('canvas').replaceWith(c2);
    renderer = new Renderer(c2);
  }
  rendererKind = kind;
  return renderer;
}
let net = null;

// ---------------- helpers ----------------
const myName = () => {
  const n = $('name').value.trim().slice(0, 16) || 'Player';
  localStorage.setItem('cricmate.name', n);
  return n;
};
const settings = () => ({ overs: +$('opt-overs').value, wickets: +$('opt-wickets').value, toss: $('opt-toss').value });
const tossToFirstBat = (toss) => (toss === 'host' ? 0 : toss === 'guest' ? 1 : Math.random() < 0.5 ? 0 : 1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setTransportBadge(el, mode) {
  el.textContent = mode === 'p2p' ? 'P2P direct' : mode === 'offline' ? 'Offline' : 'Relay';
  el.className = `badge ${mode}`;
}

function modal(title, html, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  const box = $('modal-actions');
  box.innerHTML = '';
  for (const [label, fn, primary] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = fn;
    box.appendChild(b);
  }
  $('modal').hidden = false;
}
const closeModal = () => ($('modal').hidden = true);

// ---------------- character select ----------------
let myChar = getChar(localStorage.getItem('cricmate.char')).id;

function buildRoster() {
  const box = $('roster');
  for (const ch of CHARACTERS) {
    const b = document.createElement('button');
    b.className = 'char';
    b.dataset.char = ch.id;
    b.style.setProperty('--a', ch.look.accent);
    b.title = `${ch.name} — ${ch.role}`;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    drawPortrait(cv, ch);
    b.append(cv);
    b.insertAdjacentHTML('beforeend', `<b>${esc(ch.nick)}</b><small>${esc(ch.role)}</small>`);
    b.onclick = () => selectChar(ch.id);
    box.appendChild(b);
  }
  selectChar(myChar);
}

function selectChar(id) {
  const ch = getChar(id);
  myChar = ch.id;
  localStorage.setItem('cricmate.char', ch.id);
  document.querySelectorAll('#roster .char').forEach((b) => b.classList.toggle('sel', b.dataset.char === ch.id));
  const d = $('char-detail');
  d.style.setProperty('--a', ch.look.accent);
  const bars = Object.entries(STATS)
    .map(
      ([k, s]) =>
        `<div class="stat" title="${esc(s.hint)}"><span>${s.label}</span><i>${'<em></em>'.repeat(ch.stats[k])}${'<u></u>'.repeat(5 - ch.stats[k])}</i></div>`,
    )
    .join('');
  d.innerHTML = `<canvas width="200" height="200"></canvas><div><h3>#${ch.num} ${esc(ch.name)} <span>“${esc(ch.nick)}”</span></h3><p class="muted small">${esc(ch.role)} · ${esc(ch.bio)}</p><div class="stats">${bars}</div></div>`;
  drawPortrait(d.querySelector('canvas'), ch);
}

// ---------------- controls UI ----------------
const sel = {
  type: localStorage.getItem('cricmate.type') || 'medium',
  line: localStorage.getItem('cricmate.line') || 'off',
};

function buildControls() {
  const typeBox = $('choose-type');
  for (const [k, d] of Object.entries(DELIVERIES)) {
    const b = document.createElement('button');
    b.dataset.type = k;
    b.title = d.hint;
    b.innerHTML = `${d.label}<small>${d.key}</small>`;
    b.onclick = () => selectType(k);
    typeBox.appendChild(b);
  }
  const lineBox = $('choose-line');
  for (const [k, l] of Object.entries(LINES)) {
    const b = document.createElement('button');
    b.dataset.line = k;
    b.innerHTML = `${l.label}<small>${l.key}</small>`;
    b.onclick = () => selectLine(k);
    lineBox.appendChild(b);
  }
  $('btn-bowl').onclick = () => session?.bowl();
  selectType(sel.type);
  selectLine(sel.line);

  const pad = $('shot-pad');
  for (const [k, s] of Object.entries(SHOTS)) {
    const b = document.createElement('button');
    b.dataset.shot = k;
    b.title = s.hint;
    b.innerHTML = `${s.label}<small>${s.keys}</small>`;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      session?.input(k);
    });
    pad.appendChild(b);
  }
}
function selectType(k) {
  sel.type = k;
  localStorage.setItem('cricmate.type', k);
  document.querySelectorAll('#choose-type button').forEach((b) => b.classList.toggle('sel', b.dataset.type === k));
}
function selectLine(k) {
  sel.line = k;
  localStorage.setItem('cricmate.line', k);
  document.querySelectorAll('#choose-line button').forEach((b) => b.classList.toggle('sel', b.dataset.line === k));
}
function showPanel(name, text = '') {
  for (const p of ['bowl', 'bat', 'wait']) $(`panel-${p}`).classList.toggle('active', p === name);
  if (name === 'wait') $('wait-text').textContent = text;
}
function flashShot(shot) {
  const b = document.querySelector(`#shot-pad [data-shot="${shot}"]`);
  if (!b) return;
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 250);
}
let timingTimer = 0;
function showTiming(text) {
  const el = $('timing');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(timingTimer);
  timingTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- game session ----------------
// One class drives both offline (AiPeer) and online (Net) games.
// Flow per ball:  bowler: 'choose' → sends deliver →         'waitSwing' → (swing msg) → result
//                 batter: 'waitBowler' → (deliver msg) → 'incoming' → sends swing → result
// Both sides compute the identical outcome with resolveBall(delivery, swing, seed).
class Session {
  constructor({ peer, me, isHost, names, chars, mode }) {
    Object.assign(this, { peer, me, isHost, names, mode });
    this.charIds = chars || ['sparks', 'sparks'];
    this.queue = [];
    this.phase = 'setup';
    this.match = null;
    this.cur = null;
    this.timers = new Set();
    this.rematchRequested = false;
    peer.onMessage = (m) => {
      this.queue.push(m);
      this.pump();
    };
    setTransportBadge($('game-transport'), mode === 'ai' ? 'offline' : peer.mode);
  }

  get opp() {
    return 1 - this.me;
  }
  get oppName() {
    return this.names[this.opp];
  }

  // ---- characters: both peers derive the same modifiers from the ids in the setup message ----
  charOf(side) {
    return this.chars?.[side] || getChar(this.charIds[side]);
  }
  get batChar() {
    return this.charOf(this.match.battingSide);
  }
  get bowlChar() {
    return this.charOf(this.match.bowlingSide);
  }
  get mods() {
    return matchupMods(this.batChar, this.bowlChar);
  }
  // how long after arrival before an unplayed ball counts as left (covers the widest Edge window)
  get lateMs() {
    return Math.max(LATE_WINDOW, Math.ceil(200 * this.mods.window) + 10);
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }
  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
  destroy() {
    this.clearTimers();
    this.phase = 'ended';
    this.peer.onMessage = () => {};
  }

  // ---- message pump: hold messages until the local state is ready for them ----
  pump() {
    while (this.queue.length) {
      const m = this.queue[0];
      if (!this.accepts(m)) return;
      this.queue.shift();
      this.handle(m);
    }
  }
  accepts(m) {
    if (m.t === 'deliver') return this.phase === 'waitBowler';
    if (m.t === 'swing') return this.phase === 'waitSwing';
    return true;
  }
  handle(m) {
    switch (m.t) {
      case 'setup':
        if (!this.isHost) this.startMatch(m);
        break;
      case 'deliver':
        if (m.n === this.match.seq && DELIVERIES[m.d?.type] && LINES[m.d?.line]) this.onDeliver(m);
        break;
      case 'swing':
        if (this.cur && m.n === this.cur.n) this.onRemoteSwing(m);
        break;
      case 'hello':
        // the guest (re)announces their character; used from the next match on
        if (this.isHost && typeof m.char === 'string') this.charIds[this.opp] = getChar(m.char).id;
        break;
      case 'rematch':
        if (this.isHost) {
          this.rematchRequested = true;
          if (this.match?.over) this.showResult();
        }
        break;
    }
  }

  // ---- match lifecycle ----
  hostStart() {
    const s = settings();
    const firstBat = this.match ? 1 - this.match.cfg.firstBat : tossToFirstBat(s.toss);
    const cfg = { overs: s.overs, wickets: s.wickets, firstBat };
    const msg = { t: 'setup', cfg, names: this.names, chars: this.charIds };
    this.peer.send(msg);
    this.startMatch(msg);
  }

  startMatch(m) {
    this.clearTimers();
    this.queue = this.queue.filter((x) => x.t !== 'deliver' && x.t !== 'swing');
    this.names = m.names;
    this.charIds = [0, 1].map((i) => getChar(m.chars?.[i]).id);
    this.chars = this.charIds.map(getChar);
    this.match = new Match(m.cfg, m.names);
    this.cur = null;
    this.rematchRequested = false;
    closeModal();
    show('game');
    ensureRenderer();
    renderer.reset();
    renderer.setCharacters(this.chars);
    renderer.setTeams(this.match.battingSide);
    renderer.setView(this.match.battingSide === this.me);
    this.hud();
    const batter = this.match.battingSide === this.me ? 'You bat' : `${this.oppName} bats`;
    this.say(`${batter} first · ${m.cfg.overs} over${m.cfg.overs > 1 ? 's' : ''}, ${m.cfg.wickets} wicket${m.cfg.wickets > 1 ? 's' : ''}.`);
    if (!renderer.present) renderer.banner(this.match.battingSide === this.me ? 'YOU BAT' : 'YOU BOWL', '#fff', `${this.chars[0].short} v ${this.chars[1].short}`, 1600);
    this.phase = 'intro';
    showPanel('wait', 'Get ready…');
    this.introduce(1300, false);
  }

  // close-ups of the striker and the bowler (3D only), then play
  introduce(minMs, announce = true) {
    renderer.setTeams(this.match.battingSide);
    const who = (side) => (side === this.me ? 'YOU' : this.names[side].toUpperCase());
    const ms = renderer.present?.(this.batChar, this.bowlChar, [`${who(this.match.battingSide)} · ON STRIKE`, `${who(this.match.bowlingSide)} · TO BOWL`]) || 0;
    if (announce) this.say(`${this.batChar.name} (“${this.batChar.nick}”) faces ${this.bowlChar.name} (“${this.bowlChar.nick}”).`, true);
    this.later(Math.max(minMs, ms), () => this.nextBall());
  }

  nextBall() {
    if (this.match.over) return this.showResult();
    renderer.setTeams(this.match.battingSide);
    renderer.setView(this.match.battingSide === this.me);
    if (this.match.bowlingSide === this.me) {
      this.phase = 'choose';
      showPanel('bowl');
    } else {
      this.phase = 'waitBowler';
      showPanel('bat');
      $('shot-pad').classList.remove('live');
      this.say(`${this.bowlChar.short} is running in…`, true);
    }
    this.pump();
  }

  // ---- bowling ----
  bowl() {
    if (this.phase !== 'choose') return;
    sfx.unlock();
    const m = { t: 'deliver', n: this.match.seq, d: { type: sel.type, line: sel.line }, seed: newSeed() };
    this.peer.send(m);
    this.onDeliver(m);
  }

  onDeliver(m) {
    this.cur = { n: m.n, d: m.d, seed: m.seed };
    const time = deliveryTime(m.d.type, this.bowlChar);
    this.cur.t = renderer.playDelivery(m.d, m.seed, { time, move: movement(this.bowlChar) });
    this.later(this.cur.t.release + time * DELIVERIES[m.d.type].pitch - performance.now(), () => sfx.thud());
    if (this.match.battingSide === this.me) {
      this.phase = 'incoming';
      showPanel('bat');
      $('shot-pad').classList.add('live');
      this.later(this.cur.t.arrive + this.lateMs - performance.now(), () => this.leave());
    } else {
      this.phase = 'waitSwing';
      showPanel('wait', `${DELIVERIES[m.d.type].label}, ${LINES[m.d.line].label.toLowerCase()} line — ${this.oppName} to face…`);
      this.pump();
    }
  }

  // ---- batting ----
  input(shot) {
    sfx.unlock();
    if (this.phase !== 'incoming') return;
    const now = performance.now();
    if (now < this.cur.t.release) return; // ignore presses during the run-up
    flashShot(shot);
    this.commitSwing({ shot, err: Math.round(now - this.cur.t.arrive) }, now);
  }

  leave() {
    if (this.phase === 'incoming') this.commitSwing({ shot: 'leave', err: null });
  }

  commitSwing(sw, at = performance.now()) {
    this.phase = 'resolving';
    $('shot-pad').classList.remove('live');
    if (sw.shot !== 'leave') renderer.swing(sw.shot, at);
    this.peer.send({ t: 'swing', n: this.cur.n, shot: sw.shot, err: sw.err });
    showTiming(timingLabel(sw.err, this.mods.window));
    this.resolve(sw);
  }

  onRemoteSwing(m) {
    this.phase = 'resolving';
    const sw = { shot: m.shot, err: Number.isFinite(m.err) ? Math.round(m.err) : null };
    if (sw.shot !== 'leave') {
      const at = this.cur.t.arrive + (sw.err ?? 0);
      this.later(at - performance.now(), () => renderer.swing(sw.shot));
    }
    this.resolve(sw);
  }

  resolve(sw) {
    const mods = this.mods;
    const res = resolveBall(this.cur.d, sw, this.cur.seed, mods);
    const contact = res.kind === 'hit' ? this.cur.t.arrive + Math.max(0, Math.min(sw.err ?? 0, this.lateMs)) : this.cur.t.arrive;
    this.later(contact - performance.now(), async () => {
      if (res.kind === 'hit') sfx.bat(timingTier(sw.err, mods.window) === 0 ? 1.3 : 1);
      if (res.out === 'bowled') this.later(120, () => sfx.stumps());
      await renderer.playResult(res);
      if (this.phase === 'ended') return;
      const iBat = this.match.battingSide === this.me;
      if (res.out) iBat ? sfx.groan() : sfx.cheer();
      else if (res.runs >= 4) iBat ? sfx.cheer(res.runs === 6) : sfx.groan();
      this.afterBall(res);
    });
  }

  afterBall(res) {
    const ev = this.match.applyBall(res);
    this.cur = null;
    this.hud();
    this.say(res.text);
    if (ev === 'innings') {
      const t = this.match.target;
      renderer.banner('INNINGS BREAK', '#fff', `Target ${t}`, 2400);
      this.say(`${this.names[this.match.battingSide]} need ${t} to win from ${this.match.cfg.overs * 6} balls.`);
      this.phase = 'break';
      showPanel('wait', 'Innings break…');
      this.later(2600, () => this.introduce(0));
    } else if (ev === 'match') {
      this.phase = 'over';
      this.later(900, () => this.showResult());
    } else {
      this.later(400, () => this.nextBall());
    }
  }

  // ---- UI ----
  say(text, quiet = false) {
    const el = $('commentary');
    el.textContent = text;
    el.style.opacity = quiet ? 0.7 : 1;
  }

  hud() {
    const m = this.match;
    for (const side of [0, 1]) {
      const el = $(`team-${side}`);
      const inn = m.innings.find((i) => i.bat === side);
      el.querySelector('.tname').textContent = this.names[side] + (side === this.me ? ' (you)' : '');
      el.querySelector('.tchar').textContent = this.charOf(side).nick;
      el.querySelector('.tchar').style.color = this.charOf(side).look.accent;
      el.querySelector('.tscore').textContent = inn ? `${inn.runs}/${inn.wkts}  (${oversStr(inn.balls)})` : 'yet to bat';
      el.classList.toggle('batting', m.battingSide === side && !m.over);
    }
    const inn = m.inn;
    let eq = `${m.cfg.overs} ov · ${m.cfg.wickets} wkt`;
    if (m.target && !m.over) {
      const need = m.target - inn.runs;
      eq = `Need ${need} off ${m.ballsLeft} ball${m.ballsLeft === 1 ? '' : 's'}`;
    }
    $('equation').textContent = eq;
    $('this-over').innerHTML = inn.thisOver.map((s) => `<span class="b${s}">${s === '0' ? '•' : s}</span>`).join('');
  }

  showResult() {
    const m = this.match;
    if (!m?.result) return;
    const r = m.result;
    const title = r.winner == null ? 'Match tied!' : r.winner === this.me ? '🏆 You win!' : `${this.oppName} wins`;
    const rows = m.innings
      .map(
        (i) =>
          `<tr><td><span class="dot t${i.bat}" style="display:inline-block"></span> ${esc(this.names[i.bat])} <span class="muted small">· ${esc(this.charOf(i.bat).name)}</span></td><td>${i.runs}/${i.wkts} (${oversStr(i.balls)}) · 4s ${i.fours} · 6s ${i.sixes}</td></tr>`,
      )
      .join('');
    let note = '';
    if (!this.isHost) note = `<p class="muted small">${esc(this.oppName)} (host) starts the rematch.</p>`;
    else if (this.rematchRequested) note = `<p class="status">${esc(this.oppName)} wants a rematch!</p>`;
    const actions = [];
    if (this.isHost) actions.push(['Play again', () => this.hostStart(), true]);
    else
      actions.push([
        'Ask for rematch',
        (e) => {
          this.peer.send({ t: 'rematch' });
          e.target.disabled = true;
          e.target.textContent = 'Asked ✓';
        },
        true,
      ]);
    actions.push(['Main menu', () => quitToMenu()]);
    modal(title, `<p>${esc(r.text)}</p><table class="scorecard">${rows}</table>${note}`, actions);
    showPanel('wait', 'Match over');
  }

  peerLeft() {
    this.destroy();
    modal('Opponent left', `<p>${esc(this.oppName)} disconnected.</p>`, [['Main menu', () => quitToMenu(), true]]);
  }
}

// ---------------- menu actions ----------------
function quitToMenu() {
  session?.destroy();
  session?.peer.close?.();
  session = null;
  net?.close();
  net = null;
  closeModal();
  renderer?.reset();
  show('menu');
}

$('btn-ai').onclick = () => {
  sfx.unlock();
  const level = $('opt-diff').value;
  const ai = new AiPeer(level);
  const cpu = randomChar(myChar);
  session = new Session({ peer: ai, me: 0, isHost: true, names: [myName(), `CPU (${DIFFICULTY[level].label})`], chars: [myChar, cpu.id], mode: 'ai' });
  session.hostStart();
};

function netStatus(text) {
  $('net-status').textContent = text;
}

function wireNet() {
  // before a host's Session exists, the only message that matters is the guest's character
  net.onMessage = (m) => {
    if (m?.t !== 'hello') return;
    lobbyChar = getChar(m.char).id;
    if (lobbyPeer) $('lobby-status').textContent = `${lobbyPeer} joined as ${getChar(lobbyChar).name}! Ready when you are.`;
  };
  net.onEvent = (type, data) => {
    if (type === 'transport') {
      setTransportBadge($('lobby-transport'), data);
      if (session) setTransportBadge($('game-transport'), data);
    } else if (type === 'peer-joined') {
      lobbyPeer = data;
      $('lobby-status').textContent = `${data} joined! Ready when you are.`;
      $('btn-start').disabled = false;
      sfx.click();
    } else if (type === 'peer-left') {
      if (session && session.phase !== 'setup') {
        session.peerLeft();
        return;
      }
      if (net.role === 'host') {
        lobbyPeer = null;
        lobbyChar = 'sparks';
        session?.destroy();
        session = null;
        $('btn-start').disabled = true;
        $('lobby-status').textContent = 'Opponent left. Waiting for someone to join…';
        show('lobby');
      } else {
        quitToMenu();
        netStatus('The host closed the room.');
      }
    } else if (type === 'closed') {
      if (session) session.peerLeft();
      else {
        quitToMenu();
        netStatus('Lost connection to the server.');
      }
    } else if (type === 'error') {
      netStatus(data);
    }
  };
}

let lobbyPeer = null;
let lobbyChar = 'sparks';

$('btn-host').onclick = async () => {
  sfx.unlock();
  netStatus('Connecting…');
  net = new Net();
  try {
    await net.connect();
    wireNet();
    const code = await net.create(myName());
    netStatus('');
    lobbyPeer = null;
    lobbyChar = 'sparks';
    $('lobby-code').textContent = code;
    $('lobby-host-info').hidden = false;
    $('btn-start').hidden = false;
    $('btn-start').disabled = true;
    $('lobby-status').textContent = 'Waiting for your opponent to join…';
    setTransportBadge($('lobby-transport'), 'relay');
    show('lobby');
    fillLinks(code);
  } catch (e) {
    net?.close();
    net = null;
    netStatus(e.message);
  }
};

async function fillLinks(code) {
  const ul = $('lobby-links');
  ul.innerHTML = '';
  const add = (label, url) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="lbl">${esc(label)}</span><code>${esc(url)}</code>`;
    const b = document.createElement('button');
    b.textContent = 'Copy';
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        b.textContent = 'Copied ✓';
      } catch {
        b.textContent = 'Select & copy';
      }
    };
    li.appendChild(b);
    ul.appendChild(li);
  };
  const here = `${location.origin}${location.pathname}?room=${code}`;
  let info = { lan: [], publicUrl: null };
  try {
    info = await (await fetch('/api/info', { cache: 'no-store' })).json();
  } catch {
    /* ignore */
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (info.publicUrl) add('Online', `${info.publicUrl}/?room=${code}`);
  if (!isLocal && !(info.publicUrl && here.startsWith(info.publicUrl))) add('This URL', here);
  for (const u of info.lan) add('LAN', `${u}/?room=${code}`);
  if (!info.publicUrl) {
    const li = document.createElement('li');
    const port = location.port || (location.protocol === 'https:' ? 443 : 80);
    li.innerHTML = `<span class="muted small">For online play run <code>npm run online</code> or <code>ngrok http ${port}</code> on the host, then host a new room.</span>`;
    ul.appendChild(li);
  }
}

$('btn-start').onclick = () => {
  if (!net || !lobbyPeer) return;
  session = new Session({ peer: net, me: 0, isHost: true, names: [myName(), lobbyPeer], chars: [myChar, lobbyChar], mode: 'net' });
  session.hostStart();
};

async function joinRoom(code) {
  code = code.trim().toUpperCase();
  if (code.length !== 4) {
    netStatus('Enter the 4-letter room code.');
    return;
  }
  sfx.unlock();
  netStatus('Connecting…');
  net = new Net();
  try {
    await net.connect();
    wireNet();
    const res = await net.join(code, myName());
    netStatus('');
    $('lobby-code').textContent = res.code;
    $('lobby-host-info').hidden = true;
    $('btn-start').hidden = true;
    $('lobby-status').textContent = `Joined ${res.peerName}'s room. Waiting for the host to start…`;
    setTransportBadge($('lobby-transport'), 'relay');
    show('lobby');
    session = new Session({ peer: net, me: 1, isHost: false, names: [res.peerName, myName()], chars: ['sparks', myChar], mode: 'net' });
    net.send({ t: 'hello', char: myChar });
  } catch (e) {
    net?.close();
    net = null;
    netStatus(e.message);
  }
}

$('btn-join').onclick = () => joinRoom($('join-code').value);
$('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom(e.target.value));
$('btn-leave-lobby').onclick = () => quitToMenu();
$('btn-quit').onclick = () => {
  if (session?.match?.over || confirm('Quit this match?')) quitToMenu();
};

// ---------------- keyboard ----------------
const SHOT_KEYS = { ArrowLeft: 'pull', KeyA: 'pull', ArrowUp: 'drive', KeyW: 'drive', ArrowRight: 'cut', KeyD: 'cut', ArrowDown: 'defend', KeyS: 'defend', Space: 'loft' };
const TYPE_KEYS = Object.fromEntries(Object.entries(DELIVERIES).map(([k, d]) => [`Digit${d.key}`, k]));
const LINE_KEYS = Object.fromEntries(Object.entries(LINES).map(([k, l]) => [`Key${l.key}`, k]));

document.addEventListener('keydown', (e) => {
  if (!session || !$('game').classList.contains('active') || e.target.matches('input, select, textarea')) return;
  // keep Space/Enter from also "clicking" whichever button has focus
  if (document.activeElement instanceof HTMLButtonElement && $('modal').hidden) document.activeElement.blur();
  if (session.match?.bowlingSide === session.me) {
    if (TYPE_KEYS[e.code]) selectType(TYPE_KEYS[e.code]);
    else if (LINE_KEYS[e.code]) selectLine(LINE_KEYS[e.code]);
    else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      session.bowl();
    }
    return;
  }
  if (SHOT_KEYS[e.code]) {
    e.preventDefault();
    if (!e.repeat) session.input(SHOT_KEYS[e.code]);
  }
});

// ---------------- boot ----------------
buildControls();
buildRoster();
$('name').value = localStorage.getItem('cricmate.name') || '';
$('opt-gfx').value = localStorage.getItem('cricmate.gfx') || (webglAvailable() ? '3d' : '2d');
$('opt-gfx').onchange = (e) => localStorage.setItem('cricmate.gfx', e.target.value);
const muteBtn = $('btn-mute');
const paintMute = () => (muteBtn.textContent = sfx.muted ? '🔇 Sound off' : '🔊 Sound on');
muteBtn.onclick = () => {
  sfx.toggle();
  paintMute();
};
paintMute();

const paintOnline = () => {
  $('offline-badge').textContent = navigator.onLine ? 'Online' : 'Offline — CPU & LAN still work';
};
window.addEventListener('online', paintOnline);
window.addEventListener('offline', paintOnline);
paintOnline();

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $('join-code').value = roomParam.toUpperCase();
  netStatus('Enter your name and press Join.');
  $('name').focus();
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
