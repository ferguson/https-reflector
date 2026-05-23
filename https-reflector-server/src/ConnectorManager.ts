import HubWSPool from './HubWSPool';
import DeviceTracker from './DeviceTracker';

const log = {...console};

//const MAX_UPLINK_POOL_SIZE = 30;


export default class ConnectorManager {
    connector_pool: Map<string, any>;
    io_connector_pool: Map<string, any>;
    map_of_uplink_pools: Map<string, HubWSPool>;
    private deviceTracker: DeviceTracker | null;

    constructor(deviceTracker: DeviceTracker | null = null) {
        this.connector_pool = new Map();
        this.io_connector_pool = new Map();
        this.map_of_uplink_pools = new Map();
        this.deviceTracker = deviceTracker;
    };


    async init(): Promise<void> {};


    addConnector(devicename: string, ws: any, req: any): void {
        let connector = this.connector_pool.get(devicename);
        if (!connector) {
            this.connector_pool.set(devicename, ws);
            log.log(`devicename ${devicename} connected`);
            if (this.deviceTracker) this.deviceTracker.recordConnect(devicename);
            ws.on('close', () => this.destroyConnector(devicename));
            ws.on('error', () => this.destroyConnector(devicename));
            ws.send('proceed');
        } else {
            // block this attempt to connect to an in use devicename
            ws.send('inuse');
            ws.close();
        }
    }


    addIOConnector(devicename: string, wsio: any, req: any): void {
        let io_connector = this.io_connector_pool.get(devicename);
        if (!io_connector) {
            this.connector_pool.set(devicename, wsio);
            log.log(`devicename ${devicename} connected via socket io`);
            if (this.deviceTracker) this.deviceTracker.recordConnect(devicename);
            wsio.on('disconnect', () => this.destroyConnector(devicename));
            wsio.on('connecterror', () => this.destroyConnector(devicename)); // i think this event name is wrong
            wsio.on('connect_error', (err) => {
                log.error('socket.io connect_error!', err);
                this.destroyConnector(devicename);
            });
            wsio.emit('proceed');
        } else {
            // block this attempt to connect to an in use devicename
            wsio.emit('inuse');
            wsio.disconnect();
        }
    }


    destroyConnector(devicename: string): void {
        // we lost the connection, clean up all related uplinks
        log.log(`devicename ${devicename} disconnected`);
        if (this.deviceTracker) this.deviceTracker.recordDisconnect(devicename);
        let uplink_pool = this.getUplinkPool(devicename);
        uplink_pool.destroy();
        this.connector_pool.delete(devicename);
    }


    addUplink(devicename: string, ws_stream: any, req: any): void {
        let uplink_pool = this.getUplinkPool(devicename);
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
            pool = new HubWSPool(devicename);  /*{ max_pool_size: MAX_UPLINK_POOL_SIZE }*/
            this.map_of_uplink_pools.set(devicename, pool);
        }
        return pool;
    }
}
