'use strict';
// Raw HTTP/1.1 over TCP or TLS. Requests are written byte for byte (so malformed ones can
// be sent), and responses are parsed by hand (so nothing a front end does is hidden by a
// lenient client library).

const net = require('net');
const tls = require('tls');

// Parse as many complete responses as `buf` holds. `methods` lists the request method for
// each expected response in order (HEAD responses have no body). `closed` = the connection
// has ended, which completes a close-delimited body.
function parseResponses(buf, methods = [], closed = false) {
    const responses = [];
    let pos = 0;
    let reqIndex = 0;
    while (pos < buf.length) {
        let eoh = buf.indexOf('\r\n\r\n', pos);
        let sepLen = 4;
        if (eoh < 0) {
            const lf = buf.indexOf('\n\n', pos);
            if (lf < 0) break;
            eoh = lf; sepLen = 2;
        }
        const headText = buf.slice(pos, eoh).toString('latin1');
        const lines = headText.split(/\r?\n/);
        const statusLine = lines.shift();
        const m = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine);
        if (!m) {
            responses.push({ malformed: true, statusLine, raw: buf.slice(pos).toString('latin1').slice(0, 300) });
            pos = buf.length;
            break;
        }
        const headers = [];
        for (const line of lines) {
            const i = line.indexOf(':');
            if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
        }
        const status = Number(m[2]);
        const res = {
            version: m[1], status, statusText: m[3] || '', headers,
            header(name) { const h = headers.find(([k]) => k.toLowerCase() === name.toLowerCase()); return h ? h[1] : undefined; },
            headerAll(name) { return headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v); },
            headBytes: eoh + sepLen - pos,
        };
        let bodyStart = eoh + sepLen;
        if (status >= 100 && status < 200 && status !== 101) {
            res.interim = true;
            responses.push(res);
            pos = bodyStart;
            continue;
        }
        const method = methods[reqIndex] || 'GET';
        const te = (res.header('transfer-encoding') || '').toLowerCase();
        const cl = res.header('content-length');
        if (status === 101) {
            res.body = buf.slice(bodyStart);
            res.complete = true;
            responses.push(res);
            pos = buf.length;
            break;
        } else if (method === 'HEAD' || status === 204 || status === 304) {
            res.body = Buffer.alloc(0);
            res.complete = true;
            pos = bodyStart;
        } else if (te.includes('chunked')) {
            const chunks = [];
            let p = bodyStart;
            let done = false;
            while (true) {
                const le = buf.indexOf('\r\n', p);
                if (le < 0) break;
                const size = parseInt(buf.slice(p, le).toString('latin1').split(';')[0].trim(), 16);
                if (Number.isNaN(size)) { res.badChunk = true; done = true; p = buf.length; break; }
                if (size === 0) {
                    const end = buf.indexOf('\r\n\r\n', le);   // trailers end with a blank line
                    if (end < 0) break;
                    res.trailers = buf.slice(le + 2, end).toString('latin1');
                    p = end + 4;
                    done = true;
                    break;
                }
                if (le + 2 + size + 2 > buf.length) break;
                chunks.push(buf.slice(le + 2, le + 2 + size));
                p = le + 2 + size + 2;
            }
            res.body = Buffer.concat(chunks);
            res.complete = done;
            pos = done ? p : buf.length;
        } else if (cl !== undefined) {
            const n = Number(cl);
            res.body = buf.slice(bodyStart, bodyStart + n);
            res.complete = res.body.length === n;
            pos = bodyStart + res.body.length;
        } else {
            res.body = buf.slice(bodyStart);
            res.closeDelimited = true;
            res.complete = closed;
            pos = buf.length;
        }
        responses.push(res);
        reqIndex += 1;
        if (!res.complete) break;
    }
    return { responses, rest: buf.slice(pos) };
}

// Open a connection to the entry point (TCP, or TLS with the given SNI).
function connect(entry, opts = {}) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        let sock;
        const onErr = (e) => reject(e);
        if (entry.tls) {
            sock = tls.connect({
                host: entry.address || entry.host, port: entry.port,
                servername: opts.servername === undefined ? entry.servername : (opts.servername || undefined),
                rejectUnauthorized: !entry.insecure,
                ALPNProtocols: opts.alpn || ['http/1.1'],
                minVersion: opts.minVersion, maxVersion: opts.maxVersion,
            }, () => { sock.removeListener('error', onErr); sock.connectMs = Date.now() - t0; resolve(sock); });
        } else {
            sock = net.connect({ host: entry.address || entry.host, port: entry.port },
                () => { sock.removeListener('error', onErr); sock.connectMs = Date.now() - t0; resolve(sock); });
        }
        sock.once('error', onErr);
    });
}

