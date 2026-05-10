#!/usr/bin/env bash
# Shared config.json management for Canvas Notebook CLI and installer.
# Provides CRUD operations, .env generation, and migration from legacy config.

[[ -n "${_SHARED_CONFIG_JSON_LOADED:-}" ]] && return 0
_SHARED_CONFIG_JSON_LOADED=1

CONFIG_JSON_PATH="${CANVAS_CONFIG_JSON:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-config.json}"
CONFIG_ENV_PATH="${CANVAS_CONFIG_ENV:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook.env}"
COMPOSE_ENV_PATH="${CANVAS_COMPOSE_ENV:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/.env}"

CONFIG_JSON_DEFAULTS='{
  "domain": "",
  "image": "ghcr.io/canvascoding/canvas-notebook:latest",
  "hostPort": 3456,
  "containerPort": 3000,
  "dataDir": "",
  "swap": {
    "enabled": false,
    "size": "2G",
    "file": "/swapfile"
  },
  "autoUpdate": {
    "enabled": true,
    "schedule": "*-*-* 04:00:00"
  },
  "env": {
    "BETTER_AUTH_SECRET": "",
    "CANVAS_INTERNAL_API_KEY": "",
    "BETTER_AUTH_BASE_URL": "",
    "BASE_URL": "",
    "PORT": "3000",
    "HOSTNAME": "0.0.0.0",
    "NODE_ENV": "production",
    "DATA": "/data",
    "BOOTSTRAP_ADMIN_EMAIL": "",
    "BOOTSTRAP_ADMIN_PASSWORD": "",
    "BOOTSTRAP_ADMIN_NAME": "Administrator",
    "LOG_LEVEL": "info",
    "ONBOARDING": true,
    "ALLOW_SIGNUP": false,
    "OLLAMA_CLI_AUTO_INSTALL": true
  }
}'

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      info "Installing jq..."
      run_root apt-get update -qq && run_root apt-get install -y -qq jq
    else
      fail "jq is required but not installed. Install with: sudo apt-get install jq"
    fi
  fi
}

config_json_init() {
  require_jq
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    run_root mkdir -p "$(dirname "$CONFIG_JSON_PATH")"
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | run_root tee "$CONFIG_JSON_PATH" >/dev/null
    run_root chown "$(id -u):$(id -g)" "$CONFIG_JSON_PATH" 2>/dev/null || true
    ok "Created default config at ${CONFIG_JSON_PATH}"
  fi
}

config_json_read() {
  local key="$1"
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq -r --arg k "$key" 'getpath($k | split(".")) // empty'
    return
  fi
  jq -r --arg k "$key" 'getpath($k | split(".")) // empty' "$CONFIG_JSON_PATH"
}

config_json_read_raw() {
  local key="$1"
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq --arg k "$key" 'getpath($k | split("."))'
    return
  fi
  jq --arg k "$key" 'getpath($k | split("."))' "$CONFIG_JSON_PATH"
}

