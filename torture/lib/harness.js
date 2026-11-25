'use strict';
// Sets up what the tests run against: two devices (A and B, each a real device client
// tunnelling to its own Target), and in local mode the hub itself. Gives tests a context
// with request helpers, and checks after every test that nothing broke.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const Target = require('./target');
const { exchange, buildRequest } = require('./http1');
const { openWebSocket } = require('./ws');
const { sleep, newId, randomName } = require('./util');

const WRAPPER = path.join(__dirname, 'client-wrapper.js');

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

class Proc {
    constructor(label, args, opts = {}) {
        this.label = label;
        this.lines = [];
        this.exited = null;
        this.child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } });
        const take = (d) => {
            for (const line of d.toString().split('\n')) {
                if (!line.trim()) continue;
                this.lines.push(line);
                if (this.lines.length > 400) this.lines.shift();
                if (opts.verbose) console.log(`    [${label}] ${line}`);
            }
        };
        this.child.stdout.on('data', take);
        this.child.stderr.on('data', take);
        this.child.on('exit', (code, signal) => { this.exited = { code, signal, at: Date.now() }; });
    }
    alive() { return this.exited === null; }
    kill() { if (this.alive()) this.child.kill('SIGKILL'); }
    tail(n = 15) { return this.lines.slice(-n).join('\n'); }
    grep(re) { return this.lines.filter((l) => re.test(l)); }
    rss() {
        try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(this.child.pid)]).toString().trim()) * 1024; } catch (e) { return null; }
    }
}

class Harness {
    constructor(opts) {
        this.opts = opts;
        this.repo = path.resolve(__dirname, '../..');
        this.clientDir = path.resolve(opts.client || path.join(this.repo, 'https-reflector-client'));
        this.serverDir = path.join(this.repo, 'https-reflector-server');
        this.procs = [];
        this.devices = {};
        this.acceptedSmuggles = new Set();   // hidden requests a test showed were plain pipelining
    }

    async setup() {
        const o = this.opts;
        if (o.local) {
            if (!fs.existsSync(path.join(this.serverDir, 'build', 'main.js'))) throw new Error('hub not built: run yarn build in https-reflector-server');
            this.hubPort = o.hubPort || await freePort();
            this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torture-hub-'));
            this.base = 'localhost';
            this.hubWildcard = `http://*.localhost:${this.hubPort}`;
            this.pins = { localhost: '127.0.0.1' };
            this.startHub();
            await this.waitForPort('127.0.0.1', this.hubPort, 10000);
            const e = o.entry ? new URL(o.entry) : new URL(`http://127.0.0.1:${this.hubPort}`);
            this.entryBase = { tls: e.protocol === 'https:', address: e.hostname, port: Number(e.port || (e.protocol === 'https:' ? 443 : 80)), insecure: true };
            this.hostPort = o.entry ? '' : `:${this.hubPort}`;
        } else {
            const u = new URL(o.hub);
            this.base = u.hostname;
            this.hubWildcard = `${u.protocol}//*.${u.host}`;
            this.pins = o.resolve ? { [this.base]: o.resolve } : {};
            const e = o.entry ? new URL(o.entry) : u;
            const tls = e.protocol === 'https:';
            this.entryBase = {
                tls, address: o.entry ? e.hostname : (o.resolve || null),
                port: Number(e.port || (tls ? 443 : 80)), insecure: !!o.insecure,
            };
            this.hostPort = (u.port && !o.entry) ? `:${u.port}` : '';
        }
        this.hubHost = this.base;
        for (const tag of ['A', 'B']) {
            const name = randomName(o.prefix || 'torture-');
            const target = new Target(tag);
            await target.start();
            this.devices[tag] = { tag, name, host: `${name}.${this.base}`, target, proc: null };
            this.startClient(tag);
        }
        for (const tag of ['A', 'B']) {
            const ok = await this.waitReachable(tag, 30000);
            if (!ok) {
                throw new Error(`device ${tag} (${this.devices[tag].name}) never became reachable through the hub.\n` +
                    `client output:\n${this.devices[tag].proc.tail(20)}` + (this.hub ? `\nhub output:\n${this.hub.tail(20)}` : ''));
            }
        }
    }

    startHub() {
        const args = [path.join(this.serverDir, 'https-reflector-server.js'), '--hostname', '*.localhost', '--port', String(this.hubPort), '--bind', '127.0.0.1', '--data-dir', this.dataDir];
        if (this.opts.statusPassword) args.push('--status-password', this.opts.statusPassword);
        this.hub = new Proc('hub', args, { verbose: this.opts.verbose > 1 });
        this.procs.push(this.hub);
    }

    startClient(tag, { name, targetPort, label } = {}) {
        const d = this.devices[tag];
        const proc = new Proc(label || `client-${tag}`, [WRAPPER, this.clientDir, JSON.stringify(this.pins),
            '--reflector', this.hubWildcard, '--host', '127.0.0.1', '--port', String(targetPort || d.target.port), '--devicename', name || d.name],
        { verbose: this.opts.verbose > 1 });
        this.procs.push(proc);
        if (!name) d.proc = proc;
        return proc;
    }

    // an extra client process (e.g. a rogue claiming a device's name)
    spawnClient(name, targetPort, label) {
        return this.startClient('A', { name, targetPort, label });
    }

