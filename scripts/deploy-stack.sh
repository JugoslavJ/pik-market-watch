#!/usr/bin/env bash
# Run on the instance after syncing the checkout; accepts DEPLOY_DIR and GIT_SHA.
set -euo pipefail

# Read from a pipe (`bash -s`), any command that reads stdin swallows the rest
# of this script and the deploy silently stops early with status 0.
if [ ! -f "${BASH_SOURCE[0]:-}" ]; then
  echo "✗ Run deploy-stack.sh as a file, not through bash -s." >&2
  exit 2
fi
exec </dev/null

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/pik-market-watch}"
cd "$DEPLOY_DIR"
echo "▶ Deploying ${GIT_SHA:-unknown} in $(pwd) on $(hostname)"

# Ignored configuration must already exist on the instance.
for f in .env config/searches.json; do
  if [ ! -f "$f" ]; then
    echo "✗ Missing $DEPLOY_DIR/$f on the instance."
    echo "  Fix once over SSH, then re-run this job:"
    echo "    cp .env.example .env                          # set the passwords"
    echo "    cp config/searches.example.json config/searches.json   # add searches"
    exit 1
  fi
done

. scripts/lib/superset-stack.sh
configure_superset_stack
case "${1:-}" in ''|--check) ;; *) echo "Usage: deploy-stack.sh [--check]" >&2; exit 2 ;; esac

require_secret() {
  local value
  value=$(read_env_value "$1")
  case "$value" in ''|change-me*) echo "✗ $1 must be configured (see docs/CONFIGURATION.md)." >&2; exit 1 ;; esac
}
for v in POSTGRES_PASSWORD POSTGRES_MIGRATOR_PASSWORD POSTGRES_APP_PASSWORD \
         POSTGRES_REPORTING_PASSWORD POSTGRES_BACKUP_PASSWORD \
         SUPERSET_META_PASSWORD SUPERSET_ADMIN_PASSWORD SUPERSET_SECRET_KEY; do
  require_secret "$v"
done

domain=$(read_env_value SUPERSET_DOMAIN)
url=$(read_env_value SUPERSET_ROOT_URL)
if [ "$(read_env_value SUPERSET_BIND)" != 127.0.0.1 ]; then
  echo "✗ SUPERSET_BIND must be 127.0.0.1 in production." >&2; exit 1
fi
if ! printf '%s' "$domain" | grep -Eq '^([A-Za-z0-9]([-A-Za-z0-9]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
  echo "✗ SUPERSET_DOMAIN must be a public DNS hostname." >&2; exit 1
fi
if [ "$url" != "https://$domain/" ]; then
  echo "✗ SUPERSET_ROOT_URL must be https://SUPERSET_DOMAIN/." >&2; exit 1
fi
if [ "$(read_env_value SUPERSET_COOKIE_SECURE)" != true ]; then
  echo "✗ SUPERSET_COOKIE_SECURE must be true in production." >&2; exit 1
fi
docker compose config --quiet
if [ "${1:-}" = --check ]; then
  echo "✓ Production preflight passed; no services changed."
  exit 0
fi

# The database image is digest-pinned, so `up` pulls it only when missing.
echo "▶ Starting database for ownership checks"
docker compose up -d db

# Build each image once (in parallel); later steps reuse them. Superset
# services share one image, so building `superset` covers all of them.
echo "▶ Building scraper and Superset images"
docker compose --profile migrate build migrator superset

db_deadline=$((SECONDS + 120))
until docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$db_deadline" ]; then
    echo "✗ Database did not become ready within 2 min"
    docker compose logs --tail 80 db
    exit 1
  fi
  sleep 2
done

# Repair legacy object ownership before running migrations.
echo "▶ Ensuring database role ownership"
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

echo "▶ Applying database migrations"
docker compose --profile migrate run --rm migrator

# Apply grants for objects added by migrations.
echo "▶ Applying database role grants"
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

echo "▶ Upgrading Superset metadata and syncing security permissions"
docker compose run --rm superset-init

# Superset services depend on superset-init, and Compose reruns that
# dependency (db upgrade + init, minutes each) for every `up` or `run`
# that resolves dependencies. It has just run, so skip it from here on.
services=(db db-backup superset superset-alert-check)
echo "▶ Starting Superset dashboard stack"
docker compose up -d --no-deps "${services[@]}"

deadline=$((SECONDS + 360))
while :; do
  healthy=true
  for service in "${services[@]}"; do
    status=$(health_status "$service")
    echo "   $service=$status"
    [ "$status" = healthy ] || healthy=false
  done
  [ "$healthy" != true ] || break
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker compose ps -a
    docker compose logs --tail 80 "${services[@]}"
    echo "✗ Stack did not become healthy within six minutes" >&2
    exit 1
  fi
  sleep 10
done

echo "▶ Taking and verifying a fresh database and application-state backup"
docker compose run --rm --no-deps db-backup --once

# validate_access.py in the readiness gate prepares the viewer roles before checking them.
bash scripts/superset-readiness.sh
echo "✓ Stack healthy — deployed ${GIT_SHA:-unknown} (Superset)."
echo "  React dashboards use the Cloudflare Tunnel origin at 127.0.0.1:3000."
