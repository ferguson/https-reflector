# HTTPS Reflector

![Basic architecture diagram showing how the HTTPS Redirector server and client interact.](HTTPS-Reflector-20250426.png)

## Setup

If you clone this repo and run `./setup.sh` you should end up with a
working HTTPS Reflector client with it's own local copy of the
specific version of node it's configured for.

You can try this on-device, or your macOS/Linux laptop.

Note: The server might not be currently working with that version of node.

```
git clone https://github.com/ferguson/https-reflector
cd https-reflector
./setup.sh
```

You can test the install:

```
source ./activate
node --version  // should be v11.15.0
node --experimental-modules https-reflector-client.mjs --help
```

You should see:
```
Usage: https-reflector-client [options]

Options:
    --hub <url>             https-reflector server url
    --host <hostname>       hostname of local server to uplink to (default localhost)
    --port <number>         port to uplink to (default 9090)
    --devicename <name>     unique device name to use (defaults to hostname)
  -h, --help                display help for command
```

# Setting up the HTTPS Reflector Server

I don't think you can setup the server the way things are right now.
Sorry. I will fix that.

# Using the client

You can now try using the client:

```
node --experimental-modules https-reflector-client.mjs --devicename air-solvent --host 10.99.0.70 --port 80 --hub "https://*.some-https-reflector-server.org"
```

That should look something like this:
```
using device name air-solvent
attempting an uplink connection to https://air-solvent.some-https-reflector-server.org/
socket.io connected
hub says to proceed
https-reflector server https://air-solvent.some-https-reflector-server.org/ connected
```

You should then be able to go to `https://air-solvent.some-https-reflector-server.org/`
and be connected to whatever web page is being served on port 80!

Note: `air-solvent` was just a unique name I picked randomly for the
device. You just have to use the same identifier when connecting with
your browser, as shown above.
