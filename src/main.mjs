//import { Command as Commander } from 'commander';
import C from 'commander';
const Commander = C.Command;
//import { toSnake } from 'snake-camel';
import snake_Camel from 'snake-camel';
const toSnake = snake_Camel.toSnake;

import { WebServer } from '../API.mjs';

const log = console;

const usage = `
  --hostname <hostname>  - the external host name of the server (required)

  --port <port>          - override the default port (80 for http, 443 for https)
  --use-https            - use https
  --redirect-http        - redirect port 80 to port 443 (or --port) if using https
  --redirect-port        - change port for redirector to listen on (default 80)
  --use-vhosts           - use <devicename>.<hostname> to route multiple upstream nodes
                               (requires DNS support)
  --bind                 - the ip address to bind to (default 0.0.0.0)
  --private-key-file     - privkey.pem file to use for https
  --certificate-file     - cert.pem file to use for https
  --authority-file       - chain.pem file to use for https
`;

const defaults = {
};  // see WebServer.mjs for defaults


export default async function main() {
    let options = parseArgs(usage, defaults);
    if (!options.hostname) {
        throw new Error('--hostname <hostname> argument required');
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
