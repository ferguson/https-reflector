import { EventEmitter } from 'events';
import WebSocket = require('ws');
import io_client = require('socket.io-client');

import UplinkWSPool from './UplinkWSPool';
import { UplinkConnectorOptions } from './types';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './version';

const log = {...console};
log.debug = ()=>{};

const HEARTBEAT_INTERVAL_MS = 10 * 1000;  // 10 seconds
const DEFAULT_RETRY_TIMEOUT_MS = 3000;  // 3 seconds, base delay
const MAX_RETRY_TIMEOUT_MS = 60 * 1000;  // cap for the doubling retry delay
const INUSE_RETRY_TIMEOUT_MS = 30 * 1000;  // floor when the hub says our name is taken
const PROCEED_TIMEOUT_MS = 20 * 1000;  // how long to wait for the hub's 'proceed' after connecting


export default class UplinkConnector extends EventEmitter {
    hub_url: string;
    connected: boolean;
    stopped: boolean;
    heartbeat_interval: NodeJS.Timeout | null;
    retry_timeout: NodeJS.Timeout | null;
    proceed_timeout: NodeJS.Timeout | null;
    consecutive_failures: number;
    uplink_ws_pool: UplinkWSPool | null;
    hub_uplink_io_url: string;
    connector_ws_url: string;
    hub_uplink_ws_url: string;
    pool_options: UplinkConnectorOptions;
    connector_wsio: any;
    connector_ws: WebSocket | null;

    constructor(hub_url: string, options: UplinkConnectorOptions) {
        super();
        this.hub_url = hub_url;
        this.connected = false;
        this.stopped = false;
        this.heartbeat_interval = null;
        this.retry_timeout = null;
        this.proceed_timeout = null;
        this.consecutive_failures = 0;
        this.uplink_ws_pool = null;
        this.connector_wsio = null;
        this.connector_ws = null;

        let url = new URL(this.hub_url);
        let ws_protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.protocol = ws_protocol;

        url.pathname = '';
        this.hub_uplink_io_url = url.href;
        url.pathname = '/https-reflector/connector.ws';
        this.connector_ws_url = url.href;
        url.pathname = '/https-reflector/uplink.ws';
        this.hub_uplink_ws_url = url.href;
        this.pool_options = {
            pool_size: options.pool_size,
            http_server_injection: options.http_server_injection,
            uplink_to_host: options.uplink_to_host,
            uplink_to_port: options.uplink_to_port,
        };
    }


    async init(): Promise<void> {
        this.connect();
    }


    connect(): void {
        if (this.stopped) {
            return;
        }
        //this.connect_old();
        this.connect_new();
    }


    connect_new(): void {
        let extraHeaders: any = {};
        extraHeaders[CLIENT_VERSION_HEADER] = CLIENT_VERSION;
        let opts = {
            reconnection: false,
            transports: ['websocket'],
            path: '/https-reflector/socket.io/',
            extraHeaders: extraHeaders,  // identify our client version to the hub
        };
        this.connector_wsio = io_client(this.hub_uplink_io_url, opts);
        this.connector_wsio.connect();

        // If the hub never says 'proceed' (it used to happen when two devices
        // connected at once), don't sit on a half-open connection forever.
        this.clearProceedTimeout();
        this.proceed_timeout = setTimeout( () => {
            this.proceed_timeout = null;
            log.warn(`hub did not say proceed within ${PROCEED_TIMEOUT_MS} ms, reconnecting`);
            this.close_or_error();
        }, PROCEED_TIMEOUT_MS);

        this.connector_wsio.onAny( (event, ...args) => {
            log.debug('message from hub', event, ...args);
        });

        this.connector_wsio.on('connect', () => {
            log.log('socket.io connected');
        });

        this.connector_wsio.on('proceed', () => {
            log.log('hub says to proceed');
            this.clearProceedTimeout();
            this.consecutive_failures = 0;
            this.connected = true;
            this.emit('connected');
            if (this.uplink_ws_pool) {
                // a repeated 'proceed' on the same connection; keep the pool we have
                return;
            }
            this.uplink_ws_pool = new UplinkWSPool(this.hub_uplink_ws_url, this.pool_options);
            this.uplink_ws_pool.fillPool();
            // socket.io has its own heartbeat so this interval is unneeded; restore if ever
            // switching back to plain WebSockets via connect_old():
            //this.heartbeat_interval = setInterval( () => { this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
        });

        this.connector_wsio.on('connect_error', (err) => {
            log.warn(`hub socket io connect_error ${err}`);
            this.close_or_error();
        });

        this.connector_wsio.on('connect_failed', (err) => {
            log.warn(`hub socket io connect_failed ${err}`);
            this.close_or_error();
        });

        this.connector_wsio.on('inuse', () => {
            log.warn(`devicename for url ${this.hub_url} is already in use on the hub`);
            this.close_or_error(INUSE_RETRY_TIMEOUT_MS);
        });

        this.connector_wsio.on('disconnect', (details) => {
            log.log('hub disconnect', details);
            this.close_or_error();
        });

        // not sure this is a actual event
        this.connector_wsio.on('error', (details) => {
            log.log('hub error', details);
            this.close_or_error();
        });
    }


