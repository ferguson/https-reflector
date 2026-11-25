import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';
import WaitServer from './WaitServer';
import DashboardAuth, { Role } from './DashboardAuth';

const log = {...console};

const WRONG_PASSWORD_DELAY_MS = 1000;   // makes guessing the password over many websockets slow

// anything with a getStatus() returning { pools: {devicename: {pool_size, waiting_queue_length}}, ... }
interface PoolStatusSource {
    getStatus(): any;
}

interface Viewer {
    role: Role;
    name: string | null;     // who signed in; null for the password or an open dashboard
    via: 'account' | 'password' | 'open';
}


export default class StatusServer {
    private clients: Map<any, Viewer>;
    private auth: DashboardAuth;
    private hostnames: string[];
    tracker: DeviceTracker;
    waitServer: WaitServer | null;
    poolSource: PoolStatusSource | null;

    constructor(tracker: DeviceTracker, waitServer: WaitServer | null, auth: DashboardAuth, hostnames: string[] = [], poolSource: PoolStatusSource | null = null) {
        this.tracker    = tracker;
        this.waitServer = waitServer;
        this.auth       = auth;
        this.hostnames  = hostnames;
        this.poolSource = poolSource;
        this.clients    = new Map();

        tracker.onUpdate = () => this.broadcast();
        if (waitServer) {
            waitServer.onWaitersChanged = () => this.broadcast();
        }
        setInterval(() => this.broadcast(), 5000);
    }


    // Close codes the dashboard page understands: 4401 wrong password, 4400 sign-in needed
    // (no password on this hub to fall back on), 4403 not from the dashboard's own page.
    addClient(ws: any, req: any): void {
        ws.on('error', () => { ws.close(); });
        if (!this.auth.originOk(req)) {
            log.warn(`StatusServer: refused a dashboard connection from a page at ${req.headers.origin}`);
            ws.close(4403, 'wrong origin');
            return;
        }
        const s = this.auth.session(req);
        if (s && s.role) {
            this.registerClient(ws, { role: s.role, name: s.name, via: 'account' });
        } else if (this.auth.password) {
            // the first message is the password
            ws.once('message', (msg: any) => {
                if (!this.auth.checkPassword(msg.toString().trim())) {
                    log.warn('StatusServer: rejected client — wrong password');
                    setTimeout(() => ws.close(4401, 'unauthorized'), WRONG_PASSWORD_DELAY_MS);
                    return;
                }
                this.registerClient(ws, { role: 'operator', name: null, via: 'password' });
            });
        } else if (this.auth.required) {
            ws.close(4400, 'sign in');
        } else {
            // nothing set up: anyone may look, nobody may change anything
            this.registerClient(ws, { role: 'viewer', name: null, via: 'open' });
        }
    }


    private buildSnapshot(): object {
        const snap: any = this.tracker.getSnapshot();
        snap.hostnames = this.hostnames;
        if (this.waitServer) {
            snap.waiting        = this.waitServer.getWaiters();
            snap.failedAttempts = this.waitServer.getFailedAttempts();
        }
        if (this.poolSource) {
            const status = this.poolSource.getStatus() || {};
            snap.pools     = status.pools || {};
            snap.uplinkCap = {
                cappable: status.max_uplinks_per_device || 0,
                legacy:   status.max_uplinks_legacy || 0,
                warnAt:   status.warn_uplinks_per_device || 0,
            };
        }
        return snap;
    }


    broadcast(): void {
        if (this.clients.size === 0) return;
        const payload = JSON.stringify(this.buildSnapshot());
        for (const ws of this.clients.keys()) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(payload); } catch (e) { /* ignore */ }
            }
        }
    }


    private handleCommand(ws: any, msg: any): void {
        let cmd: any;
        try { cmd = JSON.parse(msg.toString()); } catch (e) { return; }
        if (!cmd || typeof cmd !== 'object') return;
        const reply = (error: string | null) => {
            try { ws.send(JSON.stringify({ reply: cmd.action, name: cmd.name, ok: !error, error })); } catch (e) { /* ignore */ }
        };
        const viewer = this.clients.get(ws);
        if (!viewer || viewer.role !== 'operator') {
            return reply(viewer && viewer.via === 'open'
                ? 'This dashboard is open to anyone, so it is read-only. Set a dashboard password (HTTPS_REFLECTOR_STATUS_PASSWORD) or sign-in to make changes.'
                : 'You can look, but not change anything: your account is a viewer on this hub.');
        }
        if (typeof cmd.name !== 'string' || !cmd.name) return reply('no device name given');
        if (cmd.action === 'archive') {
            const err = this.tracker.archive(cmd.name);
            if (!err) log.log(`StatusServer: ${viewer.name || viewer.via} archived ${cmd.name}`);
            return reply(err);
        }
        if (cmd.action === 'unarchive') {
            const err = this.tracker.unarchive(cmd.name);
            if (!err) log.log(`StatusServer: ${viewer.name || viewer.via} restored ${cmd.name}`);
            return reply(err);
        }
        reply(`unknown action ${cmd.action}`);
    }


    private registerClient(ws: any, viewer: Viewer): void {
        this.clients.set(ws, viewer);
        log.log(`StatusServer: client connected (${viewer.name || viewer.via}, ${viewer.role}; ${this.clients.size} total)`);

        // who the page is talking as, then the current state
        try {
            ws.send(JSON.stringify({ you: { role: viewer.role, name: viewer.name, via: viewer.via, canEdit: viewer.role === 'operator' } }));
            ws.send(JSON.stringify(this.buildSnapshot()));
        } catch (e) { /* ignore */ }

        // commands from the dashboard: {"action": "archive" | "unarchive", "name": "..."}
        ws.on('message', (msg: any) => this.handleCommand(ws, msg));

        ws.on('close', () => {
            this.clients.delete(ws);
            log.log(`StatusServer: client disconnected (${this.clients.size} remaining)`);
        });
        ws.on('error', () => {
            this.clients.delete(ws);
        });
    }
}
