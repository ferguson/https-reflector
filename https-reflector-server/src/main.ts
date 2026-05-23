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
  --bind                      - the ip address to bind to (default 0.0.0.0)
  --private-key-file          - privkey.pem file to use for https
  --certificate-file          - cert.pem file to use for https
  --authority-file            - chain.pem file to use for https
  --status-password <pass>    - password for the status dashboard WebSocket
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
