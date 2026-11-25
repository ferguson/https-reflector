# https-reflector torture suite

An end-to-end test of a reflector setup, from a browser's point of view through to the
device, with everything a browser, a broken device or an attacker might send. Use it to
prove out a new hub, a new front-end proxy, a new client, or a code change before it goes
live.

No dependencies beyond Node (it uses the repo's virtualized Node: `source ./activate`).

## How it works

The suite plays both ends:

```
 torture.js ──requests──▶ [front end, e.g. Caddy] ──▶ hub ◀──uplinks── device client ──▶ target
   (raw HTTP/1.1, TLS,                                                  (the real one,     (stands in
    HTTP/2, websockets)                                                  from this repo     for the Otto;
                                                                         or --client)       records all)
```

- It starts **two devices**, A and B, each a real `https-reflector-client` process tunnelling
  to its own **target** server. The targets record every request that reaches them (method,
  raw headers, body hash, parse errors) and can answer in any way a device might, including
  broken ones (`lib/target.js`, routes `/t/<behavior>`).
- Requests are written **byte for byte** over raw sockets (`lib/http1.js`), so malformed ones
  can be sent and answers are seen exactly as the front end sends them.
- After **every** test the harness checks that the hub and both clients are still running,
  both devices still answer, no request meant for one device reached the other, and no
  smuggled request reached either. A test that breaks something fails even if its own checks
  passed, and the harness restarts what broke before going on.

Results: **PASS**; **FAIL** = a bug or a hole (exit code 1); **WARN** = a design weakness or
a risky behavior to know about; **INFO** = how this setup behaves (worth comparing between
setups); **SKIP** = not applicable here.

## Running it

```sh
cd ~/ferguson/https-reflector && source ./activate
(cd https-reflector-client && yarn build); (cd https-reflector-server && yarn build)

# a hub from this checkout, on 127.0.0.1 (no front end)
node torture/torture.js --local

# a live hub, exactly as the internet sees it (devices dial *.otto.stream)
node torture/torture.js --hub https://otto.stream

# a new box before DNS points at it (both the devices and the requests go to that address)
node torture/torture.js --hub https://otto.stream --resolve 87.99.139.67

# a candidate front end in front of a local hub: start the hub on a fixed port, point your
# proxy (Caddy, nginx, HAProxy...) at it, and send the requests through the proxy
node torture/torture.js --local --hub-port 18080 --entry https://127.0.0.1:8443 --insecure

# compatibility with an older device client
node torture/torture.js --local --client /path/to/old/https-reflector-client

# include the abuse tests (floods, slowloris, rapid reset). These degrade the hub for
# everyone while they run: use --local, or a live hub at a quiet moment.
node torture/torture.js --local --abuse --scale 2
```

Other options: `--only <regex>`, `--skip <regex>`, `--category basics,security`, `--long`
(multi-minute streams and timeouts), `--json results.json`, `--list`, `-v` / `-vv`.

Against a live hub the test devices are called `torture-xxxxxx` and show up in the hub's
device list and history afterwards, like any device would. Give the hub's dashboard password
with `--status-password` and the run files its two names under Archived on the dashboard when
it finishes (archiving needs a hub that has a dashboard password).

## The tests

| Category | What it covers |
|---|---|
| basics (B) | methods, HEAD, paths and query strings, status codes, redirects, compression, trailers, 103, keep-alive, pipelining, binary bodies |
| bodies (R) | response sizes at every buffer boundary up to 10 MB, chunked and close-delimited answers, request bodies of every size, framing and timing, Expect: 100-continue, slow uploads |
| headers (H) | duplicates, cookies, huge and numerous headers both ways, Set-Cookie, **spoofed X-Forwarded-For / X-Real-IP** (can a browser pretend to be 127.0.0.1?), hop-by-hop abuse, non-ASCII bytes, Host variants |
| streaming (S), websocket (W) | buffering detection, SSE, slow devices, slow readers and back-pressure (hub memory in --local), websocket echo/concurrency/malformed frames, refused upgrades, offline devices |
| concurrency (C) | bursts, parallel uploads, **two devices at once never cross** (the front-end connection-reuse bug), starvation, hanging requests, one device's queue vs another device |
| device (D) | a device that drops connections, never answers, answers garbage, appends forged answers, sends conflicting framing, has its web server down, is offline |
| malformed (M) | ~45 broken or odd requests: bad request lines, header syntax, NUL/CR/obs-fold, huge headers/URLs, bad lengths, Host tricks, absolute-form URLs |
| smuggling (X) | CL.TE, TE.CL, ~10 Transfer-Encoding obfuscations, duplicate/odd Content-Lengths, CL.0, chunk overflows: a follow-up request must get its own answer and no hidden request may reach a device |
| security (I) | **stranger uplinks** into someone else's device, **claiming a connected device's name**, the status dashboard without a password, writing names into the dashboard, path traversal into the hub's files, hub path prefixes, hub websockets fed garbage, SNI vs Host, open redirects |
| tls (T) | certificate names/expiry/**Common Name** (old Node clients like the Jibos need one), old TLS versions, ALPN, no SNI, HTTP/2 requests/uploads/50 streams, huge h2 headers |
| abuse (A) | slowloris, slow uploads, queue flood, connection flood, stranger-uplink flood, dashboard name spam, request-rate flood, websocket flood, HTTP/2 rapid reset; each probes both devices throughout and fails if attacking A takes down B |

## Adding a test

Each file in `tests/` exports an array of tests:

```js
{ id: 'B12', category: 'basics', name: 'what it checks',
  async run(h, r, opts) {
      const x = await h.request('A', { method: 'POST', path: '/t/echo', body: 'hi' });
      const seen = h.devices.A.target.find(x.id);       // what the device actually received
      r.check(seen && seen.bodyLength === 2, 'body lost');
  } }
```

Optional fields: `abuse: true`, `long: true`, `needs: 'tls' | 'local'`, `timeout` (ms),
`scaleTimeout: true`, `noHealth: true`. `r` takes `pass/fail/warn/info/skip(message)` and
`check(condition, failMessage, passMessage)`. `h` gives `request`, `entry(hostname)` for raw
`exchange()`/`session()` calls, `openWS`, `canary`, `devices.{A,B}.{name,host,target}`,
`spawnClient` and, in --local mode, `hub` (its process, with `rss()`).

Mark a request's id with `h.id('A')` (or `'B'`): the post-test check uses the prefix to spot
cross-device delivery. Put `smuggled` in the path of any request that must never arrive.
