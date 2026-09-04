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
    "file": "/swapfile",
    "swappiness": 10
  },
  "autoUpdate": {
    "enabled": false,
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
    "LOG_LEVEL": "info",
    "ONBOARDING": true,
    "ONBOARDING_HINTS": false,
    "ALLOW_SIGNUP": false,
    "OLLAMA_CLI_AUTO_INSTALL": true,
    "CANVAS_DEPLOYMENT_MODE": "single_user",
    "CANVAS_DATABASE_PROVIDER": "postgres",
    "CANVAS_POSTGRES_MODE": "managed",
    "DATABASE_URL": "",
    "CANVAS_POSTGRES_VECTOR_ENABLED": true,
    "CANVAS_POSTGRES_IMAGE": "pgvector/pgvector:0.8.3-pg18",
    "CANVAS_POSTGRES_DATA_VOLUME": "canvas-postgres-data",
    "CANVAS_POSTGRES_DB": "canvas_notebook",
    "CANVAS_POSTGRES_USER": "canvas",
    "CANVAS_POSTGRES_PASSWORD": "",
    "CANVAS_STANDALONE_UPDATER_ENABLED": false,
    "CANVAS_UPDATER_GID": ""
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

_install_user() {
  if [[ -n "${SUDO_USER:-}" ]]; then
    printf '%s:%s' "$SUDO_USER" "$(id -g "$SUDO_USER" 2>/dev/null || printf '0')"
  elif [[ "$(id -u)" -ne 0 ]]; then
    printf '%s:%s' "$(id -un)" "$(id -g)"
  else
    local _dir="${CONFIG_JSON_PATH%/*}"
    local _owner
    _owner="$(stat -c '%U:%G' "$_dir" 2>/dev/null || stat -f '%Su:%Sg' "$_dir" 2>/dev/null || true)"
    if [[ -z "$_owner" || "$_owner" == "root:root" ]]; then
      local _home_owner
      _home_owner="$(stat -c '%U:%G' "$HOME" 2>/dev/null || stat -f '%Su:%Sg' "$HOME" 2>/dev/null || true)"
      if [[ -n "$_home_owner" && "$_home_owner" != "root:root" ]]; then
        _owner="$_home_owner"
      else
        _owner="1000:1000"
      fi
    fi
    printf '%s' "$_owner"
  fi
}

_config_file_owner() {
  printf '%s\n' "${CANVAS_CONFIG_FILE_OWNER:-root:root}"
}

_host_code_owner() {
  printf '%s\n' "${CANVAS_HOST_CODE_OWNER:-root:root}"
}

_atomic_write_file() {
  local dest="$1" src="$2" mode="$3" owner="$4" dir base tmp current_owner
  dir="$(dirname "$dest")"
  base="$(basename "$dest")"
  current_owner="$(id -u):$(id -g)"
  if [[ "$(id -u)" -eq 0 || "$owner" == "root:root" ]]; then
    run_root mkdir -p "$dir" || return 1
    tmp="$(run_root mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
    if ! run_root cp "$src" "$tmp" || ! run_root chown "$owner" "$tmp" || ! run_root chmod "$mode" "$tmp" || ! run_root mv -f "$tmp" "$dest"; then
      run_root rm -f "$tmp" 2>/dev/null || true
      return 1
    fi
  elif [[ "$owner" == "$current_owner" ]]; then
    mkdir -p "$dir" || return 1
    tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
    if ! cp "$src" "$tmp" || ! chmod "$mode" "$tmp" || ! mv -f "$tmp" "$dest"; then
      rm -f "$tmp" 2>/dev/null || true
      return 1
    fi
  else
    return 1
  fi
}

_write_secure_config_file() {
  _atomic_write_file "$1" "$2" 600 "$(_config_file_owner)"
}

_read_config_file() {
  local file="$1"
  if [[ -r "$file" ]]; then cat "$file"; else run_root cat "$file"; fi
}

_secure_config_file_permissions() {
  local file owner current_owner
  owner="$(_config_file_owner)"
  current_owner="$(id -u):$(id -g)"
  for file in "$CONFIG_JSON_PATH" "$CONFIG_ENV_PATH" "$COMPOSE_ENV_PATH"; do
    [[ -f "$file" ]] || continue
    if [[ "$(id -u)" -eq 0 || "$owner" == "root:root" ]]; then
      run_root chown "$owner" "$file" || return 1
      run_root chmod 600 "$file" || return 1
    elif [[ "$owner" == "$current_owner" ]]; then
      chmod 600 "$file" || return 1
    fi
  done
}

_write_owned_file() {
  local dest="$1" src="$2"
  _atomic_write_file "$dest" "$src" 644 "$(_host_code_owner)"
}

_ensure_dir_writable() {
  local dir="$1" owner current_owner
  owner="$(_host_code_owner)"
  current_owner="$(id -u):$(id -g)"
  if [[ ! -d "$dir" ]]; then
    if [[ "$owner" == "$current_owner" ]]; then
      mkdir -p "$dir" || return 1
      chmod 755 "$dir" || return 1
    else
      run_root mkdir -p "$dir" || return 1
      run_root chown "$owner" "$dir" || return 1
      run_root chmod 755 "$dir" || return 1
    fi
  elif [[ "$(id -u)" -eq 0 || "$owner" == "root:root" ]]; then
    run_root chown "$owner" "$dir" || return 1
    run_root chmod 755 "$dir" || return 1
  elif [[ "$owner" == "$current_owner" ]]; then
    chmod 755 "$dir" || return 1
  fi
}

config_json_init() {
  require_jq || return 1
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    _ensure_dir_writable "$(dirname "$CONFIG_JSON_PATH")" || return 1
    local tmp
    tmp="$(mktemp)" || return 1
    if ! printf '%s\n' "$CONFIG_JSON_DEFAULTS" > "$tmp" || ! _write_secure_config_file "$CONFIG_JSON_PATH" "$tmp"; then
      rm -f "$tmp"
      return 1
    fi
    rm -f "$tmp" || true
    if [[ "${OUTPUT_JSON:-false}" != "true" && "${NO_BANNER:-false}" != "true" ]]; then
      ok "Created default config at ${CONFIG_JSON_PATH}"
    fi
  fi
}

config_json_read() {
  local key="$1"
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq -r --arg k "$key" 'getpath($k | split(".")) // empty'
    return
  fi
  _read_config_file "$CONFIG_JSON_PATH" | jq -r --arg k "$key" 'getpath($k | split(".")) // empty'
}

config_json_read_raw() {
  local key="$1"
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq --arg k "$key" 'getpath($k | split("."))'
    return
  fi
  _read_config_file "$CONFIG_JSON_PATH" | jq --arg k "$key" 'getpath($k | split("."))'
}

config_json_encode_string() {
  jq -Rs '.'
}

config_json_write() {
  local key="$1" value="$2" tmp

  require_jq || return 1

  case "$key" in
    swap.size)
      if ! printf '%s' "$value" | grep -qE '^[0-9]+[KMGTkmgt]$'; then
        fail "Invalid swap size '${value}'. Expected format: <number>[K|M|G|T] (e.g. 2G, 512M)"
      fi
      local swap_amount swap_unit swap_number
      swap_amount="${value%?}"
      swap_unit="$(printf '%s' "${value: -1}" | tr '[:lower:]' '[:upper:]')"
      [[ "${#swap_amount}" -le 8 ]] || fail "Swap size must be between 128M and 16G"
      swap_number=$((10#$swap_amount))
      case "$swap_unit" in
        K) [[ "$swap_number" -ge 131072 && "$swap_number" -le 16777216 ]] || fail "Swap size must be between 128M and 16G" ;;
        M) [[ "$swap_number" -ge 128 && "$swap_number" -le 16384 ]] || fail "Swap size must be between 128M and 16G" ;;
        G) [[ "$swap_number" -ge 1 && "$swap_number" -le 16 ]] || fail "Swap size must be between 128M and 16G" ;;
        T) fail "Swap size must be between 128M and 16G" ;;
      esac
      ;;
    swap.file)
      if [[ "$value" != "${CANVAS_SWAP_MANAGED_FILE:-/swapfile}" ]]; then
        fail "Canvas-managed swap file path must be ${CANVAS_SWAP_MANAGED_FILE:-/swapfile}"
      fi
      ;;
    swap.swappiness)
      if ! printf '%s' "$value" | grep -qE '^[0-9]+$' || [[ "$value" -lt 0 || "$value" -gt 200 ]]; then
        fail "Swap swappiness must be an integer between 0 and 200"
      fi
      ;;
    swap.enabled)
      value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | xargs)"
      case "$value" in
        true|1|yes|on) value=true ;;
        false|0|no|off|disabled) value=false ;;
        *) fail "Swap enabled must be true or false" ;;
      esac
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
        _config_json_write_raw "domain" "$(printf '%s' "$extracted_domain" | config_json_encode_string)" || return 1
        local base_url
        base_url="$value"
        _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "$(printf '%s' "$base_url" | config_json_encode_string)" || return 1
        _config_json_write_raw "env.BASE_URL" "$(printf '%s' "$base_url" | config_json_encode_string)" || return 1
        return
      fi
      ;;
    env.BASE_URL)
      if [[ -n "$value" ]]; then
        local extracted_domain
        extracted_domain="$(printf '%s' "$value" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1)"
        _config_json_write_raw "domain" "$(printf '%s' "$extracted_domain" | config_json_encode_string)" || return 1
        _config_json_write_raw "env.BASE_URL" "$(printf '%s' "$value" | config_json_encode_string)" || return 1
        local current_auth_url
        current_auth_url="$(config_json_read env.BETTER_AUTH_BASE_URL)"
        if [[ -z "$current_auth_url" ]]; then
          _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "$(printf '%s' "$value" | config_json_encode_string)" || return 1
        fi
        return
      fi
      ;;
    env.CANVAS_DATABASE_PROVIDER)
      value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | xargs)"
      if [[ "$value" != "sqlite" && "$value" != "postgres" ]]; then
        fail "Invalid CANVAS_DATABASE_PROVIDER '${value}'. Expected sqlite or postgres."
      fi
      ;;
    env.CANVAS_POSTGRES_MODE)
      value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | xargs)"
      if [[ -n "$value" && "$value" != "managed" && "$value" != "external" ]]; then
        fail "Invalid CANVAS_POSTGRES_MODE '${value}'. Expected managed or external."
      fi
      ;;
    env.CANVAS_DEPLOYMENT_MODE)
      value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | xargs)"
      ;;
    env.DATABASE_URL)
      if [[ -n "$value" && ! "$value" =~ ^postgres(ql)?:// ]]; then
        fail "DATABASE_URL must use postgres:// or postgresql://"
      fi
      ;;
    env.*)
      ;;
  esac

  if printf '%s' "$value" | grep -qE '^-?[0-9]+$'; then
    _config_json_write_raw "$key" "$value" || return 1
  elif [[ "$value" == "true" || "$value" == "false" ]]; then
    _config_json_write_raw "$key" "$value" || return 1
  else
    _config_json_write_raw "$key" "$(printf '%s' "$value" | config_json_encode_string)" || return 1
  fi

  if [[ "$key" == "domain" ]] && [[ -n "$value" ]]; then
    local base_url="https://${value}"
    _config_json_write_raw "env.BETTER_AUTH_BASE_URL" "$(printf '%s' "$base_url" | config_json_encode_string)" || return 1
    _config_json_write_raw "env.BASE_URL" "$(printf '%s' "$base_url" | config_json_encode_string)" || return 1
  fi
}

