#!/usr/bin/env bash
set -euo pipefail

superset db upgrade

# Create the admin idempotently without exposing its password.
if [ ! -f /app/superset_home/.prototype-admin-created ]; then
  superset fab create-admin \
    --username admin \
    --firstname Market \
    --lastname Admin \
    --email admin@localhost \
    --password "$SUPERSET_ADMIN_PASSWORD"
  touch /app/superset_home/.prototype-admin-created
fi

superset init
