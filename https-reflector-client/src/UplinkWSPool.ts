import stream = require('stream');
import WSPool from './WSPool';
import { createUplinkWS } from './UplinkWS';
import { UplinkWSOptions, UplinkConnectorOptions } from './types';

const log = {...console};
log.debug = ()=>{};

const DEFAULT_POOL_SIZE = 10;


export default class UplinkWSPool extends WSPool {
    hub_uplink_ws_url: string;
    ws_options: UplinkWSOptions;
    pool_size: number;

    constructor(hub_uplink_ws_url: string, options: UplinkConnectorOptions) {
        super();
        this.hub_uplink_ws_url = hub_uplink_ws_url;

        this.ws_options = {
            http_server_injection: options.http_server_injection,
            uplink_to_host: options.uplink_to_host,
            uplink_to_port: options.uplink_to_port,
        };

        this.pool_size = options.pool_size || DEFAULT_POOL_SIZE;
    }


    fillPool(): void {
        while (this.getPoolSize() < this.pool_size) {
            let ws = createUplinkWS(this.hub_uplink_ws_url, this.ws_options);
            this.addOne(ws);
        }
    }


    releaseOne(ws: stream.Duplex): boolean {
        let deleted = super.releaseOne(ws);
        if (deleted) this.fillPool();
        return deleted;
    }


    terminateOne(ws: stream.Duplex): void {
        super.terminateOne(ws);
        this.fillPool();
    }
}
