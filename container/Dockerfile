FROM node:22-slim
WORKDIR /https-reflector

COPY . /https-reflector

# Each package manages its own node_modules (nohoist workspace)
RUN cd /https-reflector/https-reflector-client && yarn install
RUN cd /https-reflector/https-reflector-server && yarn install

# Both packages: tsc exits non-zero due to socket.io .d.ts parse errors in TypeScript 2.9.2,
# but output files are still emitted. Use ; (not &&) to ignore exit code, then verify output.
RUN cd /https-reflector/https-reflector-client && \
    node_modules/.bin/tsc -p tsconfig.json 2>&1; \
    test -f build/API.js

RUN cd /https-reflector/https-reflector-server && \
    node_modules/.bin/tsc -p tsconfig.json 2>&1; \
    test -f build/main.js

# All runtime options are configured via environment variables — see container/run.sh
CMD node /https-reflector/https-reflector-server/https-reflector-server.js \
    --use-https \
    --redirect-http
