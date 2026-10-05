#!/bin/sh
# Forced-command SSH endpoint: receive a custom-format dump on stdin and restore olx.
# Validate the archive and ownership before replacing schemas; retain a rollback snapshot.
set -eu
umask 077

REPO_DIR="${OLX_REPO_DIR:-$HOME/pik-market-watch}"
BACKUP_DIR="$REPO_DIR/backups"
MIN_BYTES=20000
MAX_BYTES="${OLX_SYNC_MAX_BYTES:-536870912}"
case "$MAX_BYTES" in
  ''|*[!0-9]*)
    echo "RESTORE_ERROR: OLX_SYNC_MAX_BYTES must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "$MAX_BYTES" -le 0 ]; then
  echo "RESTORE_ERROR: OLX_SYNC_MAX_BYTES must be greater than zero" >&2
  exit 1
fi
# The migrator role must own restored objects.
migrator_user="$(sed -n 's/^POSTGRES_MIGRATOR_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
migrator_user="${migrator_user:-olx_migrator}"
app_user="$(sed -n 's/^POSTGRES_APP_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
app_user="${app_user:-olx_app}"
reporting_user="$(sed -n 's/^POSTGRES_REPORTING_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
reporting_user="${reporting_user:-olx_reporting}"
# Reset public as the bootstrap superuser; runtime roles do not own it.
boot_user="$(sed -n 's/^POSTGRES_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
boot_user="${boot_user:-olx}"
db_name="$(sed -n 's/^POSTGRES_DB=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
db_name="${db_name:-olx}"

validate_identifier() {
  name="$1"
  value="$2"
  case "$value" in
    ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*)
      echo "RESTORE_ERROR: $name is not a safe PostgreSQL identifier" >&2
      exit 1
      ;;
  esac
  if [ "${#value}" -gt 63 ]; then
    echo "RESTORE_ERROR: $name exceeds PostgreSQL's 63-character identifier limit" >&2
    exit 1
  fi
}
validate_identifier POSTGRES_MIGRATOR_USER "$migrator_user"
validate_identifier POSTGRES_APP_USER "$app_user"
validate_identifier POSTGRES_REPORTING_USER "$reporting_user"
validate_identifier POSTGRES_USER "$boot_user"
validate_identifier POSTGRES_DB "$db_name"

was_running=0   # EXIT trap restarts the scraper if we stop it and then fail
restore_ok=0

cd "$REPO_DIR"
. scripts/lib/superset-stack.sh
configure_superset_stack

# This is instance-controlled configuration, never an argument from the sender.
# Routine data restores do not change Superset metadata or viewer permissions.
provision_dashboards=$(read_env_value OLX_SYNC_PROVISION_DASHBOARDS)
provision_dashboards=${provision_dashboards:-0}
case "$provision_dashboards" in
  0|1) ;;
  *) echo "RESTORE_ERROR: OLX_SYNC_PROVISION_DASHBOARDS must be 0 or 1" >&2; exit 1 ;;
esac
phase_started=$(date +%s)
finish_phase() {
  phase_finished=$(date +%s)
  echo "RESTORE_STAGE $1 $((phase_finished - phase_started))s"
  phase_started=$phase_finished
}

LOCK=/tmp/olx-restore.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "RESTORE_ERROR: another restore is already in progress" >&2
  exit 1
fi
on_exit() {
  rmdir "$LOCK" 2>/dev/null || :
  rm -f "$incoming" "$incoming_partial"
  if [ "$was_running" = "1" ] && [ "$restore_ok" != "1" ]; then
    docker compose start scraper >/dev/null 2>&1 || :
    echo "RESTORE_ERROR: aborted after stopping the scraper - restarted it" >&2
  fi
}
trap on_exit EXIT
incoming="$BACKUP_DIR/olx-sync-incoming.dump"
incoming_partial="$incoming.partial"
rm -f "$incoming" "$incoming_partial"
# Read only one byte beyond the configured limit so an untrusted sender cannot
# fill the restore disk with an arbitrarily large stream.
head -c "$((MAX_BYTES + 1))" > "$incoming_partial" || :

