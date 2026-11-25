'use strict';
// The "device": the local web server a device client tunnels to (an Otto, a Jibo). It
// records everything that reaches it, so a test can check what actually arrived, and it
// can answer in every way a real or broken device might.
//
// Every route is /t/<behavior>?<params>. A request's id comes from ?id= or x-torture-id.

const http = require('http');
const zlib = require('zlib');
const { genBytes, sha } = require('./util');
const { acceptFor, encodeFrame, FrameDecoder } = require('./ws');

class Target {
    constructor(label) {
        this.label = label;
        this.log = [];          // { kind, id, method, url, rawHeaders, host, bodyLength, bodySha, t }
        this.hung = new Set();  // sockets held open by /t/hang
        this.upgraded = new Set();  // upgraded sockets (the HTTP server no longer tracks them)
        this.waiters = [];
    }

    start() {
        this.server = http.createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 5000 });
        this.server.on('request', (req, res) => this.onRequest(req, res));
        this.server.on('checkContinue', (req, res) => this.onCheckContinue(req, res));
        this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
        this.server.on('clientError', (err, socket) => {
            // something reached the device that its HTTP parser rejected
            this.record({ kind: 'clientError', error: err.code || err.message, rawPacket: err.rawPacket ? err.rawPacket.toString('latin1').slice(0, 400) : null });
            if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        });
        return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
            this.port = this.server.address().port;
            resolve(this.port);
        }));
    }

    // stop listening and drop every connection (resolves at once; close() waits for nothing)
    stop() {
        this.releaseHangs();
        for (const s of this.upgraded) s.destroy();
        this.upgraded.clear();
        this.server.close();
        this.server.closeAllConnections();
        return Promise.resolve();
    }

    // listen again on the same port after stop()
    restart() {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
        });
    }

    record(entry) {
        entry.t = Date.now();
        entry.target = this.label;
        this.log.push(entry);
        if (this.log.length > 20000) this.log.splice(0, 5000);
        for (const w of [...this.waiters]) {
            if (w.match(entry)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(entry); }
        }
    }

    find(id) { return this.log.find((e) => e.id === id); }
    findAll(id) { return this.log.filter((e) => e.id === id); }
    since(t) { return this.log.filter((e) => e.t >= t); }

    waitFor(id, ms = 5000) {
        const hit = this.find(id);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve) => {
            const w = { match: (e) => e.id === id, resolve };
            this.waiters.push(w);
            setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(null); } }, ms);
        });
    }

    releaseHangs() {
        for (const s of this.hung) s.destroy();
        this.hung.clear();
    }

    parse(req) {
        const u = new URL(req.url, 'http://x');
        const q = Object.fromEntries(u.searchParams.entries());
        const behavior = u.pathname.startsWith('/t/') ? u.pathname.slice(3).split('/')[0] : '';
        const id = q.id || req.headers['x-torture-id'] || null;
        return { u, q, behavior, id };
    }

    onCheckContinue(req, res) {
        const { behavior } = this.parse(req);
        if (behavior === 'early') {            // answer before (and without) the body
            this.record({ kind: 'request', ...this.describe(req), bodyLength: null, early: true });
            res.writeHead(401, { 'Content-Length': 5, 'Connection': 'close' });
            res.end('nope\n');
            return;
        }
        if (behavior !== 'no100') res.writeContinue();   // /t/no100 ignores Expect like some servers do
        this.server.emit('request', req, res);
    }

    describe(req) {
        const { id, behavior, q } = this.parse(req);
        return {
            id, behavior, q, method: req.method, url: req.url, httpVersion: req.httpVersion,
            rawHeaders: req.rawHeaders, host: req.headers.host,
            remote: req.socket.remoteAddress,
        };
    }

    onRequest(req, res) {
        const info = this.describe(req);
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { chunks.push(c); size += c.length; });
        req.on('error', () => {});
        req.on('end', () => {
            const body = Buffer.concat(chunks, size);
            info.bodyLength = size;
            info.bodySha = sha(body);
            info.bodyHead = body.slice(0, 200).toString('latin1');
            info.trailers = req.rawTrailers && req.rawTrailers.length ? req.rawTrailers : null;
            this.record({ kind: 'request', ...info });
            try {
                this.respond(info, req, res, body);
            } catch (e) {
                res.writeHead(500); res.end('target error ' + e.message);
            }
        });
    }

    respond(info, req, res, body) {
        const q = info.q;
        const n = Number(q.n || 0);
        const seed = Number(q.seed || 1);
        switch (info.behavior) {
        case 'echo': {
            const out = Buffer.from(JSON.stringify({
                target: this.label, id: info.id, method: info.method, url: info.url, host: info.host,
                rawHeaders: info.rawHeaders, bodyLength: info.bodyLength, bodySha: info.bodySha,
                trailers: info.trailers, httpVersion: info.httpVersion,
            }));
            res.writeHead(Number(q.code || 200), { 'Content-Type': 'application/json', 'Content-Length': out.length, 'x-torture-id': info.id || '' });
            return res.end(info.method === 'HEAD' ? undefined : out);
        }
        case 'bytes': {   // n deterministic bytes; chunked=1, close=1 (no length, close-delimited)
            const data = genBytes(n, seed);
            const headers = { 'Content-Type': 'application/octet-stream', 'x-sha256': sha(data), 'x-torture-id': info.id || '' };
            if (q.close) {
                headers.Connection = 'close';
                res.socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nx-sha256: ${headers['x-sha256']}\r\nConnection: close\r\n\r\n`);
                res.socket.end(data);
                return;
            }
            if (!q.chunked) headers['Content-Length'] = n;
            res.writeHead(200, headers);
            if (info.method === 'HEAD') return res.end();
            if (q.chunked) {
                const piece = Number(q.piece || 16384);
                for (let i = 0; i < data.length; i += piece) res.write(data.slice(i, i + piece));
                return res.end();
            }
            return res.end(data);
        }
        case 'status': {
            const code = Number(q.code || 200);
            res.statusMessage = q.text || http.STATUS_CODES[code] || 'Whatever';
            const b = (code === 204 || code === 304) ? '' : `status ${code}\n`;
            res.writeHead(code, { 'Content-Length': Buffer.byteLength(b), 'x-torture-id': info.id || '' });
            return res.end(b);
        }
        case 'headers': {  // many / big / duplicate response headers
            const count = Number(q.count || 0);
            const size = Number(q.size || 0);
            const raw = [['Content-Type', 'text/plain'], ['x-torture-id', info.id || '']];
            for (let i = 0; i < count; i++) raw.push([`X-Many-${i}`, `value-${i}`]);
            if (size) raw.push(['X-Big', 'b'.repeat(size)]);
            const cookies = Number(q.cookies || 0);
            for (let i = 0; i < cookies; i++) raw.push(['Set-Cookie', `c${i}=v${i}; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT`]);
            res.writeHead(200, raw.flat());
            return res.end('ok\n');
        }
        case 'slow': {     // headers only after ms
            const timer = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain', 'x-torture-id': info.id || '' }); res.end('slow ok\n'); }, Number(q.ms || 1000));
            res.on('close', () => clearTimeout(timer));
            return;
        }
        case 'drip': {     // chunks one at a time, interval ms apart (buffering detector)
            const count = Number(q.count || 5);
            const interval = Number(q.interval || 500);
            res.writeHead(200, { 'Content-Type': q.sse ? 'text/event-stream' : 'text/plain', 'Cache-Control': 'no-cache', 'x-torture-id': info.id || '' });
            let i = 0;
            const tick = () => {
                if (res.destroyed) return;
                res.write(q.sse ? `data: ${i} ${Date.now()}\n\n` : `chunk ${i} ${Date.now()}\n`);
                if (++i >= count) return res.end();
                setTimeout(tick, interval);
            };
            return tick();
        }
        case 'hang': {     // never answer
            this.hung.add(req.socket);
            req.socket.on('close', () => this.hung.delete(req.socket));
            return;
        }
        case 'cut': {      // headers + part of the body, then drop the connection
            res.writeHead(200, { 'Content-Length': n || 100000, 'x-torture-id': info.id || '' });
            res.write(genBytes(Math.floor((n || 100000) / 3), seed));
            setTimeout(() => req.socket.destroy(), 100);
            return;
        }
        case 'raw': {      // arbitrary response bytes (base64url in ?b64=), then close if ?close=1
            const bytes = Buffer.from(q.b64 || '', 'base64url');
            req.socket.write(bytes);
            if (q.close) req.socket.end();
            return;
        }
        case 'gzip': {
            const plain = Buffer.from('gzip body '.repeat(1000));
            const gz = zlib.gzipSync(plain);
            res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain', 'Content-Length': gz.length, 'x-sha256': sha(gz), 'x-plain-sha256': sha(plain) });
            return res.end(gz);
        }
        case 'trailers': {
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Trailer': 'X-Checksum' });
            res.write('body with a trailer\n');
            res.addTrailers({ 'X-Checksum': 'abc123' });
            return res.end();
        }
        case 'hints': {
            if (res.writeEarlyHints) res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' });
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('after hints\n');
        }
        case 'redirect': {
            res.writeHead(Number(q.code || 302), { Location: q.to || '/t/echo', 'Content-Length': 0 });
            return res.end();
        }
        case 'no100':
        default: {
            const out = `got ${info.bodyLength} bytes for ${info.method} ${info.url}\n`;
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(out), 'x-torture-id': info.id || '' });
            return res.end(out);
        }
        }
    }

    onUpgrade(req, socket, head) {
        const info = this.describe(req);
        this.upgraded.add(socket);
        socket.on('close', () => this.upgraded.delete(socket));
        this.record({ kind: 'upgrade', ...info, headLength: head.length, head: head.toString('latin1').slice(0, 200) });
        if (info.behavior === 'ws') {          // real websocket echo
            const key = req.headers['sec-websocket-key'];
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`);
            const dec = new FrameDecoder();
            const onData = (d) => {
                for (const f of dec.push(d)) {
                    if (f.opcode === 0x8) { socket.end(encodeFrame(0x8, f.payload, { mask: false })); return; }
                    if (f.opcode === 0x9) { socket.write(encodeFrame(0xA, f.payload, { mask: false })); continue; }
                    if (f.opcode === 0x1 || f.opcode === 0x2) socket.write(encodeFrame(f.opcode, f.payload, { mask: false }));
                }
            };
            if (head.length) onData(head);
            socket.on('data', onData);
            socket.on('error', () => {});
            return;
        }
        if (info.behavior === 'refuse') {      // not an upgrade after all: plain answer, keep reading
            socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 10\r\n\r\nno upgrade');
            socket.on('data', (d) => this.record({ kind: 'afterRefusedUpgrade', id: info.id, data: d.toString('latin1').slice(0, 400) }));
            socket.on('error', () => {});
            setTimeout(() => socket.destroy(), 5000);
            return;
        }
        // raw echo: 101 then echo bytes in upper case
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
        if (head.length) socket.write(head.toString('latin1').toUpperCase());
        socket.on('data', (d) => socket.write(d.toString('latin1').toUpperCase()));
        socket.on('error', () => {});
    }
}

module.exports = Target;
