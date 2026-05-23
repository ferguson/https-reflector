#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $DIR || (echo "error!"; exit 1)
cd ..
source ./activate
cd -

export HTTPS_REFLECTOR_PUBLIC_STATIC_DIR=/var/www/some-https-reflector-server.org

echo "starting https-reflector-server"
exec node ./https-reflector-server.js --use-https --redirect-http --hostname="*.some-https-reflector-server.org"
