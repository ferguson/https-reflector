import http = require('http');
import path = require('path');
import pump = require('pump');
import * as express from 'express';
import _http_common = require('_http_common');
//import asyncHandler from 'express-async-handler';
import WebSocketStream = require('websocket-stream');
import { WebSocketServer } from 'ws';
import { Server as SocketIOServer } from 'socket.io';

import { HeaderBlock } from 'https-reflector-client';
import { ConnectorManager } from './API';
import { WebServerOptions } from './types';
import DeviceTracker from './DeviceTracker';
import StatusServer from './StatusServer';
import WaitServer from './WaitServer';

const log = {...console};
log.debug = ()=>{};

const STATIC_DIR = __dirname + '/../static';
const DEFAULT_DATA_DIR = path.join(__dirname, '../data');

const HUB_PREFIX = '/https-reflector';
const LEGACY_HUB_PREFIX = '/otto-hub';  // alias kept for backward compatibility

function isHubPath(p: string): boolean {
    return p.startsWith(HUB_PREFIX) || p.startsWith(LEGACY_HUB_PREFIX);
}


export default class Hub {
    hostname: string;
    hostnames: string[];
    options: WebServerOptions;
    connector_manager: ConnectorManager;
    ws_server: WebSocketServer;
    static_server: any;
    io_http_server: http.Server;
    io: SocketIOServer;
    deviceTracker: DeviceTracker;
    statusServer: StatusServer;
    waitServer: WaitServer;

    constructor(options: WebServerOptions) {
        this.hostname  = options.hostname;
        this.hostnames = options.hostnames || [options.hostname];
        this.options   = options;
        const dataDir = options.data_dir || DEFAULT_DATA_DIR;
        this.deviceTracker = new DeviceTracker(dataDir);
        this.waitServer    = new WaitServer(this.deviceTracker);
        this.connector_manager = new ConnectorManager(this.deviceTracker);
        this.statusServer  = new StatusServer(this.deviceTracker, this.waitServer, options.status_password || null, this.hostnames, this.connector_manager);
    }


    async init(): Promise<void> {
        this.deviceTracker.init();
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
        // One persistent handler. The old per-upgrade io.once('connection') was a
        // race: two devices handshaking at once both fired on the first connection,
        // binding both names to one socket and leaving the other device without a
        // 'proceed' (it then sat there forever).
        this.io.on('connection', (io_socket) => this.handleIOConnection(io_socket));
    }


    shutdown(): void {
        this.deviceTracker.shutdown();
    }


    handleIOConnection(io_socket: any): void {
        let devicename: string;
        if (this.options.use_vhosts) {
            let host = io_socket.handshake && io_socket.handshake.headers && io_socket.handshake.headers.host;
            let hostname = this.getHostnameFromHost(host) || '';
            devicename = this.getDevicenameFromHostname(hostname);
            if (!devicename) {
                log.warn('socket.io connector with no devicename in host header:', host);
                io_socket.disconnect(true);
                return;
            }
        } else {
            devicename = 'default';
        }
        log.debug('the devicename', devicename);
        this.connector_manager.addIOConnector(devicename, io_socket, io_socket.request);
    }


    requestHandler(devicename: string, req: any, res: any): void {
        if (isHubPath(req.url)) {
            // device reflector client connections, and requests regarding them
            this.hubInternalRequestHandler(devicename, req, res);
        } else if (this.connector_manager.uplinkExists(devicename)) {
            // device is online — proxy the request through
            this.upstreamRequestHandler(devicename, req, res);
        } else {
            // device is offline — serve the wait page for any path
            req.url = '/';
            this.static_server(req, res, () => { res.statusCode = 503; res.end(); });
        }
    }


