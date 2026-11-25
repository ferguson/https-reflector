'use strict';
// What a stranger on the internet can do to other people's devices and to the hub.
// Everything here targets only the suite's own test devices.

const { buildRequest, exchange, session } = require('../lib/http1');
const { openWebSocket, nextSnapshot } = require('../lib/ws');
const { echoOf, describe } = require('../lib/checks');
const Target = require('../lib/target');
const { sleep, newId } = require('../lib/util');

const HUB_PREFIX = '/https-reflector';

module.exports = [
    {
        id: 'I01', category: 'security', name: 'one connection, two devices: where does the second request go?',
        async run(h, r) {
            // Only an attacker sends this (a browser never mixes host names on one HTTP/1.1
            // connection), so landing on A is not itself a leak; but it shows the connection is
            // bound to the first device, which any connection-reusing front end turns into one.
            const s = await session(h.entry(h.devices.A.host));
            try {
                const idA = `X-${newId()}`;
                const idB = `X-${newId()}`;
                await s.send(buildRequest({ path: `/t/echo?id=${idA}`, host: h.hostHeader('A') }));
                const b = await s.send(buildRequest({ path: `/t/echo?id=${idB}`, host: h.hostHeader('B') }), { timeout: 6000 });
                const eb = echoOf(b);
                if (!eb) r.pass(`second request: ${b.status || describe(b)} (the front end did not carry it to a device)`);
                else if (eb.target === 'B') r.pass('the second request reached device B');
                else r.info(`a request for device B sent on a connection first used for A was delivered to device A: connections are bound to the first device (fine only while nothing in front reuses connections)`);
            } finally { s.close(); }
        },
    },
    {
        id: 'I02', category: 'security', name: 'stranger attaches an uplink to someone else\'s device',
        async run(h, r) {
            // the hub's uplink.ws takes a websocket for any device name, from anyone
            const ws = await openWebSocket(h.entry(h.devices.A.host), { host: h.hostHeader('A'), path: `${HUB_PREFIX}/uplink.ws` });
            if (!ws.ok) { r.pass(`the hub refused the stranger's uplink (${ws.status || ws.error})`); return; }
            let captured = null;
            const watcher = (async () => {
                const m = await ws.next(25000);
                if (m.data) {
                    captured = m.data.toString('latin1');
                    ws.sendBinary(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nanswer by ROGUE'));
                    await sleep(300);
                }
                ws.destroy();
            })();
            let rogueAnswers = 0;
            for (let i = 0; i < 40 && !captured; i++) {
                const x = await h.request('A', { headers: [['Cookie', 'session=victims-secret']], timeout: 8000 });
                if (x.response && x.response.body.toString().includes('ROGUE')) rogueAnswers++;
            }
            ws.destroy();
            await watcher;
            if (captured) {
                const first = captured.split('\r\n')[0];
                r.fail(`a stranger's uplink was put in device A's pool and RECEIVED a visitor's request (${first}${/victims-secret/.test(captured) ? ', with its cookie' : ''})${rogueAnswers ? ', and its forged answer went back to the visitor' : ''}. Uplinks need to prove they belong to the device`);
            } else {
                r.warn('the hub accepted a stranger\'s uplink websocket for device A, though none of 40 requests went through it in this run');
            }
        },
    },
    {
        id: 'I03', category: 'security', name: 'stranger claims a connected device\'s name', timeout: 120000,
        async run(h, r) {
            const rogueTarget = new Target('ROGUE');
            await rogueTarget.start();
            const rogue = h.spawnClient(h.devices.A.name, rogueTarget.port, 'rogue-client');
            try {
                await sleep(6000);
                let stolen = 0;
                for (let i = 0; i < 20; i++) {
                    const x = await h.request('A', { timeout: 8000 });
                    if (rogueTarget.find(x.id)) stolen++;
                }
                if (stolen) r.fail(`a second client claiming device A's name took over: ${stolen} of 20 visitors' requests went to the impostor. Device names need ownership (a secret per name)`);
                else if (rogueTarget.log.length) r.warn(`the impostor got ${rogueTarget.log.length} requests, though none of the test's 20`);
                else r.pass('the impostor got nothing');
                r.info(`impostor output: ${rogue.grep(/inuse|proceed|connected|refus/i).slice(-3).join(' | ') || '(none)'}`);
            } finally {
                rogue.kill();
                await rogueTarget.stop();
            }
            const t0 = Date.now();
            const back = await h.waitReachable('A', 60000);
            r.info(back ? `the real device A was reachable again ${((Date.now() - t0) / 1000).toFixed(1)} s after the impostor left` : 'the real device A did NOT come back within 60 s after the impostor left');
        },
    },
    {
        id: 'I04', category: 'security', name: 'status dashboard without a password',
        async run(h, r) {
            for (const [label, host] of [['main domain', h.base], ['through a device name', h.devices.A.host]]) {
                const ws = await openWebSocket(h.entry(host), { host: host + h.hostPort, path: `${HUB_PREFIX}/status.ws` });
                if (!ws.ok) { r.pass(`${label}: refused (${ws.status || ws.error})`); continue; }
                const m = await nextSnapshot(ws);
                ws.destroy();
                if (!m.text) { r.pass(`${label}: connected but nothing sent without a password`); continue; }
                let snap = {};
                try { snap = JSON.parse(m.text); } catch (e) { /* not JSON */ }
                const devices = snap.devices ? Object.keys(snap.devices) : [];
                const ips = (m.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).filter((ip) => ip !== '127.0.0.1');
                r.warn(`${label}: anyone can read the dashboard feed: ${devices.length} device names${devices.includes(h.devices.A.name) ? ' (ours included)' : ''}, fields ${Object.keys(snap).join(', ')}${ips.length ? `, ${new Set(ips).size} IP addresses` : ''}`);
            }
        },
    },
    {
        id: 'I05', category: 'security', name: 'anyone can add names to the dashboard (wait.ws)',
        async run(h, r) {
            const names = Array.from({ length: 5 }, () => `spam-${newId()}`.toLowerCase());
            for (const n of names) {
                const host = `${n}.${h.base}`;
                const ws = await openWebSocket(h.entry(host), { host: host + h.hostPort, path: `${HUB_PREFIX}/wait.ws`, timeout: 5000 });
                if (ws.ok) { await sleep(100); ws.destroy(); }
            }
            await sleep(500);
            const st = await openWebSocket(h.entry(h.base), { host: h.base + h.hostPort, path: `${HUB_PREFIX}/status.ws` });
            if (!st.ok) { r.info('status feed not readable, cannot check'); return; }
            const m = await nextSnapshot(st);
            st.destroy();
            const listed = names.filter((n) => (m.text || '').includes(n));
            if (listed.length) r.warn(`${listed.length} of ${names.length} made-up device names now appear in the dashboard's failed attempts: anyone can fill it (and the hub's memory) with arbitrary names`);
            else r.pass('made-up names did not show up');
        },
    },
    {
        id: 'I06', category: 'security', name: 'path traversal into the hub\'s files',
        async run(h, r) {
            const paths = [
                `${HUB_PREFIX}/../../../../etc/passwd`, `${HUB_PREFIX}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
                `${HUB_PREFIX}/..%2f..%2f..%2fpackage.json`, `${HUB_PREFIX}/..%5c..%5cpackage.json`,
                '/admin/../../package.json', '/admin/..%2f..%2fpackage.json', '/admin/%2e%2e%2f%2e%2e%2fbuild/main.js',
                '/otto-hub/....//....//etc/passwd', '/../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd',
                '/admin/index.html%00.txt', `${HUB_PREFIX}/static/../../src/Hub.ts`,
            ];
            for (const host of [h.base, h.devices.A.host]) {
                for (const p of paths) {
                    const x = await exchange(h.entry(host), [buildRequest({ path: p, host: host + h.hostPort })], { timeout: 8000 });
                    const body = x.response ? x.response.body.toString() : '';
                    if (/root:.*:0:0:|"devDependencies"|"https-reflector|require\(|import .* from/.test(body)) r.fail(`${host}${p} served a file outside the static folder (${describe(x)}): ${JSON.stringify(body.slice(0, 80))}`);
                }
            }
            if (!r.explicit) r.pass(`${paths.length * 2} traversal attempts served nothing private`);
        },
    },
    {
        id: 'I07', category: 'security', name: 'device paths that start like hub paths',
        async run(h, r) {
            const lost = [];
            for (const p of ['/https-reflector-app/page', '/https-reflectorX', '/otto-hubble/x', '/otto-hub2']) {
                const x = await h.request('A', { path: p });
                if (!h.devices.A.target.find(x.id)) lost.push(`${p} (${describe(x)})`);
            }
            if (lost.length) r.warn(`the hub keeps these device paths for itself (prefix match without a trailing slash): ${lost.join(', ')}`);
            else r.pass('all reached the device');
        },
    },
    {
        id: 'I08', category: 'security', name: 'hub websockets on the main domain (uplink without a device, socket.io)',
        async run(h, r) {
            const up = await openWebSocket(h.entry(h.base), { host: h.base + h.hostPort, path: `${HUB_PREFIX}/uplink.ws`, timeout: 5000 });
            if (up.ok) { r.warn('the main domain accepts an uplink websocket that belongs to no device'); up.sendBinary(Buffer.from('garbage')); await sleep(300); up.destroy(); }
            else r.pass(`uplink.ws on the main domain refused (${up.status || up.error})`);
            const io = await openWebSocket(h.entry(h.base), { host: h.base + h.hostPort, path: `${HUB_PREFIX}/socket.io/?EIO=4&transport=websocket`, timeout: 5000 });
            if (io.ok) { const m = await io.next(3000); r.info(`socket.io on the main domain: opened, then ${m.close ? 'closed' : m.text ? `sent ${m.text.slice(0, 60)}` : JSON.stringify(m)}`); io.destroy(); }
            else r.info(`socket.io on the main domain: ${io.status || io.error}`);
        },
    },
    {
        id: 'I09', category: 'security', name: 'garbage into the hub\'s own websockets',
        async run(h, r) {
            for (const path of ['status.ws', 'wait.ws', 'uplink.ws', 'socket.io/?EIO=4&transport=websocket']) {
                const host = path === 'wait.ws' ? `ghost-${newId()}.${h.base}`.toLowerCase() : h.devices.B.host;
                const ws = await openWebSocket(h.entry(host), { host: host + h.hostPort, path: `${HUB_PREFIX}/${path}`, timeout: 5000 });
                if (!ws.ok) continue;
                ws.sendRaw(Buffer.from([0x81, 0xfe, 0xff, 0xff]));      // truncated 16-bit length
                ws.sendRaw(Buffer.from([0x8f, 0x80, 0, 0, 0, 0]));       // reserved opcode
                ws.sendText('{"not":"what you expected"}'.repeat(1000));
                ws.sendRaw(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
                await sleep(300);
                ws.destroy();
            }
            r.pass('sent; the health check after this test tells whether the hub or a device suffered');
        },
    },
    {
        id: 'I10', category: 'security', name: 'TLS name (SNI) of one device, Host of another', needs: 'tls',
        async run(h, r) {
            const id = `X-${newId()}`;
            const x = await exchange({ ...h.entry(h.devices.B.host) }, [buildRequest({ path: `/t/echo?id=${id}`, host: h.hostHeader('A') })], { timeout: 8000 });
            const where = h.devices.A.target.find(id) ? 'device A (Host wins)' : h.devices.B.target.find(id) ? 'device B (SNI wins)' : 'neither';
            r.info(`${describe(x)}, delivered to ${where}`);
        },
    },
    {
        id: 'I11', category: 'security', name: 'plain-HTTP port: redirect, and no open redirect', needs: 'tls',
        async run(h, r) {
            const plain = { tls: false, address: h.entryBase.address, host: h.devices.A.host, port: 80 };
            const x = await exchange(plain, [buildRequest({ path: '/some/path?x=1', host: h.devices.A.host })], { timeout: 8000 });
            const loc = x.response && x.response.header('location');
            if (!x.response) r.info(`port 80: ${describe(x)}`);
            else r.check(loc === `https://${h.devices.A.host}/some/path?x=1`, `port 80 answered ${x.response.status} Location: ${loc}`, `port 80 redirects to ${loc}`);
            const y = await exchange({ ...plain, host: 'evil.example' }, [buildRequest({ path: '/', host: 'evil.example' })], { timeout: 8000 });
            const yloc = y.response && y.response.header('location');
            if (yloc && yloc.includes('evil.example')) r.warn(`port 80 redirects any Host, e.g. to ${yloc} (open redirect)`);
            else r.pass(`Host: evil.example on port 80: ${describe(y)}`);
        },
    },
];
