import net = require('net');
import stream = require('stream');
import WebSocketStream = require('websocket-stream');
import { PassThrough } from 'stream';

import HeaderBlock from './HeaderBlock';
import { UplinkWSOptions } from './types';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from './version';

const log = {...console};

// identify ourselves to the hub on every uplink (websocket-stream passes these through to ws)
const WS_OPTIONS: any = { headers: {} };
WS_OPTIONS.headers[CLIENT_VERSION_HEADER] = CLIENT_VERSION;


class UplinkWS {
    ws: stream.Duplex;
    hub_uplink_ws_url: string;
    http_server_injection: any;
    uplink_to_host: string;
    uplink_to_port: number;

    constructor(hub_uplink_ws_url: string, options: UplinkWSOptions) {
        this.hub_uplink_ws_url = hub_uplink_ws_url;
        this.http_server_injection = options.http_server_injection;
        this.uplink_to_host = options.uplink_to_host;
        this.uplink_to_port = options.uplink_to_port;
        this.ws = new WebSocketStream(this.hub_uplink_ws_url, WS_OPTIONS);

        // Catch connection errors (e.g. DNS failure) immediately — WSPool.addOne()
        // attaches its own handler later, but the error can fire before that.
        this.ws.on('error', (err: any) => {
            log.warn('uplink ws error', err.code || err.message);
        });

        // The hub sends the request's method line and headers as one websocket message, and
        // anything after it (a request body, an upgraded connection's first bytes) as later
        // messages. Those can arrive before the local connection is open, so keep them until
        // then: before 2.2.0 they were emitted to no listener and lost, which is why the hub
        // still makes older clients ask for a body with 100 Continue.
        let early: Buffer[] | null = null;
        let onData = (data: Buffer) => {
            if (early === null) {
                early = [];
                this.handleData(data, early, () => this.ws.removeListener('data', onData));
            } else {
                early.push(data);
            }
        };
        this.ws.on('data', onData);
    }


    // `early` collects the messages that arrive after the headers while the local connection
    // opens; `stopCollecting` ends that, right before the pipe takes over.
    handleData(data: Buffer, early: Buffer[] = [], stopCollecting: () => void = () => {}): void {
        // Only the header block is used from this first message. Hubs older than 2026-11-23
        // end it with a stray extra CRLF, so nothing after the blank line may be passed on.
        let header_block = new HeaderBlock();
        header_block.addFromString(data.toString(), true);

        // let connection = header_block.headers.get('connection');
        // if (connection && connection.toLowerCase().indexOf('keep-alive') >= 0) {
        //     header_block.headers.set('connection', 'close');  // overwrite connection: keep-alive
        // }

        if (false && this.http_server_injection) {  // can't seem to get injection to work FIXME
            log.debug('http_server_injection');
            let pass = new PassThrough;
            // header_block.headers.set('connection', 'close');
            // let headers_string = header_block.toHeadersString(false);
            // //log.debug(`headers_string:\n${headers_string}`);
            // pass.write(headers_string);
            pass.write(data);
            pass.pipe(this.ws).pipe(pass);
            //pass.on('data', (data) => { log.debug('pass data', data.toString()) });
            this.http_server_injection.emit('connection', pass);
        } else {
            let url = `http://localhost:9090${header_block.path}`;  // note: not currently used

            let socket = new net.Socket();
            socket.connect({ host: this.uplink_to_host, port: this.uplink_to_port });

            socket.on('connect', () => {
                let headers_string = header_block.toHeadersString(false);
                socket.write(headers_string);
                stopCollecting();   // relay()'s pipes listen from here on; nothing in between
                for (let chunk of early) {
                    socket.write(chunk);
                }
                early.length = 0;
                this.relay(socket);
            });

            socket.on('error', (err) => {
                log.error('loopback socket error', err);
                this.ws.destroy();
            });
        }
    }


    // Relay between the local server and the hub, and tear the pair down in the right order.
    //
    // This used to be pump(pump(ws, socket), ws), which lost the tail of answers. With
    // Connection: close (which every request through a front end with keep-alive off
    // carries), the local server closes its connection right after answering; the inner pump
    // saw that as the end of the pipeline and destroyed the websocket, and websocket-stream's
    // destroy() closes the websocket at once, dropping whatever it still held to send. Over
    // a real network that is often the last few KB to tens of KB: the answer arrives cut
    // off. It never showed on one machine, where the buffers empty instantly. The hub had
    // the same bug, fixed the same way (Hub.relayFromDevice).
    //
    // Now each side's END is passed on as an end, which flushes first (the websocket sends
    // its close frame after the last data), and only an error, or the other side going away
    // entirely, destroys.
    relay(socket: net.Socket): void {
        let ws: any = this.ws;
        ws.pipe(socket);    // hub → local server; the hub ending the uplink ends the connection
        socket.pipe(ws);    // local server → hub; the server closing ends the uplink, gracefully
        socket.on('close', (had_error: boolean) => {
            if (had_error) ws.destroy();    // the local server died mid-answer: let the hub know
        });
        ws.on('close', () => {
            // the hub is gone (the browser left), or our own graceful close has completed
            if (!socket.destroyed) socket.destroy();
        });
    }
}

export function createUplinkWS(hub_uplink_ws_url: string, options: UplinkWSOptions): stream.Duplex {
    const uplinkWS = new UplinkWS(hub_uplink_ws_url, options);
    return uplinkWS.ws;
}
