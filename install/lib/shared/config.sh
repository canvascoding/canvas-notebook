#!/usr/bin/env bash
# Shared config management for Canvas Notebook CLI and installer.
# Safe loading with key whitelist, and set_manager_env for writing.

[[ -n "${_SHARED_CONFIG_LOADED:-}" ]] && return 0
_SHARED_CONFIG_LOADED=1

CANVAS_MANAGER_KEYS=(
  INSTALL_DIR
  COMPOSE_FILE
  DATA_DIR
  SERVICE
  CANVAS_SWAP_ENABLED
  CANVAS_SWAP_SIZE
  CANVAS_SWAP_FILE
  CANVAS_IMAGE
  CANVAS_HEALTH_MAX_ATTEMPTS
  CANVAS_MANAGER_LOG_DIR
  CANVAS_AUTO_UPDATE_ENABLED
  CANVAS_AUTO_UPDATE_SCHEDULE
)

load_manager_config() {
  local config_file="${1:-$CONFIG_FILE}"
  if [[ ! -f "$config_file" ]]; then
    return 0
  fi

  local key value line
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d "\"'")"
    local found=false
    for allowed_key in "${CANVAS_MANAGER_KEYS[@]}"; do
      if [[ "$key" == "$allowed_key" ]]; then
        found=true
        break
      fi
    done
    if [[ "$found" == "true" ]]; then
      printf -v "$key" '%s' "$value"
    fi
  done < "$config_file"
}

set_manager_env() {
  local key="$1" value="$2" config_file="${3:-$CONFIG_FILE}" escaped
  run_root mkdir -p "$(dirname "$config_file")"
  run_root touch "$config_file"
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g; s/"/\\"/g')"
  if grep -q "^${key}=" "$config_file" 2>/dev/null; then
    run_root sed -i "s|^${key}=.*|${key}=\"${escaped}\"|" "$config_file"
  else
    printf '%s="%s"\n' "$key" "$value" | run_root tee -a "$config_file" >/dev/null
  fi
}