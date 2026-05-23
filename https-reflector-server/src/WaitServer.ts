import WebSocket = require('ws');
import DeviceTracker from './DeviceTracker';

const log = {...console};


export default class WaitServer {
    private waiters: Map<string, Set<any>>;
    private tracker: DeviceTracker;

    constructor(tracker: DeviceTracker) {
        this.tracker = tracker;
        this.waiters = new Map();

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

        ws.on('close', () => {
            const s = this.waiters.get(devicename);
            if (s) {
                s.delete(ws);
                if (s.size === 0) this.waiters.delete(devicename);
            }
        });
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
    }
}
