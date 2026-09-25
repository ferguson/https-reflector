#!/bin/bash

TIMESTAMP="`date +'%Y%m%d'`"
INITIAL_TAG="https-reflector:$TIMESTAMP"
REGISTRY_TAG="docker-registry.otto.stream:5000/https-reflector:$TIMESTAMP"

docker tag "$INITIAL_TAG" "$REGISTRY_TAG"
time docker push "$REGISTRY_TAG"

exit
