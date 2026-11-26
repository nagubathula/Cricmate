// CricMate server: static files + WebSocket rooms (relay & WebRTC signaling).
// Run `npm start` for LAN play, `npm run online` to also open an ngrok tunnel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

export function lanUrls(port) {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

// If the user runs the ngrok CLI themselves (`ngrok http 3000`), discover its URL
// through ngrok's local inspection API.
async function discoverNgrokUrl() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 400);
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: ctrl.signal });
    clearTimeout(timer);
    const { tunnels = [] } = await r.json();
    const t = tunnels.find((x) => x.public_url?.startsWith('https')) || tunnels[0];
    return t?.public_url || null;
  } catch {
    return null;
  }
}

const cleanName = (n) => String(n ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Player';

export function createServer({ port = 3000, publicUrl = null } = {}) {
  const state = { publicUrl };
  const rooms = new Map(); // code -> { host, guest }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (url.pathname === '/api/info') {
      const actualPort = server.address()?.port ?? port;
      const pub = state.publicUrl || (await discoverNgrokUrl());
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ lan: lanUrls(actualPort), publicUrl: pub, rooms: rooms.size }));
      return;
    }

    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  const send = (ws, msg) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const peerOf = (ws) => {
    const room = rooms.get(ws.room);
    if (!room) return null;
    return room.host === ws ? room.guest : room.host;
  };
  const newCode = () => {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (rooms.has(code));
    return code;
  };

  function leave(ws) {
    const room = rooms.get(ws.room);
    if (!room) return;
    if (room.host === ws) {
      rooms.delete(ws.room);
      if (room.guest) {
        room.guest.room = null;
        send(room.guest, { t: 'peer-left', hostClosed: true });
      }
    } else if (room.guest === ws) {
      room.guest = null;
      send(room.host, { t: 'peer-left' });
    }
    ws.room = null;
  }

  function handle(ws, m) {
    switch (m.t) {
      case 'create': {
        leave(ws);
        const code = newCode();
        ws.name = cleanName(m.name);
        ws.room = code;
        rooms.set(code, { host: ws, guest: null });
        send(ws, { t: 'created', code });
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', msg: `Room ${code || '?'} not found` });
        if (room.host === ws) return send(ws, { t: 'error', msg: "You can't join your own room" });
        if (room.guest) return send(ws, { t: 'error', msg: 'Room is full' });
        leave(ws);
        ws.name = cleanName(m.name);
        ws.room = code;
        room.guest = ws;
        send(ws, { t: 'joined', code, peerName: room.host.name });
        send(room.host, { t: 'peer-joined', name: ws.name });
        break;
      }
      case 'relay':
      case 'signal':
        send(peerOf(ws), { t: m.t, data: m.data });
        break;
      case 'leave':
        leave(ws);
        break;
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m && typeof m.t === 'string') handle(ws, m);
    });
    ws.on('close', () => leave(ws));
  });

  // Heartbeat keeps tunnels (ngrok) from idling out and reaps dead sockets.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  return { server, wss, rooms, state };
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  const useNgrok = process.argv.includes('--ngrok') || process.env.NGROK === '1';
  const { server, state } = createServer({ port, publicUrl: process.env.PUBLIC_URL || null });

  server.listen(port, '0.0.0.0', async () => {
    console.log('\n  🏏  CricMate is running\n');
    console.log(`  This computer:   http://localhost:${port}`);
    for (const u of lanUrls(port)) console.log(`  LAN (same Wi‑Fi): ${u}`);

    if (useNgrok) {
      try {
        const ngrok = await import('@ngrok/ngrok');
        const listener = await ngrok.forward({ addr: port, authtoken_from_env: true });
        state.publicUrl = listener.url();
        console.log(`  Online (ngrok):   ${state.publicUrl}`);
      } catch (e) {
        console.log(`\n  ⚠ ngrok tunnel failed: ${e.message}`);
        console.log('    Set NGROK_AUTHTOKEN (https://dashboard.ngrok.com) or run `ngrok http ' + port + '` separately.');
      }
    } else {
      console.log(`\n  Online play: run \`npm run online\` (needs NGROK_AUTHTOKEN) or \`ngrok http ${port}\`.`);
    }
    console.log('');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
