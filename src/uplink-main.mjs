import os from 'os';
import { EventEmitter } from 'events';
//import { Command as Commander } from 'commander';
import * as C from 'commander';
const Commander = C.Command;
//import { toSnake } from 'snake-camel';
import * as snake_Camel from 'snake-camel';
const toSnake = snake_Camel.toSnake;
import { HubUplinkClient } from '../API.mjs';

const log = { ...console };

const usage = `
  --reflector <url>            - https-reflector server url
  --host <hostname>      - hostname of local server to uplink to (default localhost)
  --port <number>        - port to uplink to (default 9090)
  --devicename <name>    - unique device name to use (defaults to hostname)
`;

const defaults = {
    reflector: 'https://woot.localreflector:7887',
    host: 'localhost',
    port: 9090,
};


export default async function main() {
    let options = parseArgs(usage, defaults);
    //log.debug(options);

    let reflector_url = options.reflector;

    let uplink_client_options = {
        uplink_to_host: options.host,
        uplink_to_port: options.port,
    };
    let devicename = options.devicename || os.hostname().split('.')[0];
    console.log(`using device name ${devicename}`);
    let hubUplinkClient = new HubUplinkClient(reflector_url, uplink_client_options);
    await hubUplinkClient.init(devicename);
    log.debug('https-reflector client ready');
}


function parseArgs(usage, defaults=null) {
    let commander = new Commander();

    let usageLines = usage.split('\n').filter( line => line.trim().length);
    for (let usageLine of usageLines) {
        let [ definition, description ] = usageLine.split(' - ');
        commander.option(definition, description);
    }

    commander.parse();
    let options = commander.opts();
    options = toSnake(options);

    if (defaults) {
        for (let [key, value] of Object.entries(defaults)) {
            if (options[key] === undefined) {
                options[key] = value;
            }
        }
    }

    return options;
}
