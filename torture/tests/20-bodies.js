'use strict';
// Request and response bodies of every size, framing and timing.

const { buildRequest, exchange } = require('../lib/http1');
const { describe } = require('../lib/checks');
const { genBytes, sha, fmtBytes } = require('../lib/util');

// send a body to device A with the given writes; check what arrived
async function sendBody(h, r, label, makeWrites, expectedBody, opts = {}) {
    const id = h.id('A');
    const writes = makeWrites(id);
    const x = await exchange(h.entry(h.devices.A.host), writes, { timeout: opts.timeout || 20000, methods: ['POST'] });
    const seen = h.devices.A.target.find(id);
    if (!seen) { r.fail(`${label}: body never reached the device (${describe(x)})`); return x; }
    if (seen.bodySha !== sha(expectedBody)) { r.fail(`${label}: ${seen.bodyLength} bytes arrived, expected ${expectedBody.length} intact`); return x; }
    if (!x.response || x.response.status !== 200) r.fail(`${label}: body arrived but the answer was ${describe(x)}`);
    return x;
}

const head = (h, id, extra) => `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\n${extra}\r\n`;

module.exports = [
    {
        id: 'R01', category: 'bodies', name: 'response bodies at every size boundary', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const sizes = [0, 1, 1023, 1024, 4095, 4096, 16383, 16384, 16385, 65535, 65536, 65537, 131072, 1 << 20, (10 << 20) * o.scale];
            for (const n of sizes) {
                const x = await h.request('A', { path: `/t/bytes?n=${n}&seed=${n + 3}`, timeout: 60000 });
                const ok = x.response && x.response.status === 200 && x.response.body.length === n && sha(x.response.body) === sha(genBytes(n, n + 3));
                if (!ok) r.fail(`${fmtBytes(n)}: ${x.response ? `${x.response.body.length} bytes, ${x.response.complete ? 'complete' : 'INCOMPLETE'}` : describe(x)}`);
            }
            if (!r.explicit) r.pass(`${sizes.length} sizes up to ${fmtBytes(sizes[sizes.length - 1])} intact`);
        },
    },
    {
        id: 'R02', category: 'bodies', name: 'chunked and close-delimited responses',
        async run(h, r) {
            for (const [n, piece] of [[1, 1], [100000, 7], [1 << 20, 65536], [300000, 1500]]) {
                const x = await h.request('A', { path: `/t/bytes?n=${n}&seed=5&chunked=1&piece=${piece}`, timeout: 60000 });
                const ok = r.check(x.response && x.response.complete && sha(x.response.body) === sha(genBytes(n, 5)), `chunked ${fmtBytes(n)} in ${piece}-byte pieces: ${x.response ? `${x.response.body.length} bytes after ${x.totalMs} ms` : describe(x)}`);
                if (ok && x.totalMs > 5000) r.warn(`chunked ${fmtBytes(n)} in ${piece}-byte pieces took ${(x.totalMs / 1000).toFixed(1)} s (${fmtBytes(n / (x.totalMs / 1000))}/s): tiny writes are slow end to end`);
            }
            const y = await exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/bytes?n=300000&seed=6&close=1&id=${h.id('A')}`, host: h.hostHeader('A') })], { expect: 0, timeout: 20000 });
            const res = y.final && y.final[0];
            r.check(res && sha(res.body) === sha(genBytes(300000, 6)), `close-delimited 300 KB response: ${res ? `${res.body.length} bytes` : describe(y)}`);
        },
    },
    {
        id: 'R03', category: 'bodies', name: 'request bodies with Content-Length, every size', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            for (const n of [1, 1023, 65535, 65536, 65537, 1 << 20, (10 << 20) * o.scale]) {
                const body = genBytes(n, n);
                await sendBody(h, r, fmtBytes(n), (id) => [Buffer.concat([Buffer.from(head(h, id, `Content-Length: ${n}\r\n`)), body])], body, { timeout: 60000 });
            }
            if (!r.explicit) r.pass('all intact');
        },
    },
    {
        id: 'R04', category: 'bodies', name: 'request body sent at different moments after the headers',
        async run(h, r) {
            const body = Buffer.from('{"timing":"test"}');
            for (const delay of [0, 1, 50, 500, 2500]) {
                await sendBody(h, r, `body ${delay} ms after headers`, (id) => [head(h, id, `Content-Length: ${body.length}\r\nContent-Type: application/json\r\n`), delay, body], body);
            }
            await sendBody(h, r, 'headers and body in one write', (id) => [Buffer.concat([Buffer.from(head(h, id, `Content-Length: ${body.length}\r\n`)), body])], body);
            await sendBody(h, r, 'headers split mid-line', (id) => {
                const b = Buffer.from(head(h, id, `Content-Length: ${body.length}\r\n`));
                return [b.slice(0, 20), 100, b.slice(20), 100, body];
            }, body);
            if (!r.explicit) r.pass('every timing delivered');
        },
    },
    {
        id: 'R05', category: 'bodies', name: 'chunked request bodies (one write, split, tiny chunks, extensions, trailers)',
        async run(h, r) {
            const tiny = Array.from({ length: 300 }, (_, i) => `${(1).toString(16)}\r\n${String.fromCharCode(97 + (i % 26))}\r\n`).join('');
            const tinyBody = Buffer.from(Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''));
            const cases = [
                ['one write', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\n') + '5\r\nhello\r\n0\r\n\r\n'], 'hello'],
                ['chunks 200 ms apart', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\n'), 200, '5\r\nhello\r\n', 200, '6\r\n world\r\n', 200, '0\r\n\r\n'], 'hello world'],
                ['300 one-byte chunks', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\n') + tiny + '0\r\n\r\n'], tinyBody],
                ['chunk extensions', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\n') + '5;name=value\r\nhello\r\n0\r\n\r\n'], 'hello'],
                ['trailers', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\nTrailer: X-Sum\r\n') + '5\r\nhello\r\n0\r\nX-Sum: 42\r\n\r\n'], 'hello'],
                ['uppercase hex sizes', (id) => [head(h, id, 'Transfer-Encoding: chunked\r\n') + 'A\r\n0123456789\r\n0\r\n\r\n'], '0123456789'],
            ];
            for (const [label, writes, expected] of cases) await sendBody(h, r, label, writes, Buffer.from(expected));
            if (!r.explicit) r.pass('all delivered');
        },
    },
    {
        id: 'R06', category: 'bodies', name: 'Expect: 100-continue from the browser',
        async run(h, r) {
            const body = Buffer.from('{"after":"continue"}');
            const id = h.id('A');
            const x = await exchange(h.entry(h.devices.A.host), [head(h, id, `Content-Length: ${body.length}\r\nExpect: 100-continue\r\n`), 400, body], { timeout: 15000, methods: ['POST'] });
            const seen = h.devices.A.target.find(id);
            r.check(seen && seen.bodySha === sha(body), `body not delivered intact (${describe(x)})`);
            const conts = (x.interim || []).filter((i) => i.status === 100).length;
            if (conts > 1) r.info(`the browser got ${conts} "100 Continue" answers (one from the front end, one passed on from behind it). Legal: clients must accept any number of 1xx answers, and browsers do`);
            r.check(x.response && x.response.status === 200, `final answer: ${describe(x)}`);
        },
    },
    {
        id: 'R07', category: 'bodies', name: 'empty bodies: Content-Length: 0, and POST with no length at all',
        async run(h, r) {
            await sendBody(h, r, 'Content-Length: 0', (id) => [head(h, id, 'Content-Length: 0\r\n')], Buffer.alloc(0));
            const id = h.id('A');
            const x = await exchange(h.entry(h.devices.A.host), [head(h, id, '')], { timeout: 10000, methods: ['POST'] });
            const seen = h.devices.A.target.find(id);
            if (x.response && x.response.status === 411) r.info('POST without a length: 411 Length Required from the front end');
            else r.check(seen && seen.bodyLength === 0 && x.response && x.response.status === 200, `POST without a length: ${describe(x)}`);
        },
    },
    {
        id: 'R08', category: 'bodies', name: 'slow upload: 1 MB trickled over 3 s',
        async run(h, r) {
            const body = genBytes(1 << 20, 77);
            await sendBody(h, r, 'trickled upload', (id) => {
                const w = [head(h, id, `Content-Length: ${body.length}\r\n`)];
                for (let i = 0; i < 30; i++) w.push(100, body.slice(i * 34953, (i + 1) * 34953));
                w.push(body.slice(30 * 34953));
                return w;
            }, body);
        },
    },
    {
        id: 'R09', category: 'bodies', name: 'GET and DELETE with a body',
        async run(h, r) {
            for (const method of ['GET', 'DELETE']) {
                const x = await h.request('A', { method, body: 'payload-on-a-' + method });
                const seen = h.devices.A.target.find(x.id);
                if (!seen) r.warn(`${method} with a body never reached the device (${describe(x)})`);
                else if (seen.bodyLength !== ('payload-on-a-' + method).length) r.info(`${method} body: ${seen.bodyLength} bytes arrived`);
            }
        },
    },
    {
        id: 'R10', category: 'bodies', name: 'many uploads in a row reuse uplinks cleanly', scaleTimeout: true,
        async run(h, r, o) {
            const n = 40 * o.scale;
            for (let i = 0; i < n; i++) {
                const body = genBytes(1000 + i * 37, i);
                await sendBody(h, r, `upload ${i}`, (id) => [Buffer.concat([Buffer.from(head(h, id, `Content-Length: ${body.length}\r\n`)), body])], body);
                if (r.status === 'fail') return;
            }
            r.pass(`${n} uploads delivered`);
        },
    },
];
