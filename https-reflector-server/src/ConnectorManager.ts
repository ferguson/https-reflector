import { CLIENT_VERSION_HEADER, MIN_CAPPABLE_CLIENT_VERSION, compareVersions } from 'https-reflector-client';
import HubWSPool from './HubWSPool';
import DeviceTracker from './DeviceTracker';

const log = {...console};

// Per-device cap on idle uplink sockets held by the hub, for clients that
// identify themselves (x-https-reflector-client header) as a version that
// backs off when an uplink is refused. A healthy client keeps 7. 0 = unlimited.
const MAX_UPLINKS_PER_DEVICE = parseInt(process.env.HTTPS_REFLECTOR_MAX_UPLINKS_PER_DEVICE || '32', 10) || 0;
// Cap for legacy clients (no version header). Default 0 = never refuse, only
// log: those clients refill an uplink the instant it is closed, with no
// backoff, so refusing turns a leaked pool into a tight reconnect loop.
const MAX_UPLINKS_LEGACY = parseInt(process.env.HTTPS_REFLECTOR_MAX_UPLINKS_LEGACY || '0', 10) || 0;
// Log (once per crossing) when a device holds more idle uplinks than this.
const WARN_UPLINKS_PER_DEVICE = 64;


function clientVersionOf(req: any): string | null {
    let v = req && req.headers && req.headers[CLIENT_VERSION_HEADER];
    if (Array.isArray(v)) v = v[0];
    return v ? String(v) : null;
}

function isCappable(version: string | null): boolean {
    return !!version && compareVersions(version, MIN_CAPPABLE_CLIENT_VERSION) >= 0;
}


export default class ConnectorManager {
    connector_pool: Map<string, any>;
    io_connector_pool: Map<string, any>;
    map_of_uplink_pools: Map<string, HubWSPool>;
    private deviceTracker: DeviceTracker | null;
    private warned_pools: Set<string>;

    constructor(deviceTracker: DeviceTracker | null = null) {
        this.connector_pool = new Map();
        this.io_connector_pool = new Map();
        this.map_of_uplink_pools = new Map();
        this.deviceTracker = deviceTracker;
        this.warned_pools = new Set();
        log.log(`uplink cap per device: ${MAX_UPLINKS_PER_DEVICE || 'none'} (clients >= ${MIN_CAPPABLE_CLIENT_VERSION}), ${MAX_UPLINKS_LEGACY || 'none'} (legacy clients)`);
    };


    async init(): Promise<void> {};


    addConnector(devicename: string, ws: any, req: any): void {
        let connector = this.connector_pool.get(devicename);
        if (!connector) {
            this.connector_pool.set(devicename, ws);
            log.log(`devicename ${devicename} connected`);
            if (this.deviceTracker) this.deviceTracker.recordConnect(devicename, clientVersionOf(req));
            ws.on('close', () => this.destroyConnector(devicename, ws));
            ws.on('error', () => this.destroyConnector(devicename, ws));
            ws.send('proceed');
        } else {
            // block this attempt to connect to an in use devicename
            ws.send('inuse');
            ws.close();
        }
    }


    addIOConnector(devicename: string, wsio: any, req: any): void {
        let existing = this.connector_pool.get(devicename);
        if (existing && existing !== wsio) {
            // Newest wins. The existing one is nearly always the same device's
            // previous connection that socket.io hasn't timed out yet (the client
            // reconnects in seconds, the hub notices the dead socket in ~45 s).
            // Before this check, the stale socket's eventual disconnect
            // unregistered the live one and the device showed as offline.
            log.warn(`devicename ${devicename} reconnected while an older connector was registered; replacing it`);
            existing.removeAllListeners('disconnect');
            try {
                existing.emit('inuse');  // if it really is another live device, it backs off and retries
                existing.disconnect(true);
            } catch (err) {
                log.warn('error closing replaced connector', err && err.message);
            }
        }
        const version = clientVersionOf(req);
        this.connector_pool.set(devicename, wsio);
        log.log(`devicename ${devicename} connected via socket io (client ${version || 'legacy'})`);
        if (this.deviceTracker) this.deviceTracker.recordConnect(devicename, version);
        wsio.on('disconnect', () => this.destroyConnector(devicename, wsio));
        wsio.on('connect_error', (err) => {
            log.error('socket.io connect_error!', err);
            this.destroyConnector(devicename, wsio);
        });
        wsio.emit('proceed');
    }


    destroyConnector(devicename: string, connector: any = null): void {
        if (connector && this.connector_pool.get(devicename) !== connector) {
            // a connection we already replaced went away; the live one is unaffected
            log.log(`stale connector for ${devicename} went away`);
            return;
        }
        // we lost the connection, clean up all related uplinks
        log.log(`devicename ${devicename} disconnected`);
        if (this.deviceTracker) this.deviceTracker.recordDisconnect(devicename);
        let uplink_pool = this.getUplinkPool(devicename);
        uplink_pool.destroy();
        this.map_of_uplink_pools.delete(devicename);  // destroyed pools refuse new sockets; a fresh one is made on demand
        this.connector_pool.delete(devicename);
        this.warned_pools.delete(devicename);
    }


    addUplink(devicename: string, ws_stream: any, req: any): void {
        let uplink_pool = this.getUplinkPool(devicename);
        let size = uplink_pool.getPoolSize();
        let version = clientVersionOf(req);
        let cappable = isCappable(version);
        let limit = cappable ? MAX_UPLINKS_PER_DEVICE : MAX_UPLINKS_LEGACY;
        if (limit && size >= limit) {
            log.warn(`[${devicename}] uplink pool full (${size}, client ${version || 'legacy'}), refusing another uplink`);
            try {
                ws_stream.socket.close(1013, 'uplink pool full');  // 1013 = try again later
            } catch (err) {
                ws_stream.destroy();
            }
            return;
        }
        if (size >= WARN_UPLINKS_PER_DEVICE && !this.warned_pools.has(devicename)) {
            this.warned_pools.add(devicename);
            if (cappable) {
                log.warn(`[${devicename}] holds ${size} idle uplinks (a healthy client keeps 7)`);
            } else {
                log.warn(`[${devicename}] holds ${size} idle uplinks from a legacy client (${version || 'no version header'}); it is leaking pools and needs a restart, and cannot be capped safely until it is updated`);
            }
        }
        uplink_pool.addOne(ws_stream);
    }


    async getUplinkWS(devicename: string): Promise<any> {
        let uplink_pool = this.getUplinkPool(devicename);
        return uplink_pool.grabOne();
    }


    uplinkExists(devicename: string): boolean {
        let uplink_exists = false;
        if (this.connector_pool.get(devicename)) {
            uplink_exists = true;
        }
        return uplink_exists;
    }


    getUplinkPool(devicename: string): HubWSPool {
        devicename = devicename || 'default';
        let pool = this.map_of_uplink_pools.get(devicename);
        if (!pool) {
            pool = new HubWSPool(devicename);
            this.map_of_uplink_pools.set(devicename, pool);
        }
        return pool;
    }


    getStatus(): any {
        let pools: any = {};
        for (const [name, pool] of this.map_of_uplink_pools) {
            pools[name] = pool.getStatus();  // { pool_size, waiting_queue_length }
        }
        return {
            pools: pools,
            max_uplinks_per_device:  MAX_UPLINKS_PER_DEVICE,
            max_uplinks_legacy:      MAX_UPLINKS_LEGACY,
            warn_uplinks_per_device: WARN_UPLINKS_PER_DEVICE,
        };
    }
}
