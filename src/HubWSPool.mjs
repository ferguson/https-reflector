import WSPool from './WSPool.mjs';

const log = Object.assign({}, console);
log.debug = ()=>{};

const WAITING_QUEUE_MAX = 50;


export default class HubWSPool extends WSPool {
    constructor(devicename) {
        super();
        this.devicename = devicename;
        this.waiting_queue = [];
    }


    addOne(ws) {
        if (!this.waiting_queue.length) {
            super.addOne(ws);
        } else {
            let resolve = this.waiting_queue.shift();
            resolve(ws);
            log.debug('addOne: given to queue', this.pool.size, this.waiting_queue.length);
        }
    }


    getStatus() {
        let status = super.getStatus();
        status.waiting_queue_length = this.waiting_queue.length;
        return status;
    }


    async grabOne() {
        let ws;
        if (this.pool.size > 0) {
            return super.grabOne();
            ws = this.pool.keys().next().value;
            this.pool.delete(ws);
            this.emitStatus();
        } else {
            // we wait for more websockets here
            log.info(`[${this.devicename}] waiting for uplink sockets, waiting queue length is ${this.waiting_queue.length}`);
            ws = await new Promise((resolve) => this.waiting_queue.push(resolve));
            while (this.waiting_queue.length > WAITING_QUEUE_MAX) {
                log.debug('ejecting a connection from the waiting pool');
                let resolve = this.waiting_queue.shift();
                resolve(null);  // no ws for you!
            }
        }
        // if (!ws) {
        //     throw new Error('something went very wrong with the hub ws pool!');
        // }
        return ws;
    }
}
