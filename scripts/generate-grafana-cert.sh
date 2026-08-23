#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Self-signed TLS certificate for Grafana's native HTTPS listener.
#
#   bash scripts/generate-grafana-cert.sh [extra SANs...]
#     e.g.  bash scripts/generate-grafana-cert.sh 203.0.113.10 grafana.example.com
#           args containing ':' become IP: SANs (IPv6), digit-only args become
#           IPv4 SANs, anything else a DNS: SAN.
#
# Writes git-ignored tls/grafana.crt + tls/grafana.key (10 years, EC P-256).
# docker-compose.yml mounts ./tls into the grafana container (/certs, ro).
# Browsers distrust self-signed certs: compare the SHA-256 fingerprint printed
# below with what the browser shows on first visit, or import tls/grafana.crt
# into your OS trust store to silence the warning.
# Re-run any time (new key, extra SANs, nearing expiry), then:
#   docker compose up -d --force-recreate grafana
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
# Stop MSYS/Git-Bash from rewriting /CN=... args into Windows paths:
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/.."          # repo root

OUT_DIR=tls
CRT="$OUT_DIR/grafana.crt"
KEY="$OUT_DIR/grafana.key"
DAYS=3650

command -v openssl >/dev/null 2>&1 || {
  echo "error: openssl not found — Windows: it ships with Git for Windows (Git Bash)" >&2
  exit 1
}

sans="DNS:localhost,IP:127.0.0.1,IP:::1"
for arg in "$@"; do
  case $arg in
    *:*)          sans="$sans,IP:$arg" ;;   # contains a colon → IPv6 address
    *[!0-9.]* )   sans="$sans,DNS:$arg" ;;  # hostname / domain
    * )           sans="$sans,IP:$arg" ;;   # digits + dots → IPv4
  esac
done

mkdir -p "$OUT_DIR"
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes \
  -keyout "$KEY" -out "$CRT" -days "$DAYS" \
  -subj "/CN=pik-market-watch grafana" \
  -addext "subjectAltName=$sans" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "basicConstraints=critical,CA:FALSE"

chmod 600 "$KEY"
chmod 644 "$CRT"


echo
echo "wrote $CRT and $KEY (valid $DAYS days)"
openssl x509 -in "$CRT" -noout -subject -dates -ext subjectAltName
echo
openssl x509 -in "$CRT" -noout -fingerprint -sha256
echo "↑ self-signed: browsers warn until trusted — verify this fingerprint on first visit."
echo "restart grafana:  docker compose up -d --force-recreate grafana"