#!/bin/sh
# Shared by deployment, restore, and the readiness gate. Never source .env.
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

configure_superset_stack() {
  # Pinning the file also keeps a stray docker-compose.override.yml out.
  COMPOSE_FILE=docker-compose.yml
  COMPOSE_PROFILES=superset
  export COMPOSE_PROFILES COMPOSE_FILE
}

health_status() {
  health_id=$(docker compose ps -q "$1" 2>/dev/null || true)
  if [ -z "$health_id" ]; then
    printf 'missing'
  else
    docker inspect -f '{{.State.Health.Status}}' "$health_id" 2>/dev/null || printf 'missing'
  fi
}
