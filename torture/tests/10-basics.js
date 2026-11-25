'use strict';
// Ordinary, well-formed traffic: does it arrive intact and come back intact?

const { buildRequest, exchange, session } = require('../lib/http1');
const { echoOf, describe } = require('../lib/checks');
const { genBytes, sha } = require('../lib/util');

module.exports = [
    {
        id: 'B01', category: 'basics', name: 'GET reaches the right device and comes back',
        async run(h, r) {
            const x = await h.request('A');
            const e = echoOf(x.response);
            if (!r.check(x.response && x.response.status === 200, `expected 200, got ${describe(x)}`)) return;
            r.check(e && e.id === x.id && e.target === 'A', `echo mismatch: ${JSON.stringify(e).slice(0, 200)}`);
            const seen = h.devices.A.target.find(x.id);
            r.check(seen, 'the device never saw the request');
            if (seen) r.info(`device saw Host: ${seen.host}`);
        },
    },
    {
        id: 'B02', category: 'basics', name: 'every method arrives as sent',
        async run(h, r) {
            for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'MKCOL', 'PURGE']) {
                const body = ['POST', 'PUT', 'PATCH', 'PROPFIND'].includes(method) ? `body for ${method}` : null;
                const x = await h.request('A', { method, body });
                const seen = h.devices.A.target.find(x.id);
                if (!seen) { r.fail(`${method}: never reached the device (${describe(x)})`); continue; }
                r.check(seen.method === method, `${method} arrived as ${seen.method}`);
                if (body) r.check(seen.bodySha === sha(Buffer.from(body)), `${method}: body changed on the way (${seen.bodyLength} bytes arrived)`);
            }
        },
    },
    {
        id: 'B03', category: 'basics', name: 'HEAD gets headers and no body bytes',
        async run(h, r) {
            const id = h.id('A');
            const x = await exchange(h.entry(h.devices.A.host), [buildRequest({ method: 'HEAD', path: `/t/bytes?n=5000&id=${id}`, host: h.hostHeader('A') })], { expect: 0, idleAfter: 1500, timeout: 10000, methods: ['HEAD'] });
            if (!r.check(x.response && x.response.status === 200, `expected 200, got ${describe(x)}`)) return;
            const extra = x.data.length - x.response.headBytes;
            r.check(extra === 0, `${extra} stray bytes after the HEAD response's headers (a body leaked, which corrupts the next response on a kept-alive connection)`);
            const cl = x.response.header('content-length');
            if (cl !== '5000') r.info(`Content-Length on HEAD: ${cl === undefined ? 'missing' : cl} (device sent 5000)`);
        },
    },
    {
        id: 'B04', category: 'basics', name: 'paths and query strings arrive as sent',
        async run(h, r) {
            const paths = [
                '/t/echo?a=1&b=two&c=%E2%9C%93&d=%20&e=&f',
                '/t/echo/%2F..%2Fencoded-slash',
                '/t/echo//double//slashes',
                '/t/echo/./dot/../segments',
                '/t/echo/;matrix=1;x=2',
                '/t/echo/~user/%7Euser',
                `/t/echo?long=${'x'.repeat(6000)}`,
                '/t/echo?q=%00null',
                "/t/echo?quote='\"<>`",
                '/t/echo/%u0041',
            ];
            for (const p of paths) {
                const x = await h.request('A', { path: p });
                const seen = h.devices.A.target.find(x.id);
                const sent = p + (p.includes('?') ? '&' : '?') + 'id=' + x.id;
                if (!seen) {
                    r.info(`${p.slice(0, 60)}: not delivered (${describe(x)})`);
                } else if (seen.url !== sent) {
                    r.info(`${p.slice(0, 60)} arrived as ${seen.url.slice(0, 80)}`);
                }
            }
            if (!r.explicit) r.pass('all arrived unchanged');
        },
    },
    {
        id: 'B05', category: 'basics', name: 'status codes come back unchanged',
        async run(h, r) {
            const codes = [200, 201, 202, 204, 206, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405, 409, 410, 413, 418, 429, 451, 500, 501, 502, 503, 504, 599];
            const changed = [];
            for (const code of codes) {
                const x = await h.request('A', { path: `/t/status?code=${code}` });
                const got = x.response && x.response.status;
                if (got !== code) changed.push(`${code}→${got || describe(x)}`);
            }
            r.check(!changed.length, `changed on the way: ${changed.join(', ')}`, `${codes.length} codes passed through`);
        },
    },
    {
        id: 'B06', category: 'basics', name: 'reason phrase and redirects',
        async run(h, r) {
            const x = await h.request('A', { path: '/t/status?code=200&text=Totally%20Fine' });
            if (x.response && x.response.statusText !== 'Totally Fine') r.info(`custom reason phrase arrived as "${x.response.statusText}" (normal behind an HTTP/2-capable proxy)`);
            for (const to of ['/relative/path?x=1', 'https://example.com/elsewhere', '//example.net/protocol-relative']) {
                const y = await h.request('A', { path: `/t/redirect?code=302&to=${encodeURIComponent(to)}` });
                const loc = y.response && y.response.header('location');
                r.check(loc === to, `Location ${to} came back as ${loc}`);
            }
        },
    },
    {
        id: 'B07', category: 'basics', name: 'compressed responses pass through untouched',
        async run(h, r) {
            // like a browser, which always says what it accepts
            const x = await h.request('A', { path: '/t/gzip', headers: [['Accept-Encoding', 'gzip, deflate, br']] });
            if (!r.check(x.response && x.response.status === 200, describe(x))) return;
            const enc = x.response.header('content-encoding');
            if (enc !== 'gzip') r.warn(`Content-Encoding is now ${enc}: something re-encoded the body`);
            else r.check(sha(x.response.body) === x.response.header('x-sha256'), 'gzip bytes changed on the way');
            // a client that accepts no encoding, served gzip anyway by a careless device
            const y = await h.request('A', { path: '/t/gzip' });
            if (!y.response) return;
            const yEnc = y.response.header('content-encoding');
            if (yEnc === 'gzip') r.info('without Accept-Encoding the gzip answer still arrives as is');
            else if (sha(y.response.body) === y.response.header('x-plain-sha256')) r.info('without Accept-Encoding the front end unzipped the answer for the client (correct: it never asked for gzip)');
            else r.fail(`without Accept-Encoding the answer arrived as neither gzip nor the plain text (Content-Encoding ${yEnc})`);
        },
    },
    {
        id: 'B08', category: 'basics', name: 'trailers and 103 Early Hints',
        async run(h, r) {
            const x = await h.request('A', { path: '/t/trailers' });
            r.check(x.response && x.response.status === 200 && x.response.body.toString().includes('body with a trailer'), `trailer response broken: ${describe(x)}`);
            r.info(`trailers ${x.response && x.response.trailers && x.response.trailers.includes('abc123') ? 'arrive' : 'are dropped'}`);
            const y = await h.request('A', { path: '/t/hints' });
            r.check(y.response && y.response.status === 200, `103 response broke the final answer: ${describe(y)}`);
            r.info(`103 Early Hints ${y.interim && y.interim.some((i) => i.status === 103) ? 'arrive' : 'are dropped'}`);
        },
    },
    {
        id: 'B09', category: 'basics', name: '30 requests on one kept-alive connection',
        async run(h, r) {
            const s = await session(h.entry(h.devices.A.host));
            let ok = 0;
            try {
                for (let i = 0; i < 30; i++) {
                    const id = h.id('A');
                    const res = await s.send(buildRequest({ path: `/t/echo?id=${id}&i=${i}`, host: h.hostHeader('A') }));
                    if (res.closed) { r.info(`front end closed the connection after ${i} requests`); break; }
                    const e = echoOf(res);
                    if (!e || e.id !== id) { r.fail(`request ${i} got someone else's answer: ${JSON.stringify(e).slice(0, 150)}`); break; }
                    ok++;
                }
            } finally { s.close(); }
            if (ok === 30) r.pass('all 30 answered in order');
        },
    },
    {
        id: 'B10', category: 'basics', name: 'pipelined requests (5 in one write)',
        async run(h, r) {
            const ids = [1, 2, 3, 4, 5].map(() => h.id('A'));
            const bytes = Buffer.concat(ids.map((id) => buildRequest({ path: `/t/echo?id=${id}`, host: h.hostHeader('A') })));
            const x = await exchange(h.entry(h.devices.A.host), [bytes], { expect: 5, timeout: 15000 });
            const got = (x.final || []).map((res) => (echoOf(res) || {}).id);
            if (got.length < 5) { r.warn(`only ${got.length} of 5 pipelined requests answered (${describe(x)}); pipelining isn't used by browsers, but a front end must not mix answers up`); }
            const wrong = got.filter((id, i) => id !== ids[i]);
            r.check(!wrong.length, `pipelined answers out of order or mixed up: ${JSON.stringify(got)}`);
        },
    },
    {
        id: 'B11', category: 'basics', name: 'binary bodies with every byte value, both ways',
        async run(h, r) {
            const body = Buffer.concat([Buffer.from([0, 13, 10, 13, 10, 0]), genBytes(70000, 7)]);
            const x = await h.request('A', { method: 'POST', path: '/t/echo', body, headers: [['Content-Type', 'application/octet-stream']] });
            const seen = h.devices.A.target.find(x.id);
            r.check(seen && seen.bodySha === sha(body), `request body changed: ${seen ? seen.bodyLength : 'not delivered'} bytes arrived of ${body.length}`);
            const y = await h.request('A', { path: '/t/bytes?n=70001&seed=9' });
            r.check(y.response && sha(y.response.body) === sha(genBytes(70001, 9)), `response body changed: ${y.response ? y.response.body.length : describe(y)}`);
        },
    },
];
