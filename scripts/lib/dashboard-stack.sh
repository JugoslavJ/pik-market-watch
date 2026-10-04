#!/bin/sh
# Shared by deployment, restore, and the cutover readiness gate. Never source .env.
read_env_value() {
  env_name=$1
  if printenv "$env_name" >/dev/null 2>&1; then
    printenv "$env_name"
    return
  fi
  env_line=$(sed -n "s/^${env_name}=//p" .env | tail -n 1 | tr -d '\r')
  case "$env_line" in
    \"*\") env_line=${env_line#\"}; env_line=${env_line%\"} ;;
    \'*\') env_line=${env_line#\'}; env_line=${env_line%\'} ;;
  esac
  printf '%s' "$env_line"
}

configure_dashboard_stack() {
  DASHBOARD_MODE=$(read_env_value DASHBOARD_MODE)
  DASHBOARD_MODE=${DASHBOARD_MODE:-superset}
  HAS_SUPERSET=true
  HAS_GRAFANA=false
  COMPOSE_FILE=docker-compose.yml
  COMPOSE_PATH_SEPARATOR=:
  if [ "$DASHBOARD_MODE" != superset ]; then
    echo "Grafana is retired. Set DASHBOARD_MODE=superset in the instance .env." >&2
    return 1
  fi
  COMPOSE_PROFILES=superset
  export DASHBOARD_MODE COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PATH_SEPARATOR
}

dashboard_services() {
  printf 'superset '
}

stack_services() {
  printf 'db db-backup '
  dashboard_services
  [ "$HAS_SUPERSET" != true ] || printf 'superset-alert-check '
  return 0
}

health_status() {
  health_id=$(docker compose ps -q "$1" 2>/dev/null || true)
  if [ -z "$health_id" ]; then
    printf 'missing'
  else
    docker inspect -f '{{.State.Health.Status}}' "$health_id" 2>/dev/null || printf 'missing'
  fi
}
