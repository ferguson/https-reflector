#!/bin/bash

# ── Configuration ────────────────────────────────────────────────────────────
HOSTNAME="*.otto.stream,*.mitlivinglabs.org"
CERT_BASE="/etc/letsencrypt/live/otto.stream"
STATIC_DIR="/var/www/https-reflector"
DATA_DIR="/var/lib/https-reflector"
STATUS_PASSWORD=""   # leave blank for no password
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
    -v "$STATIC_DIR":/var/www/https-reflector
    -v "$DATA_DIR":/data
    -e HTTPS_REFLECTOR_HOSTNAME="$HOSTNAME"
    -e HTTPS_REFLECTOR_DATA_DIR=/data
    -e HTTPS_REFLECTOR_PRIVATE_KEY_FILE="$CERT_BASE/privkey.pem"
    -e HTTPS_REFLECTOR_CERTIFICATE_FILE="$CERT_BASE/cert.pem"
    -e HTTPS_REFLECTOR_AUTHORITY_FILE="$CERT_BASE/chain.pem"
)

if [ -n "$STATUS_PASSWORD" ]; then
    ARGS+=(-e HTTPS_REFLECTOR_STATUS_PASSWORD="$STATUS_PASSWORD")
fi

docker run "${ARGS[@]}" https-reflector

echo "https-reflector started"
