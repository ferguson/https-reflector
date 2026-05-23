import { EventEmitter } from 'events';
import WebSocket = require('ws');
import io_client = require('socket.io-client');

import UplinkWSPool from './UplinkWSPool';
import { UplinkConnectorOptions } from './types';

const log = {...console};
log.debug = ()=>{};

const HEARTBEAT_INTERVAL_MS = 10 * 1000;  // 10 seconds
const DEFAULT_RETRY_TIMEOUT_MS = 3000;  // 3 seconds


export default class UplinkConnector extends EventEmitter {
    hub_url: string;
    connected: boolean;
    heartbeat_interval: NodeJS.Timeout | null;
    retry_timeout: NodeJS.Timeout | null;
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
        this.heartbeat_interval = null;
        this.retry_timeout = null;
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
        //this.connect_old();
        this.connect_new();
    }


    connect_new(): void {
        let opts = {
            reconnection: false,
            transports: ['websocket'],
            path: '/https-reflector/socket.io/',
        };
        this.connector_wsio = io_client(this.hub_uplink_io_url, opts);
        this.connector_wsio.connect();

        this.connector_wsio.onAny( (event, ...args) => {
            log.debug('message from hub', event, ...args);
        });

        this.connector_wsio.on('connect', () => {
            log.log('socket.io connected');
        });

        this.connector_wsio.on('proceed', () => {
            log.log('hub says to proceed');
            this.connected = true;
            this.emit('connected');
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
            this.close_or_error();  // FIXME should probably delay longer than the default retry delay here?
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


    close_or_error(): void {
        this.disconnect();
        this.reconnect();
    }


    async reconnect(): Promise<void> {
        if (this.retry_timeout) {
            return;  // a reconnect is already pending
        }
        await new Promise<void>( (resolve) => {
            this.retry_timeout = setTimeout( () => {
                this.retry_timeout = null;
                resolve();
            }, DEFAULT_RETRY_TIMEOUT_MS);
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


    disconnect(): void {
        this.connected = false;
        this.emit('disconnected');
        if (this.connector_wsio) {
            this.connector_wsio.disconnect();
            delete this.connector_wsio;  // FIXME should reuse the client and use manual connect
        }
        if (this.connector_ws) {
            this.connector_ws.terminate();
            delete this.connector_ws;
        }
        if (this.uplink_ws_pool) {
            this.uplink_ws_pool.destroy();
            delete this.uplink_ws_pool;
        }
        clearInterval(this.heartbeat_interval);
        this.heartbeat_interval = null;
    }
}
