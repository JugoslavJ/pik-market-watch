#!/usr/bin/env bash
# Migrate the existing PostgreSQL 16 Compose volume to PostgreSQL 18.
#
# The old volume is never modified or removed. A custom-format dump is taken
# from a temporary PostgreSQL 16 container, restored into a new PostgreSQL 18
# volume, checked, and then Compose is started against the new volume.
set -Eeuo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

SOURCE_VOLUME=${SOURCE_VOLUME:-olx-price-ext_pgdata}
TARGET_VOLUME=${TARGET_VOLUME:-}
SOURCE_IMAGE=${SOURCE_IMAGE:-ghcr.io/baosystems/postgis:16-3.5@sha256:0f1c5c0f70f03d4d19ad1d7308d86e6162dff5429c491002298a7b5e46d2f2e8}
TARGET_IMAGE=${TARGET_IMAGE:-ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8}
SOURCE_CONTAINER=${SOURCE_CONTAINER:-olx-pg16-migration-source}
TARGET_CONTAINER=${TARGET_CONTAINER:-olx-pg18-migration-target}

usage() {
  cat <<'EOF'
Usage: db/migrate-pg16-to-pg18.sh --yes

Required: --yes acknowledges the maintenance window and starts/stops the
Compose stack. The PostgreSQL 16 volume is retained; the PostgreSQL 18 target
volume is named olx-price-ext_pgdata_pg18 by default.

Overrides: SOURCE_VOLUME, TARGET_VOLUME, SOURCE_IMAGE, TARGET_IMAGE,
SOURCE_CONTAINER, TARGET_CONTAINER, MIGRATION_DUMP.
EOF
}

if [[ "${1:-}" != "--yes" ]]; then
  usage >&2
  exit 2
fi

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
[[ -f .env ]] || { echo ".env is required" >&2; exit 1; }

# Deployment secrets are URL-safe by project convention. Avoid printing them.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

TARGET_VOLUME=${TARGET_VOLUME:-${POSTGRES_VOLUME_NAME:-olx-price-ext_pgdata_pg18}}

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is missing from .env}"
: "${POSTGRES_MIGRATOR_PASSWORD:?POSTGRES_MIGRATOR_PASSWORD is missing from .env}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is missing from .env}"
: "${POSTGRES_REPORTING_PASSWORD:?POSTGRES_REPORTING_PASSWORD is missing from .env}"
: "${POSTGRES_BACKUP_PASSWORD:?POSTGRES_BACKUP_PASSWORD is missing from .env}"

POSTGRES_USER=${POSTGRES_USER:-olx}
POSTGRES_DB=${POSTGRES_DB:-olx}
POSTGRES_MIGRATOR_USER=${POSTGRES_MIGRATOR_USER:-olx_migrator}
POSTGRES_APP_USER=${POSTGRES_APP_USER:-olx_app}
POSTGRES_REPORTING_USER=${POSTGRES_REPORTING_USER:-olx_reporting}
POSTGRES_BACKUP_USER=${POSTGRES_BACKUP_USER:-olx_backup}
compose_project=${COMPOSE_PROJECT_NAME:-$(basename -- "$ROOT_DIR")}
STAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP_FILE=${MIGRATION_DUMP:-$ROOT_DIR/backups/pg16-to-pg18-$STAMP.dump}
PARTIAL_DUMP="$DUMP_FILE.partial"
TARGET_CREATED=0

cleanup() {
  docker rm -f "$SOURCE_CONTAINER" "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  if [[ "$TARGET_CREATED" == 1 && "${KEEP_TARGET_ON_FAILURE:-0}" != 1 && "${migration_ok:-0}" != 1 ]]; then
    docker volume rm "$TARGET_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -f "$PARTIAL_DUMP"
}
trap cleanup EXIT

if docker volume inspect "$SOURCE_VOLUME" >/dev/null 2>&1; then :; else
  echo "source volume does not exist: $SOURCE_VOLUME" >&2
  exit 1
fi
if docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1; then
  echo "refusing to overwrite existing target volume: $TARGET_VOLUME" >&2
  echo "Set TARGET_VOLUME to a new empty volume name, or remove it only after verifying it is disposable." >&2
  exit 1
fi
if [[ -e "$DUMP_FILE" ]]; then
  echo "refusing to overwrite existing dump: $DUMP_FILE" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$DUMP_FILE")"

wait_for_postgres() {
  local container=$1
  for _ in {1..90}; do
    if docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true && \
       docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$container" \
         psql -Atqc "SELECT 1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      # PostgreSQL 18's entrypoint briefly exposes a temporary server while
      # initializing a new volume. Require a second probe after the shutdown
      # window before treating the final server as ready.
      sleep 3
      if docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$container" \
        psql -Atqc "SELECT 1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done
  docker logs "$container" >&2 || true
  echo "PostgreSQL container did not become stable: $container" >&2
  return 1
}

target_psql() {
  for _ in {1..90}; do
    if docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$TARGET_CONTAINER" \
      psql "$@"; then
      return 0
    fi
    sleep 2
  done
  docker logs "$TARGET_CONTAINER" >&2 || true
  echo "PostgreSQL 18 target rejected SQL for too long" >&2
  return 1
}

echo "Stopping Compose services for a consistent snapshot"
docker compose --profile scrape --profile migrate --profile maintenance stop >/dev/null 2>&1 || true
old_db_container="${compose_project}-db-1"
if docker inspect "$old_db_container" >/dev/null 2>&1; then
  docker stop "$old_db_container" >/dev/null
