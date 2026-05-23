#!/bin/bash

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/.." || (echo "error!"; exit 1)

TIMESTAMP="$(date +'%Y%m%d')"
IMAGE_TAG_DATE="https-reflector:$TIMESTAMP"
IMAGE_TAG_LATEST="https-reflector:latest"

## building amd64 on an arm mac; --load pulls the result into the local docker image store
docker buildx build --platform=linux/amd64 --load \
    -t "$IMAGE_TAG_DATE" \
    -t "$IMAGE_TAG_LATEST" \
    -f container/Dockerfile \
    . || exit 1

echo "Built $IMAGE_TAG_DATE / $IMAGE_TAG_LATEST"
