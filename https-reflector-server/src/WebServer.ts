import fs = require('fs');
import http = require('http');
import https = require('https');
import express = require('express');
//import asyncHandler = require('express-async-handler');

import Hub from './Hub';
import { WebServerOptions } from './types';

const log = {...console};
log.debug = ()=>{};

//import { fileURLToPath } from 'url';
//import { dirname } from 'path';
//const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.HTTPS_REFLECTOR_PUBLIC_STATIC_DIR || __dirname + '/../static';

const DEFAULT_CERTIFICATE_DIR  = '/etc/letsencrypt/live/some-https-reflector-server.org';

const defaults: Partial<WebServerOptions> = {
    bind: '0.0.0.0',
    http_port: 80,
    https_port: 443,
    hostname: 'some-https-reflector-server.org',
    private_key_file: DEFAULT_CERTIFICATE_DIR + '/privkey.pem',
    certificate_file: DEFAULT_CERTIFICATE_DIR + '/cert.pem',
    authority_file:   DEFAULT_CERTIFICATE_DIR + '/chain.pem',
};


export default class WebServer {
    options: WebServerOptions;
    app: express.Application;
    hub: Hub;

    constructor(options: WebServerOptions) {
        this.options = Object.assign({}, defaults, options);
        // hostname may be a comma-separated list, each optionally prefixed with *.
        const raw = this.options.hostname.split(',').map((h: string) => h.trim());
        if (raw.some((h: string) => h.startsWith('*.'))) {
            this.options.use_vhosts = true;
        }
        this.options.hostnames = raw.map((h: string) => h.replace('*.', ''));
        this.options.hostname  = this.options.hostnames[0];
    }


    async init(): Promise<void> {
        let web_server: http.Server | https.Server;
        let web_server_options: any = {
            keepAlive: true
        };
        let use_port: number;
        if (!this.options.use_https) {
            web_server = http.createServer(web_server_options);
            use_port = this.options.port || this.options.http_port;
        } else {
            const privateKey = fs.readFileSync(this.options.private_key_file);
            const certificate = fs.readFileSync(this.options.certificate_file);
            const certAuthority = fs.readFileSync(this.options.authority_file);
            const credentials = {
                key: privateKey,
                cert: certificate,
                ca: certAuthority
            };
            web_server_options = Object.assign(web_server_options, credentials);
            web_server = https.createServer(web_server_options);
            use_port = this.options.port || this.options.https_port;
        }

        web_server.on('request', (req, res) => this.requestHandler(req, res));
        web_server.on('upgrade', (req, socket, head) => this.upgradeHandler(req, socket, head));

        this.app = express();
        this.addRoutes(this.app);

        this.hub = new Hub(this.options);
        await this.hub.init();

        web_server.listen(use_port, this.options.bind, async () => {
            log.log(`server listening on ${this.options.bind}:${use_port}`);
            if (this.options.use_https && this.options.redirect_http) {
                this.initHTTPRedirector();
            }
        });
    }


    requestHandler(req: any, res: any): void {
        log.debug('requestHandler', req.url);
        let devicename: string;
        if (this.options.use_vhosts) {
            devicename = this.getDevicenameFromReq(req);
            log.log(`[${devicename||''}] ${req.url}`);
            if (devicename) {
                // hub request
                this.hub.requestHandler(devicename, req, res);
            } else {
                // regular web site stuff, let express handle it
                this.app(req, res);
            }
        } else {
            // no vhosts, everything is a hub request
            devicename = 'default';
            log.log(req.url);
            this.hub.requestHandler(devicename, req, res);
        }
    }


    upgradeHandler(req: any, socket: any, head: any): void {
        log.debug('upgradeHandler', req.url);
        let devicename: string;
        if (this.options.use_vhosts) {
            devicename = this.getDevicenameFromReq(req);
            log.log(`[${devicename||''}] ${req.url}`);
            if (devicename) {
                // hub request
                this.hub.upgradeHandler(devicename, req, socket, head);
            } else if (req.url && (req.url.startsWith('/https-reflector/') || req.url.startsWith('/otto-hub/'))) {
                // hub-internal WebSocket on the root domain (e.g. status.ws from the dashboard)
                this.hub.upgradeHandler(null, req, socket, head);
            }
        } else {
            // no vhosts, everything is a hub request
            devicename = 'default';
            log.log(req.url);
            this.hub.upgradeHandler(devicename, req, socket, head);
        }
    }


    addRoutes(app: express.Application): void {
        app.use(express.static(STATIC_DIR));
        // app.get('/', (req, res) => {
        //     log.log('hello!');
        //     res.end('hello!');
        // });
    }


    getDevicenameFromReq(req: any): string | null {
        let host = this.hub.getHostHeader(req) || this.options.hostname;
        log.debug('host', host);
        let hostname = this.hub.getHostnameFromHost(host);
        log.debug('hostname', hostname);
        let devicename = this.hub.getDevicenameFromHostname(hostname);
        log.debug('devicename', devicename);
        return devicename;
    }


    initHTTPRedirector(): void {
        let redirect_app = express();  // using express here is a bit overkill
        let redirect_server = http.createServer(redirect_app);

        redirect_app.use((req, res, next) => {
            let host = (req.headers && req.headers.host) || this.options.hostname;
            host = host.split(':')[0];  // remove port
            log.debug('redirecting to', 'https://' + host + req.originalUrl);
            res.redirect('https://' + host + req.originalUrl);
        });

        redirect_server.listen(this.options.http_port, this.options.bind, async () => {
            log.log(`redirect server listening on ${this.options.bind}:${this.options.http_port}`);
        });
    }
}
