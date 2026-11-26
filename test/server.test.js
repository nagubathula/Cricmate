import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const w = waiters.findIndex((x) => x.t === m.t);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (t) =>
      new Promise((resolve) => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) resolve(inbox.splice(i, 1)[0]);
        else waiters.push({ t, resolve });
      }),
  };
}

test('rooms: create, join, relay, signal, leave', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const host = client(port);
    const guest = client(port);
    await Promise.all([host.open(), guest.open()]);

    host.send({ t: 'create', name: 'Host<script>' });
    const { code } = await host.next('created');
    assert.match(code, /^[A-Z]{4}$/);

    guest.send({ t: 'join', code: code.toLowerCase(), name: 'Guest' });
    const joined = await guest.next('joined');
    assert.equal(joined.peerName, 'Hostscript');
    assert.equal((await host.next('peer-joined')).name, 'Guest');

    const third = client(port);
    await third.open();
    third.send({ t: 'join', code, name: 'X' });
    assert.match((await third.next('error')).msg, /full/);
    third.ws.close();

    host.send({ t: 'relay', data: { s: 0, m: { t: 'setup' } } });
    assert.deepEqual((await guest.next('relay')).data, { s: 0, m: { t: 'setup' } });
    guest.send({ t: 'signal', data: { sdp: 'x' } });
    assert.deepEqual((await host.next('signal')).data, { sdp: 'x' });

    guest.ws.close();
    await host.next('peer-left');
    host.ws.close();

    const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.ok(Array.isArray(info.lan));
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const bad = await fetch(`http://127.0.0.1:${port}/..%2Fserver.js`);
    assert.notEqual(bad.status, 200);
  } finally {
    server.close();
  }
});
