import http = require('http');
import pump = require('pump');
import * as express from 'express';
import _http_common = require('_http_common');
//import asyncHandler from 'express-async-handler';
import WebSocketStream = require('websocket-stream');
import { WebSocketServer, createWebSocketStream } from 'ws';
//import WS from 'ws';
//const WebSocketServer = WS.WebSocketServer;
//const createWebSocketStream = WS.createWebSocketStream;
import { Server as SocketIOServer } from 'socket.io';

import { HeaderBlock } from 'https-reflector-client';
import { HubWSPool } from './API';
import { ConnectorManager } from './API';
import { WebServerOptions } from './types';

const log = {...console};
log.debug = ()=>{};

const STATIC_DIR = __dirname + '/../static';

const HUB_PREFIX = '/https-reflector';
const LEGACY_HUB_PREFIX = '/otto-hub';  // alias kept for backward compatibility

function isHubPath(path: string): boolean {
    return path.startsWith(HUB_PREFIX) || path.startsWith(LEGACY_HUB_PREFIX);
}


export default class Hub {
    hostname: string;
    options: WebServerOptions;
    connector_manager: ConnectorManager;
    statusPools: Map<string, HubWSPool>;
    ws_server: WebSocketServer;
    static_server: any;
    io_http_server: http.Server;
    io: SocketIOServer;

    constructor(options: WebServerOptions) {
        this.hostname = options.hostname;
        this.options = options;
        this.connector_manager = new ConnectorManager();
        this.statusPools = new Map();
    }


    async init(): Promise<void> {
        this.ws_server = new WebSocketServer(
            { clientTracking: false, noServer: true, perMessageDeflate: false }
        );
        this.static_server = express.static(STATIC_DIR);
        this.io_http_server = http.createServer();
        this.io_http_server.removeAllListeners('upgrade');
        let io_opts = {
            transports: ['websocket'],  // websockets only, no long poll
            //path: HUB_PREFIX + '/',
            serveClient: false,
        };
        this.io = new SocketIOServer(this.io_http_server, io_opts);
        //this.io = new SocketIOServer(io_opts);
    }


    requestHandler(devicename: string, req: any, res: any): void {
        if (!isHubPath(req.url)) {
            // a client trying to connect to a device via the reflector
            this.upstreamRequestHandler(devicename, req, res);
        } else {
            // device reflector client connections, and requests regarding them
            this.hubInternalRequestHandler(devicename, req, res);
        }
    }


    upgradeHandler(devicename: string, req: any, socket: any, head: any): void {
        let path = req.url;
        log.debug('hub upgradeHandler', path);
        if (!isHubPath(path)) {
            // upstream socket
            this.upstreamUpgradeRequestHandler(devicename, req, socket, head);
        } else {
            // internal socket
            if (path.startsWith(HUB_PREFIX + '/socket.io/') || path.startsWith(LEGACY_HUB_PREFIX + '/socket.io/')) {
                socket.devicename = devicename;
                this.io.engine.handleUpgrade(req, socket, head);
                this.io.once('connection', (io_socket) => {
                    let host = io_socket.handshake && io_socket.handshake.headers && io_socket.handshake.headers.host;
                    let hostname = this.getHostnameFromHost(host);
                    if (this.options.use_vhosts) {
                        let devicename_now = this.getDevicenameFromHostname(hostname);
                        if (!devicename_now) {
                            throw new Error('we lost the devicename');
                        } else if (devicename_now !== devicename) {
                            log.warn('the devicename does not match');
                        }
                    }
                    log.debug('the devicename', devicename);
                    this.connector_manager.addIOConnector(devicename, io_socket, req);
                });
            } else {
                this.ws_server.handleUpgrade(req, socket, head, (ws) => {
                    log.debug('ws created with path', path, 'and devicename', devicename);
                    if (path === HUB_PREFIX + '/uplink.ws' || path === LEGACY_HUB_PREFIX + '/uplink.ws') {  // uplink ws from a client device
                        let ws_stream = WebSocketStream(ws);
                        // let ws_stream = createWebSocketStream(ws, { encoding: 'utf8' });  // maybe no encoding would do the trick to make this method work?
                        // see https://github.com/websockets/ws/issues/1781
                        this.connector_manager.addUplink(devicename, ws_stream, req);
                        // this.ws_server.emit('stream', duplex_stream, req);
//                    } else if (path === HUB_PREFIX + '/connector.ws') {  // connector ws from a client device
//                        this.connector_manager.addConnector(devicename, ws, req);
                    } else if (path === HUB_PREFIX + '/status.ws' || path === LEGACY_HUB_PREFIX + '/status.ws') {  // ws for hub status
                        let status_pool = this.getStatusPool(devicename);
                        status_pool.addOne(ws);
                        this.sendStatusUpdate(devicename, status_pool.getStatus(), ws);
                    } else {
                        log.error('ignored unknown ws stream path', path);
                    }
                });
            }
        }
    }


