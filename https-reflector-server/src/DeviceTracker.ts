import fs = require('fs');
import path = require('path');
import { DeviceRecord } from './types';

const log = {...console};

const SAVE_INTERVAL_MS = 30 * 1000;
const SUMMARY_FILE = 'reflector-summary.json';
const EVENTS_FILE  = 'reflector-events.jsonl';


export default class DeviceTracker {
    devices: Map<string, DeviceRecord>;
    dataDir: string;
    onUpdate: () => void;
    onConnect: (devicename: string) => void;
    serverStartAt: number;
    private saveTimer: NodeJS.Timeout | null;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.devices = new Map();
        this.onUpdate = () => {};
        this.onConnect = () => {};
        this.serverStartAt = Date.now();
        this.saveTimer = null;
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
        this.save();
    }


    recordConnect(devicename: string): void {
        const now = Date.now();
        let rec = this.devices.get(devicename);
        if (!rec) {
            rec = {
                firstSeenAt: now,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                connectionCount: 0,
                requestCount: 0,
                bytesIn: 0,
                bytesOut: 0,
                connected: false,
                sessionStartAt: null,
            };
            this.devices.set(devicename, rec);
        }
        rec.connected = true;
        rec.lastConnectedAt = now;
        rec.sessionStartAt = now;
        rec.connectionCount++;
        this.appendEvent({ ts: now, event: 'connect', device: devicename });
        this.save();
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
        this.save();
        this.onUpdate();
    }


    recordRequest(devicename: string): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.requestCount++;
        this.onUpdate();
    }


    addBytes(devicename: string, bytesIn: number, bytesOut: number): void {
        const rec = this.devices.get(devicename);
        if (!rec) return;
        rec.bytesIn  += bytesIn;
        rec.bytesOut += bytesOut;
        // no onUpdate() here — too frequent; dashboard refreshes on connect/disconnect
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
                this.devices.set(name, {
                    firstSeenAt:        s.firstSeenAt        != null ? s.firstSeenAt        : Date.now(),
                    lastConnectedAt:    s.lastConnectedAt    != null ? s.lastConnectedAt    : null,
                    lastDisconnectedAt: s.lastDisconnectedAt != null ? s.lastDisconnectedAt : null,
                    connectionCount:    s.connectionCount    != null ? s.connectionCount    : 0,
                    requestCount:       s.requestCount       != null ? s.requestCount       : 0,
                    bytesIn:            s.bytesIn            != null ? s.bytesIn            : 0,
                    bytesOut:           s.bytesOut           != null ? s.bytesOut           : 0,
                    connected:    false,
                    sessionStartAt: null,
                });
            }
            log.log(`DeviceTracker: loaded ${this.devices.size} device(s) from ${file}`);
        } catch (err) {
            log.error('DeviceTracker: failed to load summary', err);
        }
    }


    save(): void {
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
            };
        }
        try {
            fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), devices: data }, null, 2));
        } catch (err) {
            log.error('DeviceTracker: failed to save summary', err);
        }
    }


    private appendEvent(obj: object): void {
        const file = path.join(this.dataDir, EVENTS_FILE);
        try {
            fs.appendFileSync(file, JSON.stringify(obj) + '\n');
        } catch (err) {
            log.error('DeviceTracker: failed to append event', err);
        }
    }


    private ensureDataDir(): void {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
}
