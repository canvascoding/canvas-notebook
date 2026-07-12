#!/usr/bin/env bash

_lifecycle_recover_postgres_auth() {
  local journal_path="${CANVAS_POSTGRES_RECONCILE_JOURNAL:-${INSTALL_DIR}/.postgres-auth-reconcile.json}"
  if [[ ! -f "$journal_path" ]]; then
    postgres_runtime_desired || return 0
    [[ -f "$CONFIG_ENV_PATH" && -f "$COMPOSE_ENV_PATH" ]] || return 0
  fi
  if ! declare -f _database_reconcile_postgres_auth >/dev/null 2>&1; then
    . "${CMD_DIR:-${INSTALL_DIR}/lib/commands}/database.sh"
  fi
  _database_reconcile_postgres_auth --timeout "${CANVAS_POSTGRES_RECONCILE_TIMEOUT:-900}"
}

cmd_start() {
  log_msg "start"
  _lifecycle_recover_postgres_auth
  migrate_compose_file
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
  ensure_env_file
  postgres_prepare_managed_runtime
  run_compose up -d
  wait_until_healthy
}

cmd_restart() {
  log_msg "restart"
  _lifecycle_recover_postgres_auth
  migrate_compose_file
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
  ensure_env_file
  postgres_prepare_managed_runtime
  run_compose up -d --force-recreate
  wait_until_healthy
}

cmd_stop() {
  log_msg "stop"
  run_compose stop "$SERVICE"
}

cmd_down() {
  log_msg "down"
  run_compose down
}
