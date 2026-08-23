#!/bin/sh
# Remote restore endpoint for the home-machine sync (scripts/sync-to-instance.ps1).
#
# Invoked over SSH by a FORCED-COMMAND key (see authorized_keys):
#   command=".../db/remote-restore.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ...
# The client's command is ignored; the pg_dump custom-format archive arrives
# on STDIN:
#   Get-Content dump -AsByteStream | ssh -i key <host>   (forced command runs)
#
# Pipeline: receive -> size check -> integrity check -> rollback snapshot ->
# stop scraper (only if running) -> restore -> restart scraper.
# No client-controlled input is ever evaluated: the dump path is fixed and
# the archive must pass pg_restore -l and contain the listings data.
set -eu

REPO_DIR="${OLX_REPO_DIR:-$HOME/pik-market-watch}"
BACKUP_DIR="$REPO_DIR/backups"
MIN_BYTES=20000

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

# rollback snapshot; keep the 3 newest
stamp=$(date +%Y%m%d-%H%M%S)
cp "$incoming" "$BACKUP_DIR/olx-sync-$stamp.dump"
ls -1t "$BACKUP_DIR"/olx-sync-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f

if docker compose ps --status running scraper 2>/dev/null | grep -q scraper; then
  was_running=1
  docker compose stop scraper
fi

# pg_restore runs INSIDE the db container: address the archive by its mount
# point (/backups), never by the host-side path.
if ! docker compose exec -T db pg_restore -U olx -d olx --clean --if-exists /backups/olx-sync-incoming.dump; then
  echo "RESTORE_ERROR: pg_restore failed - database unchanged, rollback snapshot kept ($BACKUP_DIR/olx-sync-$stamp.dump)" >&2
  exit 1
fi
restore_ok=1

if [ "$was_running" = "1" ]; then
  docker compose start scraper
fi

echo "RESTORE_OK $stamp ($size bytes)"