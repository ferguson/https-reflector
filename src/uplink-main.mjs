import os from 'os';
import { EventEmitter } from 'events';
//import { Command as Commander } from 'commander';
import C from 'commander';
const Commander = C.Command;
//import { toSnake } from 'snake-camel';
import snake_Camel from 'snake-camel';
const toSnake = snake_Camel.toSnake;
import { HubUplinkClient } from '../API.mjs';

const log = console;

const options = `
  --hub <url>            - https-reflector server url
  --host <hostname>      - hostname of local server to uplink to (default localhost)
  --port <number>        - port to uplink to (default 9090)
  --devicename <name>    - unique device name to use (defaults to hostname)
`;

const defaults = {
    hub: 'https://woot.localreflector:7887',
    host: 'localhost',
    port: 9090,
};


export default async function main() {
    let opts = parseArgs(options, defaults);
    //log.log(opts);

    let hub_url = opts.hub;

    let uplink_client_options = {
        uplink_to_host: opts.host,
        uplink_to_port: opts.port,
    };
    let devicename = opts.devicename || os.hostname().split('.')[0];
    console.log(`using device name ${devicename}`);
    let hubUplinkClient = new HubUplinkClient(hub_url, uplink_client_options);
    await hubUplinkClient.init(devicename);
    log.debug('https-reflector client ready');
    //setTimeout(() => { console.log('done blocking'); }, 200 * 1000);  // FIXME
}


function parseArgs(options, defaults=null) {
    let commander = new Commander();

    let optionsLines = options.split('\n').filter( line => line.trim().length);
    for (let optionLine of optionsLines) {
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
