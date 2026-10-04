#!/bin/sh
# Atomic, verified daily backups; --once forces a snapshot, --check verifies freshness.
set -eu
umask 077
BACKUP_DIR=${BACKUP_DIR:-/backups}
SUPERSET_HOME=${SUPERSET_HOME:-/superset-home}
META_DB=${SUPERSET_META_DB:-superset_meta}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
MODE=${DASHBOARD_MODE:-superset}
partial=
case "$MODE" in superset) ;; *) echo "Only Superset is supported; DASHBOARD_MODE must be superset" >&2; exit 1 ;; esac
case "$RETENTION_DAYS" in ''|*[!0-9]*) echo "Invalid BACKUP_RETENTION_DAYS" >&2; exit 1 ;; esac
cleanup() { [ -z "$partial" ] || rm -f "$partial"; }
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

fresh_archive() {
  prefix=$1
  suffix=$2
  max_age=$3
  newest=$(find "$BACKUP_DIR" -maxdepth 1 -name "$prefix-*.$suffix" -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d ' ' -f 2-)
  [ -n "$newest" ] || return 1
  age=$(( $(date +%s) - $(stat -c %Y "$newest") ))
  [ "$age" -ge 0 ] && [ "$age" -lt "$max_age" ] || return 1
  case "$suffix" in
    dump) pg_restore -l "$newest" >/dev/null 2>&1 ;;
    tar.gz) tar -tzf "$newest" >/dev/null 2>&1 ;;
  esac
}

check_backups() {
  fresh_archive olx dump "$1" && fresh_archive "$META_DB" dump "$1" &&
    fresh_archive superset-home tar.gz "$1" || return 1
}

dump_database() {
  prefix=$1
  database=$2
  out="$BACKUP_DIR/$prefix-$(date +%Y%m%d).dump"
  partial=$(mktemp "$out.partial.XXXXXX")
  echo "$(date -u '+%F %T') dumping $prefix"
  if pg_dump -Fc --dbname="$database" -f "$partial" && pg_restore -l "$partial" >/dev/null 2>&1; then
    mv -f "$partial" "$out"
    partial=
  else
    echo "Backup verification failed: $prefix" >&2
    cleanup
    partial=
    return 1
  fi
}

archive_volume() {
  prefix=$1
  directory=$2
  out="$BACKUP_DIR/$prefix-$(date +%Y%m%d).tar.gz"
  partial=$(mktemp "$out.partial.XXXXXX")
  echo "$(date -u '+%F %T') archiving $prefix"
  if tar -czf "$partial" -C "$directory" . && tar -tzf "$partial" >/dev/null 2>&1; then
    mv -f "$partial" "$out"
    partial=
  else
    echo "Volume backup verification failed: $prefix" >&2
    cleanup
    partial=
    return 1
  fi
}

backup_cycle() {
  exec 9>"$BACKUP_DIR/.backup.lock"
  flock -x 9 || return 1
  if [ "$1" = force ] || ! check_backups 86400; then
    dump_database olx "${PGDATABASE:-olx}" &&
      dump_database "$META_DB" "$META_DB" &&
      archive_volume superset-home "$SUPERSET_HOME" || return 1
    if [ "$RETENTION_DAYS" -gt 0 ]; then
      for pattern in 'olx-*.dump' "$META_DB-*.dump" 'superset-home-*.tar.gz'; do
        find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -mtime +"$RETENTION_DAYS" -delete
      done
    fi
  fi
  flock -u 9
}

case "${1:-}" in
  --check) check_backups 93600; exit $? ;;
  --once) backup_cycle force; check_backups 93600; exit $? ;;
  '') ;;
  *) echo "Usage: backup.sh [--once|--check]" >&2; exit 2 ;;
esac
echo "$(date -u '+%F %T') backup loop started ($MODE, retention $RETENTION_DAYS days)"
while true; do
  # Release the lock even when an archive fails.
  (backup_cycle daily) || echo "Backup failed; retrying in one hour" >&2
  sleep 3600
done
