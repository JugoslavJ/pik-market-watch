#!/usr/bin/env bash
# Run on the dashboard host. No public route changes are made here.
set -euo pipefail
cd "${DEPLOY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
. scripts/lib/superset-stack.sh
configure_superset_stack
case "${1:-}" in ''|--snapshot) ;; *) echo "Usage: superset-readiness.sh [--snapshot]" >&2; exit 2 ;; esac
docker compose run --rm --no-deps --entrypoint python superset-seed /app/validate_viewer.py
docker compose run --rm --no-deps --entrypoint python superset-seed /app/benchmark_viewer.py
# validate_access.py prepares viewer and guest access before checking it.
docker compose run --rm --no-deps --entrypoint python superset-access /app/validate_access.py
if [ "${1:-}" = --snapshot ]; then
  docker compose run --rm --no-deps db-backup --once
else
  docker compose exec -T db-backup sh /usr/local/bin/backup.sh --check
fi
echo "React viewer data, API performance, scoped access, and backup gates passed."
echo "Complete HTTPS/browser and notification checks in docs/DEPLOYMENT.md."
