'use strict';
// Abuse: what one attacker with one machine can do. Only with --abuse. Against a live hub
// these WILL degrade service for everyone on it while they run.

const http2 = require('http2');
const tls = require('tls');
const { buildRequest, exchange, connect, session } = require('../lib/http1');
const { openWebSocket, nextSnapshot } = require('../lib/ws');
const { sleep, newId, fmtBytes, percentile } = require('../lib/util');

// probe both devices every `every` ms while `during` runs; report how they fared
async function probed(h, during, every = 1500) {
    const stats = { A: [], B: [] };
    let running = true;
    const loop = (async () => {
        while (running) {
            for (const tag of ['A', 'B']) {
                const x = await h.request(tag, { timeout: 8000 });
                stats[tag].push(x.response && x.response.status === 200 ? x.totalMs : null);
            }
            await sleep(every);
        }
    })();
    const rssBefore = h.hub ? h.hub.rss() : null;
    let result;
    try { result = await during(); } finally { running = false; await loop; }
    const sum = (tag) => {
        const ok = stats[tag].filter((v) => v !== null);
        return { probes: stats[tag].length, failed: stats[tag].length - ok.length, p95: percentile(ok, 95) };
    };
    return { result, A: sum('A'), B: sum('B'), rssGrowth: rssBefore && h.hub ? (h.hub.rss() || 0) - rssBefore : null };
}

function verdict(r, p, label) {
    const line = `${label}. Probes during it: device A ${p.A.failed}/${p.A.probes} failed (p95 ${p.A.p95} ms), device B ${p.B.failed}/${p.B.probes} failed (p95 ${p.B.p95} ms)${p.rssGrowth != null ? `; hub memory +${fmtBytes(Math.max(0, p.rssGrowth))}` : ''}`;
    if (p.B.failed > p.B.probes / 3) r.fail(line + ' — an attack on one device took down another');
    else if (p.A.failed > p.A.probes / 3) r.warn(line);
    else r.info(line);
}

