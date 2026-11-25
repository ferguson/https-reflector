'use strict';
// Devices that misbehave: broken answers, dropped connections, silence, being offline.

const { buildRequest, exchange, session } = require('../lib/http1');
const { echoOf, describe } = require('../lib/checks');
const { sleep } = require('../lib/util');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64url');

// ask device A to answer with exactly these bytes
function rawAnswer(h, bytes, close = true) {
    return h.request('A', { path: `/t/raw?close=${close ? 1 : ''}&b64=${b64(bytes)}`, timeout: 12000 });
}

module.exports = [
    {
        id: 'D01', category: 'device', name: 'device drops the connection mid-answer',
        async run(h, r) {
            const x = await h.request('A', { path: '/t/cut?n=300000', timeout: 20000 });
            if (x.timedOut) r.fail(`the browser was left hanging for ${x.totalMs} ms after the device dropped the connection`);
            else if (x.response && x.response.complete) r.fail('a cut-off answer was delivered as COMPLETE (the browser would cache/use a truncated file)');
            else r.pass(`browser sees ${x.response ? `a truncated answer (${x.response.body.length} bytes)` : describe(x)} after ${x.totalMs} ms`);
        },
    },
    {
        id: 'D02', category: 'device', name: 'device never answers', timeout: 70000,
        async run(h, r) {
            const x = await h.request('A', { path: '/t/hang', timeout: 60000 });
            r.info(`after a silent device the browser sees: ${describe(x)}`);
        },
    },
    {
        id: 'D03', category: 'device', name: 'device answers with garbage (not HTTP)',
        async run(h, r) {
            const x = await rawAnswer(h, 'SSH-2.0-OpenSSH_9.0\r\nthis is not http at all\r\n\r\n');
            const res = x.response;
            if (res && res.malformed) r.info(`the garbage was passed to the browser as is (${JSON.stringify(res.statusLine)})`);
            else r.info(`browser sees ${describe(x)}`);
        },
    },
    {
        id: 'D04', category: 'device', name: 'extra bytes after a device\'s answer never reach the next request',
        async run(h, r) {
            // a buggy/hostile device answers, then appends a second, forged answer
            const forged = 'HTTP/1.1 200 OK\r\nContent-Length: 8\r\nX-Forged: yes\r\n\r\nINJECTED';
            const s = await session(h.entry(h.devices.A.host));
            try {
                const first = await s.send(buildRequest({ path: `/t/raw?b64=${b64('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nfirst' + forged)}&id=${h.id('A')}`, host: h.hostHeader('A') }));
                const id2 = h.id('A');
                const second = await s.send(buildRequest({ path: `/t/echo?id=${id2}`, host: h.hostHeader('A') }), { timeout: 6000 });
                if (second.header && second.header('x-forged')) {
                    r.warn('on the same browser connection, the next request got the device\'s forged answer. Harmless while one connection = one device (the browser is talking to that device anyway), but fatal if a front end ever reuses a connection for another device or user');
                } else {
                    r.pass(`first answer ${first.status || describe(first)}, next request ${second.status ? `got its own answer (${second.status})` : describe(second)}`);
                }
            } finally { s.close(); }
        },
    },
    {
        id: 'D05', category: 'device', name: 'device answers with conflicting or broken framing',
        async run(h, r) {
            const cases = [
                ['Content-Length and Transfer-Encoding both', 'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'],
                ['two different Content-Lengths', 'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 5\r\n\r\nhello'],
                ['bad chunk size', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nhello\r\n0\r\n\r\n'],
                ['Content-Length larger than the body', 'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nshort'],
                ['status line without reason', 'HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nok'],
                ['LF-only line endings', 'HTTP/1.1 200 OK\nContent-Length: 2\n\nok'],
                ['header with CR in the value', 'HTTP/1.1 200 OK\r\nX-Bad: a\rb\r\nContent-Length: 2\r\n\r\nok'],
                ['HTTP/1.0 answer', 'HTTP/1.0 200 OK\r\n\r\nold style body'],
                ['101 to a plain request', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: nonsense\r\nConnection: Upgrade\r\n\r\nraw bytes'],
                ['1 MB header', `HTTP/1.1 200 OK\r\nX-Huge: ${'h'.repeat(1 << 20)}\r\nContent-Length: 2\r\n\r\nok`],
            ];
            for (const [label, bytes] of cases) {
                const x = await rawAnswer(h, bytes);
                r.info(`${label}: browser sees ${x.response && x.response.malformed ? 'the raw bytes' : describe(x)}`);
                if (!(await h.canary('A', 6000))) { r.fail(`${label}: the device became unreachable`); return; }
            }
        },
    },
    {
        id: 'D06', category: 'device', name: 'device\'s local server is down',
        async run(h, r) {
            const t = h.devices.A.target;
            await t.stop();
            const x = await h.request('A', { timeout: 15000 });
            await t.restart();
            if (x.timedOut) r.warn(`with the device's web server down the browser hangs (${x.totalMs} ms, no answer)`);
            else r.info(`with the device's web server down the browser sees ${describe(x)}`);
            await sleep(500);
        },
    },
    {
        id: 'D07', category: 'device', name: 'a device that is not connected',
        async run(h, r) {
            const ghost = `ghost-${Date.now().toString(36)}.${h.base}`;
            for (const [method, body] of [['GET', null], ['POST', '{"x":1}'], ['HEAD', null]]) {
                const x = await exchange(h.entry(ghost), [buildRequest({ method, path: '/anything?x=1', host: ghost + h.hostPort, body })], { timeout: 10000, methods: [method] });
                if (x.timedOut) r.fail(`${method} to an offline device hangs`);
                else r.info(`${method} to an offline device: ${describe(x)}`);
            }
        },
    },
    {
        id: 'D08', category: 'device', name: 'device answers every request on a kept-alive connection correctly after errors',
        async run(h, r) {
            const s = await session(h.entry(h.devices.A.host));
            try {
                for (const p of ['/t/status?code=500', '/t/status?code=404', '/t/echo', '/t/status?code=304', '/t/echo']) {
                    const id = h.id('A');
                    const res = await s.send(buildRequest({ path: `${p}${p.includes('?') ? '&' : '?'}id=${id}`, host: h.hostHeader('A') }));
                    if (res.closed || res.timedOut) { r.info(`connection ended after ${p}`); return; }
                    if (p === '/t/echo' && (echoOf(res) || {}).id !== id) { r.fail(`after error answers, ${p} got the wrong answer`); return; }
                }
                r.pass('answers stayed in step');
            } finally { s.close(); }
        },
    },
];
