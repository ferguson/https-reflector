//import { Headers } from 'node-fetch';
import NodeFetch from 'node-fetch';
const Headers = NodeFetch.Headers;

const log = console;
const MAX_HEADERS_BLOCK_SIZE = 8192;


export default class HeaderBlock {
    constructor() {
        this.headers = new Headers();
    }


    addMethodLine(req, protocol='HTTP/1.1') {
        this.method = req.method;
        this.path = req.url;  // req.url is actually path + params
        this.protocol = protocol;
        this.method_line = `${this.method} ${this.path} ${this.protocol}`;
    }


    changePath(path) {
        this.path = path;
        this.method_line = `${this.method} ${this.path} ${this.protocol}`;
    }


    addStatusLine(response) {
        this.status_line = `${response.status} ${response.statusText}`;
    }


    addFromRawHeaders(raw_headers) {
        //log.debug(`raw_headers\n${raw_headers}`);
        for (let i=0; i<raw_headers.length; i+=2) {
            let name  = raw_headers[i];
            let value = raw_headers[i+1];
            this.headers.append(name, value);
        }
    }


    addFromString(headers_string, has_method_line=false) {
        let lines = headers_string.split(/\r?\n/);
        if (has_method_line) {
            // method line is the first line
            this.method_line = lines.shift();
            [this.method, this.path, this.protocol] = this.method_line.split(' ');
        }

        for (let line of lines) {
            if (line === '') {
                break;  // stop on the first blank line
            }
            let [name, value] = line.split(': ', 2);
            this.headers.append(name, value);
        }
    }


    addFromHeadersObj(headers) {
        for (let [name, value] of headers) {
            this.headers.append(name, value);
        }
    }


    async addFromSocket(socket, has_method_line=true) {
        let headers_data = new Buffer(0);
        let eohb = 0;  // end of header block (including terminating blank line)

        while (eohb === 0) {
            let data = await new Promise((resolve) => socket.once('data', resolve));
            headers_data = Buffer.concat([headers_data, data]);

            if (headers_data > MAX_HEADERS_BLOCK_SIZE) {
                throw new Error('headers block size exceeded');
            }

            for (let i of headers_data.keys()) {
                if (i > headers_data.length - 4) {
                    break;
                }
                let four_bytes = headers_data.slice(i, i+4);
                if (four_bytes.toString() === '\r\n\r\n') {
                    eohb = i+4;
                    break;
                }

                if (four_bytes[2] === 10 && four_bytes[3] === 10) {  // also accept just \n\n (telnet)
                    eohb = i+4;
                    break;
                }
            }
            if (eohb === 0) {
                log.debug('more than one data event required!');
            }
        }

        if (eohb < headers_data.length) {
            let extra = headers_data.slice(eohb);
            headers_data = headers_data.slice(0, eohb-1);
            socket.unshift(extra);
            log.debug('there was extra!');
        }

        let headers_string = headers_data.toString();
        this.addFromString(headers_string, has_method_line);
    }


    toHeadersString(suppress_method_line=true, suppress_blank_line_finalizer=false) {
        let lines = [];

        if (this.method_line && !suppress_method_line) {
            lines.push(this.method_line);
        }

        if (this.status_line) {
            lines.push(this.status_line);
        }

        for (let [name, value] of this.headers) {
            lines.push(`${name}: ${value}`);
        }

        let headers_string = lines.join('\r\n')+'\r\n';

        if (!suppress_blank_line_finalizer) {
            headers_string += '\r\n';
        }

        return headers_string;
    }

    toHeadersObj() {
        return this.headers;
    }
}


export function buildHeaderBlockString(raw_headers, suppress_connection=false) {
    let header_block_string = '';
    let skip_next = false;
    for (let i in raw_headers) {
        if (skip_next) {
            skip_next = false;
            continue;
        }
        let entry = raw_headers[i];
        if (i % 2 === 0) {
            if (suppress_connection && entry.toLowerCase() === 'connection') {
                skip_next = true;
                continue;
            }
            header_block_string += entry + ': ';
        } else {
            header_block_string += entry + '\r\n';
        }
    }
    return header_block_string;
}
