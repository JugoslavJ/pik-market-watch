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
# rollback snapshot -> stop scraper (only if running) -> replace the public
# schema -> restore (atomic) -> on failure roll back to the previous snapshot
# -> restart scraper.
#
# Why the schema is dropped instead of pg_restore --clean: the instance never
# runs migrations (no scraper), so home and instance schemas can drift (e.g. a
# migration renamed a function's signature). Stale instance-side functions
# that depend on a dumped table make --clean's plain DROP TABLE fail without
# CASCADE, and the dump cannot drop what it does not contain. Dropping the
# whole schema removes any drift; the dump recreates everything.
#
# No client-controlled input is ever evaluated: the dump path is fixed and
# the archive must pass pg_restore -l and contain the listings data.
set -eu

REPO_DIR="${OLX_REPO_DIR:-$HOME/pik-market-watch}"
BACKUP_DIR="$REPO_DIR/backups"
MIN_BYTES=20000
# Restore as the least-privileged OWNING role (db/init/zz-database-roles.sh):
# it must own the restored objects. Names come from .env.
app_user="$(sed -n 's/^POSTGRES_APP_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
app_user="${app_user:-olx_app}"
reader_user="$(sed -n 's/^POSTGRES_READER_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
reader_user="${reader_user:-olx_reader}"
# Bootstrap superuser (POSTGRES_USER) - owns the public schema itself, which
# $app_user does not, so the schema reset below runs as this role.
boot_user="$(sed -n 's/^POSTGRES_USER=//p' "$REPO_DIR/.env" 2>/dev/null | tr -d '\r')"
boot_user="${boot_user:-olx}"

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
  if [ "$was_running" = "1" ] && [ "$restore_ok" != "1" ]; then
    docker compose start scraper >/dev/null 2>&1 || :
    echo "RESTORE_ERROR: aborted after stopping the scraper - restarted it" >&2
  fi
}
trap on_exit EXIT
incoming="$BACKUP_DIR/olx-sync-incoming.dump"
cat > "$incoming"

size=$(stat -c %s "$incoming")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "RESTORE_ERROR: archive too small ($size bytes) - transfer truncated?" >&2
  exit 1
fi

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
# archived object must ALREADY be owned by $app_user. Drift happens when the
# SOURCE machine creates objects as its bootstrap superuser (2026-08-24: a
# migration re-applied by hand as "-U olx" shipped two superuser-owned objects;
# the failure only surfaced here, after the schema had already been dropped).
# DEFAULT ACL entries are excluded: build_toc filters those separately and
# their trailing token is a grantee, not the owner.
drifted=$(docker compose exec -T db sh -c "
    pg_restore -l '$incoming' | grep -v '^;' | grep -v 'DEFAULT ACL' |
    awk '\$NF != \"$app_user\" {print \$NF}' | sort -u" 2>/dev/null || :)
if [ -n "$drifted" ]; then
  echo "RESTORE_ERROR: archive contains objects not owned by $app_user:" >&2
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
# admin>. Restoring runs as $app_user, which may not alter ANOTHER role's
# defaults - those archive entries would fail, and any pg_restore error aborts
# the whole sync. Keep every entry EXCEPT DEFAULT ACL items whose trailing
# role is not $app_user; the dump's own app-role defaults restore normally.
build_toc() {
  docker compose exec -T db sh -c "
     pg_restore -l '$1' > /tmp/toc.all || exit 1
     grep 'DEFAULT ACL' /tmp/toc.all | grep -Ev \" ${app_user}\\$\" > /tmp/toc.drop || :
     if [ -s /tmp/toc.drop ]; then
       grep -vxFf /tmp/toc.drop /tmp/toc.all > '$2' || :
     else
       # busybox grep -v -f <empty file> selects NOTHING (GNU selects
       # everything) - skip the filter when there is nothing to exclude
       cp /tmp/toc.all '$2'
     fi
     # schema-level entries carry the source schema's owner (ALTER ... OWNER
     # TO <bootstrap admin>) and cannot be replayed by $app_user; the reset
     # block already created the schema with the right owner and grants
     grep -ve 'SCHEMA - public' -e 'COMMENT - SCHEMA' -e 'ACL - SCHEMA' '$2' > '$2.f' || :
     mv '$2.f' '$2'
     test -s '$2' && grep -q 'TABLE DATA public listings' '$2'
  "
}

if ! build_toc /backups/olx-sync-incoming.dump /tmp/toc.use; then
  echo "RESTORE_ERROR: could not build a usable filtered restore list" >&2
  exit 1
fi
# Replace the whole public schema (see header). Runs as the bootstrap
# superuser: it owns the schema itself, which $app_user does not. Ownership is
# transferred to $app_user afterwards - the dump carries schema-level entries
# (COMMENT ON SCHEMA, schema ACLs) that only the owner may execute.
if ! docker compose exec -T db psql -U "$boot_user" -d olx -q -c "
       DROP SCHEMA public CASCADE;
       CREATE SCHEMA public;
       ALTER SCHEMA public OWNER TO \"$app_user\";
       GRANT ALL ON SCHEMA public TO \"$app_user\";
       GRANT USAGE ON SCHEMA public TO \"$reader_user\";"; then
  echo "RESTORE_ERROR: could not reset the public schema - database unchanged" >&2
  exit 1
fi

# --single-transaction: the restore is all-or-nothing. If it fails after the
# schema reset, the database is empty and the auto-rollback below replays the
# previous snapshot.
restore_failed=0
# --no-owner: belt-and-braces behind the audit above — a no-op while every
# entry targets $app_user; if anything ever slips through it degrades to
# "object owned by the restoring role" instead of failing the whole sync.
if ! docker compose exec -T db pg_restore -U "$app_user" -d olx --clean --if-exists --no-owner \
       --single-transaction --use-list=/tmp/toc.use /backups/olx-sync-incoming.dump; then
  restore_failed=1
fi

if [ "$restore_failed" = "1" ]; then
  if [ -n "$prev" ] && build_toc "/backups/$(basename "$prev")" /tmp/toc.prev; then
    echo "RESTORE_ERROR: pg_restore failed - rolling back to previous snapshot $(basename "$prev")" >&2
    if docker compose exec -T db pg_restore -U "$app_user" -d olx --clean --if-exists --no-owner \
           --single-transaction --use-list=/tmp/toc.prev "/backups/$(basename "$prev")"; then
      echo "RESTORE_ERROR: rollback finished - instance is serving the previous snapshot" >&2
    else
      echo "RESTORE_ERROR: rollback FAILED - database is empty; restore $prev manually (see README)" >&2
    fi
  else
    echo "RESTORE_ERROR: pg_restore failed and no previous snapshot exists - database is empty; restore one from $BACKUP_DIR manually" >&2
  fi
  exit 1
fi
restore_ok=1

# Belt & braces: FUTURE tables created by migrations must stay readable by
# Grafana even if some future dump ever lacks the app-role defaults.
docker compose exec -T db psql -U "$app_user" -d olx -q \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO \"$reader_user\";
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO \"$reader_user\";" \
  || echo "RESTORE_WARN: could not re-assert default privileges for the reader (non-fatal)" >&2

if [ "$was_running" = "1" ]; then
  docker compose start scraper
fi

echo "RESTORE_OK $stamp ($size bytes)"

