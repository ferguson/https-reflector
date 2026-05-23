import stream = require('stream');
import { EventEmitter } from 'events';

const log = {...console};
log.debug = ()=>{};

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

type WSStream = stream.Duplex & { socket: any };

// remember, these are not straight up node WebSockets
// they are wrapped by websocket-stream
// original WebSocket is at ws.socket

export default class WSPool extends EventEmitter {
    pool: Set<WSStream>;
    intervals: Map<WSStream, NodeJS.Timeout>;
    waiting_queue: any[];

    constructor() {
        super();
        this.pool = new Set();
        this.intervals = new Map();
        this.waiting_queue = [];
    }


    getPoolSize(): number {
        return this.pool.size;
    }


    addOne(ws: stream.Duplex): void {
        let wsStream = ws as WSStream;
        this.pool.add(wsStream);
        log.debug('addOne: added to pool', this.pool.size, this.waiting_queue.length);

        wsStream.on('error', (err) => {
            log.warn('wsstream error', err.code);
            this.terminateOne(wsStream);
        });
        wsStream.socket.on('error', (err) => {
            log.warn('ws error', err.code);
            this.terminateOne(wsStream);
        });

        wsStream.on('close', () => {
            log.debug('wsstream close');
            this.releaseOne(wsStream);
        });

        wsStream.once('data', (data) => {
            // let method_line = data.toString().split('\r\n', 1)[0];
            // let [method, path, version] = method_line.split(' ');

            // deleting here is just a safety kinda thing (i think)
            // welp! not currently just a safety thing, this is required to make it work FIXME
            let deleted = this.releaseOne(wsStream);
            if (deleted) {
                //log.warn('received data on a socket still in the pool!');
            }
        });

        this.initHeartbeat(wsStream);
        this.emitStatus();
    }


    initHeartbeat(ws: WSStream): void {
        ws.socket.isAlive = true;
        let interval = setInterval( () => {
            this.sendHeartbeat(ws);
        }, HEARTBEAT_INTERVAL_MS);
        this.intervals.set(ws, interval);

        ws.socket.on('pong', () => {
            log.debug('pong');
            ws.socket.isAlive = true;
        });
    }


    sendHeartbeat(ws: WSStream): void {
        if (ws.socket.isAlive === false) {
            this.terminateOne(ws);
        } else {
            if (ws.socket.readyState === 1) {  // 1 = OPEN
                ws.socket.ping();
            }
            // give it one more interval before it's reaped
            ws.socket.isAlive = false;
        }
    }


    stopHeartbeat(ws: WSStream): void {
        clearInterval(this.intervals.get(ws));
        this.intervals.delete(ws);
    }


    async grabOne(): Promise<WSStream | undefined> {  // wondering if this needs to be async? grabOne in HubWSPool definitely does
        let ws: WSStream;

        ws = this.pool.keys().next().value;
        this.releaseOne(ws);

        if (ws) {
            log.debug('issuing one ws,', this.pool.size, 'left in pool');
        } else {
            log.warn('ws pool was empty!');
        }
        if (this.pool.size === 0) {
            log.warn('0 ws left in pool');
        }
        return ws;
    }


    getStatus(): any {
        let status = {
            pool_size: this.pool.size,
        };
        return status;
    }


    emitStatus(): void {
        let status = this.getStatus();
        this.emit('status', status);
        log.debug(status);
    }


    closeAll(): void {
        for (let ws of Array.from(this.pool)) {
            ws.close();
        }
    }


    clearAll(): void {
        this.pool.clear();
    }


    releaseOne(ws: stream.Duplex): boolean {
        let wsStream = ws as WSStream;
        this.stopHeartbeat(wsStream);
        let deleted = this.pool.delete(wsStream);
        if (deleted) {
            this.emitStatus();
        }
        return deleted;
    }


    terminateOne(ws: stream.Duplex): void {
        let wsStream = ws as WSStream;
        this.releaseOne(wsStream);
        wsStream.socket.removeAllListeners();
        wsStream.removeAllListeners();
        if (wsStream.socket.readyState > 0) {  // 0 = CONNECTING
            wsStream.socket.terminate();
        }
        wsStream.destroy();
    }


    destroy(): void {
        let destroy_list: WSStream[];
        destroy_list = Array.from(this.pool);
        for (let ws of destroy_list) {
            this.terminateOne(ws);
        }
        this.removeAllListeners();
        this.clearAll();
    }
}
