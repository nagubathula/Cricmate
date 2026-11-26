// 3D renderer (Three.js). Same public API as the 2D Renderer in render.js:
//   reset(), setTeams(batSide), setView(iAmBatting), playDelivery(d, seed) → {release, arrive},
//   swing(shot, at), playResult(res) → Promise, banner(text, color, sub, ms), float(text, color), dispose()
//
// World units are metres. Origin = middle of the pitch. The batter is at +z facing -z (toward
// the bowler). +x is the batter's off side (a right-hander), matching the engine's shot angles.
import * as THREE from 'three';
import { DELIVERIES, LINES, RUNUP_MS, mulberry32 } from './engine.js';

export const TEAM_COLORS = ['#3b82f6', '#ef4444'];
const TEAM_DARK = ['#1e3a8a', '#7f1d1d'];

const STUMPS_Z = 10.06;
const CREASE_Z = 8.84;
const RELEASE = new THREE.Vector3(-0.32, 2.15, -8.7);
const BAT_Z = CREASE_Z + 0.35; // where bat meets ball
const KEEPER_Z = 15.2;
const BALL_R = 0.075; // drawn a bit larger than life so it reads on screen
const RX = 62; // boundary ellipse radii
const RZ = 70;
const HOLD_P = 1.035; // ball waits here (just short of the stumps) until the outcome is known

