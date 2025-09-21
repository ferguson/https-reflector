#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

cd $DIR || (echo "error!"; exit 1)

source ./activate

export HTTPS_REFLECTOR_HOSTNAME="localreflector"

echo "starting https-reflector-server in dev mode"
NODE_ENV=development node_modules/.bin/nodemon -V --watch src --watch static -x 'node --inspect=7888 ./https-reflector-server.js --port 80 --hostname "$HTTPS_REFLECTOR_HOSTNAME"'