config_json_normalize_database_provider() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$value" in
    ""|sqlite) printf 'sqlite\n' ;;
    postgres) printf 'postgres\n' ;;
    *) fail "Invalid CANVAS_DATABASE_PROVIDER '${value}'. Expected sqlite or postgres." ;;
  esac
}

config_json_normalize_postgres_mode() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$value" in
    ""|managed) printf 'managed\n' ;;
    external) printf 'external\n' ;;
    *) fail "Invalid CANVAS_POSTGRES_MODE '${value}'. Expected managed or external." ;;
  esac
}

config_json_managed_by_control_plane() {
  local managed control_plane_url
  managed="$(config_json_read env.CANVAS_MANAGED_SERVICES_ENABLED)"
  control_plane_url="$(config_json_read env.CANVAS_CONTROL_PLANE_URL)"
  case "$(printf '%s' "$managed" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) return 0 ;;
  esac
  [[ -n "$control_plane_url" ]]
}

config_json_image_is_pinned() {
  local image_ref="$1"
  [[ "$image_ref" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$ ]]
}

config_json_deployment_requires_postgres() {
  local deployment_mode="$1" team_features="${2:-}"
  deployment_mode="$(printf '%s' "$deployment_mode" | tr '[:upper:]' '[:lower:]')"
  team_features="$(printf '%s' "$team_features" | tr '[:upper:]' '[:lower:]')"

  case "$deployment_mode" in
    *team*|*enterprise*|*advanced*) return 0 ;;
  esac

  case "$team_features" in
    true|1|yes|on) return 0 ;;
  esac

  return 1
}

