'use strict';
// Minimal WebSocket (RFC 6455) client and frame codec, no dependencies, so tests can open
// websockets to arbitrary paths with arbitrary headers and send malformed frames too.

const crypto = require('crypto');
const { connect } = require('./http1');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptFor = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = true, fin = true } = {}) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2); header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = (fin ? 0x80 : 0) | opcode;
    if (!mask) return Buffer.concat([header, payload]);
    header[1] |= 0x80;
    const key = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
    return Buffer.concat([header, key, masked]);
}

// Incremental decoder: push bytes, get complete frames back.
class FrameDecoder {
    constructor() { this.buf = Buffer.alloc(0); }
    push(data) {
        this.buf = Buffer.concat([this.buf, data]);
        const frames = [];
        while (this.buf.length >= 2) {
            const b0 = this.buf[0], b1 = this.buf[1];
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) break; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
            const masked = !!(b1 & 0x80);
            const total = off + (masked ? 4 : 0) + len;
            if (this.buf.length < total) break;
            let payload = this.buf.slice(off + (masked ? 4 : 0), total);
            if (masked) {
                const key = this.buf.slice(off, off + 4);
                payload = Buffer.from(payload.map((v, i) => v ^ key[i & 3]));
            }
            frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload });
            this.buf = this.buf.slice(total);
        }
        return frames;
    }
}

// Open a websocket. Resolves { ok, status, response, socket, send(), close(), messages, onMessage }.
async function openWebSocket(entry, { host, path = '/', headers = [], timeout = 10000, extraHead = null, servername } = {}) {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = await connect(entry, { servername });
    const req = [
        `GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        ...headers.map(([k, v]) => `${k}: ${v}`),
    ].join('\r\n') + '\r\n\r\n';
    sock.write(req);
    if (extraHead) sock.write(extraHead);
    return await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        let done = false;
        const timer = setTimeout(() => finish({ ok: false, error: 'handshake timeout' }), timeout);
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!r.ok) sock.destroy();
            resolve(r);
        };
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            const eoh = buf.indexOf('\r\n\r\n');
            if (eoh < 0) return;
            const head = buf.slice(0, eoh).toString('latin1');
            const status = Number((/^HTTP\/1\.\d (\d{3})/.exec(head) || [])[1]);
            sock.removeListener('data', onData);
            if (status !== 101) {
                return finish({ ok: false, status, response: head, body: buf.slice(eoh + 4).toString('latin1').slice(0, 500) });
            }
            const accept = (/sec-websocket-accept:\s*(\S+)/i.exec(head) || [])[1];
            const ws = makeSocket(sock, buf.slice(eoh + 4));
            finish({ ok: true, status, response: head, acceptOk: accept === acceptFor(key), ...ws });
        };
        sock.on('data', onData);
        sock.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
        sock.on('close', () => finish({ ok: false, error: 'closed during handshake', response: buf.toString('latin1').slice(0, 500) }));
    });
}

function makeSocket(sock, leftover) {
    const decoder = new FrameDecoder();
    const messages = [];
    const waiters = [];
    let closed = false;
    let closeInfo = null;
    const deliver = (m) => {
        const w = waiters.shift();
        if (w) w(m); else messages.push(m);
    };
    const handle = (data) => {
        for (const f of decoder.push(data)) {
            if (f.opcode === 0x9) sock.write(encodeFrame(0xA, f.payload));       // ping → pong
            else if (f.opcode === 0x8) { closeInfo = { code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null, reason: f.payload.slice(2).toString() }; deliver({ close: closeInfo }); }
            else deliver({ opcode: f.opcode, data: f.payload, text: f.opcode === 1 ? f.payload.toString() : null, fin: f.fin });
        }
    };
    sock.on('data', handle);
    sock.on('close', () => { closed = true; while (waiters.length) waiters.shift()({ closed: true, close: closeInfo }); });
    if (leftover && leftover.length) handle(leftover);
    return {
        socket: sock,
        sendText: (s) => sock.write(encodeFrame(0x1, Buffer.from(s))),
        sendBinary: (b) => sock.write(encodeFrame(0x2, b)),
        sendRaw: (b) => sock.write(b),
        ping: (b = '') => sock.write(encodeFrame(0x9, Buffer.from(b))),
        close: (code = 1000) => { const p = Buffer.alloc(2); p.writeUInt16BE(code); try { sock.write(encodeFrame(0x8, p)); } catch (e) { /* gone */ } setTimeout(() => sock.destroy(), 200); },
        destroy: () => sock.destroy(),
        isClosed: () => closed,
        next: (timeout = 10000) => {
            if (messages.length) return Promise.resolve(messages.shift());
            if (closed) return Promise.resolve({ closed: true, close: closeInfo });
            return new Promise((resolve) => {
                const t = setTimeout(() => { const i = waiters.indexOf(fn); if (i >= 0) waiters.splice(i, 1); resolve({ timeout: true }); }, timeout);
                const fn = (m) => { clearTimeout(t); resolve(m); };
                waiters.push(fn);
            });
        },
    };
}

// the next dashboard snapshot on a status.ws connection, skipping the hub's other messages
// (since 2.2 a hub first says who the page is talking as: {"you": ...})
async function nextSnapshot(ws, ms = 4000) {
    const until = Date.now() + ms;
    for (;;) {
        const m = await ws.next(Math.max(1, until - Date.now()));
        if (!m.text) return m;
        let d = null;
        try { d = JSON.parse(m.text); } catch (e) { return m; }
        if (!d || !d.you) return m;
    }
}

module.exports = { encodeFrame, FrameDecoder, openWebSocket, acceptFor, makeSocket, nextSnapshot };
