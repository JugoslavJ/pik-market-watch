#!/usr/bin/env bash
# Run the lightweight checker immediately and then every fifteen minutes.
set -u
while true; do
  python /app/check_alerts.py
  status=$?
  case "$status" in
    0) ;;
    1) echo "pipeline alert checker: one or more configured conditions are firing" >&2 ;;
    *) echo "pipeline alert checker: evaluation failed with status $status" >&2 ;;
  esac
  sleep 900
done
