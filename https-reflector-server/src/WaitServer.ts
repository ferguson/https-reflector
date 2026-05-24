import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';

const log = {...console};


interface FailedAttempt {
    firstAt: number;
    lastAt:  number;
    count:   number;
}

export default class WaitServer {
    private waiters:        Map<string, Set<any>>;
    private failedAttempts: Map<string, FailedAttempt>;
    private tracker: DeviceTracker;
    onWaitersChanged: () => void;

    constructor(tracker: DeviceTracker) {
        this.tracker        = tracker;
        this.waiters        = new Map();
        this.failedAttempts = new Map();
        this.onWaitersChanged = () => {};

        tracker.onConnect = (devicename: string) => this.notifyWaiters(devicename);
    }


    addWaiter(devicename: string | null, ws: any): void {
        if (!devicename) {
            ws.close();
            return;
        }

        // if already connected, notify immediately
        const rec = this.tracker.devices.get(devicename);
        if (rec && rec.connected) {
            try { ws.send(JSON.stringify({ online: true })); ws.close(); } catch(e) {}
            return;
        }

        let set = this.waiters.get(devicename);
        if (!set) { set = new Set(); this.waiters.set(devicename, set); }
        set.add(ws);
        log.log(`WaitServer: ${devicename} has ${set.size} waiter(s)`);
        this.onWaitersChanged();

        const cleanup = () => {
            const s = this.waiters.get(devicename);
            if (s) {
                s.delete(ws);
                if (s.size === 0) {
                    this.waiters.delete(devicename);
                    // all waiters gave up and the device was never seen — record it
                    if (!this.tracker.devices.has(devicename)) {
                        const now = Date.now();
                        const existing = this.failedAttempts.get(devicename);
                        if (existing) {
                            existing.lastAt = now;
                            existing.count++;
                        } else {
                            this.failedAttempts.set(devicename, { firstAt: now, lastAt: now, count: 1 });
                        }
                    }
                }
                this.onWaitersChanged();
            }
        };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
    }


    getWaiters(): { [name: string]: number } {
        const result: { [name: string]: number } = {};
        for (const [name, set] of this.waiters) {
            result[name] = set.size;
        }
        return result;
    }


    getFailedAttempts(): { [name: string]: FailedAttempt } {
        const result: { [name: string]: FailedAttempt } = {};
        for (const [name, rec] of this.failedAttempts) {
            result[name] = rec;
        }
        return result;
    }


    private notifyWaiters(devicename: string): void {
        const set = this.waiters.get(devicename);
        if (!set || set.size === 0) return;
        log.log(`WaitServer: notifying ${set.size} waiter(s) for ${devicename}`);
        const msg = JSON.stringify({ online: true });
        for (const ws of set) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(msg); ws.close(); } catch(e) {}
            }
        }
        this.waiters.delete(devicename);
        // device came online — clear any failed attempt record for it
        this.failedAttempts.delete(devicename);
        this.onWaitersChanged();
    }
}
