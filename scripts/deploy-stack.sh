#!/usr/bin/env bash
# Rebuild the instance stack and wait until it is healthy.
#
# Runs ON THE INSTANCE, invoked by .github/workflows/ci.yml (deploy job):
#   ssh … "DEPLOY_DIR=… GIT_SHA=… bash -s" < scripts/deploy-stack.sh
# Expects DEPLOY_DIR (repo checkout already synced via git archive) and
# GIT_SHA in the environment.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/pik-market-watch}"
cd "$DEPLOY_DIR"
echo "▶ Deploying ${GIT_SHA:-unknown} in $(pwd) on $(hostname)"

# One-time setup guard: these two are git-ignored, so the pipeline
# never ships them — they must exist on the instance already.
for f in .env config/searches.json; do
  if [ ! -f "$f" ]; then
    echo "✗ Missing $DEPLOY_DIR/$f on the instance."
    echo "  Fix once over SSH, then re-run this job:"
    echo "    cp .env.example .env                          # set the passwords"
    echo "    cp config/searches.example.json config/searches.json   # add searches"
    exit 1
  fi
done

# Least-privilege DB roles live only on the machines (git-ignored): fail fast
# with fix instructions.
for v in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_READER_PASSWORD POSTGRES_PUBLIC_READER_PASSWORD \
         GRAFANA_ADMIN_PASSWORD GRAFANA_SECRET_KEY; do
  line=$(grep -E "^${v}=" .env | tail -n 1 || true)
  value=${line#*=}
  value=$(printf '%s' "$value" | tr -d '\r')
  case "$value" in
    ""|change-me*)
      echo "✗ $v must be set to a non-example value in $DEPLOY_DIR/.env (see docs/OPERATIONS.md)."
      exit 1
      ;;
  esac
done

# Production Grafana is reachable through Cloudflare Tunnel, which publishes
# HTTPS while forwarding to the private HTTP listener. Keep the container's
# published port private and fail closed if production settings are unsafe.
read_env_value() {
  local name=$1 line
  line=$(grep -E "^${name}=" .env | tail -n 1 || true)
  printf '%s' "${line#*=}" | tr -d '\r'
}

grafana_bind=$(read_env_value GRAFANA_BIND)
grafana_domain=$(read_env_value GRAFANA_DOMAIN)
grafana_root_url=$(read_env_value GRAFANA_ROOT_URL)
grafana_enforce_domain=$(read_env_value GRAFANA_ENFORCE_DOMAIN)
grafana_cookie_secure=$(read_env_value GRAFANA_COOKIE_SECURE)

if [ "$grafana_bind" != "127.0.0.1" ]; then
  echo "✗ GRAFANA_BIND must be 127.0.0.1 in production; port 3000 must stay private."
  exit 1
fi
if ! printf '%s' "$grafana_domain" | grep -Eq '^([A-Za-z0-9]([-A-Za-z0-9]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
  echo "✗ GRAFANA_DOMAIN must be a public DNS hostname in production (for example grafana.example.com)."
  exit 1
fi
case "$grafana_root_url" in
  https://*/)
    root_host=${grafana_root_url#https://}
    root_host=${root_host%%/*}
    if [ "$root_host" != "$grafana_domain" ]; then
      echo "✗ GRAFANA_ROOT_URL host must match GRAFANA_DOMAIN in production."
      exit 1
    fi
    ;;
  *)
    echo "✗ GRAFANA_ROOT_URL must be an HTTPS URL ending in / in production."
    exit 1
    ;;
esac
if [ "$grafana_enforce_domain" != "true" ] || [ "$grafana_cookie_secure" != "true" ]; then
  echo "✗ GRAFANA_ENFORCE_DOMAIN and GRAFANA_COOKIE_SECURE must both be true in production."
  exit 1
fi

# Non-fatal: without it the alert rule still evaluates & shows UI state, but
# mail delivery stays inert on the placeholder recipient.
grep -q '^ALERT_EMAIL_TO=.' .env || \
  echo "⚠ ALERT_EMAIL_TO not set in .env — scrape-silence alert mail is INERT (placeholder recipient)."

# Refresh the prebuilt images (postgres/grafana pins) if the registry
# is reachable; `up` below still works from the local cache otherwise.
docker compose pull db grafana db-backup || echo "⚠ pull failed, using local images"

# Apply schema changes before publishing dashboards. The migrator is a
# profile-only one-shot service, so a failed migration stops this deployment
# before Grafana can observe a partially upgraded contract.
echo "▶ Starting database for ownership checks"
docker compose up -d db
db_deadline=$((SECONDS + 120))
until docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$db_deadline" ]; then
    echo "✗ Database did not become ready within 2 min"
    docker compose logs --tail 80 db
    exit 1
  fi
  sleep 2
done

# Existing volumes may contain functions created by the bootstrap role before
# the app-owned migration gate was introduced. Re-assert ownership before the
# app-role migrator attempts CREATE OR REPLACE FUNCTION.
echo "▶ Ensuring database role ownership"
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

echo "▶ Applying database migrations"
docker compose --profile migrate run --build --rm migrator

# The reporting schema is created by the migrator. Re-run the idempotent role
# helper now so an existing volume receives the public-view allowlist too;
# fresh volumes already execute it after bootstrap SQL.
echo "▶ Applying public reporting grants"
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

echo "▶ docker compose up -d --build (build output below, if any)"
docker compose up -d --build --remove-orphans

# Provisioning files (datasources etc.) are read ONLY at Grafana
# startup, and bind-mount content changes don't trigger container
# recreation when the image tag is unchanged. Restart it so shipped
# provisioning edits always take effect. (Dashboard JSON files also
# hot-reload every 30 s via updateIntervalSeconds.)
echo "▶ Restarting grafana to re-read provisioning files…"
docker compose restart grafana

echo "▶ Waiting for containers to become healthy…"
deadline=$((SECONDS + 360))
while :; do
  db=$(docker inspect -f '{{.State.Health.Status}}' olx-db 2>/dev/null || echo missing)
  gr=$(docker inspect -f '{{.State.Health.Status}}' olx-grafana 2>/dev/null || echo missing)
  bk=$(docker inspect -f '{{.State.Health.Status}}' olx-db-backup 2>/dev/null || echo missing)
  echo "   db=$db  grafana=$gr  db-backup=$bk  (t=${SECONDS}s)"
  if [ "$db" = healthy ] && [ "$gr" = healthy ]; then
    echo "✓ Stack healthy — deployed ${GIT_SHA:-unknown} to the instance"
    echo "  Grafana: ${grafana_root_url} (public HTTPS is terminated by Cloudflare)"
    # The scraper moved to the home machine (compose profile "scrape").
    # --remove-orphans already deleted its container; drop its image too.
    docker images --format '{{.Repository}}:{{.Tag}}' \
      | grep -E '(pik-market-watch|olx-price-ext)-scraper' \
      | xargs -r docker rmi -f || true
    docker image prune -f >/dev/null
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "✗ Health check timed out after 6 min — recent state:"
    docker compose ps -a
    docker compose logs --tail 80 db grafana
    exit 1
  fi
  sleep 10
done
