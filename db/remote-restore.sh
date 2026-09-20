#!/bin/sh
# Remote restore endpoint for the home-machine sync (scripts/sync-to-instance.ps1).
#
# Invoked over SSH by a FORCED-COMMAND key (see authorized_keys):
#   command=".../db/remote-restore.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ...
# The client's command is ignored; the pg_dump custom-format archive arrives
# on STDIN:
#   Get-Content dump -AsByteStream | ssh -i key <host>   (forced command runs)
#
# Pipeline: receive -> size check -> integrity check -> ownership audit ->
# rollback snapshot -> stop scraper (only if running) -> replace application
# schemas -> restore (atomic) -> on failure roll back to the previous snapshot
# -> restart scraper.
#
# Why schemas are dropped instead of relying on pg_restore --clean: the instance never
# runs migrations (no scraper), so home and instance schemas can drift (e.g. a
# migration renamed a function's signature). Stale instance-side functions
# that depend on a dumped table make --clean's plain DROP TABLE fail without
# CASCADE, and the dump cannot drop what it does not contain. Dropping the
# application schemas removes any drift. OLAP introduced cross-schema
# dependencies, so pg_restore's archive order cannot safely clean schemas.
#
# No client-controlled input is ever evaluated: the dump path is fixed and
# the archive must pass pg_restore -l and contain the listings data.
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
# Restore as the least-privileged OWNING role (db/init/zz-database-roles.sh):
# it must own the restored objects. Names come from .env.
migrator_user="$(sed -n 's/^POSTGRES_MIGRATOR_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
migrator_user="${migrator_user:-olx_migrator}"
app_user="$(sed -n 's/^POSTGRES_APP_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
app_user="${app_user:-olx_app}"
reporting_user="$(sed -n 's/^POSTGRES_REPORTING_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
reporting_user="${reporting_user:-olx_reporting}"
# Bootstrap superuser (POSTGRES_USER) - owns the public schema itself, which
# $app_user does not, so the schema reset below runs as this role.
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

if ! docker compose exec -T db pg_restore -l /backups/olx-sync-incoming.dump >/dev/null 2>&1; then
  echo "RESTORE_ERROR: archive failed pg_restore integrity check" >&2
  exit 1
fi
if ! docker compose exec -T db sh -c 'pg_restore -l /backups/olx-sync-incoming.dump | grep -q "TABLE DATA public listings"'; then
  echo "RESTORE_ERROR: archive is missing listings data" >&2
  exit 1
fi