fi

echo "Starting the PostgreSQL 16 source container"
docker run -d --name "$SOURCE_CONTAINER" \
  -e "POSTGRES_USER=$POSTGRES_USER" \
  -e "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  -e "POSTGRES_DB=$POSTGRES_DB" \
  -v "$SOURCE_VOLUME:/var/lib/postgresql/data" \
  "$SOURCE_IMAGE" postgres >/dev/null

wait_for_postgres "$SOURCE_CONTAINER"
SOURCE_MAJOR=$(docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$SOURCE_CONTAINER" \
  psql -Atqc "SELECT split_part(current_setting('server_version'), '.', 1)" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")
[[ "$SOURCE_MAJOR" == 16 ]] || { echo "expected PostgreSQL 16, got $SOURCE_MAJOR" >&2; exit 1; }

echo "Dumping PostgreSQL 16 to $DUMP_FILE"
docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$SOURCE_CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$PARTIAL_DUMP"
docker run --rm -i --entrypoint pg_restore "$SOURCE_IMAGE" -l < "$PARTIAL_DUMP" >/dev/null
mv -- "$PARTIAL_DUMP" "$DUMP_FILE"
docker rm -f "$SOURCE_CONTAINER" >/dev/null

echo "Creating and starting the PostgreSQL 18 target container"
docker volume create "$TARGET_VOLUME" >/dev/null
TARGET_CREATED=1
docker run -d --name "$TARGET_CONTAINER" \
  -e "POSTGRES_USER=$POSTGRES_USER" \
  -e "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  -e "POSTGRES_DB=$POSTGRES_DB" \
  -e "POSTGRES_MIGRATOR_USER=$POSTGRES_MIGRATOR_USER" \
  -e "POSTGRES_MIGRATOR_PASSWORD=$POSTGRES_MIGRATOR_PASSWORD" \
  -e "POSTGRES_APP_USER=$POSTGRES_APP_USER" \
  -e "POSTGRES_APP_PASSWORD=$POSTGRES_APP_PASSWORD" \
  -e "POSTGRES_REPORTING_USER=$POSTGRES_REPORTING_USER" \
  -e "POSTGRES_REPORTING_PASSWORD=$POSTGRES_REPORTING_PASSWORD" \
  -e "POSTGRES_BACKUP_USER=$POSTGRES_BACKUP_USER" \
  -e "POSTGRES_BACKUP_PASSWORD=$POSTGRES_BACKUP_PASSWORD" \
  -v "$TARGET_VOLUME:/var/lib/postgresql" \
  "$TARGET_IMAGE" postgres \
  -c shared_preload_libraries=pg_stat_statements \
  -c track_io_timing=on >/dev/null

wait_for_postgres "$TARGET_CONTAINER"

echo "Creating application roles before restore"
docker cp "$ROOT_DIR/db/init/zz-database-roles.sh" "$TARGET_CONTAINER:/tmp/zz-database-roles.sh"
target_psql \
  -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE SCHEMA IF NOT EXISTS olap; CREATE SCHEMA IF NOT EXISTS reporting;"
sleep 20
MSYS_NO_PATHCONV=1 docker exec "$TARGET_CONTAINER" bash /tmp/zz-database-roles.sh >/dev/null
target_psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "DROP SCHEMA reporting CASCADE; DROP SCHEMA olap CASCADE;"

echo "Restoring the PostgreSQL 16 dump into PostgreSQL 18"
docker cp "$DUMP_FILE" "$TARGET_CONTAINER:/tmp/pg16-to-pg18.dump"
target_psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "DROP EXTENSION IF EXISTS postgis CASCADE; DROP EXTENSION IF EXISTS fuzzystrmatch CASCADE; DROP EXTENSION IF EXISTS pg_stat_statements CASCADE;"
MSYS_NO_PATHCONV=1 docker exec -e "PGPASSWORD=$POSTGRES_PASSWORD" "$TARGET_CONTAINER" \
  pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/pg16-to-pg18.dump

echo "Repairing ownership and grants"
MSYS_NO_PATHCONV=1 docker exec "$TARGET_CONTAINER" bash /tmp/zz-database-roles.sh >/dev/null

TARGET_MAJOR=$(target_psql -Atqc "SELECT split_part(current_setting('server_version'), '.', 1)" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")
[[ "$TARGET_MAJOR" == 18 ]] || { echo "expected PostgreSQL 18, got $TARGET_MAJOR" >&2; exit 1; }
target_psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT (SELECT count(*) FROM public.listings) AS listings, (SELECT count(*) FROM schema_migrations) AS migrations;"

echo "PostgreSQL 18 restore validated; starting Compose against $TARGET_VOLUME"
docker rm -f "$TARGET_CONTAINER" >/dev/null
# The old Compose db container still owns the service name even after stop.
# Removing the container does not remove its named PostgreSQL 16 volume.
old_db_container="${compose_project}-db-1"
if docker inspect "$old_db_container" >/dev/null 2>&1; then
  docker rm -f "$old_db_container" >/dev/null
fi
docker compose up -d db
docker compose --profile migrate run --build --rm migrator
MSYS_NO_PATHCONV=1 docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh >/dev/null
docker compose up -d --build --remove-orphans

migration_ok=1
echo "Migration complete. PostgreSQL 16 volume retained as $SOURCE_VOLUME."
echo "Verified dump retained at $DUMP_FILE."
