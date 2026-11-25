'use strict';
// Runs a real https-reflector-client with DNS pinned, so a device can dial a hub that DNS
// doesn't point at yet (a new box), or *.localhost in local mode.
//   node client-wrapper.js <client package dir> <resolve JSON: {"otto.stream":"1.2.3.4"}> <client args...>
// A name matches a key exactly or as a subdomain of it.

const dns = require('dns');
const path = require('path');

const [, , clientDir, resolveJson, ...clientArgs] = process.argv;
const pins = JSON.parse(resolveJson || '{}');

function pinned(host) {
    for (const [name, ip] of Object.entries(pins)) {
        if (host === name || host.endsWith('.' + name)) return ip;
    }
    return null;
}

const realLookup = dns.lookup;
dns.lookup = function (host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    const ip = pinned(host);
    if (!ip) return realLookup.call(dns, host, options, callback);
    const family = ip.includes(':') ? 6 : 4;
    if (options && options.all) return process.nextTick(callback, null, [{ address: ip, family }]);
    return process.nextTick(callback, null, ip, family);
};

const main = path.join(path.resolve(clientDir), 'https-reflector-client.js');
process.argv = [process.argv[0], main, ...clientArgs];
require(main);
