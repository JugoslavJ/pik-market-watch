#!/usr/bin/env bash
# Run on the dashboard host. No public route changes are made here.
set -euo pipefail
cd "${DEPLOY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
. scripts/lib/dashboard-stack.sh
configure_dashboard_stack
if [ "$HAS_SUPERSET" != true ]; then
  echo "Readiness checks require DASHBOARD_MODE=superset" >&2
  exit 1
fi
case "${1:-}" in ''|--snapshot) ;; *) echo "Usage: superset-readiness.sh [--snapshot]" >&2; exit 2 ;; esac
docker compose run --rm --no-deps --entrypoint python superset-seed /app/validate_viewer.py
docker compose run --rm --no-deps --entrypoint python superset-seed /app/benchmark_viewer.py
docker compose run --rm --no-deps superset-access
docker compose run --rm --no-deps --entrypoint python superset-access /app/validate_access.py
if [ "${1:-}" = --snapshot ]; then
  docker compose run --rm --no-deps db-backup --once
else
  docker compose exec -T db-backup sh /usr/local/bin/backup.sh --check
fi
echo "React viewer data, API performance, scoped access, and backup gates passed."
echo "Complete HTTPS/browser and notification checks in docs/SUPERSET_CUTOVER.md."
