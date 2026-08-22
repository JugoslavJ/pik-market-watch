#!/bin/sh
# Daily database backup loop (runs in the db-backup sidecar).
# - dumps at most once per 24 h (safe across container restarts)
# - compressed custom-format archives: olx-YYYYMMDD.dump
# - verifies each archive with pg_restore -l
# - also tars the Grafana state volume: grafana-YYYYMMDD.tar.gz
#   (SQLite is snapshotted live — fine as a safety net, but take a COLD copy,
#    i.e. stop the grafana container first, before any major Grafana upgrade)
# - prunes archives older than BACKUP_RETENTION_DAYS

set -u

BACKUP_DIR=/backups
GRAFANA_DIR=/grafana-data
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
DAY=86400

echo "$(date -u '+%F %T') backup loop started (retention: ${RETENTION_DAYS} days)"

while true; do
  newest=$(ls -1t "$BACKUP_DIR"/olx-*.dump 2>/dev/null | head -n 1)
  fresh=false
  if [ -n "$newest" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$newest") ))
    if [ "$age" -lt "$DAY" ]; then fresh=true; fi
  fi

  if [ "$fresh" = true ]; then
    echo "$(date -u '+%F %T') newest archive younger than 24 h — skipping"
  else
    out="$BACKUP_DIR/olx-$(date +%Y%m%d).dump"
    echo "$(date -u '+%F %T') dumping -> $out"
    if pg_dump -Fc -f "$out"; then
      if pg_restore -l "$out" >/dev/null 2>&1; then
        echo "$(date -u '+%F %T') OK ($(du -h "$out" | cut -f1))"
      else
        echo "$(date -u '+%F %T') archive failed verification — removing"
        rm -f "$out"
      fi
    else
      echo "$(date -u '+%F %T') pg_dump FAILED — removing partial file"
      rm -f "$out"
    fi

    # ── Grafana state volume (users, prefs, UI-made dashboard edits) ──────────
    gtar="$BACKUP_DIR/grafana-$(date +%Y%m%d).tar.gz"
    echo "$(date -u '+%F %T') archiving grafana volume -> $gtar"
    if tar -czf "$gtar" -C "$GRAFANA_DIR" . ; then
      if tar -tzf "$gtar" >/dev/null 2>&1; then
        echo "$(date -u '+%F %T') OK ($(du -h "$gtar" | cut -f1))"
      else
        echo "$(date -u '+%F %T') grafana archive failed verification — removing"
        rm -f "$gtar"
      fi
    else
      echo "$(date -u '+%F %T') grafana tar FAILED — removing partial file"
      rm -f "$gtar"
    fi

    if [ "$RETENTION_DAYS" -gt 0 ]; then
      find "$BACKUP_DIR" -name 'olx-*.dump' -mtime +"$RETENTION_DAYS" | \
        while read -r old; do echo "pruning: $old"; rm -f "$old"; done
      find "$BACKUP_DIR" -name 'grafana-*.tar.gz' -mtime +"$RETENTION_DAYS" | \
        while read -r old; do echo "pruning: $old"; rm -f "$old"; done
    fi
  fi

  sleep 3600   # re-check hourly; acts only when the newest archive is stale
done