import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const log = Object.assign(console);

let PORT = 80;
const HTTPS_PORT = 443;
const BIND = '0.0.0.0';

const privateKey = fs.readFileSync('/etc/letsencrypt/live/some-https-reflector-server.org/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/some-https-reflector-server.org/cert.pem', 'utf8');
const ca = fs.readFileSync('/etc/letsencrypt/live/some-https-reflector-server.org/chain.pem', 'utf8');

const credentials = {
        key: privateKey,
        cert: certificate,
        ca: ca
};

main(true);

async function main(test_https) {
    let http_server;
    if (test_https) {
        http_server = https.createServer(credentials);
        PORT = HTTPS_PORT;
    } else {
        let http_server = http.createServer();
    }

    http_server.on('connection', async (socket) => {
        log.log('http_server connection');
        try {
            //socket.resume();
            let data = await new Promise((resolve) => {
                console.log('socket');
                // this next even will never fire with the https server
                socket.once('data', (data) => {
                    console.log('got socket data!');
                    resolve(data);
                });
            });
        } catch(err) {
            log.info('caught error', err.code);
        }
    });

    http_server.listen(PORT, BIND, async () => {
        log.log(`server listening on ${BIND}:${PORT}`);
    });
}
