import WSPool from './WSPool.mjs';
import UplinkWS from './UplinkWS.mjs';

const log = Object.assign({}, console);
log.debug = ()=>{};

const DEFAULT_POOL_SIZE = 10;


export default class UplinkWSPool extends WSPool {
    constructor(hub_uplink_ws_url, options) {
        super();
        this.hub_uplink_ws_url = hub_uplink_ws_url;

        this.ws_options = {
            http_server_injection: options.http_server_injection,
            uplink_to_host: options.uplink_to_host,
            uplink_to_port: options.uplink_to_port,
        };

        this.pool_size = options.pool_size || DEFAULT_POOL_SIZE;
    }


    fillPool() {
        while (this.getPoolSize() < this.pool_size) {
            let ws = new UplinkWS(this.hub_uplink_ws_url, this.ws_options);
            this.addOne(ws);

            ws.on('close', async () => {
                this.fillPool();
            });

            ws.on('error', (error) => {
                this.fillPool();
            });

            ws.socket.on('error', (error) => {
                this.fillPool();
            });

            // just a safety measure
            ws.once('data', () => {
                this.fillPool();
            });

            ws.socket.on('ping', () => {
                log.debug('ping');
            });
        }
    }
}
