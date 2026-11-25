'use strict';
// Helpers shared by the test files.

function echoOf(res) {
    if (!res || !res.body) return null;
    try { return JSON.parse(res.body.toString()); } catch (e) { return null; }
}

// "200 in 35 ms", "no answer (timed out after 15000 ms)", "connection closed, no response"
function describe(x) {
    if (!x) return 'nothing';
    if (x.response) return `${x.response.status} ${x.response.statusText || ''}`.trim() + (x.totalMs != null ? ` in ${x.totalMs} ms` : '');
    if (x.status) return `${x.status} ${x.statusText || ''}`.trim();
    if (x.timedOut) return `no answer (timed out after ${x.totalMs || '?'} ms)`;
    if (x.error) return `error ${x.error}`;
    if (x.closed) return 'connection closed with no response';
    return JSON.stringify(x).slice(0, 120);
}

// raw header pairs from Node's rawHeaders array, or from a parsed response
function pairs(raw) {
    const out = [];
    for (let i = 0; i < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
    return out;
}

function headerValues(rawHeaders, name) {
    return pairs(rawHeaders || []).filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

module.exports = { echoOf, describe, pairs, headerValues };