    async waitForPort(host, port, ms) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const ok = await new Promise((r) => { const s = net.connect(port, host, () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
            if (ok) return true;
            await sleep(200);
        }
        throw new Error(`nothing listening on ${host}:${port}`);
    }

    // where a test's connection goes: the entry point, with SNI = the device's host name
    entry(hostname) {
        return { ...this.entryBase, host: hostname, servername: net.isIP(hostname) ? undefined : hostname };
    }

    hostHeader(tag) { return this.devices[tag].host + this.hostPort; }

    acceptSmuggled(id) { this.acceptedSmuggles.add(`smuggled-${id}`); }

    id(tag = 'A') { return `${tag}-${newId()}`; }

    // one well-formed request to device `tag`; returns the exchange result
    async request(tag, { method = 'GET', path = '/t/echo', headers = [], body = null, chunked = false, timeout = 15000, id } = {}) {
        id = id || this.id(tag);
        const sep = path.includes('?') ? '&' : '?';
        const p = path + sep + 'id=' + id;
        const r = await exchange(this.entry(this.devices[tag].host), [buildRequest({ method, path: p, host: this.hostHeader(tag), headers: [['x-torture-id', id], ...headers], body, chunked })], { methods: [method], timeout });
        r.id = id;
        return r;
    }

    async canary(tag, timeout = 8000) {
        const id = `${tag}-canary-${newId()}`;
        const r = await this.request(tag, { id, timeout });
        const seen = r.response && r.response.status === 200 && this.devices[tag].target.find(id);
        return !!seen;
    }

    async waitReachable(tag, ms) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            if (await this.canary(tag, 5000)) return true;
            await sleep(500);
        }
        return false;
    }

    async openWS(tag, opts = {}) {
        return openWebSocket(this.entry(opts.hostname || this.devices[tag].host), { host: opts.host || this.hostHeader(tag), ...opts });
    }

    // After every test: is everything still up? Did anything leak across devices?
    async health(sinceT) {
        const problems = [];
        const notes = [];
        if (this.hub && !this.hub.alive()) problems.push(`HUB PROCESS DIED (exit ${JSON.stringify(this.hub.exited)})\n${this.hub.tail(15)}`);
        for (const tag of ['A', 'B']) {
            const d = this.devices[tag];
            if (!d.proc.alive()) problems.push(`device client ${tag} DIED (exit ${JSON.stringify(d.proc.exited)})\n${d.proc.tail(15)}`);
        }
        // cross-delivery and smuggling, from what the targets saw
        for (const tag of ['A', 'B']) {
            const t = this.devices[tag].target;
            for (const e of t.since(sinceT)) {
                if (e.id && /^[AB]-/.test(e.id) && e.id[0] !== tag) problems.push(`CROSS-DELIVERY: request ${e.id} meant for device ${e.id[0]} reached device ${tag} (${e.method} ${e.url})`);
                if (e.url && /smuggled/i.test(e.url) && ![...this.acceptedSmuggles].some((s) => e.url.includes(s))) problems.push(`SMUGGLED REQUEST reached device ${tag}: ${e.method} ${e.url}`);
                if (e.kind === 'clientError') notes.push(`device ${tag}'s HTTP server rejected something that reached it (${e.error}): ${JSON.stringify((e.rawPacket || '').slice(0, 100))}`);
            }
        }
        // reachability (with time to recover, e.g. after a client reconnect)
        for (const tag of ['A', 'B']) {
            if (await this.canary(tag)) continue;
            const t0 = Date.now();
            const back = await this.waitReachable(tag, this.opts.recoverMs || 20000);
            if (back) notes.push(`device ${tag} was unreachable after the test; came back after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
            else problems.push(`device ${tag} UNREACHABLE after the test and did not recover in ${(this.opts.recoverMs || 20000) / 1000} s`);
        }
        return { problems, notes };
    }

    // put things back after a test broke them, so the run can go on
    async repair() {
        if (this.hub && !this.hub.alive()) {
            this.startHub();
            await this.waitForPort('127.0.0.1', this.hubPort, 10000);
        }
        for (const tag of ['A', 'B']) {
            const d = this.devices[tag];
            if (!d.target.server.listening) await d.target.restart().catch(() => {});
            if (!d.proc.alive() || !(await this.canary(tag, 5000))) {
                d.proc.kill();
                this.startClient(tag);
            }
        }
        for (const tag of ['A', 'B']) await this.waitReachable(tag, 30000);
    }

    async teardown() {
        for (const p of this.procs) p.kill();
        // with the dashboard password, file our throwaway names under Archived so test runs
        // don't pile up in the hub's device list (a hub that is torn down anyway needn't bother)
        if (this.opts.statusPassword && !this.opts.local) await this.archiveOurNames().catch(() => {});
        for (const d of Object.values(this.devices)) await d.target.stop();
        if (this.dataDir) fs.rmSync(this.dataDir, { recursive: true, force: true });
    }
}

Harness.prototype.archiveOurNames = async function () {
    const names = Object.values(this.devices).map((d) => d.name);
    await sleep(1500);   // let the hub see the clients go
    const ws = await openWebSocket(this.entry(this.base), { host: this.base + this.hostPort, path: '/https-reflector/status.ws', timeout: 8000 });
    if (!ws.ok) return;
    try {
        ws.sendText(this.opts.statusPassword);
        for (const name of names) ws.sendText(JSON.stringify({ action: 'archive', name }));
        const until = Date.now() + 5000;
        let done = 0;
        while (done < names.length && Date.now() < until) {
            const m = await ws.next(Math.max(1, until - Date.now()));
            if (!m.text) break;
            const d = JSON.parse(m.text);
            if (d.reply) { done++; if (!d.ok) console.log(`  (could not archive ${d.name}: ${d.error})`); }
        }
        if (done === names.length) console.log(`archived our test devices on the hub: ${names.join(', ')}`);
    } finally { ws.destroy(); }
};

module.exports = { Harness, freePort };
