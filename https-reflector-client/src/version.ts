// Sent by the client on every connection to the hub (the socket.io control
// connection and each uplink websocket) so the hub can tell which devices run
// which client, and can apply limits only to clients known to handle them.
//
// Bump this whenever client behaviour the hub might care about changes.
// Keep it in sync with package.json "version".
export const CLIENT_VERSION = '2.1.0';
export const CLIENT_VERSION_HEADER = 'x-https-reflector-client';

// Clients from 2.1.0 on back off when an uplink is refused or closed. Anything
// older (or sending no header at all) refills instantly and must not be capped.
export const MIN_CAPPABLE_CLIENT_VERSION = '2.1.0';

// Compare dotted versions numerically: 1 if a > b, -1 if a < b, 0 if equal.
export function compareVersions(a: string, b: string): number {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}