const FIELD = [
  { x: 0.1, z: KEEPER_Z, keeper: true },
  { x: 1.6, z: 16.2 }, // slip
  { x: 24, z: 9 }, // point
  { x: 27, z: -10 }, // cover
  { x: 11, z: -30 }, // mid-off
  { x: -11, z: -30 }, // mid-on
  { x: -28, z: -6 }, // mid-wicket
  { x: -27, z: 11 }, // square leg
  { x: -22, z: 44 }, // fine leg
  { x: 24, z: 46 }, // third man
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - (1 - t) * (1 - t);

function boundaryDist(x0, z0, dx, dz) {
  const A = (dx / RX) ** 2 + (dz / RZ) ** 2;
  const B = 2 * ((dx * x0) / RX ** 2 + (dz * z0) / RZ ** 2);
  const C = (x0 / RX) ** 2 + (z0 / RZ) ** 2 - 1;
  return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ---------------- procedural textures ----------------
function canvasTex(w, h, draw, { repeat = null } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

function grassTexture() {
  // mowing stripes across the field (texture spans the whole field disc)
  return canvasTex(1024, 1024, (g, w, h) => {
    const rng = mulberry32(7);
    for (let i = 0; i < 16; i++) {
      g.fillStyle = i % 2 ? '#3f9a45' : '#47a84c';
      g.fillRect(0, (i * h) / 16, w, h / 16 + 1);
    }
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${rng() < 0.5 ? '20,70,25' : '120,190,110'},${0.08 + rng() * 0.08})`;
      g.fillRect(rng() * w, rng() * h, 2, 2);
    }
  });
}

function pitchTexture() {
  const PX = 64; // pixels per metre
  const W = 3.05;
  const L = 24;
  return canvasTex(W * PX, L * PX, (g, w, h) => {
    const rng = mulberry32(11);
    g.fillStyle = '#d6c08a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = `rgba(${rng() < 0.5 ? '150,120,70' : '240,225,180'},${0.12 + rng() * 0.15})`;
      g.fillRect(rng() * w, rng() * h, 2 + rng() * 3, 2 + rng() * 3);
    }
    // worn patches where bowlers land the ball
    g.fillStyle = 'rgba(150,115,65,0.25)';
    for (const z of [-5, 5]) {
      g.beginPath();
      g.ellipse(w / 2, h / 2 + z * PX, 0.6 * PX, 2.2 * PX, 0, 0, Math.PI * 2);
      g.fill();
    }
    const X = (x) => w / 2 + x * PX;
    const Z = (z) => h / 2 + z * PX;
    g.fillStyle = '#fff';
    const line = (x0, z0, x1, z1) => g.fillRect(X(x0), Z(z0), Math.max(3, (x1 - x0) * PX), Math.max(3, (z1 - z0) * PX));
    for (const s of [-1, 1]) {
      line(-1.52, s * CREASE_Z - 0.025, 1.52, s * CREASE_Z + 0.025); // popping crease
      line(-1.32, s * STUMPS_Z - 0.025, 1.32, s * STUMPS_Z + 0.025); // bowling crease
      const zA = Math.min(s * CREASE_Z, s * (STUMPS_Z + 1.2));
      const zB = Math.max(s * CREASE_Z, s * (STUMPS_Z + 1.2));
      line(-1.345, zA, -1.295, zB); // return creases
      line(1.295, zA, 1.345, zB);
    }
  });
}

function boardTexture() {
  return canvasTex(1024, 64, (g, w, h) => {
    const cols = ['#0ea5e9', '#f59e0b', '#10b981', '#e11d48', '#8b5cf6', '#f97316'];
    const seg = w / 4;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = cols[i % cols.length];
      g.fillRect(i * seg, 0, seg, h);
      g.fillStyle = '#fff';
      g.font = '900 38px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(['CRICMATE', 'PLAY LAN', 'GO P2P', 'HIT A SIX'][i], i * seg + seg / 2, h / 2 + 2);
    }
  }, { repeat: [-14, 1] }); // negative: the ring is seen from the inside
}

function skyTexture() {
  return canvasTex(4, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#2f6fbf');
    grd.addColorStop(0.55, '#8cc2f0');
    grd.addColorStop(1, '#d8ecfa');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
}

// ---------------- people ----------------
const GEO = {};
function geos() {
  if (GEO.ready) return GEO;
  GEO.leg = new THREE.CylinderGeometry(0.075, 0.065, 0.86, 8).translate(0, -0.43, 0);
  GEO.torso = new THREE.CapsuleGeometry(0.19, 0.42, 4, 10);
  GEO.head = new THREE.SphereGeometry(0.12, 16, 12);
  GEO.helmet = new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  GEO.grille = new THREE.BoxGeometry(0.2, 0.1, 0.04);
  GEO.cap = new THREE.CylinderGeometry(0.13, 0.13, 0.06, 12);
  GEO.brim = new THREE.BoxGeometry(0.2, 0.015, 0.14);
  GEO.arm = new THREE.CylinderGeometry(0.055, 0.05, 0.62, 8).translate(0, -0.31, 0);
  GEO.hand = new THREE.SphereGeometry(0.045, 8, 6);
  GEO.pad = new THREE.BoxGeometry(0.17, 0.62, 0.12);
  GEO.glove = new THREE.SphereGeometry(0.08, 8, 6);
  // face & hair (head centre is at y = 1.68, face toward +z)
  GEO.eye = new THREE.SphereGeometry(0.02, 8, 6);
  GEO.pupil = new THREE.SphereGeometry(0.011, 6, 4);
  GEO.nose = new THREE.SphereGeometry(0.02, 6, 4);
  GEO.mouth = new THREE.BoxGeometry(0.045, 0.008, 0.01);
  GEO.ear = new THREE.SphereGeometry(0.03, 6, 4);
  GEO.shoulder = new THREE.SphereGeometry(0.072, 10, 8);
  GEO.neck = new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8);
  GEO.hairTop = new THREE.SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42);
  GEO.curl = new THREE.SphereGeometry(0.05, 8, 6);
  GEO.spike = new THREE.ConeGeometry(0.03, 0.1, 5);
  GEO.mohawk = new THREE.BoxGeometry(0.035, 0.08, 0.24);
  GEO.longBack = new THREE.BoxGeometry(0.23, 0.3, 0.06);
  GEO.tail = new THREE.CapsuleGeometry(0.035, 0.16, 3, 6);
  GEO.bun = new THREE.SphereGeometry(0.055, 10, 8);
  GEO.fringe = new THREE.SphereGeometry(0.124, 16, 6, Math.PI * 0.95, Math.PI * 1.1, Math.PI * 0.4, Math.PI * 0.18);
  GEO.beard = new THREE.SphereGeometry(0.124, 14, 8, 0, Math.PI, Math.PI * 0.55, Math.PI * 0.38);
  GEO.moustache = new THREE.BoxGeometry(0.075, 0.016, 0.02);
  GEO.band = new THREE.TorusGeometry(0.123, 0.014, 6, 20);
  GEO.jersey = new THREE.PlaneGeometry(0.3, 0.36);
  GEO.ready = true;
  return GEO;
}
const MAT = {};
const mat = (color, extra = {}) => {
  const key = color + JSON.stringify(extra);
  return (MAT[key] ||= new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra }));
};

// Name + number printed on the back of the shirt.
const JERSEYS = {};
function jerseyMat(ch) {
  if (JERSEYS[ch.id]) return JERSEYS[ch.id];
  const tex = canvasTex(128, 160, (g, w) => {
    g.textAlign = 'center';
    g.lineJoin = 'round';
    g.font = '800 22px system-ui, sans-serif';
    g.lineWidth = 4;
    g.strokeStyle = ch.look.accent;
    g.fillStyle = '#fff';
    g.strokeText(ch.short.toUpperCase(), w / 2, 34);
    g.fillText(ch.short.toUpperCase(), w / 2, 34);
    g.font = '900 88px system-ui, sans-serif';
    g.lineWidth = 6;
    g.strokeText(String(ch.num), w / 2, 128);
    g.fillText(String(ch.num), w / 2, 128);
  });
  return (JERSEYS[ch.id] = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, depthWrite: false }));
}

// Anonymous team-mates (fielders, non-striker, umpire) get a varied random look.
const SKINS = ['#f1c7a5', '#e8b894', '#d9a47c', '#c68a5e', '#a8714a', '#7a4a2c', '#5a3a24', '#3d2618'];
const HAIRS = ['#0f0f0f', '#24160b', '#3b2414', '#6b4423', '#d9a95b', '#9ca3af'];
function randomLook(rng) {
  const p = (a) => a[Math.floor(rng() * a.length)];
  return {
    skin: p(SKINS),
    hair: p(HAIRS),
    style: p(['short', 'short', 'short', 'curly', 'spiky', 'bald', 'bun']),
    beard: p([null, null, null, 'stubble', 'full', 'moustache']),
    build: [0.95 + rng() * 0.1, 0.94 + rng() * 0.14],
    accent: '#e5e7eb',
    headwear: p(['cap', 'cap', 'none']),
  };
}

function makePerson(side, { helmet = false, pads = false, gloves = false, umpire = false, look = null, jersey = null } = {}) {
  const G = geos();
  const g = new THREE.Group();
  const L = look || { skin: '#d9a47c', hair: '#24160b', style: 'short', beard: null, build: [1, 1], accent: '#e5e7eb', headwear: 'cap' };
  const shirt = umpire ? mat('#f8fafc') : mat(TEAM_COLORS[side]);
  const trousers = umpire ? mat('#1f2937') : mat(TEAM_DARK[side]);
  const skin = mat(L.skin, { roughness: 0.6 });
  const hair = mat(L.hair, { roughness: 0.9 });
  const mk = (geo, m, x, y, z, parent = g) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const legs = [-0.11, 0.11].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.88, 0);
    const leg = new THREE.Mesh(G.leg, trousers);
    leg.castShadow = true;
    pivot.add(leg);
    if (pads) {
      const pad = new THREE.Mesh(G.pad, mat('#f1f5f9'));
      pad.position.set(0, -0.5, 0.05);
      pad.castShadow = true;
      pivot.add(pad);
    }
    g.add(pivot);
    return pivot;
  });
  const torso = mk(G.torso, shirt, 0, 1.22, 0);
  torso.scale.set(1, 1, 0.75);
  if (jersey) {
    const back = new THREE.Mesh(G.jersey, jerseyMat(jersey));
    back.position.set(0, 1.27, -0.148);
    back.rotation.y = Math.PI;
    g.add(back);
  }
  mk(G.head, skin, 0, 1.68, 0);

  // face
  for (const x of [-0.042, 0.042]) {
    mk(G.eye, mat('#f8fafc', { roughness: 0.3 }), x, 1.697, 0.1);
    mk(G.pupil, mat('#111111', { roughness: 0.2 }), x, 1.697, 0.115);
    mk(G.ear, skin, Math.sign(x) * 0.118, 1.68, 0);
  }
  mk(G.nose, skin, 0, 1.668, 0.118);
  mk(G.mouth, mat('#5b2a22'), 0, 1.632, 0.112);
  mk(G.neck, skin, 0, 1.56, 0);
  if (L.beard === 'full' || L.beard === 'stubble') {
    const b = mk(G.beard, L.beard === 'full' ? hair : mat(L.hair, { transparent: true, opacity: 0.45 }), 0, 1.68, 0.002);
    b.scale.setScalar(L.beard === 'full' ? 1.03 : 1.005);
  } else if (L.beard === 'moustache') mk(G.moustache, hair, 0, 1.648, 0.115);

  // hair. Anything that would poke through a helmet goes in `bare` and is hidden while it's on.
  const bare = new THREE.Group();
  g.add(bare);
  if (L.style !== 'bald' && L.style !== 'mohawk') {
    const t = mk(G.hairTop, hair, 0, 1.685, -0.01);
    t.rotation.x = -0.3;
    if (L.style === 'curly') t.scale.setScalar(1.08);
  }
  if (L.style === 'curly')
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      mk(G.curl, hair, Math.cos(a) * 0.09, 1.78 + (i % 2) * 0.015, Math.sin(a) * 0.08 - 0.02, bare);
    }
  if (L.style === 'spiky')
    for (let i = 0; i < 6; i++) {
      const sp = mk(G.spike, hair, (i % 3) * 0.06 - 0.06, 1.8, i < 3 ? 0.02 : -0.06, bare);
      sp.rotation.set(i < 3 ? 0.35 : -0.35, 0, ((i % 3) - 1) * 0.4);
    }
  if (L.style === 'mohawk') mk(G.mohawk, hair, 0, 1.8, -0.01, bare);
  if (L.style === 'bald') mk(G.fringe, hair, 0, 1.68, 0);
  if (L.style === 'long') mk(G.longBack, hair, 0, 1.58, -0.085);
  if (L.style === 'ponytail') mk(G.tail, hair, 0, 1.62, -0.15).rotation.x = 0.5;
  if (L.style === 'bun') mk(G.bun, hair, 0, 1.82, -0.05, bare);

  // headwear
  let helmetParts = null;
  if (helmet) {
    helmetParts = new THREE.Group();
    g.add(helmetParts);
    mk(G.helmet, mat(TEAM_DARK[side]), 0, 1.7, 0, helmetParts);
    mk(G.grille, mat('#9ca3af', { metalness: 0.6 }), 0, 1.64, 0.12, helmetParts);
    if (L.style === 'bun') mk(G.bun, hair, 0, 1.66, -0.15, helmetParts);
    bare.visible = false;
  } else if (umpire || L.headwear === 'cap') {
    const capM = umpire ? mat('#f8fafc') : mat(TEAM_DARK[side]);
    mk(G.cap, capM, 0, 1.79, 0);
    mk(G.brim, capM, 0, 1.77, 0.1);
  } else if (L.headwear === 'band') {
    mk(G.band, mat(L.accent), 0, 1.735, 0).rotation.x = Math.PI / 2;
  }

  const arms = [-0.27, 0.27].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x * 0.93, 1.45, 0);
    const arm = new THREE.Mesh(G.arm, shirt);
    arm.castShadow = true;
    pivot.add(arm);
    mk(G.shoulder, shirt, 0, -0.02, 0, pivot);
    if (gloves) {
      const glove = new THREE.Mesh(G.glove, mat('#f1f5f9'));
      glove.position.y = -0.64;
      pivot.add(glove);
    } else {
      mk(G.hand, skin, 0, -0.64, 0, pivot);
    }
    g.add(pivot);
    return pivot;
  });
  g.scale.set(L.build[1], L.build[0], L.build[1]);
  const setHelmet = (on) => {
    if (!helmetParts) return;
    helmetParts.visible = on;
    bare.visible = !on;
  };
  return { group: g, legs, arms, shirtMeshes: [torso], side, setHelmet };
}

function makeStumps() {
  const g = new THREE.Group();
  const wood = mat('#f3e3c3', { roughness: 0.5 });
  const geo = new THREE.CylinderGeometry(0.019, 0.019, 0.71, 10).translate(0, 0.355, 0);
  const stumps = [-0.114, 0, 0.114].map((x) => {
    const s = new THREE.Mesh(geo, wood);
    s.position.x = x;
    s.castShadow = true;
    g.add(s);
    return s;
  });
  const bailGeo = new THREE.BoxGeometry(0.11, 0.02, 0.02);
  const bails = [-0.057, 0.057].map((x) => {
    const b = new THREE.Mesh(bailGeo, mat('#e2a44b'));
    b.position.set(x, 0.72, 0);
    g.add(b);
    return b;
  });
  return { group: g, stumps, bails };
}

// ---------------- renderer ----------------
export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.stage = canvas.parentElement;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog('#b9dbf5', 140, 320);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    this.camPos = new THREE.Vector3(0, 6, 30);
    this.camLook = new THREE.Vector3(0, 0.6, 0);
    this.camPosT = this.camPos.clone();
    this.camLookT = this.camLook.clone();
    this.view = 'bat';

    this._buildLights();
    this._buildGround();
    this._buildStadium();
    this._buildPlayers();
    this._buildBall();

    this.overlay = document.createElement('div');
    this.overlay.className = 'fx-overlay';
    this.stage.appendChild(this.overlay);

    this.reset();
    this._resize();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(canvas);
    this.clock = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this._frame();
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.overlay.remove();
    this.gl.dispose();
  }

  // ---------- scene construction ----------
  _buildLights() {
    this.scene.add(new THREE.HemisphereLight('#dbeafe', '#3f6b35', 1.1));
    const sun = new THREE.DirectionalLight('#fff4e0', 2.4);
    sun.position.set(-40, 70, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -70;
    s.right = 70;
    s.top = 75;
    s.bottom = -75;
    s.near = 10;
    s.far = 200;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
  }

  _buildGround() {
    const outer = new THREE.Mesh(new THREE.CircleGeometry(1, 96), mat('#3a8a3f'));
    outer.rotation.x = -Math.PI / 2;
    outer.scale.set(RX + 16, RZ + 16, 1);
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.scene.add(outer);

    const field = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 0.95 }));
    field.rotation.x = -Math.PI / 2;
    field.scale.set(RX, RZ, 1);
    field.receiveShadow = true;
    this.scene.add(field);

    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 24), new THREE.MeshStandardMaterial({ map: pitchTexture(), roughness: 1 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.y = 0.005;
    pitch.receiveShadow = true;
    this.scene.add(pitch);

    // boundary rope
    const pts = [];
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * RX, 0.08, Math.sin(a) * RZ));
    }
    const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 256, 0.09, 6, true), mat('#fafafa'));
    this.scene.add(rope);

    // 30-yard circle as dots
    const dot = new THREE.CircleGeometry(0.18, 8);
    const dots = new THREE.InstancedMesh(dot, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }), 64);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      m.compose(new THREE.Vector3(Math.cos(a) * 27.4, 0.01, Math.sin(a) * 30), q, new THREE.Vector3(1, 1, 1));
      dots.setMatrixAt(i, m);
    }
    this.scene.add(dots);

    this.stumpsFar = makeStumps();
    this.stumpsFar.group.position.z = -STUMPS_Z;
    this.stumpsNear = makeStumps();
    this.stumpsNear.group.position.z = STUMPS_Z;
    this.scene.add(this.stumpsFar.group, this.stumpsNear.group);

    // glowing hit zone at the batter's crease
    this.zone = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.7),
      new THREE.MeshBasicMaterial({ color: '#fff36b', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.zone.rotation.x = -Math.PI / 2;
    this.zone.position.set(0.05, 0.012, BAT_Z);
    this.scene.add(this.zone);
  }

  _buildStadium() {
    // advertising boards
    const boards = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 128, 1, true),
      new THREE.MeshStandardMaterial({ map: boardTexture(), side: THREE.DoubleSide, roughness: 0.6, emissive: '#222', emissiveIntensity: 0.2 }),
    );
    boards.scale.set(RX + 5, 0.9, RZ + 5);
    boards.position.y = 0.45;
    this.scene.add(boards);

    // tiered stands
    const tiers = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1, 1, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: '#8b95a5', side: THREE.BackSide, roughness: 0.9 }),
    );
    tiers.scale.set(RX + 10, 24, RZ + 10);
    tiers.position.y = 12;
    tiers.receiveShadow = true;
    this.scene.add(tiers);

    // crowd (instanced)
    const N = 7000;
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.9, 0.5), new THREE.MeshLambertMaterial(), N);
    const rng = mulberry32(3);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    this.crowdBase = [];
    for (let i = 0; i < N; i++) {
      const t = 0.04 + rng() * 0.92;
      const a = rng() * Math.PI * 2;
      const k = 1 + 0.5 * t;
      const x = Math.cos(a) * (RX + 10) * k;
      const z = Math.sin(a) * (RZ + 10) * k;
      const y = t * 24 + 0.45;
      this.crowdBase.push(x, y, z, rng() * 6.28);
      m.makeRotationY(-a + Math.PI / 2);
      m.setPosition(x, y, z);
      crowd.setMatrixAt(i, m);
      crowd.setColorAt(i, col.setHSL(rng(), 0.55, 0.35 + rng() * 0.35));
    }
    this.crowd = crowd;
    this.scene.add(crowd);

    // floodlight towers
    const poleGeo = new THREE.CylinderGeometry(0.6, 0.9, 46, 8);
    const headGeo = new THREE.BoxGeometry(9, 5, 1.2);
    for (const a of [0.7, 2.45, 3.85, 5.6]) {
      const x = Math.cos(a) * (RX + 46);
      const z = Math.sin(a) * (RZ + 46);
      const pole = new THREE.Mesh(poleGeo, mat('#6b7280'));
      pole.position.set(x, 23, z);
      const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#fffbe6', emissiveIntensity: 0.9 }));
      head.position.set(x, 47, z);
      head.lookAt(0, 0, 0);
      this.scene.add(pole, head);
    }
  }

  _buildPlayers() {
    const rng = mulberry32(21);
    this.batter = makePerson(0, { helmet: true, pads: true, gloves: true });
    this.batter.group.position.set(-0.42, 0, CREASE_Z + 0.45);
    this.batter.group.rotation.y = Math.PI / 2; // side-on, chest to the off side
    this.scene.add(this.batter.group);

    // bat on a pivot at the batter's hands
    this.batPivot = new THREE.Group();
    this.batPivot.rotation.order = 'YXZ';
    this.batPivot.position.set(-0.18, 0.98, CREASE_Z + 0.42);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.56, 0.045), mat('#e8cf9a', { roughness: 0.55 }));
    blade.position.y = -0.52;
    blade.castShadow = true;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 8), mat('#111827'));
    handle.position.y = -0.12;
    this.batPivot.add(blade, handle);
    this.batHandle = handle;
    this.scene.add(this.batPivot);

    this.nonStriker = makePerson(0, { helmet: true, pads: true, gloves: true, look: randomLook(rng) });
    this.nonStriker.group.position.set(1.5, 0, -CREASE_Z - 0.6);
    this.nonStriker.group.rotation.y = 0.3;
    this.scene.add(this.nonStriker.group);

    this.umpire = makePerson(0, { umpire: true });
    this.umpire.group.position.set(1.1, 0, -STUMPS_Z - 2.4);
    this.scene.add(this.umpire.group);

    this.bowler = makePerson(1);
    this.scene.add(this.bowler.group);

    this.fielders = FIELD.map((f) => {
      const look = randomLook(rng);
      const p = makePerson(1, f.keeper ? { helmet: true, pads: true, gloves: true, look } : { look });
      p.home = new THREE.Vector3(f.x, 0, f.z);
      p.target = p.home.clone();
      p.speed = 8;
      p.keeper = !!f.keeper;
      p.group.position.copy(p.home);
      this.scene.add(p.group);
      return p;
    });
    this.teamPeople = { bat: [this.batter, this.nonStriker], bowl: [this.bowler, ...this.fielders] };
  }

  _buildBall() {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 16, 12), new THREE.MeshStandardMaterial({ color: '#c1121f', roughness: 0.35, emissive: '#5a0008', emissiveIntensity: 0.6 }));
    this.ball.castShadow = true;
    this.ball.visible = false;
    this.scene.add(this.ball);
    // soft blob shadow, always visible (helps judge length)
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.4, 16),
      new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.visible = false;
    this.scene.add(this.ballShadow);
  }

  // ---------- characters ----------
  // chars[side] = a character from characters.js. The striker and the bowler wear their look;
  // everyone else stays an anonymous team-mate.
  setCharacters(chars) {
    this.chars = chars;
    this._leadKey = null;
  }

  _swapPerson(old, fresh) {
    fresh.group.position.copy(old.group.position);
    fresh.group.rotation.copy(old.group.rotation);
    this.scene.remove(old.group);
    this.scene.add(fresh.group);
    return fresh;
  }

  _dressLeads(batSide) {
    const batC = this.chars?.[batSide];
    const bowlC = this.chars?.[1 - batSide];
    const key = `${batSide}|${batC?.id}|${bowlC?.id}`;
    if (key === this._leadKey) return;
    this._leadKey = key;
    this.batter = this._swapPerson(this.batter, makePerson(batSide, { helmet: true, pads: true, gloves: true, look: batC?.look, jersey: batC }));
    this.bowler = this._swapPerson(this.bowler, makePerson(1 - batSide, { look: bowlC?.look, jersey: bowlC }));
    this.teamPeople.bat[0] = this.batter;
    this.teamPeople.bowl[0] = this.bowler;
    this.batHandle.material = mat(batC?.look.accent || '#111827');
    this.batPivot.position.y = 0.98 * (batC?.look.build[0] || 1);
  }

  // Broadcast-style introduction: close-up of the striker, then the bowler, each with a name card.
  // Returns how long it runs (ms).
  present(batC, bowlC, labels = ['ON STRIKE', 'TO BOWL']) {
    if (!batC || !bowlC) return 0;
    const now = performance.now();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const bh = batC.look.build[0];
    const wh = bowlC.look.build[0];
    this.focus = [
      { until: now + 1700, from: V(3.6, 1.5 * bh, CREASE_Z + 2.6), to: V(2.9, 1.5 * bh, CREASE_Z + 2.0), look: V(-0.42, 1.25 * bh, CREASE_Z + 0.45), fov: 30, ch: batC, label: labels[0] },
      { until: now + 3400, from: V(1.6, 1.55 * wh, -21.6), to: V(1.1, 1.5 * wh, -22.5), look: V(-0.05, 1.3 * wh, -26), fov: 30, ch: bowlC, label: labels[1] },
    ];
    this.focusIdx = -1;
    this.batter.setHelmet(false); // helmet off for the close-up, so you can see who it is
    return 3400;
  }

  _card(ch, label, ms) {
    const el = document.createElement('div');
    el.className = 'fx-card';
    el.style.setProperty('--a', ch.look.accent);
    el.style.animationDuration = `${ms}ms`;
    el.innerHTML = '<small></small><b></b><span></span>';
    el.querySelector('small').textContent = label;
    el.querySelector('b').textContent = `#${ch.num} ${ch.name}`;
    el.querySelector('span').textContent = `“${ch.nick}” · ${ch.role}`;
    this.overlay.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  _updateFocus(now) {
    if (!this.focus) return false;
    const i = this.focus.findIndex((f) => now < f.until);
    if (i < 0) {
      this.focus = null;
      this.batter.setHelmet(true);
      this._roleCamera();
      this.camPos.copy(this.camPosT); // cut back to the play camera
      this.camLook.copy(this.camLookT);
      return false;
    }
    const f = this.focus[i];
    const start = i ? this.focus[i - 1].until : f.until - 1700;
    if (i !== this.focusIdx) {
      this.focusIdx = i;
      this.camPos.copy(f.from); // hard cut between shots
      this.camLook.copy(f.look);
      this.camera.fov = this.fovT = f.fov;
      this.camera.updateProjectionMatrix();
      this._card(f.ch, f.label, f.until - now);
      if (i > 0) this.batter.setHelmet(true);
    }
    const q = easeOut(clamp((now - start) / (f.until - start), 0, 1));
    this.camPos.lerpVectors(f.from, f.to, q); // slow push-in
    this.camLook.copy(f.look);
    return true;
  }

  // ---------- public API ----------
  setTeams(batSide) {
    this._dressLeads(batSide);
    const recolor = (p, side) => {
      p.group.traverse((o) => {
        if (!o.isMesh) return;
        if (o.material === mat(TEAM_COLORS[1 - side])) o.material = mat(TEAM_COLORS[side]);
        else if (o.material === mat(TEAM_DARK[1 - side])) o.material = mat(TEAM_DARK[side]);
      });
      p.side = side;
    };
    for (const p of this.teamPeople.bat) if (p.side !== batSide) recolor(p, batSide);
    for (const p of this.teamPeople.bowl) if (p.side !== 1 - batSide) recolor(p, 1 - batSide);
  }

  setView(iAmBatting) {
    this.view = iAmBatting ? 'bat' : 'bowl';
    this._roleCamera();
  }

  _roleCamera() {
    const portrait = this.camera.aspect < 1;
    if (this.view === 'bat') {
      // behind and above the keeper, looking down the pitch at the bowler
      this.camPosT.set(0.2, portrait ? 6.2 : 5.6, STUMPS_Z + (portrait ? 17 : 15));
      this.camLookT.set(0, 0.2, -2.5);
      this._setFov(portrait ? 46 : 32);
    } else {
      // high "broadcast" camera over the umpire's head, zoomed toward the batter
      this.camPosT.set(-0.3, portrait ? 7 : 6, -STUMPS_Z - (portrait ? 20 : 18));
      this.camLookT.set(0, 0.5, 6.5);
      this._setFov(portrait ? 40 : 28);
    }
  }

  _setFov(fov) {
    this.fovT = fov;
  }

  reset() {
    this.focus = null;
    this.batter?.setHelmet(true);
    this.overlay?.querySelectorAll('.fx-card').forEach((e) => e.remove());
    this.del = null;
    this.hit = null;
    this.bat = null;
    this.stumpsHit = 0;
    this.ball.visible = false;
    this.ballShadow.visible = false;
    this.bowler.group.position.set(-0.05, 0, -32);
    this.bowler.group.rotation.y = 0;
    this.bowler.arms[0].rotation.x = 0;
    this._resetStumps();
    for (const f of this.fielders) {
      f.target.copy(f.home);
      f.speed = 10;
    }
    this._roleCamera();
  }

  _resetStumps() {
    const s = this.stumpsNear;
    s.stumps.forEach((st, i) => {
      st.rotation.set(0, 0, 0);
      st.position.set([-0.114, 0, 0.114][i], 0, 0);
    });
    s.bails.forEach((b, i) => {
      b.position.set([-0.057, 0.057][i], 0.72, 0);
      b.rotation.set(0, 0, 0);
    });
  }

  // opts.time: ms from release to the batter (bowler's pace); opts.move: swing/turn multiplier (craft)
  playDelivery(d, seed, { time, move = 1, startAt = performance.now() } = {}) {
    const spec = { ...DELIVERIES[d.type] };
    if (time) spec.time = time;
    const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.reset();
    const release = startAt + RUNUP_MS;
    const arrive = release + spec.time;
    const endX = LINES[d.line].x / 60;
    this.del = {
      d,
      spec,
      start: startAt,
      release,
      arrive,
      endX,
      turn: spec.drift ? (rng() < 0.5 ? -1 : 1) * 0.38 * move : 0,
      swing: spec.swing ? (rng() < 0.5 ? -1 : 1) * spec.swing * 0.28 * move : 0,
      yBat: 0.1 + 0.78 * spec.height,
      miss: null,
    };
    return { release, arrive };
  }

  swing(shot, at = performance.now()) {
    this.bat = { shot, at };
  }

  banner(text, color = '#fff', sub = '', ms = 1600) {
    const el = document.createElement('div');
    el.className = text === 'OUT!' ? 'fx-banner out' : 'fx-banner';
    el.style.setProperty('--c', color);
    el.style.animationDuration = `${ms}ms`;
    el.innerHTML = `<b></b>${sub ? '<small></small>' : ''}`;
    el.querySelector('b').textContent = text;
    if (sub) el.querySelector('small').textContent = sub;
    this.overlay.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  float(text, color = '#fff') {
    const el = document.createElement('div');
    el.className = 'fx-float';
    el.style.color = color;
    el.textContent = text;
    this.overlay.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }

  playResult(res, rng = Math.random) {
    const now = performance.now();
    const del = this.del;
    if (!del) return Promise.resolve();

    if (res.kind !== 'hit') {
      const stopZ = res.out === 'bowled' ? STUMPS_Z - 0.05 : res.out === 'lbw' ? BAT_Z + 0.1 : KEEPER_Z - 0.5;
      const stopP = (stopZ - RELEASE.z) / (BAT_Z - RELEASE.z);
      const p0 = Math.min(this._progress(now), stopP);
      del.miss = { at: now, p0, stopP, res };
      const travel = Math.max(0, (stopP - p0) * del.spec.time);
      return new Promise((done) =>
        setTimeout(() => {
          if (res.out === 'bowled') this.stumpsHit = performance.now();
          if (res.out) this.banner('OUT!', '#ff5a5a', res.out.toUpperCase(), 1800);
          setTimeout(done, res.out ? 1500 : 650);
        }, travel),
      );
    }

    const b = this._ballPos(now) || new THREE.Vector3(del.endX, 0.5, BAT_Z);
    const x0 = b.x;
    const z0 = Math.min(b.z, BAT_Z + 0.1);
    const y0 = b.y;
    const dx = Math.sin(res.angle);
    const dz = -Math.cos(res.angle);
    const B = boundaryDist(x0, z0, dx, dz);
    let dist;
    if (res.out === 'caught behind') dist = Math.hypot(this.fielders[1].home.x - x0, this.fielders[1].home.z - z0);
    else if (res.out) dist = B * (0.55 + rng() * 0.25);
    else if (res.runs === 6) dist = B * 1.18;
    else if (res.runs === 4) dist = B * 0.99;
    else if (res.runs === 3) dist = B * 0.85;
    else if (res.runs === 2) dist = B * 0.66;
    else if (res.runs === 1) dist = B * 0.4;
    else dist = res.shot === 'defend' ? 1.5 + rng() * 2.5 : Math.min(B * 0.4, 25);

    const aerial = res.aerial || res.runs === 6 || !!res.out;
    const dur = aerial ? 900 + dist * 24 : 450 + dist * 26;
    const peak = res.runs === 6 ? 26 : res.out === 'caught behind' ? 1.2 : res.out ? 15 : aerial ? 8 : 0;
    const end = new THREE.Vector3(x0 + dx * dist, res.out ? 1.3 : BALL_R, z0 + dz * dist);
    this.hit = { start: now, dur, from: new THREE.Vector3(x0, y0, z0), to: end, peak, aerial, res };

    // nearest fielder chases / settles under it
    let best = null;
    let bestD = Infinity;
    for (const f of this.fielders) {
      if (f.keeper && res.out !== 'caught behind') continue;
      const d = Math.hypot(f.home.x - end.x, f.home.z - end.z);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (best && res.shot !== 'defend') {
      const reach = res.out ? 1 : res.runs >= 4 ? 0.8 : 1;
      best.target.set(lerp(best.home.x, end.x, reach), 0, lerp(best.home.z, end.z, reach));
      best.speed = res.out ? Math.max(3, bestD / (dur / 1000)) : 8.5;
      this.hit.catcher = res.out ? best : null;
    }

    return new Promise((done) =>
      setTimeout(() => {
        if (res.out) this.banner('OUT!', '#ff5a5a', res.out.toUpperCase(), 1800);
        else if (res.runs === 6) this.banner('SIX!', '#c084fc', '', 1700);
        else if (res.runs === 4) this.banner('FOUR!', '#facc15', '', 1500);
        else if (res.runs > 0) this.float(`+${res.runs}`);
        else this.float('•', '#ddd');
        setTimeout(done, res.out || res.runs >= 4 ? 1400 : 700);
      }, dur),
    );
  }

  // ---------- simulation ----------
  _progress(t) {
    const del = this.del;
    if (!del || t < del.release) return -1;
    if (del.miss) return Math.min(del.miss.p0 + (t - del.miss.at) / del.spec.time, del.miss.stopP);
    if (this.hit) return 1;
    return Math.min((t - del.release) / (del.arrive - del.release), HOLD_P);
  }

  _ballPos(t, out = new THREE.Vector3()) {
    const del = this.del;
    const p = this._progress(t);
    if (p < 0) return null;
    const f = del.spec.pitch;
    const bounceX = del.endX - del.turn;
    let x;
    let y;
    if (p < f) {
      const q = p / f;
      x = lerp(RELEASE.x, bounceX, q) + del.swing * Math.sin(Math.PI * q);
      y = BALL_R + (RELEASE.y - BALL_R) * (1 - q) + 0.5 * q * (1 - q);
    } else {
      const q = (p - f) / (1 - f);
      x = lerp(bounceX, del.endX, q);
      y = BALL_R + del.yBat * Math.sin(Math.min(q, 1.25) * Math.PI * 0.5);
    }
    if (del.miss?.res.out === 'lbw' && p >= del.miss.stopP) y = BALL_R;
    const z = RELEASE.z + p * (BAT_Z - RELEASE.z);
    return out.set(x, y, z);
  }

  _animateWalk(p, moving, t) {
    const sw = moving ? Math.sin(t * 0.014) * 0.6 : 0;
    p.legs[0].rotation.x = sw;
    p.legs[1].rotation.x = -sw;
    p.arms[0].rotation.x = -sw * 0.8;
    p.arms[1].rotation.x = sw * 0.8;
  }

  _frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.clock) / 1000);
    this.clock = now;
    const del = this.del;

    // bowler run-up and delivery stride
    if (del) {
      const bw = this.bowler;
      if (now < del.release) {
        const q = clamp((now - del.start) / RUNUP_MS, 0, 1);
        bw.group.position.z = lerp(-26, -STUMPS_Z - 0.4, q);
        this._animateWalk(bw, true, now * 1.4);
        // bowling arm windmills over in the last 40% of the run-up
        bw.arms[0].rotation.x = q > 0.6 ? -((q - 0.6) / 0.4) * Math.PI * 1.1 : 0;
      } else {
        const q = clamp((now - del.release) / 600, 0, 1);
        bw.group.position.z = lerp(-STUMPS_Z - 0.4, -STUMPS_Z + 2.8, easeOut(q));
        bw.group.position.x = lerp(-0.05, -1.2, easeOut(q));
        bw.arms[0].rotation.x = -Math.PI * 1.1 - q * Math.PI * 0.7;
        this._animateWalk(bw, q < 1, now);
      }
    } else {
      this.bowler.group.position.set(-0.05, 0, -26);
      this._animateWalk(this.bowler, false, now);
    }

    // fielders
    for (const f of this.fielders) {
      const pos = f.group.position;
      const dx = f.target.x - pos.x;
      const dz = f.target.z - pos.z;
      const d = Math.hypot(dx, dz);
      const step = f.speed * dt;
      const moving = d > 0.05;
      if (d > step) {
        pos.x += (dx / d) * step;
        pos.z += (dz / d) * step;
      } else {
        pos.x = f.target.x;
        pos.z = f.target.z;
      }
      if (moving) f.group.rotation.y = Math.atan2(dx, dz);
      else f.group.rotation.y = lerp(f.group.rotation.y, Math.atan2(-pos.x, BAT_Z - pos.z), 0.1);
      this._animateWalk(f, moving, now);
    }

    this._updateBat(now);
    this._updateBall(now);
    this._updateStumps(now);
    this._updateCrowd(now);

    // hit zone pulse while the ball is coming
    const zoneOn = del && !this.hit && !del.miss && now > del.release;
    this.zone.material.opacity = zoneOn ? 0.25 + 0.15 * Math.sin(now / 90) : 0;

    // camera
    const k = 1 - Math.pow(this.hit ? 0.08 : 0.004, dt);
    const focused = this._updateFocus(now);
    if (!focused) {
      this.camPos.lerp(this.camPosT, k);
      this.camLook.lerp(this.camLookT, this.hit ? 1 - Math.pow(0.002, dt) : k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (!focused && this.fovT && Math.abs(this.camera.fov - this.fovT) > 0.05) {
      this.camera.fov = lerp(this.camera.fov, this.fovT, k);
      this.camera.updateProjectionMatrix();
    }
    this.gl.render(this.scene, this.camera);
  }

  _updateBat(now) {
    const p = this.batPivot;
    const del = this.del;
    if (this.bat) {
      const ends = {
        drive: { yaw: -0.2, x0: -2.2, x1: 2.2 },
        cut: { yaw: -1.5, x0: -2.0, x1: 1.9 },
        pull: { yaw: 1.4, x0: -2.0, x1: 2.3 },
        loft: { yaw: 0.05, x0: -2.5, x1: 2.9 },
        defend: { yaw: -0.1, x0: -0.9, x1: 0.35 },
      }[this.bat.shot] || { yaw: 0, x0: 0, x1: 0 };
      const q = clamp((now - (this.bat.at - 120)) / 260, 0, 1);
      p.rotation.y = ends.yaw;
      p.rotation.x = lerp(ends.x0, ends.x1, easeOut(q));
      p.rotation.z = 0;
    } else if (del && now > del.release - 250 && !del.miss) {
      p.rotation.set(-1.1, 0, 0); // back-lift, ready
    } else {
      p.rotation.set(0.25, 0, 0.1); // stance: bat grounded
    }
  }

  _updateBall(now) {
    const ball = this.ball;
    const shadow = this.ballShadow;
    let pos = null;
    if (this.hit) {
      const h = this.hit;
      const q = clamp((now - h.start) / h.dur, 0, 1);
      const e = h.aerial ? q : easeOut(q);
      pos = new THREE.Vector3().lerpVectors(h.from, h.to, e);
      if (h.aerial) pos.y = lerp(h.from.y, h.to.y, q) + 4 * h.peak * q * (1 - q);
      else pos.y = BALL_R + Math.abs(Math.sin(q * 9)) * 0.4 * (1 - q) * (h.res.runs ? 1 : 0.3);
      if (h.catcher && q >= 1) {
        const c = h.catcher.group.position;
        pos.set(c.x, 1.25, c.z);
      }
      // follow cam: hover behind-and-above the ball, looking at it
      const dirX = h.to.x - h.from.x;
      const dirZ = h.to.z - h.from.z;
      const len = Math.hypot(dirX, dirZ) || 1;
      const back = h.res.shot === 'defend' ? 6 : 16;
      this.camPosT.set(pos.x - (dirX / len) * back, Math.max(6, pos.y * 0.6 + 7), pos.z - (dirZ / len) * back + 4);
      this.camLookT.copy(pos);
      this._setFov(this.camera.aspect < 1 ? 62 : 45);
    } else if (this.del) {
      pos = this._ballPos(now);
    }
    ball.visible = shadow.visible = !!pos;
    if (!pos) return;
    ball.position.copy(pos);
    ball.rotation.x -= 0.3;
    shadow.position.set(pos.x, 0.015, pos.z);
    const s = 1 + pos.y * 0.15;
    shadow.scale.set(s, s, s);
    shadow.material.opacity = 0.4 / s;
  }

  _updateStumps(now) {
    if (!this.stumpsHit) return;
    const q = clamp((now - this.stumpsHit) / 450, 0, 1);
    const s = this.stumpsNear;
    s.stumps.forEach((st, i) => {
      st.rotation.x = q * (0.5 + (i === 1 ? 0.4 : 0.2));
      st.rotation.z = (i - 1) * q * 0.4;
    });
    const t = (now - this.stumpsHit) / 1000;
    s.bails.forEach((b, i) => {
      const tt = Math.min(t, 0.7);
      b.position.set((i ? 1 : -1) * (0.057 + tt * 1.4), Math.max(0.02, 0.72 + tt * 3 - 6 * tt * tt), tt * 2.6);
      b.rotation.set(tt * 14, tt * 9 * (i ? 1 : -1), 0);
    });
  }

  _updateCrowd(now) {
    // the crowd jumps when there's something to cheer
    const cheering = this.overlay.querySelector('.fx-banner:not(.out)') && this.overlay.children.length;
    if (!cheering && !this._crowdUp) return;
    this._crowdUp = !!cheering;
    const m = new THREE.Matrix4();
    const base = this.crowdBase;
    for (let i = 0, n = this.crowd.count; i < n; i++) {
      this.crowd.getMatrixAt(i, m);
      const bob = cheering ? Math.max(0, Math.sin(now / 90 + base[i * 4 + 3])) * 0.35 : 0;
      m.elements[13] = base[i * 4 + 1] + bob;
      this.crowd.setMatrixAt(i, m);
    }
    this.crowd.instanceMatrix.needsUpdate = true;
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (!this.hit && !this.focus) this._roleCamera();
    this.camera.fov = this.fovT || 45;
    this.camera.updateProjectionMatrix();
  }
}
