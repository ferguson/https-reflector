#!/bin/bash

# ── Configuration ────────────────────────────────────────────────────────────
HOSTNAME="*.otto.stream,*.mitlivinglabs.org"
CERT_BASE="/etc/letsencrypt/live/otto.stream"
DATA_DIR="/var/lib/https-reflector"
PUBLIC_DIR="/var/www/otto.stream"   # mounted at /var/www/public inside the container
STATUS_PASSWORD=""                  # leave blank for no password
# ─────────────────────────────────────────────────────────────────────────────

docker stop https-reflector 2>/dev/null
sleep 1
docker rm https-reflector 2>/dev/null

ARGS=(
    --name https-reflector
    -d
    --restart=unless-stopped
    -p 443:443
    -p 80:80
    -v /etc/letsencrypt:/etc/letsencrypt:ro
    -v "$DATA_DIR":/data
    -v "$PUBLIC_DIR":/var/www/public:ro
    -e HTTPS_REFLECTOR_HOSTNAME="$HOSTNAME"
    -e HTTPS_REFLECTOR_PUBLIC_STATIC_DIR=/var/www/public
    -e HTTPS_REFLECTOR_DATA_DIR=/data
    -e HTTPS_REFLECTOR_PRIVATE_KEY_FILE="$CERT_BASE/privkey.pem"
    -e HTTPS_REFLECTOR_CERTIFICATE_FILE="$CERT_BASE/cert.pem"
    -e HTTPS_REFLECTOR_AUTHORITY_FILE="$CERT_BASE/chain.pem"
)

if [ -n "$STATUS_PASSWORD" ]; then
    ARGS+=(-e HTTPS_REFLECTOR_STATUS_PASSWORD="$STATUS_PASSWORD")
fi

if docker run "${ARGS[@]}" https-reflector; then
    echo "https-reflector started"
else
    echo "error: docker run failed" >&2
    exit 1
fi