config_json_generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  date +%s%N | sha256sum | awk '{print $1}'
}

config_json_url_decode_component() {
  local value="$1" decoded="" rest="$1" prefix hex char
  while [[ "$rest" == *%* ]]; do
    prefix="${rest%%\%*}"
    decoded+="$prefix"
    rest="${rest#*%}"
    hex="${rest:0:2}"
    if [[ ! "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
      fail "DATABASE_URL contains invalid percent encoding."
    fi
    printf -v char "\\x$hex"
    decoded+="$char"
    rest="${rest:2}"
  done
  printf '%s\n' "${decoded}${rest}"
}

config_json_require_url_safe_postgres_part() {
  local key="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    fail "${key} contains URL-reserved characters. Set DATABASE_URL explicitly or use URL-safe Postgres credentials."
  fi
}

config_json_decode_postgres_url_part() {
  local key="$1" value="$2" decoded
  decoded="$(config_json_url_decode_component "$value")" || return 1
  config_json_require_url_safe_postgres_part "$key" "$decoded" || return 1
  printf '%s\n' "$decoded"
}

config_json_decode_postgres_password() {
  local value="$1" decoded
  if [[ "$value" =~ %([0][0AaDd]) ]]; then
    fail "CANVAS_POSTGRES_PASSWORD contains unsafe control characters."
  fi
  decoded="$(config_json_url_decode_component "$value")" || return 1
  if [[ "$decoded" == *$'\n'* || "$decoded" == *$'\r'* || "$decoded" == *"***"* || "$decoded" == "(not set)" ]]; then
    fail "CANVAS_POSTGRES_PASSWORD contains unsafe or masked content."
  fi
  printf '%s\n' "$decoded"
}

config_json_ensure_database_config() {
  local deployment_mode team_features provider provider_raw postgres_mode database_url pg_image pg_volume pg_db pg_user pg_password
  deployment_mode="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  deployment_mode="${deployment_mode:-single_user}"
  team_features="$(config_json_read env.CANVAS_TEAM_FEATURES_ENABLED)"
  provider_raw="$(config_json_read env.CANVAS_DATABASE_PROVIDER)"
  database_url="$(config_json_read env.DATABASE_URL)"
  if [[ -z "$(printf '%s' "$provider_raw" | xargs)" && "$database_url" =~ ^postgres(ql)?:// ]]; then
    provider="postgres"
  else
    provider="$(config_json_normalize_database_provider "$provider_raw")" || return 1
  fi

  if config_json_deployment_requires_postgres "$deployment_mode" "$team_features" && [[ "$provider" != "postgres" ]]; then
    if [[ "${CANVAS_ALLOW_SQLITE_POSTGRES_PREPARE:-false}" != "true" ]]; then
      fail "${deployment_mode} requires CANVAS_DATABASE_PROVIDER=postgres."
    fi
    config_json_write env.CANVAS_POSTGRES_REQUIRED true
  fi

  config_json_write env.CANVAS_DEPLOYMENT_MODE "$deployment_mode"
  config_json_write env.CANVAS_DATABASE_PROVIDER "$provider"

  if [[ "$provider" != "postgres" ]]; then
    config_json_write env.CANVAS_POSTGRES_MODE ""
    config_json_write env.CANVAS_POSTGRES_VECTOR_ENABLED false
    return 0
  fi

  postgres_mode="$(config_json_normalize_postgres_mode "$(config_json_read env.CANVAS_POSTGRES_MODE)")" || return 1
  config_json_write env.CANVAS_POSTGRES_MODE "$postgres_mode"
  if [[ "$postgres_mode" == "external" ]]; then
    if [[ -z "$database_url" ]]; then
      fail "External Postgres requires DATABASE_URL."
    fi
    if [[ ! "$database_url" =~ ^postgres(ql)?:// ]]; then
      fail "DATABASE_URL must use postgres:// or postgresql://"
    fi
    config_json_write env.CANVAS_POSTGRES_PASSWORD ""
    return 0
  fi

  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_image="${pg_image:-pgvector/pgvector:0.8.3-pg18}"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  pg_volume="${pg_volume:-canvas-postgres-data}"
  pg_db="$(config_json_read env.CANVAS_POSTGRES_DB)"
  pg_db="${pg_db:-canvas_notebook}"
  pg_user="$(config_json_read env.CANVAS_POSTGRES_USER)"
  pg_user="${pg_user:-canvas}"
  pg_password="$(config_json_read env.CANVAS_POSTGRES_PASSWORD)"
  if [[ -n "$database_url" ]]; then
    if [[ "$database_url" =~ ^postgres(ql)?://([^:/@]+):([^@]+)@[^/]+/([^/?#]+) ]]; then
      pg_user="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_USER "${BASH_REMATCH[2]}")" || return 1
      pg_password="$(config_json_decode_postgres_password "${BASH_REMATCH[3]}")" || return 1
      pg_db="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_DB "${BASH_REMATCH[4]}")" || return 1
    elif [[ "$database_url" =~ ^postgres(ql)?:// ]]; then
      fail "DATABASE_URL must include user, password, host, and database for managed Postgres."
    fi
  fi

  if [[ -z "$database_url" ]]; then
    if [[ -z "$pg_password" ]]; then
      if [[ "${CANVAS_ALLOW_POSTGRES_SECRET_GENERATION:-true}" != "true" ]]; then
        fail "Managed Postgres credentials are missing. Run: canvas-notebook database prepare-postgres"
      fi
      pg_password="$(config_json_generate_secret)"
      config_json_write env.CANVAS_POSTGRES_PASSWORD "$pg_password"
    fi
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_USER "$pg_user"
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_PASSWORD "$pg_password"
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_DB "$pg_db"
    database_url="postgresql://${pg_user}:${pg_password}@postgres:5432/${pg_db}"
    config_json_write env.DATABASE_URL "$database_url"
  elif [[ ! "$database_url" =~ ^postgres(ql)?:// ]]; then
    fail "DATABASE_URL must use postgres:// or postgresql://"
  fi

  config_json_write env.CANVAS_POSTGRES_VECTOR_ENABLED true
  config_json_write env.CANVAS_POSTGRES_IMAGE "$pg_image"
  config_json_write env.CANVAS_POSTGRES_DATA_VOLUME "$pg_volume"
  config_json_write env.CANVAS_POSTGRES_DB "$pg_db"
  config_json_write env.CANVAS_POSTGRES_USER "$pg_user"
  config_json_write env.CANVAS_POSTGRES_PASSWORD "$pg_password"
}

config_json_ensure_postgres_infrastructure_config() {
  local pg_image pg_volume pg_db pg_user pg_password database_url
  if [[ "$(config_json_normalize_postgres_mode "$(config_json_read env.CANVAS_POSTGRES_MODE)")" != "managed" ]]; then
    fail "Managed Postgres infrastructure cannot be prepared when CANVAS_POSTGRES_MODE=external."
  fi
  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_image="${pg_image:-pgvector/pgvector:0.8.3-pg18}"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  pg_volume="${pg_volume:-canvas-postgres-data}"
  pg_db="$(config_json_read env.CANVAS_POSTGRES_DB)"
  pg_db="${pg_db:-canvas_notebook}"
  pg_user="$(config_json_read env.CANVAS_POSTGRES_USER)"
  pg_user="${pg_user:-canvas}"
  pg_password="$(config_json_read env.CANVAS_POSTGRES_PASSWORD)"
  database_url="$(config_json_read env.DATABASE_URL)"
  if [[ -n "$database_url" ]]; then
    if [[ "$database_url" =~ ^postgres(ql)?://([^:/@]+):([^@]+)@[^/]+/([^/?#]+) ]]; then
      pg_user="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_USER "${BASH_REMATCH[2]}")" || return 1
      pg_password="$(config_json_decode_postgres_password "${BASH_REMATCH[3]}")" || return 1
      pg_db="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_DB "${BASH_REMATCH[4]}")" || return 1
    elif [[ "$database_url" =~ ^postgres(ql)?:// ]]; then
      fail "DATABASE_URL must include user, password, host, and database for managed Postgres."
    fi
  fi
  if [[ -z "$pg_password" ]]; then
    if [[ "${CANVAS_ALLOW_POSTGRES_SECRET_GENERATION:-true}" != "true" ]]; then
      fail "Managed Postgres credentials are missing. Run: canvas-notebook database prepare-postgres"
    fi
    pg_password="$(config_json_generate_secret)"
  fi

  if [[ -z "$database_url" ]]; then
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_USER "$pg_user"
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_PASSWORD "$pg_password"
    config_json_require_url_safe_postgres_part CANVAS_POSTGRES_DB "$pg_db"
    database_url="postgresql://${pg_user}:${pg_password}@postgres:5432/${pg_db}"
  elif [[ ! "$database_url" =~ ^postgres(ql)?:// ]]; then
    fail "DATABASE_URL must use postgres:// or postgresql://"
  fi

  config_json_write env.CANVAS_POSTGRES_REQUIRED true
  config_json_write env.CANVAS_POSTGRES_MODE managed
  config_json_write env.CANVAS_POSTGRES_IMAGE "$pg_image"
  config_json_write env.CANVAS_POSTGRES_DATA_VOLUME "$pg_volume"
  config_json_write env.CANVAS_POSTGRES_DB "$pg_db"
  config_json_write env.CANVAS_POSTGRES_USER "$pg_user"
  config_json_write env.CANVAS_POSTGRES_PASSWORD "$pg_password"
  config_json_write env.DATABASE_URL "$database_url"
}

_config_json_write_raw() {
  local key="$1" json_value="$2" tmp

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    config_json_init || return 1
  fi

  tmp="$(mktemp)" || return 1
  if ! _read_config_file "$CONFIG_JSON_PATH" | jq --arg k "$key" --argjson v "$json_value" 'setpath($k | split("."); $v)' > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! _write_secure_config_file "$CONFIG_JSON_PATH" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp" || true
}

config_json_write_swap() {
  local enabled="$1" size="$2" file="$3" swappiness="$4" tmp
  if declare -f swap_validate_config >/dev/null 2>&1; then
    swap_validate_config "$enabled" "$size" "$file" "$swappiness" || return 1
  fi
  config_json_init || return 1
  tmp="$(mktemp)" || return 1
  if ! jq \
    --argjson enabled "$enabled" \
    --arg size "$size" \
    --arg file "$file" \
    --argjson swappiness "$swappiness" \
    '.swap = { enabled: $enabled, size: $size, file: $file, swappiness: $swappiness }' \
    <(_read_config_file "$CONFIG_JSON_PATH") > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  _write_secure_config_file "$CONFIG_JSON_PATH" "$tmp" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp" || true
}

config_json_show() {
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    _read_config_file "$CONFIG_JSON_PATH" | jq '.'
  else
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" | jq '.'
  fi
}

config_json_env_key_is_secret() {
  local key="$1"
  key="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')"
  [[ "$key" == "DATABASE_URL" ]] && return 0
  [[ "$key" =~ (^|_)(PASSWORD|PASSWD|SECRET_KEY|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|LICENSE_CERT)$ ]]
}

config_json_mask_secrets() {
  jq '
    .env |= with_entries(
      if ((.key | ascii_upcase) == "DATABASE_URL" or (.key | test("(^|_)(PASSWORD|PASSWD|SECRET_KEY|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|LICENSE_CERT)$"; "i"))) then
        .value = (
          if (.value == null or .value == "") then "(not set)"
          elif (.key | ascii_upcase) == "DATABASE_URL" then "postgresql://***"
          else ((.value | tostring) | .[0:4] + "***")
          end
        )
      else . end
    )
    | reduce ["BETTER_AUTH_SECRET", "CANVAS_INTERNAL_API_KEY", "DATABASE_URL", "CANVAS_POSTGRES_PASSWORD"][] as $key
        (. ; if (.env | has($key)) then . else .env[$key] = "(not set)" end)
  '
}

config_json_to_env() {
  require_jq

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    config_json_init
  fi

  config_json_ensure_database_config

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
  local database_provider postgres_mode postgres_profile postgres_image postgres_volume postgres_db postgres_user postgres_password updater_enabled updater_gid
  database_provider="$(config_json_normalize_database_provider "$(config_json_read env.CANVAS_DATABASE_PROVIDER)")"
  postgres_mode="$(config_json_read env.CANVAS_POSTGRES_MODE)"
  if [[ "$database_provider" == "postgres" ]]; then
    postgres_mode="$(config_json_normalize_postgres_mode "$postgres_mode")"
  else
    postgres_mode=""
  fi
  if [[ "$database_provider" == "postgres" && "$postgres_mode" == "managed" ]]; then
    postgres_profile="postgres"
  else
    postgres_profile=""
  fi
  postgres_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  postgres_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  postgres_db="$(config_json_read env.CANVAS_POSTGRES_DB)"
  postgres_user="$(config_json_read env.CANVAS_POSTGRES_USER)"
  postgres_password="$(config_json_read env.CANVAS_POSTGRES_PASSWORD)"
  updater_enabled="$(config_json_read env.CANVAS_STANDALONE_UPDATER_ENABLED)"
  updater_gid="$(config_json_read env.CANVAS_UPDATER_GID)"
  {
    printf 'COMPOSE_PROFILES=%s\n' "$postgres_profile"
    printf 'CANVAS_DATABASE_PROVIDER=%s\n' "$database_provider"
    printf 'CANVAS_POSTGRES_MODE=%s\n' "$postgres_mode"
    printf 'CANVAS_POSTGRES_IMAGE=%s\n' "${postgres_image:-pgvector/pgvector:0.8.3-pg18}"
    printf 'CANVAS_POSTGRES_DATA_VOLUME=%s\n' "${postgres_volume:-canvas-postgres-data}"
    printf 'CANVAS_POSTGRES_DB=%s\n' "${postgres_db:-canvas_notebook}"
    printf 'CANVAS_POSTGRES_USER=%s\n' "${postgres_user:-canvas}"
    printf 'CANVAS_POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'CANVAS_STANDALONE_UPDATER_ENABLED=%s\n' "${updater_enabled:-false}"
    printf 'CANVAS_UPDATER_GID=%s\n' "$updater_gid"
  } >> "$compose_tmp"
  _write_secure_config_file "$COMPOSE_ENV_PATH" "$compose_tmp"
  rm -f "$compose_tmp"

  local env_tmp
  env_tmp="$(mktemp)"
  {
    printf '# Auto-generated from canvas-notebook-config.json — do not edit manually\n'
    printf '# Run: canvas-notebook env --sync to regenerate\n\n'
    _read_config_file "$CONFIG_JSON_PATH" | jq -r '.env | to_entries[] | "\(.key)=\(.value)"'
  } > "$env_tmp"
  _write_secure_config_file "$CONFIG_ENV_PATH" "$env_tmp"
  rm -f "$env_tmp"

  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    ok "Generated ${COMPOSE_ENV_PATH} (Compose substitution vars)"
    ok "Generated ${CONFIG_ENV_PATH} (container env vars)"
  fi
}

config_json_migrate() {
  local force=false compose_file="${COMPOSE_FILE:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-compose.yaml}"
  local manager_env="${CANVAS_MANAGER_ENV_PATH:-/etc/canvas-notebook/manager.env}" target_config_path migration_config_path

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

  target_config_path="$CONFIG_JSON_PATH"
  migration_config_path="${target_config_path}.migration.$$"
  _ensure_dir_writable "$(dirname "$target_config_path")"
  run_root rm -f "$migration_config_path"
  local mig_tmp
  mig_tmp="$(mktemp)"
  printf '%s\n' "$CONFIG_JSON_DEFAULTS" > "$mig_tmp"
  _write_secure_config_file "$migration_config_path" "$mig_tmp"
  rm -f "$mig_tmp"
  CONFIG_JSON_PATH="$migration_config_path"

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
        CANVAS_SWAP_SWAPPINESS) config_json_write swap.swappiness "$value" ;;
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

  CONFIG_JSON_PATH="$target_config_path"
  if ! run_root mv -f "$migration_config_path" "$target_config_path"; then
    run_root rm -f "$migration_config_path" >/dev/null 2>&1 || true
    return 1
  fi
  ok "Migration complete — config.json written to ${target_config_path}"
}