// Send `writes` (strings/Buffers, numbers = pause in ms) and collect the answer.
//   expect:  number of final responses after which to stop (default 1); 0 = read until close/timeout
//   methods: request methods, to know which responses have no body
//   timeout: give up after this many ms (result.timedOut)
//   idleAfter: stop this many ms after the last byte, once at least one response arrived
async function exchange(entry, writes, opts = {}) {
    const expect = opts.expect === undefined ? 1 : opts.expect;
    const timeout = opts.timeout || 15000;
    const result = { data: Buffer.alloc(0), responses: [], closed: false, timedOut: false, error: null, firstByteMs: null, totalMs: null, chunkTimes: [] };
    const t0 = Date.now();
    let sock;
    try {
        sock = await connect(entry, opts);
    } catch (e) {
        result.error = e.code || e.message;
        result.totalMs = Date.now() - t0;
        return result;
    }
    return await new Promise((resolve) => {
        let finished = false;
        let idleTimer = null;
        const chunks = [];
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer); clearTimeout(idleTimer);
            result.data = Buffer.concat(chunks);
            const parsed = parseResponses(result.data, opts.methods, result.closed);
            result.responses = parsed.responses;
            result.final = parsed.responses.filter((r) => !r.interim);
            result.interim = parsed.responses.filter((r) => r.interim);
            result.response = result.final[0] || null;
            result.rest = parsed.rest;
            result.totalMs = Date.now() - t0;
            if (opts.keepOpen) result.socket = sock; else sock.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => { result.timedOut = true; finish(); }, timeout);
        sock.on('data', (d) => {
            if (result.firstByteMs === null) result.firstByteMs = Date.now() - t0;
            result.chunkTimes.push([Date.now() - t0, d.length]);
            chunks.push(d);
            if (opts.onData) opts.onData(d, sock);
            if (expect > 0) {
                const parsed = parseResponses(Buffer.concat(chunks), opts.methods, false);
                const done = parsed.responses.filter((r) => !r.interim && r.complete).length;
                if (done >= expect || parsed.responses.some((r) => r.malformed)) return finish();
            }
            if (opts.idleAfter) {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(finish, opts.idleAfter);
            }
        });
        sock.on('end', () => { result.closed = true; finish(); });
        sock.on('close', () => { result.closed = true; finish(); });
        sock.on('error', (e) => { result.error = e.code || e.message; result.closed = true; finish(); });
        (async () => {
            for (const w of writes) {
                if (finished) return;
                if (typeof w === 'number') { await new Promise((r) => setTimeout(r, w)); continue; }
                if (typeof w === 'function') { await w(sock); continue; }
                await new Promise((r) => { if (!sock.write(w)) sock.once('drain', r); else r(); });
            }
            if (opts.endAfterWrite) sock.end();
        })().catch((e) => { result.error = e.message; finish(); });
    });
}

// Build a well-formed request. headers: array of [name, value] (order and duplicates kept).
function buildRequest({ method = 'GET', path = '/', host, headers = [], body = null, chunked = false, version = 'HTTP/1.1', noContentLength = false }) {
    const lines = [`${method} ${path} ${version}`];
    if (host !== null && host !== undefined) lines.push(`Host: ${host}`);
    for (const [k, v] of headers) lines.push(`${k}: ${v}`);
    let bodyBuf = null;
    if (body !== null && body !== undefined) {
        bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        if (chunked) lines.push('Transfer-Encoding: chunked');
        else if (!noContentLength) lines.push(`Content-Length: ${bodyBuf.length}`);
    }
    const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    if (!bodyBuf) return head;
    if (chunked) {
        return Buffer.concat([head, Buffer.from(bodyBuf.length.toString(16) + '\r\n'), bodyBuf, Buffer.from('\r\n0\r\n\r\n')]);
    }
    return Buffer.concat([head, bodyBuf]);
}

// A persistent connection for sequential requests: send(bytes, method) resolves with the
// next complete response (or { closed / timedOut }).
async function session(entry, opts = {}) {
    const sock = await connect(entry, opts);
    let buf = Buffer.alloc(0);
    let closed = false;
    const methods = [];
    let consumed = 0;          // responses already handed out
    let waiter = null;
    const check = () => {
        if (!waiter) return;
        const parsed = parseResponses(buf, methods, closed);
        const finals = parsed.responses.filter((r) => !r.interim && (r.complete || r.malformed));
        if (finals.length > consumed) {
            const w = waiter; waiter = null;
            w.resolve(finals[consumed++]);
        } else if (closed) {
            const w = waiter; waiter = null;
            w.resolve({ closed: true, partial: parsed.responses[consumed] || null, raw: buf.toString('latin1').slice(-300) });
        }
    };
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); check(); });
    sock.on('close', () => { closed = true; check(); });
    sock.on('error', () => { closed = true; check(); });
    return {
        socket: sock,
        isClosed: () => closed,
        all: () => parseResponses(buf, methods, closed),
        raw: () => buf,
        send(bytes, { method = 'GET', methodsInside = null, timeout = 15000 } = {}) {
            if (methodsInside) methods.push(...methodsInside); else methods.push(method);
            if (!closed) sock.write(bytes);
            return this.next(timeout);
        },
        next(timeout = 15000) {
            return new Promise((resolve) => {
                const t = setTimeout(() => { waiter = null; resolve({ timedOut: true }); }, timeout);
                waiter = { resolve: (r) => { clearTimeout(t); resolve(r); } };
                check();
            });
        },
        close() { sock.destroy(); },
    };
}

module.exports = { parseResponses, connect, exchange, buildRequest, session };
