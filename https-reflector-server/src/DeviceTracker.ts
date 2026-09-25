import fs = require('fs');
import path = require('path');
import { DeviceRecord } from './types';

const log = {...console};

const SAVE_INTERVAL_MS = 30 * 1000;
// Connect/disconnect used to rewrite the summary file synchronously every
// time. During a reconnect storm that stalls the event loop, which times out
// more socket.io connections, which causes more reconnects. Now they coalesce.
const SAVE_DEBOUNCE_MS = 2 * 1000;
const SUMMARY_FILE = 'reflector-summary.json';
const EVENTS_FILE  = 'reflector-events.jsonl';


export default class DeviceTracker {
    devices: Map<string, DeviceRecord>;
    dataDir: string;
    onUpdate: () => void;
    onConnect: (devicename: string) => void;
    serverStartAt: number;
    private saveTimer: NodeJS.Timeout | null;
    private saveDebounce: any;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.devices = new Map();
        this.onUpdate = () => {};
        this.onConnect = () => {};
        this.serverStartAt = Date.now();
        this.saveTimer = null;
        this.saveDebounce = null;
    }


    init(): void {
        this.ensureDataDir();
        this.load();
        this.saveTimer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
    }


    shutdown(): void {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.saveDebounce) {
            clearTimeout(this.saveDebounce);
            this.saveDebounce = null;
        }
        this.save(true);  // synchronous: the process may be about to exit
    }


    private newRecord(now: number): DeviceRecord {
        return {
            firstSeenAt: now,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            connectionCount: 0,
            requestCount: 0,
            bytesIn: 0,
            bytesOut: 0,
            connected: false,
            sessionStartAt: null,
            clientVersion: null,
            lastRequestAt: null,
            lastActivityAt: null,
            activeTunnels: 0,
        };
    }


    recordConnect(devicename: string, clientVersion: string | null = null): void {
        const now = Date.now();
        let rec = this.devices.get(devicename);
        if (!rec) {
            rec = this.newRecord(now);
            this.devices.set(devicename, rec);
        }
        rec.connected = true;
        rec.lastConnectedAt = now;
        rec.sessionStartAt = now;
        rec.connectionCount++;
        rec.clientVersion = clientVersion;
        this.appendEvent({ ts: now, event: 'connect', device: devicename, client: clientVersion });
        this.scheduleSave();
        this.onUpdate();
        this.onConnect(devicename);
    }


    recordDisconnect(devicename: string): void {
        const now = Date.now();
        const rec = this.devices.get(devicename);
        if (!rec) return;
        const durationMs = rec.sessionStartAt ? now - rec.sessionStartAt : 0;
        rec.connected = false;
        rec.lastDisconnectedAt = now;
        rec.sessionStartAt = null;
        this.appendEvent({
            ts: now,
            event: 'disconnect',
            device: devicename,
            durationMs,
        });
        this.scheduleSave();
        this.onUpdate();
    }


    recordRequest(devicename: string): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.requestCount++;
        rec.lastRequestAt = Date.now();
        this.onUpdate();
    }


    // a proxied connection (browser <-> uplink) has been wired up / has finished
    tunnelOpened(devicename: string): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.activeTunnels++;
        rec.lastActivityAt = Date.now();
        this.onUpdate();
    }

    tunnelClosed(devicename: string): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.activeTunnels = Math.max(0, rec.activeTunnels - 1);
        rec.lastActivityAt = Date.now();
        this.onUpdate();
    }


    addBytes(devicename: string, bytesIn: number, bytesOut: number): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.bytesIn  += bytesIn;
        rec.bytesOut += bytesOut;
        rec.lastActivityAt = Date.now();
        // no onUpdate() here — too frequent; dashboard refreshes on connect/disconnect and every 5 s
    }


    getSnapshot(): object {
        const devices: Record<string, object> = {};
        for (const [name, rec] of this.devices) {
            devices[name] = {
                connected:          rec.connected,
                firstSeenAt:        rec.firstSeenAt,
                lastConnectedAt:    rec.lastConnectedAt,
                lastDisconnectedAt: rec.lastDisconnectedAt,
                sessionStartAt:     rec.sessionStartAt,
                connectionCount:    rec.connectionCount,
                requestCount:       rec.requestCount,
                bytesIn:            rec.bytesIn,
                bytesOut:           rec.bytesOut,
                clientVersion:      rec.clientVersion,
                lastRequestAt:      rec.lastRequestAt,
                lastActivityAt:     rec.lastActivityAt,
                activeTunnels:      rec.activeTunnels,
            };
        }
        return { ts: Date.now(), serverStartAt: this.serverStartAt, devices };
    }


    private load(): void {
        const file = path.join(this.dataDir, SUMMARY_FILE);
        if (!fs.existsSync(file)) return;
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(raw);
            for (const [name, saved] of Object.entries(data.devices || {})) {
                const s = saved as any;
                const rec = this.newRecord(Date.now());
                rec.firstSeenAt        = s.firstSeenAt        != null ? s.firstSeenAt        : rec.firstSeenAt;
                rec.lastConnectedAt    = s.lastConnectedAt    != null ? s.lastConnectedAt    : null;
                rec.lastDisconnectedAt = s.lastDisconnectedAt != null ? s.lastDisconnectedAt : null;
                rec.connectionCount    = s.connectionCount    != null ? s.connectionCount    : 0;
                rec.requestCount       = s.requestCount       != null ? s.requestCount       : 0;
                rec.bytesIn            = s.bytesIn            != null ? s.bytesIn            : 0;
                rec.bytesOut           = s.bytesOut           != null ? s.bytesOut           : 0;
                rec.clientVersion      = s.clientVersion      != null ? s.clientVersion      : null;
                rec.lastRequestAt      = s.lastRequestAt      != null ? s.lastRequestAt      : null;
                rec.lastActivityAt     = s.lastActivityAt     != null ? s.lastActivityAt     : null;
                this.devices.set(name, rec);
            }
            log.log(`DeviceTracker: loaded ${this.devices.size} device(s) from ${file}`);
        } catch (err) {
            log.error('DeviceTracker: failed to load summary', err);
        }
    }


    private scheduleSave(): void {
        if (this.saveDebounce) return;
        this.saveDebounce = setTimeout(() => {
            this.saveDebounce = null;
            this.save();
        }, SAVE_DEBOUNCE_MS);
    }


    save(sync: boolean = false): void {
        const file = path.join(this.dataDir, SUMMARY_FILE);
        const data: Record<string, object> = {};
        for (const [name, rec] of this.devices) {
            data[name] = {
                firstSeenAt:        rec.firstSeenAt,
                lastConnectedAt:    rec.lastConnectedAt,
                lastDisconnectedAt: rec.lastDisconnectedAt,
                connectionCount:    rec.connectionCount,
                requestCount:       rec.requestCount,
                bytesIn:            rec.bytesIn,
                bytesOut:           rec.bytesOut,
                clientVersion:      rec.clientVersion,
                lastRequestAt:      rec.lastRequestAt,
                lastActivityAt:     rec.lastActivityAt,
            };
        }
        const json = JSON.stringify({ savedAt: Date.now(), devices: data }, null, 2);
        if (sync) {
            try {
                fs.writeFileSync(file, json);
            } catch (err) {
                log.error('DeviceTracker: failed to save summary', err);
            }
            return;
        }
        fs.writeFile(file, json, (err) => {
            if (err) log.error('DeviceTracker: failed to save summary', err);
        });
    }


    private appendEvent(obj: object): void {
        const file = path.join(this.dataDir, EVENTS_FILE);
        fs.appendFile(file, JSON.stringify(obj) + '\n', (err) => {
            if (err) log.error('DeviceTracker: failed to append event', err);
        });
    }


    private ensureDataDir(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
}
