import { EventEmitter } from 'events';

const log = Object.assign({}, console);
log.debug = ()=>{};

const HEARTBEAT_INTERVAL_MS = 30 * 1000;


// remember, these are not straight up node WebSockets
// they are wrapped by websocket-stream
// original WebSocket is at ws.socket

export default class WSPool extends EventEmitter {
    constructor() {
        super();
        this.pool = new Set();
        this.intervals = new Map();
        this.waiting_queue = [];
    }


    getPoolSize() {
        return this.pool.size;
    }


    addOne(ws) {
        this.pool.add(ws);
        log.debug('addOne: added to pool', this.pool.size, this.waiting_queue.length);

        ws.on('error', (err) => {
            log.warn('https-reflector ws error', err);
            this.terminateOne(ws);
        });
        ws.socket.on('error', (err) => {
            log.warn('https-reflector ws socket error', error);
            this.terminateOne(ws);
        });

        ws.on('close', () => {
            log.debug('https-reflector ws close');
            this.releaseOne();
        });

        ws.once('data', (data) => {
            // let method_line = data.toString().split('\r\n', 1)[0];
            // let [method, path, version] = method_line.split(' ');

            // deleting here is just a safety kinda thing (i think)
            // welp! not currently just a safety thing, this is required to make it work FIXME
            let deleted = this.releaseOne(ws);
            if (deleted) {
                //log.warn('received data on a socket still in the pool!');
            }
        });

        this.initHeartbeat(ws);
        this.emitStatus();
    }


    initHeartbeat(ws) {
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


    sendHeartbeat(ws) {
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


    stopHeartbeat(ws) {
        clearInterval(this.intervals.get(ws));
        this.intervals.delete(ws);
    }


    async grabOne() {  // wondering if this needs to be async? grabOne in HubWSPool definitely does
        let ws;

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


    getStatus() {
        let status = {
            pool_size: this.pool.size,
        };
        return status;
    }


    emitStatus() {
        let status = this.getStatus();
        this.emit('status', status);
        log.debug(status);
    }


    closeAll() {
        for (let ws of Array.from(this.pool)) {
            ws.close();
        }
    }


    clearAll() {
        this.pool.clear();
    }


    releaseOne(ws) {
        this.stopHeartbeat(ws);
        let deleted = this.pool.delete(ws);
        if (deleted) {
            this.emitStatus();
        }
        return deleted;
    }


    terminateOne(ws) {
        this.releaseOne(ws);
        ws.socket.removeAllListeners();
        ws.removeAllListeners();
        if (ws.socket.readyState > 0) {  // 0 = CONNECTING
            ws.socket.terminate();
        }
        ws.destroy();
    }


    destroy() {
        let destroy_list;
        destroy_list = Array.from(this.pool);
        for (let ws of destroy_list) {
            this.terminateOne(ws);
        }
        this.removeAllListeners();
        this.clearAll();
    }
}
