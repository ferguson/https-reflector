'use strict';
// Many requests at once: queueing, mix-ups between requests and between devices.

const { buildRequest, exchange } = require('../lib/http1');
const { echoOf, describe } = require('../lib/checks');
const { genBytes, sha, percentile, sleep } = require('../lib/util');

module.exports = [
    {
        id: 'C01', category: 'concurrency', name: 'burst of parallel GETs: every answer is the right one', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const n = 150 * o.scale;
            const results = await Promise.all(Array.from({ length: n }, () => h.request('A', { timeout: 60000 })));
            const statuses = {};
            let wrong = 0;
            for (const x of results) {
                const s = x.response ? x.response.status : (x.timedOut ? 'timeout' : (x.error || 'closed'));
                statuses[s] = (statuses[s] || 0) + 1;
                if (x.response && x.response.status === 200 && (echoOf(x.response) || {}).id !== x.id) wrong++;
            }
            const lat = results.filter((x) => x.response).map((x) => x.totalMs);
            r.check(!wrong, `${wrong} requests got ANOTHER request's answer`);
            r.check(statuses[200] === n, `of ${n}: ${JSON.stringify(statuses)}`, `${n} answered, p50 ${percentile(lat, 50)} ms, p95 ${percentile(lat, 95)} ms`);
        },
    },
    {
        id: 'C02', category: 'concurrency', name: 'parallel uploads arrive with the right bodies', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const n = 60 * o.scale;
            const results = await Promise.all(Array.from({ length: n }, (_, i) => {
                const body = genBytes(50000 + i * 101, 1000 + i);
                return h.request('A', { method: 'POST', body, timeout: 60000 }).then((x) => ({ x, body }));
            }));
            let bad = 0;
            for (const { x, body } of results) {
                const seen = h.devices.A.target.find(x.id);
                if (!seen || seen.bodySha !== sha(body) || !x.response || x.response.status !== 200) bad++;
            }
            r.check(!bad, `${bad} of ${n} parallel uploads failed or arrived wrong`, `${n} uploads intact`);
        },
    },
    {
        id: 'C03', category: 'concurrency', name: 'requests to two devices at once never cross (front-end connection reuse)', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            // A front end that pools upstream connections to the hub would hand a later request,
            // for ANY device, to whichever device an earlier request's connection was given to.
            const n = 200 * o.scale;
            const results = await Promise.all(Array.from({ length: n }, (_, i) => {
                const tag = i % 2 ? 'B' : 'A';
                return h.request(tag, { timeout: 60000 }).then((x) => ({ x, tag }));
            }));
            let crossed = 0;
            let failed = 0;
            for (const { x, tag } of results) {
                const e = echoOf(x.response);
                if (!e) { failed++; continue; }
                if (e.target !== tag) crossed++;
            }
            r.check(!crossed, `${crossed} of ${n} requests were answered by the OTHER device (front end reusing upstream connections? needs keep-alive off toward the hub)`);
            r.check(!failed, `${failed} of ${n} got no proper answer`, `${n} requests, none crossed`);
        },
    },
    {
        id: 'C04', category: 'concurrency', name: 'small requests are not starved by big downloads', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const big = Array.from({ length: 5 }, (_, i) => h.request('A', { path: `/t/bytes?n=${(20 << 20) * o.scale}&seed=${i}`, timeout: 100000 }));
            await sleep(300);
            const small = [];
            for (let i = 0; i < 10; i++) { small.push(await h.request('A', { timeout: 30000 })); await sleep(100); }
            const lat = small.filter((x) => x.response).map((x) => x.totalMs);
            const p95 = percentile(lat, 95);
            await Promise.all(big);
            r.check(lat.length === 10, `${10 - lat.length} small requests failed during the downloads`);
            if (p95 > 3000) r.warn(`small requests took up to ${p95} ms while big downloads ran`);
            else r.pass(`small requests p95 ${p95} ms during 5 big downloads`);
        },
    },
    {
        id: 'C05', category: 'concurrency', name: 'device keeps answering while 20 requests hang on it',
        async run(h, r) {
            const hangs = Array.from({ length: 20 }, () => exchange(h.entry(h.devices.A.host), [buildRequest({ path: `/t/hang?id=${h.id('A')}`, host: h.hostHeader('A') })], { timeout: 12000 }));
            await sleep(1500);
            const t0 = Date.now();
            const x = await h.request('A', { timeout: 10000 });
            r.check(x.response && x.response.status === 200, `a normal request while 20 hang: ${describe(x)}`, `answered in ${Date.now() - t0} ms with 20 requests hanging`);
            h.devices.A.target.releaseHangs();
            await Promise.all(hangs);
        },
    },
    {
        id: 'C06', category: 'concurrency', name: 'one device\'s queue does not slow the other device', scaleTimeout: true, timeout: 120000,
        async run(h, r, o) {
            const n = 300 * o.scale;
            const flood = Array.from({ length: n }, () => h.request('A', { path: '/t/slow?ms=3000', timeout: 60000 }));
            await sleep(500);
            const lat = [];
            for (let i = 0; i < 5; i++) { const x = await h.request('B', { timeout: 10000 }); lat.push(x.response ? x.totalMs : 99999); await sleep(200); }
            const results = await Promise.all(flood);
            const ok = results.filter((x) => x.response && x.response.status === 200).length;
            const p = Math.max(...lat);
            r.check(p < 2000, `device B took up to ${p} ms while device A had ${n} queued requests`, `device B max ${p} ms while A had ${n} queued`);
            r.info(`device A: ${ok} of ${n} slow requests answered (others: ${JSON.stringify(results.filter((x) => !x.response || x.response.status !== 200).slice(0, 3).map(describe))})`);
        },
    },
];
