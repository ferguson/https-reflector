'use strict';
// Streams, slow answers, slow readers, websockets.

const { buildRequest, exchange, connect, parseResponses } = require('../lib/http1');
const { encodeFrame } = require('../lib/ws');
const { describe } = require('../lib/checks');
const { genBytes, sha, sleep, fmtBytes } = require('../lib/util');

// when did each line of a dripped body arrive (ms after the first)?
function arrivalSpread(x) {
    const times = x.chunkTimes.map(([t]) => t);
    return { count: times.length, spread: times.length ? times[times.length - 1] - times[0] : 0, first: x.firstByteMs };
}

module.exports = [
    {
        id: 'S01', category: 'streaming', name: 'streamed response is not buffered (6 chunks, 500 ms apart)',
        async run(h, r) {
            const x = await exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/drip?count=6&interval=500&id=${h.id('A')}`, host: h.hostHeader('A') })], { timeout: 15000 });
            const s = arrivalSpread(x);
            if (!r.check(x.response && x.response.complete, `stream did not complete: ${describe(x)}`)) return;
            r.check(s.first < 1500 && s.spread >= 1500, `the chunks arrived together (first byte after ${s.first} ms, spread ${s.spread} ms): something buffers the stream`, `first byte after ${s.first} ms, chunks spread over ${s.spread} ms`);
        },
    },
    {
        id: 'S02', category: 'streaming', name: 'server-sent events arrive as they are sent',
        async run(h, r) {
            const x = await exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/drip?sse=1&count=10&interval=300&id=${h.id('A')}`, host: h.hostHeader('A'), headers: [['Accept', 'text/event-stream']] })], { timeout: 15000 });
            const s = arrivalSpread(x);
            r.check(x.response && s.spread >= 2000 && s.first < 1000, `SSE buffered or broken: ${describe(x)}, first ${s.first} ms, spread ${s.spread} ms`, `events spread over ${s.spread} ms`);
        },
    },
    {
        id: 'S03', category: 'streaming', name: 'slow device: answer after 5 s and 25 s', timeout: 70000,
        async run(h, r) {
            for (const ms of [5000, 25000]) {
                const x = await h.request('A', { path: `/t/slow?ms=${ms}`, timeout: ms + 15000 });
                if (x.response && x.response.status === 200) continue;
                r.warn(`an answer that takes ${ms / 1000} s: ${describe(x)}`);
            }
        },
    },
    {
        id: 'S04', category: 'streaming', name: 'slow device: answer after 70 s and 130 s', long: true, timeout: 200000,
        async run(h, r) {
            for (const ms of [70000, 130000]) {
                const x = await h.request('A', { path: `/t/slow?ms=${ms}`, timeout: ms + 20000 });
                r.info(`answer after ${ms / 1000} s: ${describe(x)}`);
            }
        },
    },
    {
        id: 'S05', category: 'streaming', name: 'slow reader: big download paused mid-way', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const n = (30 << 20) * o.scale;
            const rssBefore = h.hub ? h.hub.rss() : null;
            const sock = await connect(h.entry(h.devices.A.host));
            const chunks = [];
            let got = 0;
            let rssPeak = rssBefore;
            const done = new Promise((resolve) => { sock.on('close', resolve); sock.on('error', resolve); });
            sock.on('data', (d) => { chunks.push(d); got += d.length; });
            sock.write(buildRequest({ path: `/t/bytes?n=${n}&seed=11&id=${h.id('A')}`, host: h.hostHeader('A'), headers: [['Connection', 'close']] }));
            await sleep(300);
            sock.pause();                                   // stop reading: the whole chain should back up
            for (let i = 0; i < 6; i++) { await sleep(1000); if (h.hub) rssPeak = Math.max(rssPeak, h.hub.rss() || 0); }
            sock.resume();
            await Promise.race([done, sleep(90000)]);
            sock.destroy();
            const res = parseResponses(Buffer.concat(chunks), [], true).responses[0];
            r.check(res && res.body.length === n && sha(res.body) === sha(genBytes(n, 11)), `download after a 6 s pause: ${res ? `${fmtBytes(res.body.length)} of ${fmtBytes(n)}` : 'no response'}`, `${fmtBytes(n)} intact after a 6 s pause`);
            if (rssBefore && rssPeak) {
                const grew = rssPeak - rssBefore;
                if (grew > n / 2) r.warn(`the hub's memory grew by ${fmtBytes(grew)} while the reader was paused: it buffers instead of passing back-pressure on`);
                else r.info(`hub memory grew ${fmtBytes(Math.max(0, grew))} during the pause`);
            }
        },
    },
    {
        id: 'S06', category: 'streaming', name: 'long-lived stream (2 minutes, a chunk every 10 s)', long: true, timeout: 200000,
        async run(h, r) {
            const x = await exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/drip?count=13&interval=10000&id=${h.id('A')}`, host: h.hostHeader('A') })], { timeout: 180000 });
            r.check(x.response && x.response.complete && x.response.body.toString().split('\n').length >= 13, `2-minute stream: ${describe(x)}, ${x.response ? x.response.body.length : 0} bytes`);
        },
    },
    {
        id: 'W01', category: 'websocket', name: 'websocket echo: text, binary, 1 MB message, 100 round trips',
        async run(h, r) {
            const ws = await h.openWS('A', { path: `/t/ws?id=${h.id('A')}` });
            if (!r.check(ws.ok, `upgrade failed: ${ws.status || ws.error} ${ws.response || ''}`)) return;
            r.check(ws.acceptOk, 'Sec-WebSocket-Accept was wrong (something rewrote the handshake)');
            ws.sendText('hello');
            let m = await ws.next();
            r.check(m.text === 'hello', `text echo: ${JSON.stringify(m).slice(0, 100)}`);
            const bin = genBytes(1 << 20, 21);
            ws.sendBinary(bin);
            m = await ws.next(15000);
            r.check(m.data && sha(m.data) === sha(bin), `1 MB binary echo: ${m.data ? fmtBytes(m.data.length) : JSON.stringify(m)}`);
            for (let i = 0; i < 100; i++) {
                ws.sendText(`msg-${i}`);
                m = await ws.next();
                if (m.text !== `msg-${i}`) { r.fail(`round trip ${i}: ${JSON.stringify(m).slice(0, 100)}`); break; }
            }
            ws.ping('are you there');
            ws.close();
        },
    },
    {
        id: 'W02', category: 'websocket', name: '30 websockets at once keep their own conversations',
        async run(h, r) {
            const sockets = await Promise.all(Array.from({ length: 30 }, () => h.openWS('A', { path: `/t/ws?id=${h.id('A')}` })));
            const open = sockets.filter((s) => s.ok);
            r.check(open.length === 30, `${30 - open.length} of 30 websockets failed to open`);
            await Promise.all(open.map(async (ws, i) => {
                for (let j = 0; j < 20; j++) {
                    ws.sendText(`ws${i}-m${j}`);
                    const m = await ws.next();
                    if (m.text !== `ws${i}-m${j}`) { r.fail(`websocket ${i} got ${JSON.stringify(m).slice(0, 80)} instead of its own message ${j}`); return; }
                }
            }));
            open.forEach((ws) => ws.close());
        },
    },
    {
        id: 'W03', category: 'websocket', name: 'bytes sent right behind the upgrade request',
        async run(h, r) {
            const id = h.id('A');
            const sock = await connect(h.entry(h.devices.A.host));
            let got = '';
            sock.on('data', (d) => { got += d.toString('latin1'); });
            sock.write(`GET /t/upgrade?id=${id} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\nearly-`);
            await sleep(500);
            sock.write('late');
            await sleep(1000);
            sock.destroy();
            const echoed = got.split('\r\n\r\n')[1] || '';
            if (echoed === 'EARLY-LATE') r.pass('both arrived');
            else if (echoed === 'LATE') r.info('bytes that came with the upgrade request were lost (clients before 2.2.0 drop them; browsers never send any)');
            else r.warn(`upgrade echo: ${JSON.stringify(got.slice(0, 200))}`);
        },
    },
    {
        id: 'W04', category: 'websocket', name: 'malformed websocket frames don\'t hurt the hub or device',
        async run(h, r) {
            const ws = await h.openWS('A', { path: `/t/ws?id=${h.id('A')}` });
            if (!r.check(ws.ok, `upgrade failed: ${ws.status || ws.error}`)) return;
            ws.sendRaw(encodeFrame(0x1, 'unmasked', { mask: false }));        // clients must mask
            ws.sendRaw(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));                 // reserved opcode 3
            ws.sendRaw(Buffer.from([0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])); // absurd length
            ws.sendRaw(Buffer.from('this is not a frame at all\r\n\r\n'));
            await sleep(500);
            ws.destroy();
            r.pass('sent; the health check after this test tells whether anything broke');
        },
    },
    {
        id: 'W05', category: 'websocket', name: 'device refuses the upgrade, then more bytes follow',
        async run(h, r) {
            const id = h.id('A');
            const x = await exchange(h.entry(h.devices.A.host), [
                `GET /t/refuse?id=${id} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
                300,
                `GET /t/echo?id=${h.id('A')}&after=refused HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\n\r\n`,
            ], { expect: 2, timeout: 6000 });
            const leaked = h.devices.A.target.log.find((e) => e.kind === 'afterRefusedUpgrade' && e.id === id && /HTTP\/1\.[01]/.test(e.data));
            const answers = (x.final || []).map((f) => f.status).join(', ') || describe(x);
            if (leaked) r.warn(`after the device refused the upgrade, the next request on that connection went raw into the refused upgrade's socket (answers: ${answers}). The connection was already handed to the device, so it reaches only that same device; a front end that skips its own checks after an "upgrade" would let a client past them`);
            else r.pass(`answers: ${answers}`);
        },
    },
    {
        id: 'W06', category: 'websocket', name: 'websocket to a device that is offline',
        async run(h, r) {
            const ghost = `ghost-${Date.now().toString(36)}.${h.base}`;
            const t0 = Date.now();
            const ws = await h.openWS('A', { hostname: ghost, host: ghost + h.hostPort, path: '/t/ws', timeout: 25000 });
            const ms = Date.now() - t0;
            if (ws.ok) { r.fail('an upgrade to an offline device succeeded?!'); ws.destroy(); return; }
            if (ms > 5000) r.warn(`a websocket to a device that isn't connected hangs ${(ms / 1000).toFixed(1)} s before failing (${ws.status || ws.error}); plain requests get the offline page at once. Each such attempt holds a connection, so they're a cheap way to tie up the hub`);
            else r.pass(`refused in ${ms} ms (${ws.status || ws.error})`);
        },
    },
];
