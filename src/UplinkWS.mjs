import net from 'net';
import pump from 'pump';
import WebSocketStream from 'websocket-stream';
// import WebSocket, { createWebSocketStream } from 'ws';
import { PassThrough } from 'stream';

import HeaderBlock from './HeaderBlock.mjs';

const log = Object.assign({}, console);


export default class UplinkWS {
    constructor(hub_uplink_ws_url, options) {
        this.hub_uplink_ws_url = hub_uplink_ws_url;
        this.http_server_injection = options.http_server_injection;
        this.uplink_to_host = options.uplink_to_host;
        this.uplink_to_port = options.uplink_to_port;
        let ws = new WebSocketStream(this.hub_uplink_ws_url);
        // let plain_ws = new WebSocket(this.hub_uplink_ws_url);
        // let ws = createWebSocketStream(plain_ws, { encoding: 'utf8' });

        // this only works because we write the headers all-at-once on the other end?
        ws.once('data', (data) => {
            this.handleData(ws, data);
        });

        return ws;
    }


    handleData(ws, data) {
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
            pass.pipe(ws).pipe(pass);
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
                pump(pump(ws, socket), ws);
            });

            socket.on('error', (err) => {
                log.error('loopback socket error', err);
            });
        }
    }
}
