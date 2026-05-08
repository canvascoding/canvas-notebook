#!/usr/bin/env bash

cmd_config_show() {
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    config_json_show
  else
    info "Config file: ${CONFIG_JSON_PATH}"
    echo
    config_json_show
  fi
}

cmd_config_set() {
  if [[ $# -lt 2 ]]; then
    fail "Usage: canvas-notebook config-set <key> <value>\n  Example: canvas-notebook config-set domain app.example.com\n  Example: canvas-notebook config-set swap.enabled true\n  Example: canvas-notebook config-set env.BETTER_AUTH_BASE_URL https://app.example.com"
  fi

  local key="$1" value="$2"
  config_json_write "$key" "$value"
  ok "Set ${key} = ${value}"

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