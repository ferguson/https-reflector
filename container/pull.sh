#!/bin/bash

TIMESTAMP="`date +'%Y%m%d'`"
INITIAL_TAG="https-reflector:$TIMESTAMP"
REGISTRY_TAG="docker.otto.fast/https-reflector:$TIMESTAMP"

time docker pull "$REGISTRY_TAG"
docker tag "$REGISTRY_TAG" https-reflector

exit