# ─── Ownership audit (before anything destructive) ───────────────────────────
# pg_restore replays every entry's ALTER ... OWNER TO <source-owner>, and the
# least-privileged restore role cannot SET ROLE to any other role — so every
# archived object must ALREADY be owned by $migrator_user. Drift happens when the
# SOURCE machine creates objects as its bootstrap superuser (2026-08-24: a
# migration re-applied by hand as "-U olx" shipped two superuser-owned objects;
# the failure only surfaced here, after the schema had already been dropped).
# DEFAULT ACL entries are excluded: build_toc filters those separately and
# their trailing token is a grantee, not the owner. PostGIS extension entries
# are also excluded: pg_restore lists `EXTENSION - postgis` without an owner,
# and the extension must be installed by the bootstrap administrator rather
# than replayed by the app role.
drifted=$(docker compose exec -T db sh -c "
    pg_restore -l '/backups/olx-sync-incoming.dump' |
    grep -v '^;' | grep -v 'DEFAULT ACL' |
    grep -v ' EXTENSION - ' | grep -v ' COMMENT - EXTENSION ' |
    awk '\$NF != \"$migrator_user\" {print \$NF}' | sort -u")
if [ -n "$drifted" ]; then
  echo "RESTORE_ERROR: archive contains objects not owned by $migrator_user:" >&2
  printf '%s\n' "$drifted" | sed 's/^/RESTORE_ERROR:   /' >&2
  echo "RESTORE_ERROR: fix the source machine, then re-run the sync:" >&2
  echo "RESTORE_ERROR:   docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh" >&2
  exit 1
fi

# rollback snapshots; keep the 3 newest. prev = second-newest = the state we
# roll back to if the restore fails after the schema reset.
stamp=$(date +%Y%m%d-%H%M%S)
cp "$incoming" "$BACKUP_DIR/olx-sync-$stamp.dump"
ls -1t "$BACKUP_DIR"/olx-sync-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f
prev=$(ls -1t "$BACKUP_DIR"/olx-sync-*.dump 2>/dev/null | grep -v 'olx-sync-incoming' | sed -n 2p || :)

if docker compose ps --status running scraper 2>/dev/null | grep -q scraper; then
  was_running=1
  docker compose stop scraper
fi

# pg_restore runs INSIDE the db container: address the archive by its mount
# point (/backups), never by the host-side path.
#
# build_toc <container-archive-path> <output-list>: filter the TOC to entries
# this restore may execute. The source machine's zz-database-roles.sh
# (pre-2026-08 versions) also set default privileges FOR ROLE <bootstrap
# admin>. Restoring runs as $migrator_user, which may not alter ANOTHER role's
# defaults - those archive entries would fail, and any pg_restore error aborts
# the whole sync. Keep every entry EXCEPT DEFAULT ACL items whose trailing
# role is not $migrator_user; the dump's own migration-role defaults restore normally.
build_toc() {
  docker compose exec -T db sh -c "
     pg_restore -l '$1' > /tmp/toc.all || exit 1
    grep 'DEFAULT ACL' /tmp/toc.all | grep -Ev \" ${migrator_user}\\$\" > /tmp/toc.drop || :
     if [ -s /tmp/toc.drop ]; then
       grep -vxFf /tmp/toc.drop /tmp/toc.all > '$2' || :
     else
       # busybox grep -v -f <empty file> selects NOTHING (GNU selects
       # everything) - skip the filter when there is nothing to exclude
       cp /tmp/toc.all '$2'
     fi
     # Extension metadata is installed by the bootstrap administrator in
     # reset_schemas; the app role must not try to CREATE EXTENSION or replay
     # its extension-owned spatial_ref_sys table/data.
     grep -ve ' EXTENSION - ' -e ' COMMENT - EXTENSION ' \
          -e 'spatial_ref_sys' \
          '$2' > '$2'.extensions || :
     mv '$2'.extensions '$2'
     # schema-level entries carry the source schema's owner (ALTER ... OWNER
     # TO <bootstrap admin>) and cannot be replayed by $app_user; the reset
     # block already created the schema with the right owner and grants
     grep -ve 'SCHEMA - public' -e 'SCHEMA - reporting' -e 'SCHEMA - olap' \
          -e 'COMMENT - SCHEMA' -e 'ACL - SCHEMA' \
          '$2' > '$2.f' || :
     mv '$2.f' '$2'
     test -s '$2' && grep -q 'TABLE DATA public listings' '$2'
  "
}

if ! build_toc /backups/olx-sync-incoming.dump /tmp/toc.use; then
  echo "RESTORE_ERROR: could not build a usable filtered restore list" >&2
  exit 1
fi
reset_schemas() {
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$boot_user" -d "$db_name" -q -c "
    -- PostGIS lives in public and is extension-owned by the bootstrap role.
    -- Recreate it after the application schemas are reset; it is deliberately
    -- absent from the app-role pg_restore TOC.
    DROP EXTENSION IF EXISTS postgis CASCADE;
    DROP SCHEMA IF EXISTS reporting CASCADE;
    DROP SCHEMA IF EXISTS olap CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public AUTHORIZATION \"$migrator_user\";
    CREATE SCHEMA reporting AUTHORIZATION \"$migrator_user\";
    CREATE SCHEMA olap AUTHORIZATION \"$migrator_user\";
    CREATE EXTENSION IF NOT EXISTS postgis;
    GRANT ALL ON SCHEMA public TO \"$app_user\";
      GRANT USAGE ON SCHEMA reporting TO \"$reporting_user\";"
}

if ! reset_schemas; then
  echo "RESTORE_ERROR: could not reset application schemas - database unchanged" >&2
  exit 1
fi

# --single-transaction: the restore is all-or-nothing. If it fails after the
# schema reset, the database is empty and the auto-rollback below replays the
# previous snapshot.
restore_failed=0
# --no-owner: belt-and-braces behind the audit above — a no-op while every
# entry targets $migrator_user; if anything ever slips through it degrades to
# "object owned by the restoring role" instead of failing the whole sync.
if ! docker compose exec -T db pg_restore -U "$migrator_user" -d "$db_name" --no-owner \
       --single-transaction --use-list=/tmp/toc.use /backups/olx-sync-incoming.dump; then
  restore_failed=1
fi

if [ "$restore_failed" = "1" ]; then
  if [ -n "$prev" ] && build_toc "/backups/$(basename "$prev")" /tmp/toc.prev; then
    echo "RESTORE_ERROR: pg_restore failed - rolling back to previous snapshot $(basename "$prev")" >&2
    if reset_schemas && docker compose exec -T db pg_restore -U "$migrator_user" -d "$db_name" --no-owner \
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
restore_ok=1

# Belt & braces: FUTURE tables created by migrations must stay readable by
# Grafana even if some future dump ever lacks the app-role defaults.
docker compose exec -T db psql -U "$migrator_user" -d "$db_name" -q \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$app_user\";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$app_user\";" \
  || echo "RESTORE_WARN: could not re-assert writer default privileges (non-fatal)" >&2

# Schema replacement removes object grants. Re-run the canonical role repair so
# the writer and reporting contracts are restored before the scraper restarts.
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh

if [ "$was_running" = "1" ]; then
  docker compose start scraper
fi

echo "RESTORE_OK $stamp ($size bytes)"
