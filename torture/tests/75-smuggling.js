'use strict';
// Request smuggling: requests whose length the front end and the hub (or the device) could
// read differently, so that part of one request is taken as a second, hidden request.
// Every smuggled request asks for a path containing "smuggled"; the health check after each
// test fails it if any device ever receives one. The follow-up request on the same
// connection must still get its own answer.

const { exchange } = require('../lib/http1');
const { echoOf, describe } = require('../lib/checks');

function smuggled(H, tag) { return `GET /t/echo/smuggled-${tag} HTTP/1.1\r\nHost: ${H}\r\nX-Smuggled: 1\r\n\r\n`; }

// each case: (head of the attack request incl. its own Host, smuggled request) → attack bytes
const CASES = [
    ['CL.TE: Content-Length and chunked', (P, S) => { const body = `0\r\n\r\n${S}`; return `${P}Content-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n\r\n${body}`; }],
    ['TE.CL: chunked and a short Content-Length', (P, S) => { const size = S.length.toString(16); return `${P}Transfer-Encoding: chunked\r\nContent-Length: ${size.length + 2}\r\n\r\n${size}\r\n${S}\r\n0\r\n\r\n`; }],
    ...[
        ['Transfer-Encoding: xchunked', 'Transfer-Encoding: xchunked'],
        ['space before the colon in Transfer-Encoding', 'Transfer-Encoding : chunked'],
        ['tab before chunked', 'Transfer-Encoding:\tchunked'],
        ['vertical tab before chunked', 'Transfer-Encoding: \x0bchunked'],
        ['chunked, identity', 'Transfer-Encoding: chunked, identity'],
        ['identity, chunked', 'Transfer-Encoding: identity, chunked'],
        ['two Transfer-Encoding headers', 'Transfer-Encoding: chunked\r\nTransfer-Encoding: x'],
        ['upper-case CHUNKED', 'Transfer-encoding: CHUNKED'],
        ['folded Transfer-Encoding', 'X-Pad: x\r\n Transfer-Encoding: chunked'],
        ['LF-only before Transfer-Encoding', 'X-Pad: x\nTransfer-Encoding: chunked'],
        ['Transfer-Encoding with a NUL', 'Transfer-Encoding: chunked\x00'],
    ].map(([label, te]) => [`CL.TE with ${label}`, (P, S) => { const body = `0\r\n\r\n${S}`; return `${P}Content-Length: ${body.length}\r\n${te}\r\n\r\n${body}`; }]),
    ['two Content-Lengths (0 and the real one)', (P, S) => `${P}Content-Length: 0\r\nContent-Length: ${S.length}\r\n\r\n${S}`],
    ['two Content-Lengths (the real one and 0)', (P, S) => `${P}Content-Length: ${S.length}\r\nContent-Length: 0\r\n\r\n${S}`],
    ['Content-Length with a plus sign', (P, S) => `${P}Content-Length: +${S.length}\r\n\r\n${S}`],
    ['Content-Length "n, n"', (P, S) => `${P}Content-Length: ${S.length}, ${S.length}\r\n\r\n${S}`],
    ['Content-Length in hex', (P, S) => `${P}Content-Length: 0x${S.length.toString(16)}\r\n\r\n${S}`],
    ['GET with a Content-Length body (CL.0)', (P, S) => `${P.replace(/^POST/, 'GET')}Content-Length: ${S.length}\r\n\r\n${S}`],
    ['chunk size overflow', (P, S) => `${P}Transfer-Encoding: chunked\r\n\r\nffffffffffffffff1\r\n${S}\r\n0\r\n\r\n`],
    ['chunk size with a leading space and extension tricks', (P, S) => `${P}Transfer-Encoding: chunked\r\n\r\n 0;x="\r\n"\r\n\r\n${S}`],
    ['LF-only chunk framing', (P, S) => `${P}Transfer-Encoding: chunked\r\n\r\n0\n\n${S}`],
    ['Expect: 100-continue with a request behind it', (P, S) => `${P}Expect: 100-continue\r\nContent-Length: 0\r\n\r\n${S}`],
];

module.exports = CASES.map(([label, make], i) => ({
    id: `X${String(i + 1).padStart(2, '0')}`,
    category: 'smuggling',
    name: label,
    timeout: 30000,
    async run(h, r) {
        const id = h.id('A');
        const H = h.hostHeader('A');
        const prefix = `POST /t/echo?id=${id} HTTP/1.1\r\nHost: ${H}\r\n`;
        const attack = make(prefix, smuggled(H, id));
        const followId = h.id('A');
        const follow = `GET /t/echo?id=${followId}&follow=1 HTTP/1.1\r\nHost: ${H}\r\n\r\n`;
        const x = await exchange(h.entry(h.devices.A.host), [attack, 400, follow], { expect: 3, timeout: 7000, methods: ['POST', 'GET', 'GET'] });
        const finals = x.final || [];
        const followAnswer = finals.find((f) => (echoOf(f) || {}).id === followId);
        const wrongIds = finals.map((f) => (echoOf(f) || {}).id).filter((v) => v && v !== id && v !== followId);
        if (wrongIds.length) r.fail(`desync: the connection returned answers for ${wrongIds.join(', ')}`);
        const statuses = finals.map((f) => f.status).join(', ') || describe(x);
        // The hidden request reached the device. That is only smuggling if the parts disagree
        // about it. When the front end reads it as a second request on the sender's own
        // connection (as RFC 9112 says to for CL+TE: chunked wins) and the sender gets its
        // answer back, in order, before the follow-up's, everyone agreed: it's pipelining, it
        // went to the device the sender named anyway, and nobody else's traffic was touched.
        const iS = finals.findIndex((f) => ((echoOf(f) || {}).url || '').includes(`smuggled-${id}`));
        const iF = finals.indexOf(followAnswer);
        if (iS >= 0) {
            if (followAnswer && iF > iS) {
                h.acceptSmuggled(id);
                r.info(`the front end read the hidden request as a second request on the sender's own connection and answered it there (answers: ${statuses}): pipelining, not smuggling`);
            } else {
                r.fail(`the hidden request was answered out of step (answers: ${statuses}${followAnswer ? '' : ', the follow-up got no answer of its own'})`);
            }
            return;
        }
        r.pass(`answers: ${statuses}${followAnswer ? ' (the follow-up got its own answer)' : ''}`);
    },
}));
