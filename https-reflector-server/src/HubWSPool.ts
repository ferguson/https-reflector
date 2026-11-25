import { WSPool } from 'https-reflector-client';

const log = {...console};
log.debug = ()=>{};

// How many browser requests may wait for an uplink socket at once. One page
// load of Otto asks for well over 100 things together (scripts, then two sizes
// of every cover), and a device's pool is only 7-10 sockets, so 50 was
// overflowing on an ordinary first visit.
const WAITING_QUEUE_MAX = 1000;
// How long a browser request waits for the device to supply an uplink socket
// before the hub gives up (and answers 504). Used to be forever.
const GRAB_TIMEOUT_MS = 20 * 1000;


export default class HubWSPool extends WSPool {
    devicename: string;
    waiting_queue: Array<(ws: any) => void>;

    constructor(devicename: string) {
        super();
        this.devicename = devicename;
        this.waiting_queue = [];
    }


    addOne(ws: any): void {
        if (!this.waiting_queue.length || this.destroyed) {
            super.addOne(ws);
        } else {
            let resolve = this.waiting_queue.shift();
            resolve(ws);
            log.debug('addOne: given to queue', this.pool.size, this.waiting_queue.length);
        }
    }


    getStatus(): any {
        let status = super.getStatus();
        status.waiting_queue_length = this.waiting_queue.length;
        return status;
    }


    async grabOne(): Promise<any> {
        let ws: any;
        if (this.pool.size > 0) {
            return super.grabOne();
        } else {
            // we wait for more websockets here
            if (this.waiting_queue.length >= WAITING_QUEUE_MAX) {
                // Turn away the newcomer, never someone already waiting: the
                // oldest waiters are the page's scripts, and losing one of
                // those breaks the whole page (it used to eject the oldest).
                log.warn(`[${this.devicename}] waiting queue is full (${WAITING_QUEUE_MAX}), refusing this request`);
                return null;
            }
            log.info(`[${this.devicename}] waiting for uplink sockets, waiting queue length is ${this.waiting_queue.length}`);
            ws = await new Promise<any>((resolve) => {
                let timer: any = null;
                let waiter = (ws: any) => {
                    if (timer) clearTimeout(timer);
                    resolve(ws);
                };
                timer = setTimeout(() => {
                    let i = this.waiting_queue.indexOf(waiter);
                    if (i >= 0) this.waiting_queue.splice(i, 1);
                    log.warn(`[${this.devicename}] no uplink socket arrived within ${GRAB_TIMEOUT_MS} ms, giving up on this request`);
                    resolve(null);
                }, GRAB_TIMEOUT_MS);
                this.waiting_queue.push(waiter);
            });
        }
        // if (!ws) {
        //     throw new Error('something went very wrong with the hub ws pool!');
        // }
        return ws;
    }


    destroy(): void {
        super.destroy();
        // anyone still waiting gets a null (→ 504) now instead of at their timeout
        let waiters = this.waiting_queue;
        this.waiting_queue = [];
        for (let resolve of waiters) {
            resolve(null);
        }
    }
}
