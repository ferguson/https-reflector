#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $DIR || (echo "error!"; exit 1)
source ./activate

echo "starting https-reflector client"
exec node ./https-reflector-client.js --hub="https://*.mitlivinglab.org" --host=localhost --port=8001
