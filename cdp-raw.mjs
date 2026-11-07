// CDP raw WebSocket — без внешних зависимостей (только node:net/crypto/http).
// Переиспользуется тестами: test-cdp.mjs, diag-sticky.mjs и т.д.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

export async function waitForChrome(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/json/version`);
      if (r.status === 200 && /Browser/.test(r.body)) return JSON.parse(r.body);
    } catch {}
    await sleep(300);
  }
  throw new Error('DevTools-эндпоинт Chrome не появился за ' + timeoutMs + ' мс');
}

export class CDP {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
    this.pending = new Map();
    this.listeners = [];
    this.idSeq = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      sock.once('error', (e) => { if (!this.headerDone) fail(e); else sock.destroy(); });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        try {
          while (true) {
            if (!this.headerDone) {
              const i = this.buf.indexOf('\r\n\r\n');
              if (i < 0) break;
              const statusLine = this.buf.subarray(0, i).toString('latin1').split('\n')[0];
              if (!/ 101 /.test(' ' + statusLine)) { fail(new Error('WS handshake: ' + statusLine)); return; }
              this.headerDone = true;
              this.buf = this.buf.subarray(i + 4);
              settled = true;
              resolve();
              continue;
            }
            if (!this.readFrame()) break;
          }
        } catch (e) { fail(e); }
      });
      sock.once('connect', () => {
        sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
    });
  }

  readFrame() {
    if (this.buf.length < 2) return false;
    const opcode = this.buf[0] & 0x0f;
    let len = this.buf[1] & 0x7f;
    let off = 2;
    const masked = !!(this.buf[1] & 0x80);
    if (len === 126) {
      if (this.buf.length < 4) return false;
      len = this.buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (this.buf.length < 10) return false;
      len = Number(this.buf.readBigUInt64BE(2)); off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (this.buf.length < off + maskLen + len) return false;
    const mk = masked ? this.buf.subarray(off, off + 4) : null;
    let payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
    if (mk) for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
    this.buf = this.buf.subarray(off + maskLen + len);

    if (opcode === 8) { this.sock.end(); return false; } // close
    if (opcode === 9 && payload.length <= 125) { // ping → pong
      const head = Buffer.from([0x8a, payload.length | 0x80]);
      const m = crypto.randomBytes(4);
      const p = Buffer.from(payload);
      for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
      this.sock.write(Buffer.concat([head, m, p]));
      return true;
    }
    if (opcode === 1 || opcode === 2) {
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { return true; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    }
    return true;
  }

  sendFrame(opcode, payloadBuf) {
    const masked = crypto.randomBytes(4);
    let head;
    if (payloadBuf.length < 126) head = Buffer.from([opcode | 0x80, payloadBuf.length | 0x80]);
    else if (payloadBuf.length < 65536) {
      head = Buffer.alloc(4); head[0] = opcode | 0x80; head[1] = 126 | 0x80; head.writeUInt16BE(payloadBuf.length, 2);
    } else {
      // 127-кодирование: байт 1 = 0x80|127, длина — 8 байт с ОФСЕТОМ 2 (а не с 1!)
      head = Buffer.alloc(9); head[0] = opcode | 0x80; head[1] = 127 | 0x80; head.writeBigUInt64BE(BigInt(payloadBuf.length), 2);
    }
    const p = Buffer.from(payloadBuf);
    for (let i = 0; i < p.length; i++) p[i] ^= masked[i & 3];
    this.sock.write(Buffer.concat([head, masked, p]));
  }

  send(method, params = {}) {
    const id = this.idSeq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 15000);
      this.sendFrame(0x81, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
    });
  }

  onEvent(fn) { this.listeners.push(fn); }

  close() { try { this.sock.end(); } catch {} }
}
