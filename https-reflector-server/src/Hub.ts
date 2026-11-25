import http = require('http');
import path = require('path');
import * as express from 'express';
import _http_common = require('_http_common');
//import asyncHandler from 'express-async-handler';
import WebSocketStream = require('websocket-stream');
import { WebSocketServer } from 'ws';
import { Server as SocketIOServer } from 'socket.io';

import { HeaderBlock, MIN_EARLY_DATA_CLIENT_VERSION, compareVersions } from 'https-reflector-client';
import { ConnectorManager } from './API';
import { WebServerOptions } from './types';
import DeviceTracker from './DeviceTracker';
import StatusServer from './StatusServer';
import DashboardAuth from './DashboardAuth';
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

// How long the hub waits for a pre-2.2.0 client's 100 Continue before sending a request
// body regardless (see relayFromDevice)
const CONTINUE_WAIT_MS = 1000;
const CRLF = Buffer.from('\r\n');
const NO_UPLINK_MESSAGE = 'The device is connected to the reflector but did not answer in time.\n';

function takesEarlyData(client_version: string | null): boolean {
    return !!client_version && compareVersions(client_version, MIN_EARLY_DATA_CLIENT_VERSION) >= 0;
}

function requestHasBody(req: any): boolean {
    let cl = req.headers['content-length'];
    return (cl !== undefined && Number(cl) > 0) || req.headers['transfer-encoding'] !== undefined;
}

