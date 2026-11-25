'use strict';
// TLS and HTTP/2 at the front end (only when the entry point speaks TLS).

const tls = require('tls');
const http2 = require('http2');
const { genBytes, sha } = require('../lib/util');

function handshake(h, opts) {
    return new Promise((resolve) => {
        const s = tls.connect({
            host: h.entryBase.address || h.devices.A.host, port: h.entryBase.port,
            servername: h.devices.A.host, rejectUnauthorized: false, ...opts,
        }, () => {
            const info = { ok: true, protocol: s.getProtocol(), alpn: s.alpnProtocol, cert: s.getPeerCertificate(true), authorized: s.authorized, authError: s.authorizationError };
            s.destroy();
            resolve(info);
        });
        s.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
        setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'timeout' }); }, 8000);
    });
}

function h2session(h) {
    return http2.connect(`https://${h.devices.A.host}`, {
        createConnection: () => tls.connect({ host: h.entryBase.address || h.devices.A.host, port: h.entryBase.port, servername: h.devices.A.host, ALPNProtocols: ['h2'], rejectUnauthorized: !h.entryBase.insecure }),
    });
}

function h2request(session, headers, body) {
    return new Promise((resolve) => {
        const req = session.request(headers);
        const chunks = [];
        let head = null;
        req.on('response', (hd) => { head = hd; });
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => resolve({ status: head && head[':status'], headers: head, body: Buffer.concat(chunks) }));
        req.on('error', (e) => resolve({ error: e.code || e.message }));
        if (body) req.end(body); else req.end();
    });
}

module.exports = [
    {
        id: 'T01', category: 'tls', name: 'certificate covers the devices and is valid', needs: 'tls',
        async run(h, r) {
            const hs = await handshake(h, { rejectUnauthorized: !h.entryBase.insecure });
            if (!r.check(hs.ok, `TLS handshake failed: ${hs.error}`)) return;
            const c = hs.cert;
            r.check(hs.authorized || h.entryBase.insecure, `certificate not trusted: ${hs.authError}`);
            const san = c.subjectaltname || '';
            r.check(san.includes(`*.${h.base}`) || san.includes(h.devices.A.host), `certificate names (${san}) don't cover ${h.devices.A.host}`);
            const left = new Date(c.valid_to) - Date.now();
            const life = new Date(c.valid_to) - new Date(c.valid_from);
            const days = Math.floor(left / 86400000);
            const lifeDays = (life / 86400000).toFixed(1);
            // ACME clients renew with a third of the lifetime left (Caddy, certbot); past that,
            // renewal is failing
            if (left < 86400000 || left < life / 10) r.fail(`certificate expires in ${(left / 3600000).toFixed(1)} hours (of a ${lifeDays}-day lifetime): renewal is failing`);
            else if (left < life / 3) r.warn(`certificate has ${days} of its ${lifeDays} days left: it should have been renewed by now`);
            if (!c.subject || !c.subject.CN) r.info('the certificate has no subject Common Name (Let\'s Encrypt shortlived/tlsserver profiles): clients on Node 11 and older reject it ("Cert is empty"), e.g. the Jibos');
            r.info(`${hs.protocol}, issuer ${c.issuer && (c.issuer.O || c.issuer.CN)}, ${days} of ${lifeDays} days left, names: ${san}`);
        },
    },
    {
        id: 'T02', category: 'tls', name: 'old TLS versions are refused', needs: 'tls',
        async run(h, r) {
            for (const v of ['TLSv1', 'TLSv1.1']) {
                const hs = await handshake(h, { minVersion: v, maxVersion: v, ciphers: 'DEFAULT:@SECLEVEL=0' });
                if (hs.ok) r.warn(`${v} accepted`);
                else if (/no protocols available|unsupported protocol/i.test(hs.error) && !/alert/i.test(hs.error)) r.info(`${v}: this Node/OpenSSL can't even offer it (${hs.error}), so not tested`);
                else r.pass(`${v} refused (${hs.error})`);
            }
        },
    },
    {
        id: 'T03', category: 'tls', name: 'ALPN and handshake without SNI', needs: 'tls',
        async run(h, r) {
            const a = await handshake(h, { ALPNProtocols: ['h2', 'http/1.1'] });
            r.info(`ALPN offering h2 + http/1.1 → ${a.alpn || 'none'}`);
            const n = await handshake(h, { servername: undefined, host: h.entryBase.address || h.devices.A.host });
            r.info(`no SNI: ${n.ok ? `handshake ok, certificate for ${n.cert.subjectaltname || n.cert.subject && n.cert.subject.CN}` : `refused (${n.error})`}`);
            const o = await handshake(h, { servername: 'unrelated.example' });
            r.info(`SNI unrelated.example: ${o.ok ? `handshake ok, certificate for ${o.cert.subjectaltname}` : `refused (${o.error})`}`);
        },
    },
    {
        id: 'T04', category: 'tls', name: 'HTTP/2: requests, uploads and 50 parallel streams', needs: 'tls',
        async run(h, r) {
            const a = await handshake(h, { ALPNProtocols: ['h2', 'http/1.1'] });
            if (a.alpn !== 'h2') { r.skip('the front end does not speak HTTP/2'); return; }
            const s = h2session(h);
            s.on('error', () => {});
            try {
                const id = h.id('A');
                const g = await h2request(s, { ':path': `/t/echo?id=${id}`, ':method': 'GET' });
                r.check(g.status === 200 && h.devices.A.target.find(id), `GET over h2: ${g.status || g.error}`);
                const body = genBytes(300000, 31);
                const pid = h.id('A');
                const p = await h2request(s, { ':path': `/t/echo?id=${pid}`, ':method': 'POST', 'content-type': 'application/octet-stream' }, body);
                const seen = h.devices.A.target.find(pid);
                r.check(p.status === 200 && seen && seen.bodySha === sha(body), `300 KB POST over h2: ${p.status || p.error}, device got ${seen ? seen.bodyLength : 'nothing'}`);
                const many = await Promise.all(Array.from({ length: 50 }, (_, i) => h2request(s, { ':path': `/t/bytes?n=${20000 + i}&seed=${i}&id=${h.id('A')}`, ':method': 'GET' }).then((x) => ({ x, i }))));
                const bad = many.filter(({ x, i }) => x.status !== 200 || sha(x.body) !== sha(genBytes(20000 + i, i)));
                r.check(!bad.length, `${bad.length} of 50 parallel h2 streams failed or came back wrong`, '50 parallel streams intact');
            } finally { s.close(); }
        },
    },
    {
        id: 'T05', category: 'tls', name: 'HTTP/2: huge header block and odd pseudo-headers', needs: 'tls',
        async run(h, r) {
            const a = await handshake(h, { ALPNProtocols: ['h2'] });
            if (a.alpn !== 'h2') { r.skip('no HTTP/2'); return; }
            const s = h2session(h);
            s.on('error', () => {});
            try {
                const big = await h2request(s, { ':path': `/t/echo?id=${h.id('A')}`, cookie: 'c='.padEnd(60000, 'x') });
                r.info(`60 KB cookie over h2: ${big.status || big.error}`);
                const auth = await h2request(s, { ':path': `/t/echo?id=${h.id('A')}`, ':authority': h.devices.B.host });
                r.info(`:authority of device B on a connection for A: ${auth.status || auth.error}${auth.body && auth.body.length ? `, answered by ${(JSON.parse(auth.body.toString() || '{}').target) || '?'}` : ''}`);
            } catch (e) {
                r.info(`threw: ${e.message}`);
            } finally { s.close(); }
        },
    },
];