    connect_old(): void {
        this.connector_ws = new WebSocket(this.connector_ws_url);

        this.connector_ws.on('open', () => {
            this.connector_ws.on('message', (data) => {
                let message = String(data);
                log.debug('message from hub', message);
                if (message === 'proceed') {
                    this.connected = true;
                    this.emit('connected');
                    this.uplink_ws_pool = new UplinkWSPool(this.hub_uplink_ws_url, this.pool_options);
                    this.uplink_ws_pool.fillPool();
                    this.heartbeat_interval = setInterval( () => { this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
                } else if (message === 'inuse') {
                    log.warn(`devicename for url ${this.hub_url} is already in use on the reflector`);
                }
            });
        });

        this.connector_ws.on('close', () => {
            this.close_or_error();
        });
        this.connector_ws.on('error', () => {
            this.close_or_error();
        });
    }


    close_or_error(min_delay_ms: number = 0): void {
        this.disconnect();
        this.reconnect(min_delay_ms);
    }


    // Delay doubles per consecutive failure (3s, 6s, 12s, ... capped at 60s)
    // with +/-50% jitter, so a hub restart doesn't bring every device back at
    // the exact same instant. Reset on 'proceed'.
    retryDelay(min_delay_ms: number): number {
        let exponent = Math.min(this.consecutive_failures, 6);
        let base = Math.min(DEFAULT_RETRY_TIMEOUT_MS * Math.pow(2, exponent), MAX_RETRY_TIMEOUT_MS);
        base = Math.max(base, min_delay_ms);
        return Math.round(base * (0.5 + Math.random()));
    }


    async reconnect(min_delay_ms: number = 0): Promise<void> {
        if (this.stopped) {
            return;
        }
        if (this.retry_timeout) {
            return;  // a reconnect is already pending
        }
        let delay = this.retryDelay(min_delay_ms);
        this.consecutive_failures++;
        log.log(`reconnecting to hub in ${delay} ms`);
        await new Promise<void>( (resolve) => {
            this.retry_timeout = setTimeout( () => {
                this.retry_timeout = null;
                resolve();
            }, delay);
        });

        this.connect();
    }


    heartbeat(): void {
        // if (ws && ws.readystate === 1) {
        //     ws.socket.ping();
        //     log.debug('ping');
        // }
        if (this.connector_ws) {
            this.connector_ws.ping();
        }
    }


    clearProceedTimeout(): void {
        if (this.proceed_timeout) {
            clearTimeout(this.proceed_timeout);
            this.proceed_timeout = null;
        }
    }


    disconnect(): void {
        this.connected = false;
        this.emit('disconnected');
        this.clearProceedTimeout();
        if (this.connector_wsio) {
            // Drop our listeners first: socket.io emits 'disconnect' synchronously
            // from disconnect(), which would re-enter close_or_error().
            let wsio = this.connector_wsio;
            delete this.connector_wsio;  // FIXME should reuse the client and use manual connect
            try { wsio.offAny(); } catch (err) {}
            wsio.removeAllListeners();
            wsio.disconnect();
        }
        if (this.connector_ws) {
            let ws = this.connector_ws;
            delete this.connector_ws;
            ws.removeAllListeners();
            ws.on('error', () => {});
            ws.terminate();
        }
        if (this.uplink_ws_pool) {
            let pool = this.uplink_ws_pool;
            delete this.uplink_ws_pool;
            pool.destroy();
        }
        clearInterval(this.heartbeat_interval);
        this.heartbeat_interval = null;
    }


    // Permanent shutdown: disconnect and never reconnect. disconnect() alone
    // used to leave a pending reconnect that resurrected the connector.
    stop(): void {
        this.stopped = true;
        if (this.retry_timeout) {
            clearTimeout(this.retry_timeout);
            this.retry_timeout = null;
        }
        this.disconnect();
        this.removeAllListeners();
    }
}
