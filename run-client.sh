#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd $DIR || (echo "error!"; exit 1)
source ./activate

echo "starting https-reflector client"
exec node --experimental-modules ./https-reflector-client.mjs --hub="https://*.mitlivinglab.org" --host=10.99.0.44 --port=8001
