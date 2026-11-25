'use strict';
// Malformed and unusual requests, one test each. The front end should refuse what's
// broken (4xx or close); nothing may crash the hub or a device (checked after each test),
// and anything that does get through must reach the right device.

const { exchange } = require('../lib/http1');
const { describe } = require('../lib/checks');

// expect: 'reject' (should never reach the device) or 'any' (legal or tolerable; report only)
const CASES = [
    ['garbage instead of a request', 'reject', () => 'HELLO WORLD\r\n\r\n'],
    ['HTTP/0.9 request', 'reject', (id) => `GET /t/echo?id=${id}\r\n\r\n`],
    ['no HTTP version', 'reject', (id, H) => `GET /t/echo?id=${id}\r\nHost: ${H}\r\n\r\n`],
    ['HTTP/1.1 without Host', 'reject', (id) => `GET /t/echo?id=${id} HTTP/1.1\r\nX-A: b\r\n\r\n`],
    ['HTTP/1.0 without Host', 'any', (id) => `GET /t/echo?id=${id} HTTP/1.0\r\n\r\n`],
    ['two Host headers for two devices', 'reject', (id, H, HB) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nHost: ${HB}\r\n\r\n`],
    ['space before the colon', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost : ${H}\r\n\r\n`],
    ['header line without a colon', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nNoColonHere\r\n\r\n`],
    ['obsolete line folding', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nX-Fold: a\r\n b\r\n\r\n`],
    ['NUL byte in a header', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nX-Nul: a\x00b\r\n\r\n`],
    ['bare CR in a header', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nX-Cr: a\rb\r\n\r\n`],
    ['LF-only line endings', 'any', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\nHost: ${H}\n\n`],
    ['tabs between request-line parts', 'any', (id, H) => `GET\t/t/echo?id=${id}\tHTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['several spaces between request-line parts', 'any', (id, H) => `GET   /t/echo?id=${id}   HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['invalid characters in the method', 'reject', (id, H) => `G@T /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['lower-case method', 'any', (id, H) => `get /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['HTTP/9.9', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/9.9\r\nHost: ${H}\r\n\r\n`],
    ['HTTP/1.2', 'any', (id, H) => `GET /t/echo?id=${id} HTTP/1.2\r\nHost: ${H}\r\n\r\n`],
    ['HTTP/2 preface over HTTP/1', 'reject', () => 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
    ['space inside the URL', 'reject', (id, H) => `GET /t/echo?id=${id}&x=a b HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['control character in the URL', 'reject', (id, H) => `GET /t/echo?id=${id}&x=\x01 HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['raw UTF-8 in the URL', 'any', (id, H) => Buffer.from(`GET /t/echo?id=${id}&x=é✓ HTTP/1.1\r\nHost: ${H}\r\n\r\n`, 'utf8')],
    ['URL that does not start with /', 'any', (id, H) => `GET t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['asterisk URL on GET', 'reject', (id, H) => `GET * HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['OPTIONS *', 'any', (id, H) => `OPTIONS * HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['CONNECT to another host', 'reject', (id, H) => `CONNECT example.com:443 HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['TRACE', 'any', (id, H) => `TRACE /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nCookie: secret=1\r\n\r\n`],
    ['blank lines before the request', 'any', (id, H) => `\r\n\r\nGET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['64 KB header line', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nX-Long: ${'a'.repeat(65536)}\r\n\r\n`],
    ['5000 headers', 'reject', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n${Array.from({ length: 5000 }, (_, i) => `X-${i}: v`).join('\r\n')}\r\n\r\n`],
    ['100 KB URL', 'reject', (id, H) => `GET /t/echo?id=${id}&x=${'u'.repeat(100000)} HTTP/1.1\r\nHost: ${H}\r\n\r\n`],
    ['Content-Length that is not a number', 'reject', (id, H) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nContent-Length: abc\r\n\r\nxyz`],
    ['negative Content-Length', 'reject', (id, H) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nContent-Length: -1\r\n\r\nxyz`],
    ['gigantic Content-Length, then nothing', 'any', (id, H) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nContent-Length: 99999999999999999999\r\n\r\nxyz`],
    ['unknown Transfer-Encoding', 'reject', (id, H) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nTransfer-Encoding: gzip\r\n\r\nxyz`],
    ['Expect with an unknown value', 'any', (id, H) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nExpect: sandwich\r\nContent-Length: 3\r\n\r\nxyz`],
    ['empty Host', 'any', (id) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: \r\n\r\n`],
    ['Host is an IP address', 'any', (id) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`],
    ['Host with a 300-character label', 'any', (id, H, HB, base) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${'x'.repeat(300)}.${base}\r\n\r\n`],
    ['Host with path characters', 'any', (id, H, HB, base) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: a/../b.${base}\r\n\r\n`],
    ['Host with a percent-encoded dot', 'any', (id, H, HB, base) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: a%2eb.${base}\r\n\r\n`],
    ['h2c upgrade request', 'any', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\nConnection: Upgrade, HTTP2-Settings\r\n\r\n`],
    ['request never finished (no blank line)', 'any', (id, H) => `GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\nX-Waiting: yes\r\n`],
];

const tests = CASES.map(([label, expect, make], i) => ({
    id: `M${String(i + 1).padStart(2, '0')}`,
    category: 'malformed',
    name: label,
    timeout: 30000,
    async run(h, r) {
        const id = h.id('A');
        const bytes = make(id, h.hostHeader('A'), h.hostHeader('B'), h.base);
        const x = await exchange(h.entry(h.devices.A.host), [bytes], { timeout: 12000, expect: 1 });
        const reachedA = h.devices.A.target.find(id);
        const reachedB = h.devices.B.target.find(id);
        const what = `${describe(x)}${reachedA ? ', reached device A' : ''}${reachedB ? ', reached device B' : ''}`;
        if (reachedB) r.fail(`a request meant for A reached device B: ${what}`);
        else if (expect === 'reject' && reachedA) r.warn(`passed to the device instead of being refused: ${what}`);
        else if (x.timedOut && !x.data.length) r.info(`connection left open with no answer for ${x.totalMs} ms`);
        else r.pass(what);
        if (label === 'TRACE' && x.response && x.response.body.toString().includes('secret=1') && x.response.header('content-type') === 'message/http') r.warn('TRACE is reflected (cross-site tracing)');
    },
}));

// Absolute-form URL naming device B while Host names device A: which one gets it?
tests.push({
    id: 'M99', category: 'malformed', name: 'absolute URL for one device, Host header for another',
    async run(h, r) {
        const id = `X-${Date.now().toString(36)}`;
        const x = await exchange(h.entry(h.devices.A.host), [`GET http://${h.hostHeader('B')}/t/echo?id=${id} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\n\r\n`], { timeout: 10000 });
        const a = h.devices.A.target.find(id);
        const b = h.devices.B.target.find(id);
        r.info(`${describe(x)}; delivered to ${a ? 'A (the Host header)' : b ? 'B (the URL)' : 'neither'}. The front end and the hub must agree on which one wins`);
    },
});

module.exports = tests;
