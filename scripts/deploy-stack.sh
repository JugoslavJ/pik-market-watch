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

# Least-privilege DB roles + Grafana TLS material live only on the
# machines (git-ignored): fail fast with fix instructions.
for v in POSTGRES_APP_PASSWORD POSTGRES_READER_PASSWORD GRAFANA_SECRET_KEY; do
  grep -q "^$v=." .env || {
    echo "✗ Missing $v in $DEPLOY_DIR/.env (see docs/OPERATIONS.md §Database roles / §Exposing Grafana)."
    exit 1
  }
done
if [ ! -f tls/grafana.crt ] || [ ! -f tls/grafana.key ]; then
  echo "✗ Missing tls/grafana.crt|key on the instance (Grafana native TLS)."
  echo "  Fix once over SSH, then re-run this job:"
  echo "    mkdir -p tls && bash scripts/generate-grafana-cert.sh <instance-ip>"
  exit 1
fi

# Refresh the prebuilt images (postgres/grafana pins) if the registry
# is reachable; `up` below still works from the local cache otherwise.
docker compose pull db grafana db-backup || echo "⚠ pull failed, using local images"

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
  gr=$(docker inspect -f '{{.State.Status}}' olx-grafana 2>/dev/null || echo missing)
  echo "   db=$db  grafana=$gr  (t=${SECONDS}s)"
  if [ "$db" = healthy ] && [ "$gr" = running ]; then
    echo "✓ Stack healthy — deployed ${GIT_SHA:-unknown} to the instance"
    echo "  Grafana: https://${OCI_HOST:-<instance-ip>}:3000 (self-signed cert — expect a browser warning)"
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