    async hubInternalRequestHandler(devicename: string, req: any, res: any): Promise<void> {
        let path = req.url;
        log.log('hubInternalRequest', path);

        if (!devicename) {
            // not *.some-https-reflector-server.org
            res.error(404);
        } else {
            // *.some-https-reflector-server.org requests only
            await new Promise((resolve) => process.nextTick(resolve));
            let uplink_exists = this.connector_manager.uplinkExists(devicename);
            if (isHubPath(path) || (path === '/' && !uplink_exists))
            {
                //log.debug('passing request for', path, 'to express');
                //app(req, res);
                log.debug('passing request for', path, 'to express.static');
                this.static_server(req, res, () => {});
            }
        }
    }


    upstreamRequestHandler(devicename: string, req: any, res: any): void {
        // pass the request on to the hub node
        _http_common.freeParser(req.socket.parser, req, req.socket);
        res.detachSocket(res.socket);

        this.handOffToUpstreamSocket(devicename, req);

        req.socket = null;
        req.connection = null;
        req.client = null;
        req.destroy();

        res.socket = null;
        res.connection = null;
        res.client = null;
        res.end();
        res.destroy();
    }


    upstreamUpgradeRequestHandler(devicename: string, req: any, socket: any, head: any): void {
        log.debug('hub upstream socket upgrade request', devicename, head.length, req.url);
        if (req.socket !== socket) {
            log.warn('uh-oh, we made a bad assumption. req.socket !== socket');
            log.warn('req.socket', req.socket);
            log.warn('socket', socket);
        }
        // pass the upgrade socket request on to the hub node
        // i think node has prepped everything for us so we don't
        // need to close the req or res (i hope)
        this.handOffToUpstreamSocket(devicename, req, head);
    }


    async handOffToUpstreamSocket(devicename: string, req: any, head: any = null): Promise<void> {
        let protocol = 'HTTP/1.1';  // might not want to hard code this
        if (req.httpVersion !== '1.1') {
            log.warn('not HTTP/1.1? this might be bad');
        }
        let method_line = `${req.method} ${req.url} ${protocol}`;
        let header_block_string: string;
        if (head === null) {
            // requests
            //header_block_string = HeaderBlock.buildHeaderBlockString(req.rawHeaders, true);
            header_block_string = HeaderBlock.buildHeaderBlockString(req.rawHeaders, false);  // trying this FIXME
            // // force separate connections for each request
            // header_block_string += 'Connection: close\r\n';
            //'cache-control: no-cache'?
        } else {
            // upgrade requests
            header_block_string = HeaderBlock.buildHeaderBlockString(req.rawHeaders, false);
        }

        let socket = req.socket;
        // very much needed for requests, not so much for socket upgrades (but doesn't hurt)
        if (!head) {
            socket.removeAllListeners();
        }

        log.debug('req.url', req.url);
        let ws = await this.connector_manager.getUplinkWS(devicename);
        if (!ws) {
            socket.destroy();
            return;
        }
        //ws.pipe(socket).pipe(ws);  // using pump instead
        pump(pump(socket, ws), socket, (err) => {
            if (err) log.debug('hub pump error', err.code);
        });

        try {
            ws.write(method_line + '\r\n' + header_block_string + '\r\n\r\n');
            if (head && head.length) {
                ws.write(head);
            }
        } catch (err) {
            log.debug('ws write error in handOff', err.code);
            socket.destroy();
        }
    }


    getHostHeader(req: any): string {
        let host = req.headers['host'];
        if (Array.isArray(host)) {
            host = host[0];
        }
        return host;
    }
    getHostnameFromHost(host: string): string {
        let hostname = host && host.split(':')[0];  // remove port if present
        return hostname;
    }
    getDevicenameFromHostname(hostname: string): string | null {
        let devicename = null;
        if (hostname.endsWith('.'+this.hostname)) {
            let parts = hostname && hostname.split('.', 1);
            if (parts && parts.length > 0) {
                devicename = parts[0];
            }
        }
        return devicename;
    }
    getDevicenameFromRequest(req: any): string | null {
        let host = this.getHostHeader(req) || this.hostname;
        let hostname = this.getHostnameFromHost(host);
        let devicename = this.getDevicenameFromHostname(hostname);
        return devicename;
    }


    sendStatusUpdate(devicename: string, status: any, wsocket: any = null): void {
        return;  //FIXME convert status to use socket.io
        let json: string;
        try {
            json = JSON.stringify(status);
        } catch(err) {
            log.error('error stringifying status', status, err);
            return;
        }
        log.debug('status', status, 'json', json);

        let wsockets: any[];
        if (wsocket) {
            wsockets = [wsocket];  // make it an array
        } else {
            let ws_status_pool = this.getStatusPool(devicename);
            wsockets = ws_status_pool.pool.keys();
        }

        for (let wsocket of wsockets) {
            try {
                wsocket.write(json);
            } catch(err) {
                log.error('error sending status ws message', err);
            }
        }
    }


    getStatusPool(devicename: string): HubWSPool {
        devicename = devicename || this.hostname;
        log.debug('getStatusPool devicename', devicename);
        let pool = this.statusPools.get(devicename);
        if (!pool) {
            this.statusPools.set(devicename, new HubWSPool(devicename));
            pool = this.statusPools.get(devicename);
            // ws_tunnel_pool.on('status', (status) => {
            //     this.sendStatusUpdate(devicename, status);
            // });
        }
        return pool;
    }
}
