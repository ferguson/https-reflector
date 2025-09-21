#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $DIR || (echo "error!"; exit 1)
cd ..
source ./activate
cd -

echo "starting https-reflector client"
exec node ./https-reflector-client.js --reflector="https://*.mitlivinglab.org" --host=localhost --port=8001
