import { Command as Commander } from 'commander';
//import C from 'commander';
//const Commander = C.Command;
import { toSnake } from 'snake-camel';
//import snake_Camel from 'snake-camel';
//const toSnake = snake_Camel.toSnake;

import { WebServer } from './API';

const log = {...console};

const usage = `
  --hostname <hostname>       - domain(s) to serve (required); comma-separated for multiple,
                                    e.g. "*.otto.stream,*.mitlivinglabs.org"

  --port <port>               - override the default port (80 for http, 443 for https)
  --use-https                 - use https
  --redirect-http             - redirect port 80 to port 443 (or --port) if using https
  --redirect-port             - change port for redirector to listen on (default 80)
  --use-vhosts                - use <devicename>.<hostname> to route multiple upstream nodes
                                    (requires DNS support)
  --bind <address>            - the ip address to bind to (default 0.0.0.0)
  --private-key-file          - privkey.pem file to use for https
  --certificate-file          - cert.pem file to use for https
  --authority-file            - chain.pem file to use for https
  --status-password <pass>    - password for the status dashboard (full access)
  --dashboard-operators <ids> - comma-separated accounts that may use the dashboard and change things
  --dashboard-viewers <ids>   - comma-separated accounts that may only look at the dashboard
  --signin-plugins <files>    - comma-separated dashboard sign-in plugins (see src/DashboardAuth.ts)
  --oidc-issuer <url>         - an OpenID Connect provider to sign in to the dashboard with
  --oidc-client-id <id>       - the hub's client id there
  --oidc-client-secret <s>    - ...and its secret (better in HTTPS_REFLECTOR_OIDC_CLIENT_SECRET)
  --oidc-label <text>         - the sign-in button's text
  --data-dir <dir>            - directory for persisted device stats (default: server/data)
`;

const defaults = {
};  // see WebServer.ts for defaults


export default async function main() {
    let options = parseArgs(usage, defaults);

    // env var fallbacks for options not set via CLI
    const envMap: Record<string, string> = {
        hostname:          'HTTPS_REFLECTOR_HOSTNAME',
        status_password:   'HTTPS_REFLECTOR_STATUS_PASSWORD',
        dashboard_operators: 'HTTPS_REFLECTOR_DASHBOARD_OPERATORS',
        dashboard_viewers: 'HTTPS_REFLECTOR_DASHBOARD_VIEWERS',
        signin_plugins:    'HTTPS_REFLECTOR_SIGNIN_PLUGINS',
        oidc_issuer:       'HTTPS_REFLECTOR_OIDC_ISSUER',
        oidc_client_id:    'HTTPS_REFLECTOR_OIDC_CLIENT_ID',
        oidc_client_secret: 'HTTPS_REFLECTOR_OIDC_CLIENT_SECRET',
        oidc_label:        'HTTPS_REFLECTOR_OIDC_LABEL',
        data_dir:          'HTTPS_REFLECTOR_DATA_DIR',
        private_key_file:  'HTTPS_REFLECTOR_PRIVATE_KEY_FILE',
        certificate_file:  'HTTPS_REFLECTOR_CERTIFICATE_FILE',
        authority_file:    'HTTPS_REFLECTOR_AUTHORITY_FILE',
    };
    for (const key of Object.keys(envMap)) {
        if (!options[key] && process.env[envMap[key]]) {
            options[key] = process.env[envMap[key]];
        }
    }

    if (!options.hostname) {
        throw new Error('--hostname <hostname> argument required (or set HTTPS_REFLECTOR_HOSTNAME)');
    }
    let server = new WebServer(options);
    await server.init();
    log.debug('https-reflector server ready');
}


function parseArgs(options, defaults=null) {
    let commander = new Commander();

    let optionsLines = options.split('\n').filter( line => line.trim().length);
    for (let optionLine of optionsLines) {
        if (!optionLine.includes(' - ')) {
            continue;
        }
        let [ definition, description ] = optionLine.split(' - ');
        commander.option(definition, description);
    }

    commander.parse();
    let opts = commander.opts();
    opts = toSnake(opts);

    if (defaults) {
        for (let [key, value] of Object.entries(defaults)) {
            if (opts[key] === undefined) {
                opts[key] = value;
            }
        }
    }

    return opts;
}
