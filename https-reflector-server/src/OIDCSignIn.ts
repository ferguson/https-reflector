// A sign-in method for the dashboard that works with any OpenID Connect provider
// (authorization code flow with PKCE, as a confidential client). Plugins build on it:
// a plugin for a particular account service passes its issuer, client and the claims
// that name a person there. See DashboardAuth.ts for how sign-in methods are used.

import crypto = require('crypto');
import { SignInMethod, SignInContext } from './DashboardAuth';

const nodeUrl: any = require('url');
const log = {...console};

export interface OIDCOptions {
    id?: string;            // used in the dashboard's addresses: /admin/auth/<id>/...  (default 'oidc')
    label?: string;         // the sign-in button's text
    issuer: string;
    clientId: string;
    clientSecret: string;
    scope?: string;         // default 'openid profile email'
    // the names this person can be listed under in the hub's viewer/operator lists.
    // Default: their email address (if the provider vouches for it) and `sub@issuer-host`.
    identities?: (claims: any) => string[];
    displayName?: (claims: any) => string;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const random = (n: number) => b64url(crypto.randomBytes(n));

function defaultIdentities(issuer: string) {
    const host = new nodeUrl.URL(issuer).host;
    return (claims: any) => {
        const ids: string[] = [];
        if (claims.email && claims.email_verified === true) ids.push(String(claims.email));
        if (claims.sub) ids.push(`${claims.sub}@${host}`);
        return ids;
    };
}

function defaultDisplayName(claims: any): string {
    return claims.name || claims.preferred_username || claims.email || claims.sub;
}

export function oidc(o: OIDCOptions): SignInMethod {
    if (!o || !o.issuer || !o.clientId || !o.clientSecret) throw new Error('oidc(): issuer, clientId and clientSecret are required');
    const issuer = o.issuer.replace(/\/+$/, '');
    const fetchFn: any = (global as any).fetch;
    if (!fetchFn) throw new Error('oidc(): needs Node 18 or later (global fetch)');
    const identities = o.identities || defaultIdentities(issuer);
    const displayName = o.displayName || defaultDisplayName;

    let disco: any = null;
    let keys: any[] = [];
    let keysFetchedAt = 0;

    async function getJSON(url: string, init: any = {}): Promise<any> {
        const res = await fetchFn(url, Object.assign({ signal: (AbortSignal as any).timeout(10000) }, init));
        const text = await res.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (!res.ok) {
            const why = body && (body.error_description || body.error);
            throw new Error(`${url} answered ${res.status}${why ? `: ${why}` : ''}`);
        }
        if (!body) throw new Error(`${url} did not answer with JSON`);
        return body;
    }

    async function discovery(): Promise<any> {
        if (disco) return disco;
        const d = await getJSON(issuer + '/.well-known/openid-configuration');
        if (String(d.issuer).replace(/\/+$/, '') !== issuer) throw new Error(`the provider calls itself ${d.issuer}, not ${issuer}`);
        disco = d;
        return d;
    }

    async function keyFor(kid: string): Promise<any> {
        let jwk = keys.find((k) => !kid || k.kid === kid);
        // an unknown key id: the provider may have rotated its keys (but don't let a forged
        // token make us fetch on every request)
        if (!jwk && Date.now() - keysFetchedAt > 60000) {
            const d = await discovery();
            keys = (await getJSON(d.jwks_uri)).keys || [];
            keysFetchedAt = Date.now();
            jwk = keys.find((k) => !kid || k.kid === kid);
        }
        if (!jwk) throw new Error(`the provider has no key ${kid}`);
        return jwk;
    }

    async function verifyIdToken(token: string, nonce: string): Promise<any> {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) throw new Error('the ID token is not a signed token');
        const header = JSON.parse(fromB64url(parts[0]).toString());
        const claims = JSON.parse(fromB64url(parts[1]).toString());
        const jwk = await keyFor(header.kid);
        const key = (crypto as any).createPublicKey({ key: jwk, format: 'jwk' });
        const data = Buffer.from(parts[0] + '.' + parts[1]);
        const sig = fromB64url(parts[2]);
        let good = false;
        if (header.alg === 'RS256' && jwk.kty === 'RSA') good = (crypto as any).verify('sha256', data, key, sig);
        else if (header.alg === 'PS256' && jwk.kty === 'RSA') good = (crypto as any).verify('sha256', data, { key, padding: (crypto as any).constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
        else if (header.alg === 'ES256' && jwk.kty === 'EC') good = (crypto as any).verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
        else if (header.alg === 'EdDSA' && jwk.kty === 'OKP') good = (crypto as any).verify(null, data, key, sig);
        else throw new Error(`the ID token uses ${header.alg}, which this hub does not accept`);
        if (!good) throw new Error('the ID token signature is wrong');

        const now = Math.floor(Date.now() / 1000);
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (String(claims.iss).replace(/\/+$/, '') !== issuer) throw new Error(`the ID token is from ${claims.iss}`);
        if (aud.indexOf(o.clientId) < 0) throw new Error('the ID token is for another client');
        if (aud.length > 1 && claims.azp && claims.azp !== o.clientId) throw new Error('the ID token was issued to another client');
        if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('the ID token has expired');
        if (claims.nonce !== nonce) throw new Error('the ID token belongs to another sign-in');
        if (!claims.sub) throw new Error('the ID token names nobody');
        return claims;
    }

    return {
        id: o.id || 'oidc',
        label: o.label || 'Sign in',

        async start(req: any, res: any, ctx: SignInContext) {
            const d = await discovery();
            const state = random(16);
            const nonce = random(16);
            const verifier = random(32);
            ctx.remember(res, { state, nonce, verifier });
            const u = new nodeUrl.URL(d.authorization_endpoint);
            const params: any = {
                response_type: 'code',
                client_id: o.clientId,
                redirect_uri: ctx.callbackUrl,
                scope: o.scope || 'openid profile email',
                state,
                nonce,
                code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
                code_challenge_method: 'S256',
            };
            for (const k of Object.keys(params)) u.searchParams.set(k, params[k]);
            res.redirect(u.href);
        },

        async callback(req: any, res: any, ctx: SignInContext) {
            const q = req.query || {};
            const saved = ctx.recall(req);
            if (q.error) return ctx.fail(res, 401, `The sign-in service said: ${q.error_description || q.error}`);
            if (!saved || !q.state || q.state !== saved.state || !q.code) {
                return ctx.fail(res, 400, 'This sign-in has expired, or it was started in another browser. Try again.');
            }
            const d = await discovery();
            const basic = Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64');
            const body = new nodeUrl.URLSearchParams({
                grant_type: 'authorization_code',
                code: String(q.code),
                redirect_uri: ctx.callbackUrl,
                code_verifier: saved.verifier,
            });
            const tokens = await getJSON(d.token_endpoint, {
                method: 'POST',
                headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: body.toString(),
            });
            const claims = await verifyIdToken(tokens.id_token, saved.nonce);
            const ids = identities(claims).filter((s: any) => typeof s === 'string' && s);
            if (!ids.length) {
                log.warn(`dashboard sign-in: ${issuer} vouched for ${claims.sub}, but gave nothing to list them by`);
                return ctx.fail(res, 403, 'The sign-in worked, but your account has nothing this hub can recognize you by.');
            }
            ctx.finish(res, { ids, name: displayName(claims) || ids[0] });
        },
    };
}
