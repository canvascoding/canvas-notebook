#!/usr/bin/env bash

cmd_env() {
  local do_sync=false do_edit=false

  for arg in "$@"; do
    case "$arg" in
      --sync) do_sync=true ;;
      --edit) do_edit=true ;;
    esac
  done

  if [[ "$do_edit" == "true" ]]; then
    local editor
    editor="${EDITOR:-nano}"
    command -v "$editor" >/dev/null 2>&1 || editor="vi"
    "$editor" "$CONFIG_JSON_PATH"
    do_sync=true
  fi

  if [[ "$do_sync" == "true" ]]; then
    migrate_compose_file
    config_json_to_env
    sync_caddy
    compose up -d --force-recreate "$SERVICE"
    follow_until_healthy
    return
  fi

  if [[ "$OUTPUT_JSON" == "true" ]]; then
    jq '.' "$CONFIG_JSON_PATH"
    return
  fi

  section "Environment"
  info "Config: ${CONFIG_JSON_PATH}"
  info "Env file: ${CONFIG_ENV_PATH}"
  echo
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    printf '%-30s %s\n' "KEY" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    local key val
    for key in domain image hostPort containerPort dataDir; do
      val="$(config_json_read "$key")"
      printf '%-30s %s\n' "$key" "${val:-(not set)}"
    done
    echo
    printf '%-30s %s\n' "ENV KEY" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    for key in BETTER_AUTH_SECRET CANVAS_INTERNAL_API_KEY BETTER_AUTH_BASE_URL BASE_URL PORT HOSTNAME NODE_ENV DATA BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_NAME; do
      val="$(config_json_read "env.${key}")"
      if [[ "$key" == *"SECRET"* || "$key" == *"PASSWORD"* || "$key" == *"API_KEY"* ]] && [[ -n "$val" ]]; then
        val="${val:0:4}***"
      fi
      printf '%-30s %s\n' "$key" "${val:-(not set)}"
    done
    echo
    printf '%-30s %s\n' "SWAP" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    printf '%-30s %s\n' "swap.enabled" "$(config_json_read swap.enabled)"
    printf '%-30s %s\n' "swap.size" "$(config_json_read swap.size)"
    printf '%-30s %s\n' "swap.file" "$(config_json_read swap.file)"
    echo
    printf '%-30s %s\n' "AUTO-UPDATE" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    printf '%-30s %s\n' "autoUpdate.enabled" "$(config_json_read autoUpdate.enabled)"
    printf '%-30s %s\n' "autoUpdate.schedule" "$(config_json_read autoUpdate.schedule)"
  else
    warn "config.json not found. Run: canvas-notebook config-migrate"
  fi
}