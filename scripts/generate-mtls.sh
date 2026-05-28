#!/usr/bin/env bash
# Generate throwaway mTLS PKI for the guest agent + host client and stage
# them under artifacts/secrets/crucible-win11/mtls/.
set -euo pipefail

VM_NAME="${VM_NAME:-crucible-win11}"
OUT_DIR="artifacts/secrets/${VM_NAME}/mtls"
GUEST_HOST="${GUEST_HOST:-192.0.2.2}"
mkdir -p "${OUT_DIR}"

cd "${OUT_DIR}"

# CA
if [ ! -f ca.key.pem ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key.pem 2>/dev/null
  openssl req -new -x509 -days 365 -subj "/CN=crucible-${VM_NAME}-ca" -key ca.key.pem -out ca.cert.pem 2>/dev/null
fi

# Server cert
if [ ! -f guest-server.cert.pem ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out guest-server.key.pem 2>/dev/null
  openssl req -new -subj "/CN=${GUEST_HOST}" -key guest-server.key.pem -out guest-server.csr 2>/dev/null
  cat > guest-server.ext <<EOF
subjectAltName=DNS:localhost,IP:${GUEST_HOST},IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
  openssl x509 -req -in guest-server.csr -CA ca.cert.pem -CAkey ca.key.pem -CAcreateserial \
    -days 365 -extfile guest-server.ext -out guest-server.cert.pem 2>/dev/null
fi

# Host client cert
if [ ! -f host-client.cert.pem ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out host-client.key.pem 2>/dev/null
  openssl req -new -subj "/CN=crucible-host-client" -key host-client.key.pem -out host-client.csr 2>/dev/null
  cat > host-client.ext <<EOF
extendedKeyUsage=clientAuth
EOF
  openssl x509 -req -in host-client.csr -CA ca.cert.pem -CAkey ca.key.pem -CAcreateserial \
    -days 365 -extfile host-client.ext -out host-client.cert.pem 2>/dev/null
fi

chmod 600 *.key.pem
echo "mTLS material in ${OUT_DIR}:"
ls -lh