    upgradeHandler(devicename: string, req: any, socket: any, head: any): void {
        let p = req.url;
        log.debug('hub upgradeHandler', p);
        if (!isHubPath(p)) {
            // upstream socket
            this.upstreamUpgradeRequestHandler(devicename, req, socket, head);
        } else {
            // internal socket
            if (p.startsWith(HUB_PREFIX + '/socket.io/') || p.startsWith(LEGACY_HUB_PREFIX + '/socket.io/')) {
                socket.devicename = devicename;
                this.io.engine.handleUpgrade(req, socket, head);
                // registration happens in handleIOConnection() once socket.io finishes its handshake
            } else {
                this.ws_server.handleUpgrade(req, socket, head, (ws) => {
                    log.debug('ws created with path', p, 'and devicename', devicename);
                    if (p === HUB_PREFIX + '/uplink.ws' || p === LEGACY_HUB_PREFIX + '/uplink.ws') {
                        let ws_stream = WebSocketStream(ws);
                        this.connector_manager.addUplink(devicename, ws_stream, req);
//                    } else if (p === HUB_PREFIX + '/connector.ws') {  // connector ws from a client device
//                        this.connector_manager.addConnector(devicename, ws, req);
                    } else if (p === HUB_PREFIX + '/status.ws' || p === LEGACY_HUB_PREFIX + '/status.ws') {
                        this.statusServer.addClient(ws);
                    } else if (p === HUB_PREFIX + '/wait.ws') {
                        this.waitServer.addWaiter(devicename, ws);
                    } else {
                        log.error('ignored unknown ws stream path', p);
                        ws.close();
                    }
                });
            }
        }
    }


    async hubInternalRequestHandler(devicename: string, req: any, res: any): Promise<void> {
        let p = req.url;
        log.log('hubInternalRequest', p);

        if (!devicename) {
            // not *.some-https-reflector-server.org
            res.statusCode = 404;
            res.end();
        } else {
            // *.some-https-reflector-server.org requests only
            await new Promise((resolve) => process.nextTick(resolve));
            let uplink_exists = this.connector_manager.uplinkExists(devicename);
            if (isHubPath(p) || (p === '/' && !uplink_exists)) {
                log.debug('passing request for', p, 'to express.static');
                this.static_server(req, res, () => { res.statusCode = 404; res.end(); });
            } else {
                res.statusCode = 404;
                res.end();
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
            header_block_string = HeaderBlock.buildHeaderBlockString(req.rawHeaders, false);  // trying this FIXME
        } else {
            // upgrade requests
            header_block_string = HeaderBlock.buildHeaderBlockString(req.rawHeaders, false);
        }

        let socket = req.socket;
        // very much needed for requests, not so much for socket upgrades (but doesn't hurt)
        if (!head) {
            socket.removeAllListeners();
        }
        socket.on('error', (err) => {
            log.debug('proxied socket error', err.code || err.message);
            socket.destroy();
        });

        log.debug('req.url', req.url);
        let ws = await this.connector_manager.getUplinkWS(devicename);
        if (!ws) {
            // the device is registered but supplied no uplink socket in time
            if (!head && socket.writable && !socket.destroyed) {
                let body = 'The device is connected to the reflector but did not answer in time.\n';
                socket.end(
                    'HTTP/1.1 504 Gateway Timeout\r\n' +
                    'Content-Type: text/plain\r\n' +
                    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
                    'Connection: close\r\n' +
                    '\r\n' + body
                );
            } else {
                socket.destroy();
            }
            return;
        }
        if (socket.destroyed) {
            // the browser gave up while we waited; return the uplink unused
            log.debug('client socket gone before an uplink arrived');
            ws.destroy();
            return;
        }

        // count bytes flowing through this proxied connection
        this.deviceTracker.recordRequest(devicename);
        socket.on('data', (chunk: Buffer) => this.deviceTracker.addBytes(devicename, chunk.length, 0));
        ws.on('data',     (chunk: Buffer) => this.deviceTracker.addBytes(devicename, 0, chunk.length));

        this.deviceTracker.tunnelOpened(devicename);
        pump(pump(socket, ws), socket, (err) => {
            if (err) log.debug('hub pump error', err.code);
            this.deviceTracker.tunnelClosed(devicename);
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
        for (const base of this.hostnames) {
            if (hostname.endsWith('.' + base)) {
                const parts = hostname.split('.', 1);
                if (parts && parts.length > 0) {
                    return parts[0];
                }
            }
        }
        return null;
    }
    getDevicenameFromRequest(req: any): string | null {
        let host = this.getHostHeader(req) || this.hostname;
        let hostname = this.getHostnameFromHost(host);
        let devicename = this.getDevicenameFromHostname(hostname);
        return devicename;
    }
}
