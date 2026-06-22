#!/usr/bin/env bash

_mask_json_secrets() {
  local input="$1"
  local jq_expr
  jq_expr='.env.BETTER_AUTH_SECRET = (if (.env.BETTER_AUTH_SECRET == null or .env.BETTER_AUTH_SECRET == "") then "(not set)" else (.env.BETTER_AUTH_SECRET | .[0:4] + "***") end)
    | .env.CANVAS_INTERNAL_API_KEY = (if (.env.CANVAS_INTERNAL_API_KEY == null or .env.CANVAS_INTERNAL_API_KEY == "") then "(not set)" else (.env.CANVAS_INTERNAL_API_KEY | .[0:4] + "***") end)
    | .env.DATABASE_URL = (if (.env.DATABASE_URL == null or .env.DATABASE_URL == "") then "(not set)" else "postgresql://***" end)
    | .env.CANVAS_POSTGRES_PASSWORD = (if (.env.CANVAS_POSTGRES_PASSWORD == null or .env.CANVAS_POSTGRES_PASSWORD == "") then "(not set)" else (.env.CANVAS_POSTGRES_PASSWORD | .[0:4] + "***") end)'
  printf '%s' "$input" | jq "$jq_expr"
}

cmd_config_show() {
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    if [[ -f "$CONFIG_JSON_PATH" ]]; then
      _mask_json_secrets "$(cat "$CONFIG_JSON_PATH")"
    else
      _mask_json_secrets "$CONFIG_JSON_DEFAULTS"
    fi
  else
    info "Config file: ${CONFIG_JSON_PATH}"
    echo
    if [[ -f "$CONFIG_JSON_PATH" ]]; then
      _mask_json_secrets "$(cat "$CONFIG_JSON_PATH")"
    else
      info "No config.json found. Run: canvas-notebook config-migrate"
    fi
  fi
}

cmd_config_set() {
  if [[ $# -lt 2 ]]; then
    fail "Usage: canvas-notebook config-set <key> <value>\n  Example: canvas-notebook config-set domain app.example.com\n  Example: canvas-notebook config-set swap.enabled true\n  Example: canvas-notebook config-set env.BETTER_AUTH_BASE_URL https://app.example.com"
  fi

  local key="$1" value="$2"

  if [[ "$key" == "env.BOOTSTRAP_ADMIN_PASSWORD" ]]; then
    fail "BOOTSTRAP_ADMIN_PASSWORD is not stored in config.json. Use: canvas-notebook admin reset-password --email <email> --password-stdin"
  fi

  config_json_write "$key" "$value"

  local display_value="$value"
  case "$key" in
    env.BETTER_AUTH_SECRET|env.CANVAS_INTERNAL_API_KEY|env.CANVAS_POSTGRES_PASSWORD)
      display_value="${value:0:4}***"
      ;;
    env.DATABASE_URL)
      display_value="postgresql://***"
      ;;
  esac
  ok "Set ${key} = ${display_value}"

  case "$key" in
    domain|image|hostPort|containerPort|dataDir|env.*)
      info "Regenerating .env (run 'env --sync' to apply changes to container)"
      config_json_to_env
      ;;
  esac
}

cmd_config_migrate() {
  local force=false
  for arg in "$@"; do
    if [[ "$arg" == "--force" ]]; then
      force=true
    fi
  done

  if [[ "$force" == "true" ]]; then
    config_json_migrate --force
  else
    config_json_migrate
  fi
}
