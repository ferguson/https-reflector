import stream = require('stream');
import WSPool, { ReleaseReason } from './WSPool';
import { createUplinkWS } from './UplinkWS';
import { UplinkWSOptions, UplinkConnectorOptions } from './types';

const log = {...console};
log.debug = ()=>{};

const DEFAULT_POOL_SIZE = 10;

// Refill backoff. A refill after a normal grab is immediate. A refill after a
// failure (error, heartbeat timeout, closed while idle) waits, doubling per
// failed round up to the cap, with +/-50% jitter so a fleet of devices doesn't
// hammer the hub in lockstep.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30 * 1000;
// how long a freshly opened socket must survive, with the pool full, before we
// consider a run of failures over
const STABLE_MS = 5 * 1000;


export default class UplinkWSPool extends WSPool {
    hub_uplink_ws_url: string;
    ws_options: UplinkWSOptions;
    pool_size: number;
    consecutive_failures: number;
    fill_timer: any;

    constructor(hub_uplink_ws_url: string, options: UplinkConnectorOptions) {
        super();
        this.hub_uplink_ws_url = hub_uplink_ws_url;

        this.ws_options = {
            http_server_injection: options.http_server_injection,
            uplink_to_host: options.uplink_to_host,
            uplink_to_port: options.uplink_to_port,
        };

        this.pool_size = options.pool_size || DEFAULT_POOL_SIZE;
        this.consecutive_failures = 0;
        this.fill_timer = null;
    }


    fillPool(): void {
        if (this.destroyed) {
            return;
        }
        while (this.getPoolSize() < this.pool_size) {
            let ws = createUplinkWS(this.hub_uplink_ws_url, this.ws_options);
            ws.once('connect', () => {
                // Opening is not success: a hub that refuses us completes the
                // handshake and then closes. Count it as recovered only if the
                // whole pool is still standing a little later.
                setTimeout(() => this.checkRecovered(), STABLE_MS);
            });
            this.addOne(ws);
        }
    }


    checkRecovered(): void {
        if (this.destroyed || !this.consecutive_failures) {
            return;
        }
        if (this.getPoolSize() >= this.pool_size) {
            log.log('uplink pool recovered after', this.consecutive_failures, 'failed round(s)');
            this.consecutive_failures = 0;
        }
    }


    // Refill now if things are healthy, otherwise after a backoff delay.
    // Only one refill is ever pending; failures that arrive while it is
    // pending do not schedule more.
    scheduleFill(): void {
        if (this.destroyed || this.fill_timer) {
            return;
        }
        let delay = this.backoffDelay();
        if (delay === 0) {
            this.fillPool();
            return;
        }
        log.warn(`uplink pool: ${this.consecutive_failures} failed round(s), refilling in ${delay} ms`);
        this.fill_timer = setTimeout( () => {
            this.fill_timer = null;
            this.fillPool();
        }, delay);
    }


    backoffDelay(): number {
        if (this.consecutive_failures === 0) {
            return 0;
        }
        let exponent = Math.min(this.consecutive_failures - 1, 10);
        let base = Math.min(BACKOFF_BASE_MS * Math.pow(2, exponent), BACKOFF_MAX_MS);
        return Math.round(base * (0.5 + Math.random()));  // 50%..150%
    }


    releaseOne(ws: stream.Duplex, reason: ReleaseReason = 'grab'): boolean {
        let deleted = super.releaseOne(ws, reason);
        if (deleted) {
            // 'data' means the hub took this socket for a request: the one normal
            // way out of the pool. Anything else is a failure and counts toward
            // backoff (one count per refill round, not per socket).
            if (reason === 'data') {
                // the hub used one of our sockets: the link is healthy
                if (this.consecutive_failures) {
                    log.log('uplink pool recovered after', this.consecutive_failures, 'failed round(s)');
                }
                this.consecutive_failures = 0;
            } else if (reason !== 'grab' && !this.fill_timer) {
                this.consecutive_failures++;
                log.debug('uplink pool socket left the pool:', reason);
            }
            this.scheduleFill();
        }
        return deleted;
    }


    // Note: no terminateOne() override any more. The old one refilled
    // unconditionally, which is how destroy() used to spawn an orphan pool.
    // The base terminateOne() goes through releaseOne('terminate') above.


    destroy(): void {
        if (this.fill_timer) {
            clearTimeout(this.fill_timer);
            this.fill_timer = null;
        }
        super.destroy();
    }
}
