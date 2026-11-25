#!/usr/bin/env node
'use strict';
// https-reflector torture suite. See README.md.

const fs = require('fs');
const path = require('path');
const { Harness } = require('./lib/harness');
const { withTimeout } = require('./lib/util');

const USAGE = `
usage: node torture/torture.js (--local | --hub <url>) [options]

  --local                 start a hub from this checkout (needs yarn build) on 127.0.0.1
  --hub <url>             test a running hub, e.g. https://otto.stream (devices dial *.otto.stream)
  --entry <url>           send browser-side requests here instead (a proxy in front of a --local
                          hub, or a specific front end); Host/SNI stay the device's name
  --resolve <ip>          pin the hub's name to this address for every connection, devices too
                          (test a new box before DNS points at it)
  --hub-port <n>          fixed port for the --local hub (so a front proxy can point at it)
  --client <dir>          device client package to use (default: ./https-reflector-client);
                          point it at an older client to test compatibility
  --insecure              accept any TLS certificate
  --status-password <pw>  the hub's dashboard password: a --local hub gets it; with a live hub,
                          our two test devices are archived on its dashboard at the end
  --only <regex>          run tests whose id or name matches
  --category <list>       comma-separated categories to run
  --skip <regex>          skip tests whose id or name matches
  --abuse                 also run the abuse tests (floods, slowloris, name takeover at scale).
                          Do this against a --local hub, or a live one you are ready to hurt
  --long                  also run slow tests (multi-minute streams, idle timeouts)
  --scale <n>             multiply the sizes/counts of load tests (default 1)
  --json <file>           write all results as JSON
  --list                  list the tests and exit
  -v, -vv                 show test details / also hub and client output
`;

function parseArgs(argv) {
    const o = { scale: 1, verbose: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => argv[++i];
        switch (a) {
        case '--local': o.local = true; break;
        case '--hub': o.hub = val(); break;
        case '--entry': o.entry = val(); break;
        case '--resolve': o.resolve = val(); break;
        case '--hub-port': o.hubPort = Number(val()); break;
        case '--client': o.client = val(); break;
        case '--insecure': o.insecure = true; break;
        case '--status-password': o.statusPassword = val(); break;
        case '--only': o.only = new RegExp(val(), 'i'); break;
        case '--skip': o.skip = new RegExp(val(), 'i'); break;
        case '--category': o.categories = val().split(','); break;
        case '--abuse': o.abuse = true; break;
        case '--long': o.long = true; break;
        case '--scale': o.scale = Number(val()); break;
        case '--json': o.json = val(); break;
        case '--list': o.list = true; break;
        case '-v': o.verbose = 1; break;
        case '-vv': o.verbose = 2; break;
        case '-h': case '--help': console.log(USAGE); process.exit(0); break;
        default: console.error(`unknown argument ${a}\n${USAGE}`); process.exit(2);
        }
    }
    return o;
}

const RANK = { skip: 0, pass: 1, info: 2, warn: 3, fail: 4 };
const LABEL = { pass: '\x1b[32mPASS\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m', warn: '\x1b[33mWARN\x1b[0m', info: '\x1b[36mINFO\x1b[0m', skip: '\x1b[90mSKIP\x1b[0m' };

class Result {
    constructor() { this.status = 'pass'; this.messages = []; this.data = {}; this.explicit = false; }
    add(status, msg) {
        this.explicit = true;
        this.messages.push([status, msg]);
        if (RANK[status] > RANK[this.status] || (this.status === 'pass' && status === 'skip' && this.messages.length === 1)) this.status = status;
    }
    pass(m) { this.add('pass', m); }
    fail(m) { this.add('fail', m); }
    warn(m) { this.add('warn', m); }
    info(m) { this.add('info', m); }
    skip(m) { this.add('skip', m); }
    // assert-style helper: fail with msg unless cond
    check(cond, msg, okMsg) { if (cond) { if (okMsg) this.pass(okMsg); } else this.fail(msg); return !!cond; }
}

function loadTests() {
    const dir = path.join(__dirname, 'tests');
    const all = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
        for (const t of require(path.join(dir, f))) all.push({ timeout: 60000, ...t, file: f });
    }
    return all;
}

