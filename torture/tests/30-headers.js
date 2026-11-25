'use strict';
// Header fidelity both ways, and what the device can (and can't) learn about the client.

const { buildRequest, exchange } = require('../lib/http1');
const { describe, headerValues } = require('../lib/checks');

module.exports = [
    {
        id: 'H01', category: 'headers', name: 'duplicate, cased and empty request headers',
        async run(h, r) {
            const x = await h.request('A', { headers: [['X-Dup', 'one'], ['X-Dup', 'two'], ['X-CamelCase-Header', 'v'], ['x-empty', ''], ['X-Spaces', '  padded  '], ['Cookie', 'a=1'], ['Cookie', 'b=2']] });
            const seen = h.devices.A.target.find(x.id);
            if (!r.check(seen, `not delivered: ${describe(x)}`)) return;
            const dup = headerValues(seen.rawHeaders, 'x-dup');
            if (dup.length !== 2) r.info(`X-Dup: one / X-Dup: two arrived as ${JSON.stringify(dup)}`);
            const cookies = headerValues(seen.rawHeaders, 'cookie');
            if (cookies.length === 1 && cookies[0].includes(',')) r.warn(`two Cookie headers were joined with a comma (${JSON.stringify(cookies[0])}); cookies must be joined with "; " or the device misreads them`);
            else if (cookies.length !== 2) r.info(`two Cookie headers arrived as ${JSON.stringify(cookies)}`);
            const names = seen.rawHeaders.filter((_, i) => i % 2 === 0);
            if (!names.includes('X-CamelCase-Header')) r.info(`header name case changed (${names.find((n) => n.toLowerCase() === 'x-camelcase-header')})`);
            if (!headerValues(seen.rawHeaders, 'x-empty').length) r.info('an empty header value was dropped');
        },
    },
    {
        id: 'H02', category: 'headers', name: 'big request headers (8 KB, 16 KB, 32 KB) and 100 of them',
        async run(h, r) {
            for (const size of [8000, 16000, 32000]) {
                const x = await h.request('A', { headers: [['X-Big', 'v'.repeat(size)]] });
                const seen = h.devices.A.target.find(x.id);
                const got = seen ? (headerValues(seen.rawHeaders, 'x-big')[0] || '').length : 0;
                if (seen && got === size) continue;
                r.info(`${size}-byte header: ${seen ? `arrived as ${got} bytes` : describe(x)}`);
            }
            const many = Array.from({ length: 100 }, (_, i) => [`X-H${i}`, `v${i}`]);
            const y = await h.request('A', { headers: many });
            const seen = h.devices.A.target.find(y.id);
            r.check(seen && headerValues(seen.rawHeaders, 'x-h99')[0] === 'v99', `100 headers: ${seen ? 'some lost' : describe(y)}`);
        },
    },
    {
        id: 'H03', category: 'headers', name: 'many Set-Cookie headers stay separate',
        async run(h, r) {
            const x = await h.request('A', { path: '/t/headers?cookies=10' });
            const got = x.response ? x.response.headerAll('set-cookie') : [];
            r.check(got.length === 10, `10 Set-Cookie headers arrived as ${got.length}${got.length === 1 ? ' (joined: every cookie after the first is broken)' : ''}`, 'all 10 separate');
        },
    },
    {
        id: 'H04', category: 'headers', name: 'big and numerous response headers',
        async run(h, r) {
            for (const [q, label] of [['count=100', '100 headers'], ['size=8000', 'an 8 KB header'], ['size=32000', 'a 32 KB header'], ['size=70000', 'a 70 KB header']]) {
                const x = await h.request('A', { path: `/t/headers?${q}` });
                if (!x.response || x.response.status !== 200) r.info(`${label}: ${describe(x)}`);
            }
            if (!r.explicit) r.pass('all passed through');
        },
    },
    {
        id: 'H05', category: 'headers', name: 'spoofed X-Forwarded-For / X-Real-IP / Forwarded',
        async run(h, r) {
            const spoof = [['X-Forwarded-For', '127.0.0.1'], ['X-Real-IP', '127.0.0.1'], ['Forwarded', 'for=127.0.0.1;proto=https'], ['X-Forwarded-Host', 'localhost'], ['X-Forwarded-Proto', 'http'], ['Client-IP', '127.0.0.1'], ['True-Client-IP', '127.0.0.1']];
            const x = await h.request('A', { headers: spoof });
            const seen = h.devices.A.target.find(x.id);
            if (!r.check(seen, describe(x))) return;
            const lines = [];
            for (const [name, value] of spoof) {
                const got = headerValues(seen.rawHeaders, name);
                if (got.length === 1 && got[0] === value) lines.push(`${name}: ${value} arrived untouched`);
                else if (got.length) lines.push(`${name} arrived as ${JSON.stringify(got)}`);
                else lines.push(`${name} removed`);
            }
            const untouched = lines.filter((l) => l.includes('untouched'));
            if (untouched.length) {
                r.warn(`a browser can claim to be 127.0.0.1 and the device can't tell: ${untouched.map((l) => l.split(':')[0]).join(', ')} pass through as sent. A device must never trust these headers to decide who is local/admin`);
            }
            r.info(lines.join('; '));
            r.info(`the device sees the connection coming from ${seen.remote} (always its own device client)`);
        },
    },
    {
        id: 'H06', category: 'headers', name: 'what the device learns about the real client',
        async run(h, r) {
            const x = await h.request('A');
            const seen = h.devices.A.target.find(x.id);
            if (!r.check(seen, describe(x))) return;
            const fwd = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-proto', 'x-forwarded-host', 'via'].map((n) => [n, headerValues(seen.rawHeaders, n)]).filter(([, v]) => v.length);
            if (!fwd.length) r.info('no forwarding headers reach the device: it cannot know the client\'s address or that the request came through the hub');
            else r.info(`the device gets: ${fwd.map(([n, v]) => `${n}: ${v.join(', ')}`).join('; ')}`);
        },
    },
    {
        id: 'H07', category: 'headers', name: 'hop-by-hop header abuse (Connection: X-Forwarded-For)',
        async run(h, r) {
            const x = await h.request('A', { headers: [['Connection', 'keep-alive, X-Forwarded-For, X-Secret'], ['X-Secret', 'should-be-dropped'], ['X-Forwarded-For', '10.9.8.7']] });
            const seen = h.devices.A.target.find(x.id);
            if (!r.check(seen, describe(x))) return;
            const secret = headerValues(seen.rawHeaders, 'x-secret');
            const xff = headerValues(seen.rawHeaders, 'x-forwarded-for');
            r.info(`X-Secret named in Connection: ${secret.length ? 'still delivered' : 'removed'}; X-Forwarded-For: ${xff.length ? JSON.stringify(xff) : 'removed (a front end that adds X-Forwarded-For lost its own value)'}`);
        },
    },
    {
        id: 'H08', category: 'headers', name: 'non-ASCII and unusual header bytes',
        async run(h, r) {
            const cases = [
                ['UTF-8 value', Buffer.from('X-Utf8: héllo ✓\r\n', 'utf8')],
                ['Latin-1 value', Buffer.from('X-Latin: caf\xe9\r\n', 'latin1')],
                ['tab inside value', Buffer.from('X-Tab: a\tb\r\n')],
                ['value with only spaces', Buffer.from('X-Blank:    \r\n')],
                ['1000-character header name', Buffer.from(`X-${'n'.repeat(1000)}: v\r\n`)],
            ];
            for (const [label, line] of cases) {
                const id = h.id('A');
                const req = Buffer.concat([Buffer.from(`GET /t/echo?id=${id} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\n`), line, Buffer.from('\r\n')]);
                const x = await exchange(h.entry(h.devices.A.host), [req], { timeout: 10000 });
                const seen = h.devices.A.target.find(id);
                r.info(`${label}: ${seen ? 'delivered' : 'not delivered'}, answer ${describe(x)}`);
                if (!(await h.canary('A', 5000))) { r.fail(`${label}: the device stopped answering right after this request`); return; }
            }
        },
    },
    {
        id: 'H09', category: 'headers', name: 'Host header variants for the same device',
        async run(h, r) {
            const d = h.devices.A;
            const variants = [
                ['upper case', d.host.toUpperCase() + h.hostPort],
                ['trailing dot', d.host + '.' + h.hostPort],
                ['explicit default port', d.host + (h.hostPort || (h.entryBase.tls ? ':443' : ':80'))],
                ['with userinfo', 'user@' + d.host + h.hostPort],
            ];
            for (const [label, host] of variants) {
                const id = h.id('A');
                const x = await exchange(h.entry(d.host), [buildRequest({ path: `/t/echo?id=${id}`, host })], { timeout: 10000 });
                const seen = d.target.find(id);
                const res = seen ? 'reaches the device' : `does not (${describe(x)})`;
                // browsers lower-case host names themselves, so only non-browser clients notice
                r.info(`${label}: ${res}`);
            }
        },
    },
];
