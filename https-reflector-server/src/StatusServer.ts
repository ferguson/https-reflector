import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';
import WaitServer from './WaitServer';

const log = {...console};


export default class StatusServer {
    private clients: Set<any>;
    private password: string | null;
    private hostnames: string[];
    tracker: DeviceTracker;
    waitServer: WaitServer | null;

    constructor(tracker: DeviceTracker, waitServer: WaitServer | null, password: string | null, hostnames: string[] = []) {
        this.tracker    = tracker;
        this.waitServer = waitServer;
        this.password   = password || null;
        this.hostnames  = hostnames;
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