function selected(t, o, mode) {
    if (o.only && !(o.only.test(t.id) || o.only.test(t.name))) return 'not selected';
    if (o.skip && (o.skip.test(t.id) || o.skip.test(t.name))) return 'skipped by --skip';
    if (o.categories && !o.categories.includes(t.category)) return 'not selected';
    if (t.abuse && !o.abuse) return 'abuse test (needs --abuse)';
    if (t.long && !o.long) return 'slow test (needs --long)';
    if (t.needs === 'local' && !o.local) return 'needs --local';
    if (t.needs === 'tls' && !mode.tls) return 'needs TLS at the entry';
    return null;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const tests = loadTests();
    if (o.list) {
        for (const t of tests) console.log(`${t.id.padEnd(8)} ${t.category.padEnd(11)} ${t.abuse ? '[abuse] ' : ''}${t.long ? '[long] ' : ''}${t.name}`);
        return;
    }
    if (!o.local && !o.hub) { console.error(USAGE); process.exit(2); }

    const h = new Harness(o);
    console.log(o.local ? 'starting a local hub, two device clients and their targets...' : `connecting two test devices to ${o.hub}...`);
    try {
        await h.setup();
    } catch (e) {
        console.error('setup failed:', e.message);
        await h.teardown();
        process.exit(3);
    }
    const mode = { tls: h.entryBase.tls };
    console.log(`devices: A=${h.devices.A.host}  B=${h.devices.B.host}   entry: ${h.entryBase.tls ? 'https' : 'http'}://${h.entryBase.address || '<device host>'}:${h.entryBase.port}   client: ${h.clientDir}\n`);

    const results = [];
    let lastCategory = null;
    for (const t of tests) {
        const why = selected(t, o, mode);
        if (why === 'not selected') continue;
        if (t.category !== lastCategory) { console.log(`\x1b[1m${t.category}\x1b[0m`); lastCategory = t.category; }
        const r = new Result();
        const t0 = Date.now();
        if (why) {
            r.skip(why);
        } else {
            try {
                await withTimeout(t.run(h, r, o), t.timeout * (t.scaleTimeout ? Math.max(1, o.scale) : 1), `test ${t.id}`);
            } catch (e) {
                r.fail(`threw: ${e.stack || e.message}`.split('\n').slice(0, 4).join(' | '));
            }
            for (const d of Object.values(h.devices)) d.target.releaseHangs();
            if (!t.noHealth) {
                const { problems, notes } = await h.health(t0);
                for (const p of problems) r.fail(p);
                for (const n of notes) r.info(n);
                if (problems.length) {
                    console.log('    (repairing: restarting what broke)');
                    await h.repair();
                }
            }
            if (h.hub) r.data.hubRss = h.hub.rss();
        }
        if (!r.explicit) r.pass();
        const ms = Date.now() - t0;
        const first = r.messages.find(([s]) => s === r.status) || r.messages[0];
        console.log(`  ${LABEL[r.status]} ${t.id.padEnd(7)} ${t.name}${first && first[1] ? ` — ${String(first[1]).split('\n')[0]}` : ''} \x1b[90m(${(ms / 1000).toFixed(1)}s)\x1b[0m`);
        if (o.verbose || RANK[r.status] >= RANK.warn) {
            for (const entry of r.messages) {
                const [s, m] = entry;
                if (!m || entry === first) continue;
                if (!o.verbose && RANK[s] < RANK.warn) continue;
                console.log(`           ${s}: ${String(m).split('\n').join('\n             ')}`);
            }
        }
        results.push({ id: t.id, name: t.name, category: t.category, status: r.status, ms, messages: r.messages, data: r.data });
    }

    await h.teardown();
    const count = (s) => results.filter((x) => x.status === s).length;
    console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('info')} info, ${count('skip')} skipped`);
    if (o.json) {
        fs.writeFileSync(o.json, JSON.stringify({ when: new Date().toISOString(), options: { ...o, only: o.only && String(o.only), skip: o.skip && String(o.skip) }, devices: { A: h.devices.A.host, B: h.devices.B.host }, results }, null, 2));
        console.log(`results written to ${o.json}`);
    }
    process.exit(count('fail') ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
