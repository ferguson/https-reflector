#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $DIR || (echo "error!"; exit 1)
source ./activate

export HTTPS_REFLECTOR_PUBLIC_STATIC_DIR=/var/www/some-https-reflector-server.org

echo "starting https-reflector"
exec node --experimental-modules ./https-reflector.mjs --use-https --redirect-http --hostname="*.some-https-reflector-server.org"
