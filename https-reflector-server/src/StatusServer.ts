import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';
import WaitServer from './WaitServer';

const log = {...console};

// anything with a getStatus() returning { pools: {devicename: {pool_size, waiting_queue_length}}, ... }
interface PoolStatusSource {
    getStatus(): any;
}


export default class StatusServer {
    private clients: Set<any>;
    private password: string | null;
    private hostnames: string[];
    tracker: DeviceTracker;
    waitServer: WaitServer | null;
    poolSource: PoolStatusSource | null;

    constructor(tracker: DeviceTracker, waitServer: WaitServer | null, password: string | null, hostnames: string[] = [], poolSource: PoolStatusSource | null = null) {
        this.tracker    = tracker;
        this.waitServer = waitServer;
        this.password   = password || null;
        this.hostnames  = hostnames;
        this.poolSource = poolSource;
        this.clients    = new Set();

        tracker.onUpdate = () => this.broadcast();
        if (waitServer) {
            waitServer.onWaitersChanged = () => this.broadcast();
        }
        setInterval(() => this.broadcast(), 5000);
    }


    addClient(ws: any): void {
        if (this.password) {
            // absorb errors while waiting for the password message
            ws.on('error', () => { ws.close(); });
            // wait for first message as password
            ws.once('message', (msg: any) => {
                const attempt = msg.toString().trim();
                if (attempt !== this.password) {
                    log.warn('StatusServer: rejected client — wrong password');
                    ws.close(4401, 'unauthorized');
                    return;
                }
                this.registerClient(ws);
            });
        } else {
            this.registerClient(ws);
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
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(payload); } catch (e) { /* ignore */ }
            }
        }
    }


    private registerClient(ws: any): void {
        this.clients.add(ws);
        log.log(`StatusServer: client connected (${this.clients.size} total)`);

        // send current state immediately
        try {
            ws.send(JSON.stringify(this.buildSnapshot()));
        } catch (e) { /* ignore */ }

        ws.on('close', () => {
            this.clients.delete(ws);
            log.log(`StatusServer: client disconnected (${this.clients.size} remaining)`);
        });
        ws.on('error', () => {
            this.clients.delete(ws);
        });
    }
}