// rawHeaders ([name, value, name, value, ...]) minus the named headers (lowercase names)
function withoutHeaders(raw_headers: string[], names: string[]): string[] {
    let kept: string[] = [];
    for (let i = 0; i < raw_headers.length; i += 2) {
        if (!names.includes(raw_headers[i].toLowerCase())) {
            kept.push(raw_headers[i], raw_headers[i + 1]);
        }
    }
    return kept;
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
    dashboardAuth: DashboardAuth;
    waitServer: WaitServer;

    constructor(options: WebServerOptions) {
        this.hostname  = options.hostname;
        this.hostnames = options.hostnames || [options.hostname];
        this.options   = options;
        const dataDir = options.data_dir || DEFAULT_DATA_DIR;
        this.deviceTracker = new DeviceTracker(dataDir);
        this.waitServer    = new WaitServer(this.deviceTracker);
        this.connector_manager = new ConnectorManager(this.deviceTracker);
        this.dashboardAuth = new DashboardAuth({
            password:           options.status_password || null,
            operators:          options.dashboard_operators,
            viewers:            options.dashboard_viewers,
            signin_plugins:     options.signin_plugins,
            oidc_issuer:        options.oidc_issuer,
            oidc_client_id:     options.oidc_client_id,
            oidc_client_secret: options.oidc_client_secret,
            oidc_label:         options.oidc_label,
            data_dir:           dataDir,
            hostnames:          this.hostnames,
        });
        this.statusServer  = new StatusServer(this.deviceTracker, this.waitServer, this.dashboardAuth, this.hostnames, this.connector_manager);
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
                        this.statusServer.addClient(ws, req);
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
        if (requestHasBody(req)) {
            this.bodyRequestHandler(devicename, req, res);
            return;
        }
        // no body: the connection goes to the device raw, from right after the headers
        let socket = this.detachFromHttpServer(req, res);
        this.handOffToUpstreamSocket(devicename, req, socket);
    }


    // A request with a body can't be handed over raw like that. By the time 'request' fires,
    // Node's parser has already taken in whatever body bytes came in the same read as the
    // headers (Caddy always sends them together); freeing the parser loses them, and the
    // device then waits for a body that never comes. So the body is read through Node (which
    // also undoes any chunking) and streamed to the device as it arrives, paced by the
    // uplink. Once it is complete the connection is detached and relayed raw like any other.
    async bodyRequestHandler(devicename: string, req: any, res: any): Promise<void> {
        req.pause();
        let socket = req.socket;
        let ws = await this.connector_manager.getUplinkWS(devicename);
        if (!ws) {
            if (!socket.destroyed && !res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'text/plain', 'Connection': 'close' });
                res.end(NO_UPLINK_MESSAGE);
            } else {
                socket.destroy();
            }
            return;
        }
        if (socket.destroyed) {
            log.debug('client socket gone before an uplink arrived');
            ws.destroy();
            return;
        }

        // Clients before 2.2.0 drop a body that reaches them before their local connection
        // is open, so they have to ask for it (see relayFromDevice).
        let ask_first = !takesEarlyData(ws.client_version);
        let chunked = req.headers['transfer-encoding'] !== undefined;
        let raw_headers = withoutHeaders(req.rawHeaders, ['expect']);   // Node answered the browser's
        if (ask_first) raw_headers.push('Expect', '100-continue');

        this.deviceTracker.recordRequest(devicename);
        this.deviceTracker.tunnelOpened(devicename);
        let raw = ws.socket;
        let body_done = false;
        let onEarlyClose = () => {   // the browser left mid-body (detaching removes this)
            this.deviceTracker.tunnelClosed(devicename);
            if (raw && raw.terminate) raw.terminate();
            ws.destroy();
        };
        socket.on('close', onEarlyClose);
        socket.on('drain', () => { if (raw && raw.resume) raw.resume(); });   // relayFromBrowser takes over

        let started = false;
        let startBody = () => {
            if (started) return;
            started = true;
            req.on('data', (chunk: Buffer) => {
                this.deviceTracker.addBytes(devicename, chunk.length, 0);
                if (ws.destroyed) return;
                let ok = chunked
                    ? ws.write(Buffer.concat([Buffer.from(chunk.length.toString(16) + '\r\n'), chunk, CRLF]))
                    : ws.write(chunk);
                if (!ok) req.pause();
            });
            ws.on('drain', () => { if (!body_done) req.resume(); });
            req.on('end', () => {
                body_done = true;
                if (chunked && !ws.destroyed) ws.write('0\r\n\r\n');
                if (socket.destroyed) return;   // onEarlyClose cleans up
                this.detachFromHttpServer(req, res);
                this.relayFromBrowser(devicename, socket, ws);
            });
            req.resume();
        };

        this.relayFromDevice(devicename, socket, ws, ask_first ? startBody : null);
        try {
            ws.write(this.requestHead(req, raw_headers));
        } catch (err) {
            log.debug('ws write error in bodyRequestHandler', err.code);
            socket.destroy();
            return;
        }
        if (!ask_first) startBody();
    }


    // Take the browser's connection away from Node's HTTP server once it has parsed what it
    // needed to. Anything the connection carries from here on is relayed raw.
    detachFromHttpServer(req: any, res: any): any {
        let socket = req.socket;
        _http_common.freeParser(socket.parser, req, socket);
        res.detachSocket(socket);
        socket.removeAllListeners();   // the server's (its 'data' would feed the freed parser)
        socket.pause();                // read nothing until relayFromBrowser() can pass it on
        socket.on('error', (err) => {
            log.debug('proxied socket error', err.code || err.message);
            socket.destroy();
        });

        req.socket = null;
        req.connection = null;
        req.client = null;
        req.destroy();

        res.socket = null;
        res.connection = null;
        res.client = null;
        res.end();
        res.destroy();
        return socket;
    }


    upstreamUpgradeRequestHandler(devicename: string, req: any, socket: any, head: any): void {
        log.debug('hub upstream socket upgrade request', devicename, head.length, req.url);
        if (req.socket !== socket) {
            log.warn('uh-oh, we made a bad assumption. req.socket !== socket');
            log.warn('req.socket', req.socket);
            log.warn('socket', socket);
        }
        socket.on('error', (err) => {
            log.debug('proxied socket error', err.code || err.message);
            socket.destroy();
        });
        this.handOffToUpstreamSocket(devicename, req, socket, head);
    }


    // The method line and headers, as the first message on an uplink (the device reads that
    // message as the header block and nothing more).
    requestHead(req: any, raw_headers: string[]): string {
        if (req.httpVersion !== '1.1') {
            log.warn('not HTTP/1.1? this might be bad');
        }
        return `${req.method} ${req.url} HTTP/1.1\r\n` + HeaderBlock.buildHeaderBlockString(raw_headers, false) + '\r\n';
    }


    async handOffToUpstreamSocket(devicename: string, req: any, socket: any, head: any = null): Promise<void> {
        let request_head = this.requestHead(req, req.rawHeaders);
        log.debug('req.url', req.url);
        let ws = await this.connector_manager.getUplinkWS(devicename);
        if (!ws) {
            // the device is registered but supplied no uplink socket in time
            if (!head && socket.writable && !socket.destroyed) {
                socket.end(
                    'HTTP/1.1 504 Gateway Timeout\r\n' +
                    'Content-Type: text/plain\r\n' +
                    'Content-Length: ' + Buffer.byteLength(NO_UPLINK_MESSAGE) + '\r\n' +
                    'Connection: close\r\n' +
                    '\r\n' + NO_UPLINK_MESSAGE
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

        this.deviceTracker.recordRequest(devicename);
        this.deviceTracker.tunnelOpened(devicename);
        this.relayFromDevice(devicename, socket, ws, null);
        this.relayFromBrowser(devicename, socket, ws);

        try {
            ws.write(request_head);
            if (head && head.length) {
                ws.write(head);
            }
        } catch (err) {
            log.debug('ws write error in handOff', err.code);
            socket.destroy();
        }
    }


    // Relay bytes between a browser connection and the device's uplink websocket, and
    // tear the pair down in the right order.
    //
    // This used to be pump(pump(socket, ws), socket): one teardown for both directions,
    // and it lost the tail of big answers. The device closes the uplink as soon as its
    // local server closes the connection (straight after the answer with Connection:
    // close, 5 s after it on keep-alive), websocket-stream turns that close into
    // destroy(), and pump answered by destroying the browser socket as well – with
    // whatever the hub had read from the uplink but not yet delivered to a slower
    // browser still sitting in the buffers. A 30 MB album list downloaded at 1.5 MB/s
    // was cut off two thirds of the way through every time ("transfer closed with N
    // bytes remaining"), and with Connection: close anything past the first 64 KB was.
    //
    // Now the uplink closing ENDS the browser socket, which flushes first, and only the
    // browser going away destroys the uplink. The browser's write buffer also paces the
    // uplink (ws pause/resume), so a slow browser no longer makes the hub hold a whole
    // answer in memory.
    //
    // device → browser. With `onContinue` (a request body for a client before 2.2.0, see
    // bodyRequestHandler) the device's first bytes are held until we know whether they are
    // its server's 100 Continue to our Expect, which can only come back once the device's
    // pipe is in place. Then the body may go (onContinue), and the 100 is not passed on:
    // Node already sent the browser its own. A server that ignores Expect gets the body after
    // CONTINUE_WAIT_MS anyway; one that answers outright without a 100 doesn't get it at all.
    relayFromDevice(devicename: string, socket: any, ws: any, onContinue: (() => void) | null): void {
        let raw = ws.socket;   // the ws WebSocket under websocket-stream
        let tcp = raw && raw._socket;   // and its TCP socket: survives the pool's removeAllListeners()
        let closed = false;
        let held: Buffer | null = onContinue ? Buffer.alloc(0) : null;
        let continue_timer: any = null;
        let proceed = (why: string) => {
            if (continue_timer) clearTimeout(continue_timer);
            continue_timer = null;
            let go = onContinue;
            onContinue = null;
            if (go) {
                log.debug('sending the request body:', why);
                go();
            }
        };
        if (onContinue) {
            continue_timer = setTimeout(() => proceed('no 100 Continue in time'), CONTINUE_WAIT_MS);
        }
        let endBrowser = (why: string) => {
            if (closed) return;
            closed = true;
            if (continue_timer) clearTimeout(continue_timer);
            log.debug('uplink finished:', why);
            if (held && held.length && !socket.destroyed) socket.write(held);
            held = null;
            if (!socket.destroyed) socket.end();   // flushes what we still hold, then FIN
        };

        ws.on('data', (chunk: Buffer) => {
            this.deviceTracker.addBytes(devicename, 0, chunk.length);
            if (held) {
                held = Buffer.concat([held, chunk]);
                let eoh = held.indexOf('\r\n\r\n');
                if (eoh < 0 && held.length < 8192) return;   // wait for the whole status block
                if (eoh >= 0 && /^HTTP\/1\.[01] 100 /.test(held.toString('latin1', 0, 13))) {
                    chunk = held.slice(eoh + 4);   // swallow the 100 Continue
                    held = null;
                    proceed('100 Continue');
                    if (!chunk.length) return;
                } else {
                    // a final answer (or something we don't understand): pass it all on, and
                    // keep the body if it hasn't gone yet, since the device didn't ask for it
                    chunk = held;
                    held = null;
                    if (continue_timer) clearTimeout(continue_timer);
                    continue_timer = null;
                    onContinue = null;
                }
            }
            if (socket.destroyed || !socket.writable) return;
            if (!socket.write(chunk) && raw && raw.pause) raw.pause();
        });
        ws.on('end',   () => endBrowser('end'));
        ws.on('close', () => endBrowser('close'));
        ws.on('error', (err) => {
            log.debug('uplink error', err && (err.code || err.message));
            socket.destroy();
        });
        // The pool's error handler strips every listener off the websocket (terminateOne),
        // ours included; the TCP socket under it still tells us when it is gone.
        if (tcp) tcp.on('close', () => endBrowser('tcp close'));
    }


    // browser → device, once the connection is out of Node's HTTP server's hands
    relayFromBrowser(devicename: string, socket: any, ws: any): void {
        let raw = ws.socket;
        socket.on('drain', () => { if (raw && raw.resume) raw.resume(); });
        socket.on('data', (chunk: Buffer) => {
            this.deviceTracker.addBytes(devicename, chunk.length, 0);
            if (ws.destroyed) return;
            if (!ws.write(chunk)) socket.pause();
        });
        ws.on('drain', () => socket.resume());
        socket.on('close', () => {
            this.deviceTracker.tunnelClosed(devicename);
            // nobody left to deliver to: drop the uplink outright. A close handshake would
            // need the (maybe paused) websocket read again, spilling frames into a dead stream.
            if (raw && raw.terminate) raw.terminate();
            ws.destroy();
        });
        // socket 'error' (attached by detachFromHttpServer / the upgrade handler) destroys
        // the socket, which lands here as 'close'
        socket.resume();
        if (raw && raw.resume) raw.resume();   // in case it paused while the body was going up
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
