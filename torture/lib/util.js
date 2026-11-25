'use strict';
// Small shared helpers: ids, deterministic payloads, hashing, timing.

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let counter = 0;
function newId(prefix = 'q') {
    counter += 1;
    return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function randomName(prefix) {
    return prefix + crypto.randomBytes(3).toString('hex');
}

// Deterministic pseudo-random bytes (xorshift32), so both ends can produce and check
// a payload of any size from (n, seed) without shipping it around.
function genBytes(n, seed = 1) {
    const buf = Buffer.allocUnsafe(n);
    let x = (seed >>> 0) || 0x9e3779b9;
    let i = 0;
    for (; i + 4 <= n; i += 4) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        buf.writeUInt32LE(x, i);
    }
    for (; i < n; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        buf[i] = x & 0xff;
    }
    return buf;
}

function sha(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// Every byte value 0-255, repeated: catches any 7-bit or text-mode mangling.
function allBytes(n) {
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) buf[i] = i & 0xff;
    return buf;
}

function withTimeout(promise, ms, what = 'operation') {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Run async fns with at most `limit` in flight.
async function pool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function percentile(values, p) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

module.exports = { sleep, newId, randomName, genBytes, sha, allBytes, withTimeout, fmtBytes, pool, percentile };
