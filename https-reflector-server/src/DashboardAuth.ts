// Who may use the status dashboard, and what they may do there.
//
// Two ways in, either or both:
//  - the dashboard password (HTTPS_REFLECTOR_STATUS_PASSWORD), typed into the page: full access
//  - signing in with an account, through a sign-in method: the hub then looks the person up in
//    its own lists (HTTPS_REFLECTOR_DASHBOARD_OPERATORS, ..._VIEWERS). Operators can change
//    things (archive names); viewers can only look.
// With neither configured the dashboard is open to anyone, read-only (as hubs always were).
//
// Sign-in methods are plugins, so that nothing about a particular account service lives in the
// hub. A plugin is a JavaScript file named in HTTPS_REFLECTOR_SIGNIN_PLUGINS (comma-separated
// paths) that exports a function:
//
//     module.exports = function ({ oidc, env, log }) {
//         return oidc({ id: 'example', label: 'Sign in with Example', issuer: 'https://id.example.com',
//                       clientId: 'hub', clientSecret: env.EXAMPLE_SECRET,
//                       identities: (claims) => [claims.email] });
//     };
//
// It returns one sign-in method or a list of them: either from the oidc() helper (any OpenID
// Connect provider) or written by hand, as an object with { id, label, start(), callback() }
// (see SignInMethod below). For a plain OpenID Connect provider no plugin is needed:
// HTTPS_REFLECTOR_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET (and optionally _LABEL) set one up.
// The provider must allow https://<hub>/admin/auth/<id>/callback as a return address.
//
// The hub keeps who signed in in a signed cookie for the hub's own host name only (never the
// device names under it), and looks up their role again every time the dashboard connects, so
// taking someone off a list (and restarting the hub) takes effect at once.

import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import { oidc, OIDCOptions } from './OIDCSignIn';

const nodeUrl: any = require('url');
const log = {...console};

export type Role = 'viewer' | 'operator';

export interface Identity {
    ids: string[];      // every name the person can be listed under (an account handle, an email address, ...)
    name: string;       // for display
}

export interface Session extends Identity {
    role: Role | null;  // null: signed in, but on neither list (any more)
}

export interface SignInContext {
    callbackUrl: string;                          // where the provider must send the browser back to
    remember(res: any, data: any): void;          // keep a little state (signed, 10 minutes) between start and callback
    recall(req: any): any;                        // ...and get it back (null if missing, forged or expired)
    finish(res: any, identity: Identity): void;   // the person is who they say: let them in, if they are on a list
    fail(res: any, status: number, message: string): void;
}

export interface SignInMethod {
    id: string;          // [a-z0-9-]+, used in the addresses /admin/auth/<id>/start and /callback
    label: string;       // the button's text
    start(req: any, res: any, ctx: SignInContext): any;      // send the browser off to sign in
    callback(req: any, res: any, ctx: SignInContext): any;   // it came back: check, then ctx.finish() or ctx.fail()
}

export interface DashboardAuthOptions {
    password?: string | null;
    operators?: string;          // comma-separated
    viewers?: string;
    signin_plugins?: string;     // comma-separated paths
    oidc_issuer?: string;
    oidc_client_id?: string;
    oidc_client_secret?: string;
    oidc_label?: string;
    data_dir: string;
    hostnames: string[];
}

const SESSION_DAYS = 7;
const PENDING_MS = 10 * 60 * 1000;
const KEY_FILE = 'dashboard-session.key';

