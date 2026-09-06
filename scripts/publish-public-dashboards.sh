#!/usr/bin/env bash
# Idempotently register the four Git-provisioned public dashboards.
# Run this as the Grafana owner after the migrator and Grafana restart. The
# access tokens are intentionally stable so ordinary deployments do not change
# public links. Revoke a share in Grafana (or with DELETE) before rollback.
set -euo pipefail

: "${GRAFANA_URL:?set GRAFANA_URL, for example https://grafana.example.com}"
: "${GRAFANA_ADMIN_USER:?set GRAFANA_ADMIN_USER}"
: "${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}"

dashboards=(
  "olx-public-home:1a2b3c4d5e6f708192a3b4c5d6e7f801"
  "olx-public-apartments-sale:4d5e6f708192a3b4c5d6e7f80192a3b"
  "olx-public-apartments-rent:2b3c4d5e6f708192a3b4c5d6e7f80192"
  "olx-public-exits:3c4d5e6f708192a3b4c5d6e7f80192a3"
)

for entry in "${dashboards[@]}"; do
  uid=${entry%%:*}
  token=${entry#*:}
  endpoint="${GRAFANA_URL%/}/api/dashboards/uid/${uid}/public-dashboards/"
  if curl --fail --silent --show-error \
      --user "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
      "$endpoint" >/dev/null 2>&1; then
    echo "✓ ${uid} already has a shared dashboard"
    continue
  fi
  curl --fail --silent --show-error \
    --user "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
    --header 'Content-Type: application/json' \
    --data "{\"accessToken\":\"${token}\",\"timeSelectionEnabled\":false,\"isEnabled\":true,\"annotationsEnabled\":false,\"share\":\"public\"}" \
    "$endpoint" >/dev/null
  echo "✓ published ${uid}: ${GRAFANA_URL%/}/public-dashboards/${token}"
done
