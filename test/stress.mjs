//import http from 'node:http';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { io } from 'socket.io-client';

const BASE_URL = 'http://woot.localreflector';
//const BASE_URL = 'http://localhost:9090';

const log = Object.assign({}, console);


main();

async function main() {
    let responsesP = [];
    let n = 0;
    let finished = 0;
    let finished200 = 0;
    let finished504 = 0;
    log.log(`making ${n} requests, in parallel batches of 100...`);
    for (let i=0; i<n; i++) {
        let responseP = fetch(`${BASE_URL}/`);
        // responseP.then(async (response) => {
        //     finished++;
        //     if (finished % 100 === 0) {
        //         log.log(`finished ${finished}...`);
        //     }
        //     let text = await response.text();
        //     if (response.status === 200) {
        //         finished200++;
        //         //log.log(response.status, response.statusText, 'length', text.length);
        //     } else if (response.status === 504) {
        //         finished504++;
        //         //
        //     } else {
        //         log.log(response.status, response.statusText, 'length', text.length);
        //         log.log(text);
        //     }
        // }).catch((err) => {
        //     log.error(err.code, err.message);
        // });
        responsesP.push(responseP);

        if (i % 100 === 0) {
            // wait for 100 to finish before continuing
            await Promise.all(responsesP);
        }
    }
    log.log('done.', responsesP.length);

    for (let responseP of responsesP) {
        responseP.then(async (response) => {
            finished++;
            if (finished % 100 === 0) {
                log.log(`finished ${finished}...`);
            }
            let text = await response.text();
            if (response.status === 200) {
                finished200++;
                //log.log(response.status, response.statusText, 'length', text.length);
            } else if (response.status === 504) {
                finished504++;
                //
            } else {
                log.log(response.status, response.statusText, 'length', text.length);
                log.log(text);
            }
        }).catch((err) => {
            log.error(err.code, err.message);
        });
    }

    log.log('waiting 2 seconds...');

    await Promise.all(responsesP);
    log.log(`all requests done.`);
    log.log(`finished 200 ${finished200}`);
    log.log(`finished 504 ${finished504}`);

    n = 300;
    let sockets = [];
    let connects = 0;
    for (let i=0; i<n; i++) {
        //let websocket = new WebSocket(`${BASE_URL}/
        let socket = io(BASE_URL, { transports: ['websocket'] });
        socket.on('connect', () => {
            connects++;
            socket.emit('hello', {});
            //log.log('connect');
        });
        socket.on('connect_error', (err) => { log.log('connect_error', err); });
        // let emit = socket.emit;
        // socket.emit = (...args) => { log.log('emit'); return emit(...args); };
        if (i % 100 === 0) {
            log.log(`+ ${i}`);
            await new Promise( (resolve) => setImmediate(resolve) );
        }
        if (i === 290) {
            process.exit();
        }
        sockets.push(socket);
    }

    log.log('waiting 2 seconds...');
    await new Promise( (resolve) => setTimeout(resolve, 2000) );

    log.log(`connects ${connects}`);

    for (let socket of sockets) {
        //log.log(socket.connected, socket.id);
        socket.disconnect();
    }

    log.log('waiting 2 more seconds...');
    await new Promise( (resolve) => setTimeout(resolve, 2000) );
}