const b64url = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const list = (s: string | undefined) => (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, html: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;background:#3A5366;color:#F9F9F9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:460px}h1{color:#96EEF2;font-size:20px}p{line-height:1.5}code{background:#2E4555;padding:1px 6px;border-radius:4px}
a,button{color:#0E2446;background:#41B9C3;border:0;border-radius:6px;padding:8px 18px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;display:inline-block;margin:6px 8px 0 0}
</style></head><body><main>${html}</main></body></html>`;
}


export default class DashboardAuth {
    password: string | null;
    operators: Set<string>;
    viewers: Set<string>;
    methods: SignInMethod[];
    hostnames: string[];
    private key: Buffer;

    constructor(o: DashboardAuthOptions) {
        this.password  = o.password || null;
        this.operators = new Set(list(o.operators));
        this.viewers   = new Set(list(o.viewers));
        this.hostnames = (o.hostnames || []).map((h) => h.toLowerCase());
        this.methods   = [];
        this.key       = this.loadKey(o.data_dir);

        if (o.oidc_issuer) {
            this.addMethods(() => oidc({ issuer: o.oidc_issuer, clientId: o.oidc_client_id, clientSecret: o.oidc_client_secret, label: o.oidc_label }), 'HTTPS_REFLECTOR_OIDC_*');
        }
        for (const file of (o.signin_plugins || '').split(',').map((s) => s.trim()).filter(Boolean)) {
            this.addMethods(() => {
                const mod = require(path.resolve(file));
                const make = typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
                if (!make) throw new Error('it does not export a function');
                return make({ oidc: (opts: OIDCOptions) => oidc(opts), env: process.env, log });
            }, file);
        }
        if (this.methods.length && !this.operators.size && !this.viewers.size) {
            log.warn('dashboard: sign-in is set up, but HTTPS_REFLECTOR_DASHBOARD_OPERATORS and _VIEWERS are both empty, so nobody who signs in gets anything');
        }
    }

    private addMethods(make: () => any, source: string): void {
        try {
            let got = make();
            for (const m of (Array.isArray(got) ? got : [got])) {
                if (!m || typeof m.start !== 'function' || typeof m.callback !== 'function' || !/^[a-z0-9-]+$/.test(m.id || '')) {
                    throw new Error('a sign-in method needs an id ([a-z0-9-]+), a label, start() and callback()');
                }
                if (this.methods.some((x) => x.id === m.id)) throw new Error(`there is already a sign-in method called ${m.id}`);
                this.methods.push(m);
                log.log(`dashboard: sign-in method "${m.id}" (${m.label}) from ${source}`);
            }
        } catch (err) {
            // the hub keeps running (devices matter more than the dashboard); the password still works
            log.error(`dashboard: could not set up sign-in from ${source}: ${err && err.message}`);
        }
    }

    // a random key in the data directory signs the cookies; delete the file to sign everyone out
    private loadKey(dataDir: string): Buffer {
        const file = path.join(dataDir, KEY_FILE);
        try {
            const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
            if (k.length >= 32) return k;
        } catch (e) { /* make one */ }
        const k = crypto.randomBytes(32);
        try {
            fs.mkdirSync(dataDir, { recursive: true } as any);
            fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600 });
        } catch (err) {
            log.warn(`dashboard: could not save ${file} (${err && err.message}); sign-ins last until the hub restarts`);
        }
        return k;
    }

    // is anything needed to get onto the dashboard at all?
    get required(): boolean { return !!this.password || this.methods.length > 0; }

    roleFor(ids: string[]): Role | null {
        const lower = (ids || []).map((s) => String(s).toLowerCase());
        if (lower.some((i) => this.operators.has(i))) return 'operator';
        if (lower.some((i) => this.viewers.has(i))) return 'viewer';
        return null;
    }

    checkPassword(attempt: string): boolean {
        if (!this.password) return false;
        const a = crypto.createHash('sha256').update(String(attempt)).digest();
        const b = crypto.createHash('sha256').update(this.password).digest();
        return (crypto as any).timingSafeEqual(a, b);
    }

    // ── host names, origins, cookies ──

    private hostOf(req: any): string {
        let h = req.headers && req.headers.host;
        if (Array.isArray(h)) h = h[0];
        return String(h || '').toLowerCase();
    }

    // the hub's own name (otto.stream), not a device's (x.otto.stream): the only place sign-in happens
    isHubHost(req: any): boolean {
        const hostname = this.hostOf(req).replace(/:\d+$/, '');
        return this.hostnames.indexOf(hostname) >= 0;
    }

    private isSecure(req: any): boolean {
        if (req.socket && req.socket.encrypted) return true;
        const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        return xf === 'https';
    }

    private cookieName(req: any, name: string): string {
        // __Host-: the browser keeps it for this exact host only, and only over https
        return this.isSecure(req) ? `__Host-${name}` : name;
    }

    private readCookie(req: any, name: string): string | null {
        const want = this.cookieName(req, name);
        for (const part of String(req.headers.cookie || '').split(';')) {
            const eq = part.indexOf('=');
            if (eq > 0 && part.slice(0, eq).trim() === want) return part.slice(eq + 1).trim();
        }
        return null;
    }

    private setCookie(req: any, res: any, name: string, value: string, maxAgeS: number): void {
        const attrs = [`${this.cookieName(req, name)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
        if (this.isSecure(req)) attrs.push('Secure');
        const prev = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', (Array.isArray(prev) ? prev : prev ? [String(prev)] : []).concat(attrs.join('; ')));
    }

    private seal(data: any, purpose: string): string {
        const body = b64url(Buffer.from(JSON.stringify(data)));
        const mac = b64url(crypto.createHmac('sha256', this.key).update(purpose + '.' + body).digest());
        return body + '.' + mac;
    }

    private unseal(value: string | null, purpose: string): any {
        if (!value) return null;
        const [body, mac] = value.split('.');
        if (!body || !mac) return null;
        const want = b64url(crypto.createHmac('sha256', this.key).update(purpose + '.' + body).digest());
        if (want.length !== mac.length || !(crypto as any).timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
        try {
            const data = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
            if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
            return data;
        } catch (e) { return null; }
    }

    // Who the browser behind this request signed in as (an HTTP request or a websocket upgrade)
    session(req: any): Session | null {
        if (!this.methods.length || !this.isHubHost(req)) return null;
        const s = this.unseal(this.readCookie(req, 'hub_session'), 'session');
        if (!s || !Array.isArray(s.ids)) return null;
        return { ids: s.ids, name: s.name, role: this.roleFor(s.ids) };
    }

    // A websocket from a web page carries the page's origin. A page anywhere else (a device's
    // page on a name under this hub counts as the same *site*, so SameSite cookies don't stop
    // it) must not get to use the dashboard with the visitor's sign-in. Programs that send no
    // Origin carry no browser cookies either.
    originOk(req: any): boolean {
        const origin = req.headers.origin;
        if (!origin) return true;
        try {
            return new nodeUrl.URL(String(origin)).host.toLowerCase() === this.hostOf(req);
        } catch (e) { return false; }
    }

    // ── the sign-in pages ──

    routes(app: any): void {
        const express = require('express');
        const router = express.Router();
        const wrap = (fn: (req: any, res: any) => any) => (req: any, res: any) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Frame-Options', 'DENY');
            if (!this.isHubHost(req)) { res.statusCode = 404; return res.end(); }
            Promise.resolve().then(() => fn(req, res)).catch((err) => {
                log.error('dashboard sign-in error:', err && err.message);
                if (!res.headersSent) this.failPage(res, 502, esc(`Signing in didn't work: ${err && err.message}`));
            });
        };

        // what the dashboard page should offer
        router.get('/me', wrap((req, res) => {
            const s = this.session(req);
            res.json({
                methods: this.methods.map((m) => ({ id: m.id, label: m.label, start: `/admin/auth/${m.id}/start` })),
                password: !!this.password,
                open: !this.required,
                user: s ? { name: s.name, ids: s.ids, role: s.role } : null,
            });
        }));

        router.get('/:id/start', wrap((req, res) => {
            const m = this.methods.find((x) => x.id === req.params.id);
            if (!m) return this.failPage(res, 404, 'There is no such way to sign in here.');
            return m.start(req, res, this.context(req, m));
        }));

        router.get('/:id/callback', wrap((req, res) => {
            const m = this.methods.find((x) => x.id === req.params.id);
            if (!m) return this.failPage(res, 404, 'There is no such way to sign in here.');
            return m.callback(req, res, this.context(req, m));
        }));

        router.post('/logout', wrap((req, res) => {
            if (!req.headers.origin || !this.originOk(req)) return this.failPage(res, 403, 'Sign out from the dashboard itself.');
            this.setCookie(req, res, 'hub_session', '', 0);
            res.json({ ok: true });
        }));

        app.use('/admin/auth', router);
    }

    private context(req: any, m: SignInMethod): SignInContext {
        const proto = this.isSecure(req) ? 'https' : 'http';
        const pendingName = `hub_signin_${m.id}`;
        return {
            callbackUrl: `${proto}://${this.hostOf(req)}/admin/auth/${m.id}/callback`,
            remember: (res: any, data: any) => {
                this.setCookie(req, res, pendingName, this.seal({ d: data, exp: Date.now() + PENDING_MS }, pendingName), PENDING_MS / 1000);
            },
            recall: (r: any) => {
                const v = this.unseal(this.readCookie(r, pendingName), pendingName);
                return v ? v.d : null;
            },
            finish: (res: any, who: Identity) => {
                this.setCookie(req, res, pendingName, '', 0);
                const role = this.roleFor(who.ids);
                if (!role) {
                    log.warn(`dashboard: ${who.ids.join(' / ')} signed in (with ${m.id}) but is on neither list`);
                    return this.failPage(res, 403,
                        `You signed in as <code>${esc(who.ids[0])}</code>, but that account hasn't been given access to this hub's dashboard. ` +
                        `Its operator can add it to <code>HTTPS_REFLECTOR_DASHBOARD_VIEWERS</code> or <code>_OPERATORS</code>.`);
                }
                log.log(`dashboard: ${who.ids[0]} signed in (with ${m.id}) as ${role}`);
                this.setCookie(req, res, 'hub_session', this.seal({ ids: who.ids, name: who.name, exp: Date.now() + SESSION_DAYS * 86400000 }, 'session'), SESSION_DAYS * 86400);
                res.redirect('/admin/');
            },
            fail: (res: any, status: number, message: string) => {
                this.setCookie(req, res, pendingName, '', 0);
                this.failPage(res, status, esc(message));
            },
        };
    }

    private failPage(res: any, status: number, html: string): void {
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(page('Dashboard sign-in', `<h1>Couldn't sign you in</h1><p>${html}</p><a href="/admin/">Back to the dashboard</a>`));
    }
}
