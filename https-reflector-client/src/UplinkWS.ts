import net = require('net');
import stream = require('stream');
import pump = require('pump');
import WebSocketStream = require('websocket-stream');
import { PassThrough } from 'stream';

import HeaderBlock from './HeaderBlock';
import { UplinkWSOptions } from './types';

const log = {...console};


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
        this.ws = new WebSocketStream(this.hub_uplink_ws_url);

        // this only works because we write the headers all-at-once on the other end?
        this.ws.once('data', (data: Buffer) => {
            this.handleData(data);
        });
    }


    handleData(data: Buffer): void {
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
                //socket.pipe(ws).pipe(socket);  // using pump instead
                pump(pump(this.ws, socket), this.ws, (err) => {
                    if (err) log.debug('uplink pump error', err.code);
                });
            });

            socket.on('error', (err) => {
                log.error('loopback socket error', err);
                this.ws.destroy();
            });
        }
    }
}

export function createUplinkWS(hub_uplink_ws_url: string, options: UplinkWSOptions): stream.Duplex {
    const uplinkWS = new UplinkWS(hub_uplink_ws_url, options);
    return uplinkWS.ws;
}
