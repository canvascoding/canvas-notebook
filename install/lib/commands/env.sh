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
    compose up -d --force-recreate
    follow_until_healthy
    return
  fi

  if [[ "$OUTPUT_JSON" == "true" ]]; then
    jq '.' "$CONFIG_JSON_PATH"
    return
  fi

  section "Environment"
  info "Config: ${CONFIG_JSON_PATH}"
  info "Container env: ${CONFIG_ENV_PATH}"
  info "Compose env: ${COMPOSE_ENV_PATH}"
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
    local env_key env_val
    while IFS= read -r env_key; do
      env_val="$(config_json_read "env.${env_key}")"
      if [[ "$env_key" == "DATABASE_URL" && -n "$env_val" ]]; then
        env_val="postgresql://***"
      elif [[ "$env_key" == *"SECRET"* || "$env_key" == *"PASSWORD"* || "$env_key" == *"API_KEY"* ]] && [[ -n "$env_val" ]]; then
        env_val="${env_val:0:4}***"
      fi
      printf '%-30s %s\n' "$env_key" "${env_val:-(not set)}"
    done < <(jq -r '.env | keys[]' "$CONFIG_JSON_PATH")
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