module.exports = [
    {
        id: 'A01', category: 'abuse', abuse: true, name: 'slowloris: hundreds of connections sending headers very slowly', timeout: 120000, scaleTimeout: true,
        async run(h, r, o) {
            const n = 400 * o.scale;
            const socks = [];
            const p = await probed(h, async () => {
                for (let i = 0; i < n; i++) {
                    try {
                        const s = await connect(h.entry(h.devices.A.host));
                        s.on('error', () => {});
                        s.write(`GET /t/echo HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\n`);
                        socks.push(s);
                    } catch (e) { break; }
                }
                for (let t = 0; t < 8; t++) { await sleep(5000); socks.forEach((s) => !s.destroyed && s.write(`X-Slow-${t}: x\r\n`)); }
                return socks.filter((s) => !s.destroyed).length;
            });
            socks.forEach((s) => s.destroy());
            verdict(r, p, `${socks.length} slow connections opened, ${p.result} still held open after 40 s`);
        },
    },
    {
        id: 'A02', category: 'abuse', abuse: true, name: 'slow uploads: bodies sent a byte at a time', timeout: 120000, scaleTimeout: true,
        async run(h, r, o) {
            const n = 150 * o.scale;
            const socks = [];
            const p = await probed(h, async () => {
                for (let i = 0; i < n; i++) {
                    try {
                        const s = await connect(h.entry(h.devices.A.host));
                        s.on('error', () => {});
                        s.write(`POST /t/echo?id=${h.id('A')} HTTP/1.1\r\nHost: ${h.hostHeader('A')}\r\nContent-Length: 1000000\r\n\r\n`);
                        socks.push(s);
                    } catch (e) { break; }
                }
                for (let t = 0; t < 15; t++) { await sleep(2000); socks.forEach((s) => !s.destroyed && s.write('x')); }
                return socks.filter((s) => !s.destroyed).length;
            });
            socks.forEach((s) => s.destroy());
            verdict(r, p, `${socks.length} trickling uploads, ${p.result} still open after 30 s`);
        },
    },
    {
        id: 'A03', category: 'abuse', abuse: true, name: 'queue flood: 1200 requests a device never answers', timeout: 150000, scaleTimeout: true,
        async run(h, r, o) {
            const n = 1200 * o.scale;
            let statuses = {};
            const p = await probed(h, async () => {
                const all = await Promise.all(Array.from({ length: n }, () => exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/hang?id=${h.id('A')}`, host: h.hostHeader('A') })], { timeout: 30000 })));
                for (const x of all) { const s = x.response ? x.response.status : (x.timedOut ? 'held' : (x.error || 'closed')); statuses[s] = (statuses[s] || 0) + 1; }
            });
            h.devices.A.target.releaseHangs();
            verdict(r, p, `${n} hanging requests to device A → ${JSON.stringify(statuses)}`);
        },
    },
    {
        id: 'A04', category: 'abuse', abuse: true, name: 'connection flood: thousands of idle connections', timeout: 120000, scaleTimeout: true,
        async run(h, r, o) {
            const n = 3000 * o.scale;
            const socks = [];
            let failedAt = null;
            const p = await probed(h, async () => {
                // 50 at a time: one by one, the TLS handshakes alone take longer than the test
                // may run against a hub across the internet. Stop opening well before the
                // time limit, so a slow run reports what it got instead of timing out.
                const stopAt = Date.now() + 80000;
                for (let i = 0; i < n && !failedAt && Date.now() < stopAt; i += 50) {
                    await Promise.all(Array.from({ length: Math.min(50, n - i) }, async (_, j) => {
                        try { const s = await connect(h.entry(h.devices.A.host)); s.on('error', () => {}); socks.push(s); } catch (e) { if (!failedAt) failedAt = `${i + j} (${e.code || e.message})`; }
                    }));
                }
                await sleep(15000);
            });
            socks.forEach((s) => s.destroy());
            verdict(r, p, `${socks.length} of ${n} idle connections held for 15 s${failedAt ? `, opening failed at ${failedAt}` : ''}`);
        },
    },
    {
        id: 'A05', category: 'abuse', abuse: true, name: 'uplink flood: hundreds of stranger uplinks for one device', timeout: 120000,
        async run(h, r, o) {
            const n = 300 * o.scale;
            const socks = [];
            const p = await probed(h, async () => {
                for (let i = 0; i < n; i++) {
                    const ws = await openWebSocket(h.entry(h.devices.A.host), { host: h.hostHeader('A'), path: '/https-reflector/uplink.ws', timeout: 5000 });
                    if (!ws.ok) break;
                    socks.push(ws);
                }
                await sleep(5000);
            });
            socks.forEach((s) => s.destroy());
            if (socks.length >= n) r.warn(`the hub accepted all ${n} stranger uplinks for one device (no cap for clients that send no version header)`);
            verdict(r, p, `${socks.length} of ${n} stranger uplinks accepted`);
        },
    },
    {
        id: 'A06', category: 'abuse', abuse: true, name: 'name spam: 500 made-up devices on the wait page', timeout: 120000,
        async run(h, r, o) {
            const n = 500 * o.scale;
            const p = await probed(h, async () => {
                for (let i = 0; i < n; i++) {
                    const host = `spam-${newId()}.${h.base}`.toLowerCase();
                    const ws = await openWebSocket(h.entry(host), { host: host + h.hostPort, path: '/https-reflector/wait.ws', timeout: 3000 });
                    if (ws.ok) ws.destroy();
                }
            });
            const st = await openWebSocket(h.entry(h.base), { host: h.base + h.hostPort, path: '/https-reflector/status.ws' });
            let size = null;
            if (st.ok) { const m = await nextSnapshot(st); size = m.text ? m.text.length : null; st.destroy(); }
            verdict(r, p, `${n} made-up names${size ? `; the dashboard feed is now ${fmtBytes(size)} per update` : ''}`);
        },
    },
    {
        id: 'A07', category: 'abuse', abuse: true, name: 'request rate: 10 s at full speed from 100 connections', timeout: 120000,
        async run(h, r, o) {
            let done = 0; let failed = 0;
            const kinds = {};
            const lat = [];
            const p = await probed(h, async () => {
                const until = Date.now() + 10000;
                // kept-alive connections, like browsers (a new connection per request runs the
                // tester out of local ports long before the hub runs out of anything)
                await Promise.all(Array.from({ length: 100 * o.scale }, async () => {
                    let s = null;
                    while (Date.now() < until) {
                        if (!s || s.isClosed()) { try { s = await session(h.entry(h.devices.A.host)); } catch (e) { kinds[e.code || 'connect'] = (kinds[e.code || 'connect'] || 0) + 1; failed++; await sleep(100); continue; } }
                        const t0 = Date.now();
                        const res = await s.send(buildRequest({ path: `/t/echo?id=${h.id('A')}`, host: h.hostHeader('A') }), { timeout: 10000 });
                        if (res.status === 200) { done++; lat.push(Date.now() - t0); } else {
                            failed++;
                            const k = res.status ? String(res.status) : (res.timedOut ? 'timeout' : 'closed');
                            kinds[k] = (kinds[k] || 0) + 1;
                            s.close(); s = null;
                        }
                    }
                    if (s) s.close();
                }));
            });
            verdict(r, p, `${done} answered (${Math.round(done / 10)}/s), ${failed} failed ${JSON.stringify(kinds)}, p95 ${percentile(lat, 95)} ms`);
        },
    },
    {
        id: 'A08', category: 'abuse', abuse: true, name: 'websocket flood: 500 open websockets to one device', timeout: 120000,
        async run(h, r, o) {
            const n = 500 * o.scale;
            const socks = [];
            const p = await probed(h, async () => {
                for (let i = 0; i < n; i++) {
                    const ws = await h.openWS('A', { path: `/t/ws?id=${h.id('A')}`, timeout: 5000 });
                    if (!ws.ok) break;
                    socks.push(ws);
                }
                await sleep(5000);
            });
            socks.forEach((s) => s.destroy());
            verdict(r, p, `${socks.length} of ${n} websockets opened`);
        },
    },
    {
        id: 'A09', category: 'abuse', abuse: true, needs: 'tls', name: 'HTTP/2 rapid reset: thousands of streams opened and cancelled', timeout: 60000,
        async run(h, r, o) {
            const p = await probed(h, async () => {
                const s = http2.connect(`https://${h.devices.A.host}`, { createConnection: () => tls.connect({ host: h.entryBase.address || h.devices.A.host, port: h.entryBase.port, servername: h.devices.A.host, ALPNProtocols: ['h2'], rejectUnauthorized: !h.entryBase.insecure }) });
                let goaway = null;
                s.on('goaway', (code) => { goaway = code; });
                s.on('error', () => {});
                let sent = 0;
                for (let i = 0; i < 5000 * o.scale && !s.destroyed && !goaway; i++) {
                    try { const st = s.request({ ':path': `/t/slow?ms=5000&id=${h.id('A')}` }); st.on('error', () => {}); st.close(http2.constants.NGHTTP2_CANCEL); sent++; } catch (e) { break; }
                    if (i % 200 === 0) await sleep(1);
                }
                await sleep(3000);
                s.destroy();
                return { sent, goaway };
            });
            verdict(r, p, `${p.result.sent} streams opened and reset${p.result.goaway !== null ? `, front end sent GOAWAY (${p.result.goaway})` : ''}`);
        },
    },
];
