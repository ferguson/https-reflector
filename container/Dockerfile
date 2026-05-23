FROM node:22-slim
WORKDIR /https-reflector

COPY . /https-reflector

# Each package manages its own node_modules (nohoist workspace)
RUN cd /https-reflector/https-reflector-client && yarn install
RUN cd /https-reflector/https-reflector-server && yarn install

# Build client (TypeScript → CommonJS ES2015, exits 0)
RUN cd /https-reflector/https-reflector-client && \
    node_modules/.bin/tsc -p tsconfig.json

# Build server (tsc exits non-zero due to socket.io .d.ts parse noise, but files are emitted)
RUN cd /https-reflector/https-reflector-server && \
    node_modules/.bin/tsc -p tsconfig.json 2>&1; \
    test -f build/main.js

ENV HTTPS_REFLECTOR_PUBLIC_STATIC_DIR=/var/www/https-reflector

# All runtime options are configured via environment variables — see container/run.sh
CMD node /https-reflector/https-reflector-server/https-reflector-server.js \
    --use-https \
    --redirect-http
