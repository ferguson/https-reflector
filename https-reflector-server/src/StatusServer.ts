import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';

const log = {...console};


export default class StatusServer {
    private clients: Set<any>;
    private password: string | null;
    tracker: DeviceTracker;

    constructor(tracker: DeviceTracker, password: string | null) {
        this.tracker  = tracker;
        this.password = password || null;
        this.clients  = new Set();

        tracker.onUpdate = () => this.broadcast();
    }


    addClient(ws: any): void {
        if (this.password) {
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


    broadcast(): void {
        if (this.clients.size === 0) return;
        const payload = JSON.stringify(this.tracker.getSnapshot());
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
            ws.send(JSON.stringify(this.tracker.getSnapshot()));
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
