import stream = require('stream');
import { EventEmitter } from 'events';

const log = {...console};
log.debug = ()=>{};

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

type WSStream = stream.Duplex & { socket: any };

// Why a socket left the pool:
//   'grab'      - grabOne() handed it to a request (hub side)
//   'data'      - the far end started using it as a tunnel (client side; the one normal exit)
//   'close'     - it closed while still idle in the pool
//   'terminate' - we killed it (error, heartbeat timeout, or pool destroy)
export type ReleaseReason = 'grab' | 'data' | 'close' | 'terminate';

// remember, these are not straight up node WebSockets
// they are wrapped by websocket-stream
// original WebSocket is at ws.socket

export default class WSPool extends EventEmitter {
    pool: Set<WSStream>;
    intervals: Map<WSStream, any>;
    waiting_queue: any[];
    destroyed: boolean;

    constructor() {
        super();
        this.pool = new Set();
        this.intervals = new Map();
        this.waiting_queue = [];
        this.destroyed = false;
    }


    getPoolSize(): number {
        return this.pool.size;
    }


    addOne(ws: stream.Duplex): void {
        let wsStream = ws as WSStream;
        if (this.destroyed) {
            // a socket arriving after destroy() must not outlive the pool
            log.debug('addOne: pool is destroyed, terminating socket');
            this.terminateOne(wsStream);
            return;
        }
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
            this.releaseOne(wsStream, 'close');
        });

        wsStream.once('data', (data) => {
            // let method_line = data.toString().split('\r\n', 1)[0];
            // let [method, path, version] = method_line.split(' ');

            // deleting here is just a safety kinda thing (i think)
            // welp! not currently just a safety thing, this is required to make it work FIXME
            let deleted = this.releaseOne(wsStream, 'data');
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
        this.releaseOne(ws, 'grab');

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


    releaseOne(ws: stream.Duplex, reason: ReleaseReason = 'grab'): boolean {
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
        this.releaseOne(wsStream, 'terminate');
        wsStream.socket.removeAllListeners();
        wsStream.removeAllListeners();
        // Absorb errors that fire during/after destroy (e.g. DNS failure
        // surfacing from Duplexify._destroy after listeners were cleared).
        wsStream.on('error', () => {});
        wsStream.socket.on('error', () => {});
        // ws.terminate() is safe in every state: CONNECTING aborts the handshake,
        // CLOSED is a no-op. Skipping it for CONNECTING sockets (as we used to)
        // left them to finish connecting with no owner and no listeners.
        try {
            wsStream.socket.terminate();
        } catch (err) {
            log.debug('terminate error', err && err.code);
        }
        wsStream.destroy();
    }


    destroy(): void {
        // Set this first: subclasses refill on releaseOne(), and terminateOne()
        // below goes through releaseOne(). Without the flag, destroying the
        // pool spawned a full replacement pool that nobody owned.
        this.destroyed = true;
        let destroy_list: WSStream[];
        destroy_list = Array.from(this.pool);
        for (let ws of destroy_list) {
            this.terminateOne(ws);
        }
        for (let interval of Array.from(this.intervals.values())) {
            clearInterval(interval);
        }
        this.intervals.clear();
        this.removeAllListeners();
        this.clearAll();
    }
}