size=$(stat -c %s "$incoming_partial")
if [ "$size" -gt "$MAX_BYTES" ]; then
  echo "RESTORE_ERROR: archive exceeds maximum size ($MAX_BYTES bytes)" >&2
  exit 1
fi
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "RESTORE_ERROR: archive too small ($size bytes) - transfer truncated?" >&2
  exit 1
fi
mv -f "$incoming_partial" "$incoming"
finish_phase receive

if ! docker compose exec -T db pg_restore -l /backups/olx-sync-incoming.dump >/dev/null 2>&1; then
  echo "RESTORE_ERROR: archive failed pg_restore integrity check" >&2
  exit 1
fi
if ! docker compose exec -T db sh -c 'pg_restore -l /backups/olx-sync-incoming.dump | grep -Eq "TABLE DATA lean listings"'; then
  echo "RESTORE_ERROR: archive is missing listings data" >&2
  exit 1
fi

# Repair legacy ownership before the audit and schema reset.
if ! docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh; then
  echo "RESTORE_ERROR: could not ensure database roles and ownership" >&2
  exit 1
fi

# Audit application ownership before dropping schemas.
# Bootstrap and role repair handle schema, extension and ACL entries separately.
drifted=$(docker compose exec -T db sh -c "
    pg_restore -l '/backups/olx-sync-incoming.dump' |
    grep -v '^;' | grep -v 'DEFAULT ACL' |
    grep -v ' EXTENSION - ' | grep -v ' COMMENT - EXTENSION ' |
    grep -vE ' SCHEMA - (lean|public|tiger|topology) ' |
    grep -vE ' (COMMENT|ACL) - SCHEMA ' |
    awk '\$NF != \"$migrator_user\" {print \$NF}' | sort -u")
if [ -n "$drifted" ]; then
  echo "RESTORE_ERROR: archive contains objects not owned by $migrator_user:" >&2
  printf '%s\n' "$drifted" | sed 's/^/RESTORE_ERROR:   /' >&2
  echo "RESTORE_ERROR: fix the source machine, then re-run the sync:" >&2
  echo "RESTORE_ERROR:   docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh" >&2
  exit 1
fi

# Keep three snapshots; the second-newest is the rollback state.
stamp=$(date +%Y%m%d-%H%M%S)
cp "$incoming" "$BACKUP_DIR/olx-sync-$stamp.dump"
ls -1t "$BACKUP_DIR"/olx-sync-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f
prev=$(ls -1t "$BACKUP_DIR"/olx-sync-*.dump 2>/dev/null | grep -v 'olx-sync-incoming' | sed -n 2p || :)

if docker compose ps --status running scraper 2>/dev/null | grep -q scraper; then
  was_running=1
  docker compose stop scraper
fi

# Archive paths use the container /backups mount. Role repair reapplies omitted ACLs.
build_toc() {
  docker compose exec -T db sh -c "
     pg_restore -l '$1' > /tmp/toc.all || exit 1
    grep 'DEFAULT ACL' /tmp/toc.all | grep -Ev \" ${migrator_user}\\$\" > /tmp/toc.drop || :
     if [ -s /tmp/toc.drop ]; then
       grep -vxFf /tmp/toc.drop /tmp/toc.all > '$2' || :
     else
       # BusyBox grep rejects all rows with an empty pattern file; skip that filter.
       cp /tmp/toc.all '$2'
     fi
     # Bootstrap installs extensions; omit their metadata and spatial_ref_sys.
     grep -ve ' ACL ' -e ' EXTENSION - ' -e ' COMMENT - EXTENSION ' \
          -e 'spatial_ref_sys' \
          '$2' > '$2'.extensions || :
     mv '$2'.extensions '$2'
     # reset_schemas already creates schemas with the correct ownership and grants.
     grep -ve 'SCHEMA - lean' -e 'SCHEMA - public' \
          -e 'SCHEMA - tiger' -e 'SCHEMA - topology' \
          -e 'COMMENT - SCHEMA' -e 'ACL - SCHEMA' \
          '$2' > '$2.f' || :
     mv '$2.f' '$2'
     test -s '$2' && grep -Eq 'TABLE DATA lean listings' '$2'
  "
}

if ! build_toc /backups/olx-sync-incoming.dump /tmp/toc.use; then
  echo "RESTORE_ERROR: could not build a usable filtered restore list" >&2
  exit 1
fi
finish_phase validation-and-preparation
reset_schemas() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$boot_user" -d "$db_name" -q -c "
    DROP SCHEMA IF EXISTS lean CASCADE;
    -- PostGIS lives in public and is extension-owned by the bootstrap role.
    -- Recreate it after the application schemas are reset; it is deliberately
    -- absent from the app-role pg_restore TOC.
    DROP EXTENSION IF EXISTS postgis CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public AUTHORIZATION \"$migrator_user\";
    CREATE SCHEMA lean AUTHORIZATION \"$migrator_user\";
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    GRANT USAGE ON SCHEMA public TO \"$app_user\";"
}

