// Network transport.
// 1. Connects to the host's server over WebSocket (same origin → works on LAN and through ngrok).
// 2. Joins/creates a room; game messages are relayed by the server.
// 3. In parallel, tries to open a direct WebRTC DataChannel (P2P). If it opens, game traffic
//    moves to it; if it fails or drops, the WebSocket relay keeps the match going.
// Messages carry sequence numbers so switching channels never reorders or duplicates them.

const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};
const P2P_TIMEOUT = 8000;

export class Net {
  constructor() {
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.mode = 'relay';
    this.onMessage = () => {};
    this.onEvent = () => {};
    this._pending = null;
    this._pendingIce = [];
    this._resetSeq();
  }

  _resetSeq() {
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.inbox = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`);
      } catch (e) {
        reject(new Error('Cannot open a WebSocket here'));
        return;
      }
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('Game server not reachable. Start it with `npm start` — vs AI still works offline.'));
      };
      ws.onclose = () => {
        if (opened) this.onEvent('closed');
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        this._onServer(m);
      };
    });
  }

  _server(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _request(obj) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._server(obj);
    });
  }
  create(name) {
    this.role = 'host';
    return this._request({ t: 'create', name });
  }
  join(code, name) {
    this.role = 'guest';
    return this._request({ t: 'join', code, name });
  }

  _settle(ok, value) {
    const p = this._pending;
    this._pending = null;
    if (p) ok ? p.resolve(value) : p.reject(new Error(value));
    return !!p;
  }

  _onServer(m) {
    switch (m.t) {
      case 'created':
        this.code = m.code;
        this._settle(true, m.code);
        break;
      case 'joined':
        this.code = m.code;
        this._resetSeq();
        this._settle(true, m);
        break;
      case 'peer-joined':
        this._resetSeq();
        this.onEvent('peer-joined', m.name);
        this._startP2P(true);
        break;
      case 'peer-left':
        this._closeP2P();
        this.onEvent('peer-left', m);
        break;
      case 'relay':
        this._receive(m.data);
        break;
      case 'signal':
        this._onSignal(m.data);
        break;
      case 'error':
        if (!this._settle(false, m.msg)) this.onEvent('error', m.msg);
        break;
    }
  }

  send(msg) {
    const packet = { s: this.sendSeq++, m: msg };
    if (this.dc?.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(packet));
        return;
      } catch {
        /* fall back to relay */
      }
    }
    this._server({ t: 'relay', data: packet });
  }

  _receive(packet) {
    if (!packet || typeof packet.s !== 'number') return;
    if (packet.s < this.recvSeq || this.inbox.has(packet.s)) return; // duplicate
    this.inbox.set(packet.s, packet.m);
    while (this.inbox.has(this.recvSeq)) {
      const m = this.inbox.get(this.recvSeq);
      this.inbox.delete(this.recvSeq++);
      this.onMessage(m);
    }
  }

  // ---------- WebRTC P2P ----------
  async _startP2P(initiator) {
    if (typeof RTCPeerConnection === 'undefined') return;
    this._closeP2P();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    this._pendingIce = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) this._server({ t: 'signal', data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && this.pc === pc) this._setMode('relay');
    };
    this._p2pTimer = setTimeout(() => {
      if (this.pc === pc && this.dc?.readyState !== 'open') {
        this._closeP2P();
        this.onEvent('transport', 'relay');
      }
    }, P2P_TIMEOUT);

    if (initiator) {
      this._setupChannel(pc.createDataChannel('game', { ordered: true }));
      try {
        await pc.setLocalDescription(await pc.createOffer());
        this._server({ t: 'signal', data: { sdp: pc.localDescription } });
      } catch {
        this._closeP2P();
      }
    } else {
      pc.ondatachannel = (e) => this._setupChannel(e.channel);
    }
  }

  async _onSignal(data) {
    if (!data) return;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') await this._startP2P(false);
        const pc = this.pc;
        if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this._server({ t: 'signal', data: { sdp: pc.localDescription } });
        }
        for (const c of this._pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate && this.pc) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => {});
        else this._pendingIce.push(data.candidate);
      }
    } catch {
      /* P2P is best effort; relay keeps working */
    }
  }

  _setupChannel(dc) {
    this.dc = dc;
    dc.onopen = () => this._setMode('p2p');
    dc.onclose = () => this.dc === dc && this._setMode('relay');
    dc.onmessage = (e) => {
      try {
        this._receive(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'p2p') clearTimeout(this._p2pTimer);
    this.onEvent('transport', mode);
  }

  _closeP2P() {
    clearTimeout(this._p2pTimer);
    const { dc, pc } = this;
    this.dc = null;
    this.pc = null;
    try {
      dc?.close();
      pc?.close();
    } catch {
      /* ignore */
    }
    this._setMode('relay');
  }

  close() {
    this._closeP2P();
    this._server({ t: 'leave' });
    if (this.ws) this.ws.onclose = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
