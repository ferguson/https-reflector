import UplinkConnector from './UplinkConnector.mjs';

const log = Object.assign(console, {});

const DEFAULT_UPLINK_TO_HOST = 'localhost';
const DEFAULT_UPLINK_TO_PORT = 9090;
const POOL_SIZE = 7;
const DEBOUNCE_TIMEOUT_MS = 1000;


export default class HubUplinkClient {
    constructor(hub_url, options) {
        this.hub_url = hub_url;
        this.connector_options = {
            pool_size: POOL_SIZE,
            http_server_injection: options.http_server,  // currently ignored FIXME
            uplink_to_host: options.uplink_to_host || DEFAULT_UPLINK_TO_HOST,
            uplink_to_port: options.uplink_to_port || DEFAULT_UPLINK_TO_PORT,
        };
        this.timeout = null;
    }


    async init(devicename=null) {
        if (devicename) {
            await this.startConnector(devicename);
        }
    }


    setDevicename(devicename) {
        if (devicename !== this.devicename) {
            if (devicename) {
                this.stopConnector();
                this.startConnector(devicename);
            } else {
                this.stopConnector();
            }
            this.devicename = devicename;
        }
    }


    async startConnector(devicename) {
        let url = new URL(this.hub_url);
        if (url.hostname.startsWith('*.')) {
            url.hostname = url.hostname.replace('*', devicename);  // prepend the devicename as a "vhost"
        }
        let hub_url = url.href;
        log.warn('attempting an uplink connection to', hub_url);
        this.uplink_connector = new UplinkConnector(hub_url, this.connector_options);
        await this.uplink_connector.init();

        this.uplink_connector.on('connected', () => {
            log.warn(`https-reflector server ${hub_url} connected`);
        });

        this.uplink_connector.on('disconnected', () => {
            log.warn(`https-reflector server ${hub_url} disconnected`);
        });
    }


    stopConnector() {
        if (this.uplink_connector) {
            this.uplink_connector.disconnect();
            delete this.uplink_connector;
        }

    }
}