if ! reset_schemas; then
  echo "RESTORE_ERROR: could not reset application schemas - database unchanged" >&2
  exit 1
fi

# Restore transactionally; replay the rollback snapshot after failure.
# Ignore archive ownership/ACLs and reapply canonical grants afterwards.
restore_failed=0
if ! docker compose exec -T db pg_restore -U "$migrator_user" -d "$db_name" --no-owner --no-acl \
       --single-transaction --use-list=/tmp/toc.use /backups/olx-sync-incoming.dump; then
  restore_failed=1
fi

if [ "$restore_failed" = "1" ]; then
  if [ -n "$prev" ] && build_toc "/backups/$(basename "$prev")" /tmp/toc.prev; then
    echo "RESTORE_ERROR: pg_restore failed - rolling back to previous snapshot $(basename "$prev")" >&2
    if reset_schemas && docker compose exec -T db pg_restore -U "$migrator_user" -d "$db_name" --no-owner --no-acl \
         --single-transaction --use-list=/tmp/toc.prev "/backups/$(basename "$prev")"; then
      echo "RESTORE_ERROR: rollback finished - instance is serving the previous snapshot" >&2
    else
      echo "RESTORE_ERROR: rollback FAILED - database is empty; restore $prev manually (see docs/OPERATIONS.md)" >&2
    fi
  else
    echo "RESTORE_ERROR: pg_restore failed and no previous snapshot exists - database is empty; restore one from $BACKUP_DIR manually" >&2
  fi
  exit 1
fi
docker compose exec -T db psql -U "$migrator_user" -d "$db_name" -q \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$app_user\";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$app_user\";" \
  || echo "RESTORE_WARN: could not re-assert writer default privileges (non-fatal)" >&2

# Restore grants removed by schema replacement before restarting clients.
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

if [ "$was_running" = "1" ]; then
  docker compose start scraper
fi
restore_ok=1
finish_phase restore-and-grants

# Reconnect Superset to olx; the metadata database is outside this restore.
if ! docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 superset; then
  echo "RESTORE_ERROR: database restored, but dashboard refresh failed; check Superset logs and recreate the service (no need to repeat the scrape/restore)" >&2
  exit 1
fi
finish_phase superset-reconnect
if [ "$provision_dashboards" = "1" ]; then
  if ! docker compose run --rm --no-deps superset-seed; then
    echo "RESTORE_ERROR: database restored, but dashboard provisioning failed; rerun docker compose run --rm --no-deps superset-seed (no need to repeat the scrape/restore)" >&2
    exit 1
  fi
  finish_phase dashboard-provisioning
  if ! docker compose run --rm --no-deps superset-access; then
    echo "RESTORE_ERROR: data and charts restored, but viewer permissions could not be refreshed; rerun superset-access" >&2
    exit 1
  fi
  finish_phase viewer-permissions
fi
if ! docker compose run --rm --no-deps --entrypoint python superset-seed /app/check_sync.py; then
  echo "RESTORE_ERROR: database restored, but fresh dashboard queries failed; repair or provision dashboards and rerun /app/check_sync.py (no need to repeat the scrape/restore)" >&2
  exit 1
fi
finish_phase dashboard-query-check

echo "RESTORE_OK $stamp ($size bytes)"