config_json_write() {
  local key="$1" value="$2" tmp

  require_jq

  case "$key" in
    swap.size)
      if ! printf '%s' "$value" | grep -qE '^[0-9]+[KMGT]?$'; then
        fail "Invalid swap size '${value}'. Expected format: <number>[K|M|G|T] (e.g. 2G, 512M)"
      fi
      ;;
    swap.file)
      if [[ "$value" != /* ]]; then
        fail "Swap file path must be absolute (e.g. /swapfile)"
      fi
      ;;
    swap.enabled)
      value="$(is_false "$value" && printf 'false' || printf 'true')"
      ;;
    autoUpdate.enabled)
      value="$(is_false "$value" && printf 'false' || printf 'true')"
      ;;
    autoUpdate.schedule)
      if ! printf '%s' "$value" | grep -qE '^[*0-9]{1,2}-[*0-9]{1,2}-[*0-9]{1,2} [*0-9:,]+'; then
        fail "Invalid systemd schedule format '${value}'. Example: '*-*-* 04:00:00'"
      fi
      ;;
    hostPort|containerPort)
      if ! printf '%s' "$value" | grep -qE '^[1-9][0-9]*$' || [[ "$value" -lt 1 || "$value" -gt 65535 ]]; then
        fail "Invalid port '${value}'. Must be 1-65535."
      fi
      ;;
    domain)
      ;;
    env.BETTER_AUTH_BASE_URL)
      if [[ -n "$value" ]]; then
        local extracted_domain
        extracted_domain="$(printf '%s' "$value" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1)"
        _config_json_write_raw "domain" "\"$extracted_domain\""
        local base_url
        base_url="$value"
        _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "\"$base_url\""
        _config_json_write_raw "env.BASE_URL" "\"$base_url\""
        return
      fi
      ;;
    env.BASE_URL)
      if [[ -n "$value" ]]; then
        local extracted_domain
        extracted_domain="$(printf '%s' "$value" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1)"
        _config_json_write_raw "domain" "\"$extracted_domain\""
        _config_json_write_raw "env.BASE_URL" "\"$value\""
        local current_auth_url
        current_auth_url="$(config_json_read env.BETTER_AUTH_BASE_URL)"
        if [[ -z "$current_auth_url" ]]; then
          _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "\"$value\""
        fi
        return
      fi
      ;;
    env.*)
      ;;
  esac

  if printf '%s' "$value" | grep -qE '^-?[0-9]+$'; then
    _config_json_write_raw "$key" "$value"
  elif [[ "$value" == "true" || "$value" == "false" ]]; then
    _config_json_write_raw "$key" "$value"
  else
    _config_json_write_raw "$key" "\"$value\""
  fi

  if [[ "$key" == "domain" ]] && [[ -n "$value" ]]; then
    local base_url="https://${value}"
    _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "\"$base_url\""
    _config_json_write_raw "env.BASE_URL" "\"$base_url\""
  fi
}

_config_json_write_raw() {
  local key="$1" json_value="$2" tmp

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    config_json_init
  fi

  tmp="$(mktemp)"
  jq --arg k "$key" --argjson v "$json_value" 'setpath($k | split("."); $v)' "$CONFIG_JSON_PATH" > "$tmp"
  run_root cp "$tmp" "$CONFIG_JSON_PATH"
  rm -f "$tmp"
}

config_json_show() {
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    jq '.' "$CONFIG_JSON_PATH"
  else
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq '.'
  fi
config_json_to_env() {
  require_jq

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    config_json_init
  fi

  local domain image host_port container_port data_dir
  domain="$(config_json_read domain)"
  image="$(config_json_read image)"
  host_port="$(config_json_read hostPort)"
  container_port="$(config_json_read containerPort)"
  data_dir="$(config_json_read dataDir)"

  local compose_tmp
  compose_tmp="$(mktemp)"
  {
    printf '# Auto-generated from canvas-notebook-config.json — do not edit manually\n'
    printf '# Run: canvas-notebook env --sync to regenerate\n\n'
    printf 'CANVAS_IMAGE=%s\n' "$image"
    printf 'HOST_PORT=%s\n' "$host_port"
    printf 'CONTAINER_PORT=%s\n' "$container_port"
    if [[ -n "$data_dir" ]]; then
      printf 'DATA_DIR=%s\n' "$data_dir"
    fi
  } > "$compose_tmp"
  run_root cp "$compose_tmp" "$COMPOSE_ENV_PATH"
  run_root chmod 644 "$COMPOSE_ENV_PATH"
  rm -f "$compose_tmp"

  local env_tmp
  env_tmp="$(mktemp)"
  {
    printf '# Auto-generated from canvas-notebook-config.json — do not edit manually\n'
    printf '# Run: canvas-notebook env --sync to regenerate\n\n'
    jq -r '.env | to_entries[] | "\(.key)=\(.value)"' "$CONFIG_JSON_PATH"
  } > "$env_tmp"
  run_root cp "$env_tmp" "$CONFIG_ENV_PATH"
  run_root chmod 644 "$CONFIG_ENV_PATH"
  rm -f "$env_tmp"

  ok "Generated ${COMPOSE_ENV_PATH} (Compose substitution vars)"
  ok "Generated ${CONFIG_ENV_PATH} (container env vars)"
}

config_json_migrate() {
  local force=false compose_file="${COMPOSE_FILE:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-compose.yaml}"
  local manager_env="/etc/canvas-notebook/manager.env"

  for arg in "$@"; do
    if [[ "$arg" == "--force" ]]; then
      force=true
    fi
  done

  if [[ -f "$CONFIG_JSON_PATH" ]] && [[ "$force" != "true" ]]; then
    ok "config.json already exists at ${CONFIG_JSON_PATH} — use --force to overwrite"
    return 0
  fi

  require_jq

  run_root mkdir -p "$(dirname "$CONFIG_JSON_PATH")"
  printf '%s\n' "$CONFIG_JSON_DEFAULTS" | run_root tee "$CONFIG_JSON_PATH" >/dev/null

  if [[ -f "$manager_env" ]]; then
    local key value
    while IFS='=' read -r key value; do
      [[ -z "$key" ]] && continue
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d "\"'")"
      case "$key" in
        CANVAS_SWAP_ENABLED) config_json_write swap.enabled "$value" ;;
        CANVAS_SWAP_SIZE) config_json_write swap.size "$value" ;;
        CANVAS_SWAP_FILE) config_json_write swap.file "$value" ;;
        CANVAS_AUTO_UPDATE_ENABLED) config_json_write autoUpdate.enabled "$value" ;;
        CANVAS_AUTO_UPDATE_SCHEDULE) config_json_write autoUpdate.schedule "$value" ;;
        CANVAS_IMAGE) config_json_write image "$value" ;;
        DATA_DIR) config_json_write dataDir "$value" ;;
      esac
    done < "$manager_env"
    ok "Migrated settings from ${manager_env}"
  fi

  if [[ -f "$compose_file" ]]; then
    local val
    val="$(sed -n -E '/^[[:space:]]*BETTER_AUTH_SECRET:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "change-me-generate-with-openssl-rand-base64-32" ]]; then
      config_json_write env.BETTER_AUTH_SECRET "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*CANVAS_INTERNAL_API_KEY:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "change-me-generate-with-openssl-rand-base64-32" ]]; then
      config_json_write env.CANVAS_INTERNAL_API_KEY "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*BETTER_AUTH_BASE_URL:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "https://your-domain.com" ]]; then
      config_json_write env.BETTER_AUTH_BASE_URL "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*BASE_URL:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "https://your-domain.com" ]]; then
      config_json_write env.BASE_URL "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*BOOTSTRAP_ADMIN_EMAIL:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "admin@example.com" ]]; then
      config_json_write env.BOOTSTRAP_ADMIN_EMAIL "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*BOOTSTRAP_ADMIN_PASSWORD:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "change-me" ]]; then
      config_json_write env.BOOTSTRAP_ADMIN_PASSWORD "$val"
    fi
    val="$(sed -n -E '/^[[:space:]]*BOOTSTRAP_ADMIN_NAME:/ { s/^[^:]*:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$val" ]]; then
      config_json_write env.BOOTSTRAP_ADMIN_NAME "$val"
    fi

    local port_mapping
    port_mapping="$(sed -n -E '/^[[:space:]]*- *"[0-9]+:[0-9]+"/ { s/^[[:space:]]*- *"/; s/".*//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$port_mapping" ]]; then
      local h_port c_port
      h_port="$(printf '%s' "$port_mapping" | cut -d: -f1)"
      c_port="$(printf '%s' "$port_mapping" | cut -d: -f2)"
      [[ -n "$h_port" ]] && config_json_write hostPort "$h_port"
      [[ -n "$c_port" ]] && config_json_write containerPort "$c_port"
    fi

    local image_line
    image_line="$(sed -n -E '/^[[:space:]]*image:/ { s/^[[:space:]]*image:[[:space:]]*//; s/^[\"'\'']//; s/[\"'\'']$//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$image_line" ]]; then
      local clean_image
      clean_image="$(printf '%s' "$image_line" | sed 's/\${[^}]*:-\([^}]*\)}/\1/')"
      config_json_write image "$clean_image"
    fi

    local data_mount
    data_mount="$(sed -n -E '/^[[:space:]]*- *.+:\/data/ { s/^[[:space:]]*- *//; s/:\/data.*//; p; q }' "$compose_file" 2>/dev/null || true)"
    if [[ -n "$data_mount" ]]; then
      config_json_write dataDir "$data_mount"
    fi
    ok "Migrated settings from ${compose_file}"
  fi

  ok "Migration complete — config.json written to ${CONFIG_JSON_PATH}"
}