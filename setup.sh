#!/bin/bash

export VIRTUALIZE_NODE_VERSION=11.15.0

## install git submodules
#git submodule init
#git submodule update
# we don't use submodules here because we don't want them
# to affect the monorepo
git clone https://github.com/mitmedialab/virtualize
git clone https://github.com/mitmedialab/virtualize-node
virtualize/setup.sh

source ./activate

### node
if [[ -f package.json && -d virtualize-node ]]; then
    yarn install
fi

echo "done installing node $VIRTUALIZED_NODE_VERSION"
echo "to enable using the virtualized node in this shell:"
echo "  source ./activate"

