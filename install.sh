#!/usr/bin/env bash
# Canvas Notebook installer.
# Thin entrypoint; implementation lives in install/lib and install/bin.

set -euo pipefail

REPO="https://github.com/canvascoding/canvas-notebook.git"
ARCHIVE_URL="https://github.com/canvascoding/canvas-notebook/archive/refs/heads/main.tar.gz"
COMPOSE_URL="https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/compose.hub.yaml"
IMAGE="ghcr.io/canvascoding/canvas-notebook:latest"
DEST="canvas-notebook"
COMPOSE_FILE_NAME="canvas-notebook-compose.yaml"
SYSTEMD_SERVICE="canvas-notebook.service"
INSTALL_DIR="${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}"
INSTALL_USER="${SUDO_USER:-${USER:-$(id -un)}}"
INSTALL_USER_HOME="$(getent passwd "$INSTALL_USER" 2>/dev/null | cut -d: -f6 || true)"
INSTALL_USER_HOME="${INSTALL_USER_HOME:-${HOME:-/opt}}"
DATA_DIR="${CANVAS_DATA_DIR:-${INSTALL_USER_HOME}/canvas-notebook-data}"
CONFIG_JSON_PATH="${CANVAS_CONFIG_JSON:-${INSTALL_DIR}/canvas-notebook-config.json}"
COMPOSE_FILE="${CANVAS_COMPOSE_FILE:-${INSTALL_DIR}/canvas-notebook-compose.yaml}"
SERVICE="${CANVAS_SERVICE:-canvas-notebook}"
LOG_DIR="${CANVAS_MANAGER_LOG_DIR:-/var/log/canvas-notebook}"
LOG_FILE="${LOG_DIR}/manager.log"
DOCKER_COMPOSE="docker compose"
CANVAS_SWAP_ENABLED_WAS_SET="${CANVAS_SWAP_ENABLED+x}"
CANVAS_SWAP_SIZE_WAS_SET="${CANVAS_SWAP_SIZE+x}"
CANVAS_SWAP_FILE_WAS_SET="${CANVAS_SWAP_FILE+x}"
CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-false}"
CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
CANVAS_AUTO_UPDATE_ENABLED_WAS_SET="${CANVAS_AUTO_UPDATE_ENABLED+x}"
CANVAS_AUTO_UPDATE_SCHEDULE_WAS_SET="${CANVAS_AUTO_UPDATE_SCHEDULE+x}"
CANVAS_AUTO_UPDATE_ENABLED="${CANVAS_AUTO_UPDATE_ENABLED:-true}"
CANVAS_AUTO_UPDATE_SCHEDULE="${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}"
LEGACY_COMPOSE_PATH=""
LEGACY_DATA_PATH=""
SUPPORT_TMP_DIR=""

cleanup_support_tmp() {
  if [[ -n "$SUPPORT_TMP_DIR" ]]; then
    rm -rf "$SUPPORT_TMP_DIR"
  fi
}
trap cleanup_support_tmp EXIT

load_existing_manager_config() {
  local manager_env="/etc/canvas-notebook/manager.env"
  if [[ ! -f "$manager_env" ]]; then
    return 0
  fi

  if [[ -z "$CANVAS_SWAP_ENABLED_WAS_SET" ]]; then
    CANVAS_SWAP_ENABLED="$(awk -F= '/^CANVAS_SWAP_ENABLED=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$manager_env")"
  fi
  if [[ -z "$CANVAS_SWAP_SIZE_WAS_SET" ]]; then
    CANVAS_SWAP_SIZE="$(awk -F= '/^CANVAS_SWAP_SIZE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$manager_env")"
  fi
  if [[ -z "$CANVAS_SWAP_FILE_WAS_SET" ]]; then
    CANVAS_SWAP_FILE="$(awk -F= '/^CANVAS_SWAP_FILE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$manager_env")"
  fi
CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-true}"
  CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
  CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
  if [[ -z "$CANVAS_AUTO_UPDATE_ENABLED_WAS_SET" ]]; then
    CANVAS_AUTO_UPDATE_ENABLED="$(awk -F= '/^CANVAS_AUTO_UPDATE_ENABLED=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$manager_env")"
  fi
  if [[ -z "$CANVAS_AUTO_UPDATE_SCHEDULE_WAS_SET" ]]; then
    CANVAS_AUTO_UPDATE_SCHEDULE="$(awk -F= '/^CANVAS_AUTO_UPDATE_SCHEDULE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$manager_env")"
  fi
  CANVAS_AUTO_UPDATE_ENABLED="${CANVAS_AUTO_UPDATE_ENABLED:-true}"
  CANVAS_AUTO_UPDATE_SCHEDULE="${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}"
}

resolve_support_dir() {
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P || true)"
  if [[ -n "$script_dir" && -x "${script_dir}/install/bin/canvas-notebook" ]]; then
    SUPPORT_DIR="${script_dir}/install"
    return 0
  fi

  SUPPORT_TMP_DIR="$(mktemp -d)"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to bootstrap installer support files." >&2
    exit 1
  fi
  curl -fsSL "$ARCHIVE_URL" -o "${SUPPORT_TMP_DIR}/canvas-notebook.tar.gz"
  tar -xzf "${SUPPORT_TMP_DIR}/canvas-notebook.tar.gz" -C "$SUPPORT_TMP_DIR"
  SUPPORT_DIR="${SUPPORT_TMP_DIR}/canvas-notebook-main/install"
  if [[ ! -x "${SUPPORT_DIR}/bin/canvas-notebook" ]]; then
    echo "Installer support files are missing from ${ARCHIVE_URL}." >&2
    exit 1
  fi
}

source_libs() {
  # shellcheck source=install/lib/common.sh
  . "${SUPPORT_DIR}/lib/common.sh"
  # Shared libs are sourced by their respective installer modules:
  # common.sh -> shared/output.sh, shared/utils.sh, shared/config_json.sh
  # docker.sh -> shared/docker.sh
  # swap.sh   -> shared/swap.sh
  # caddy.sh  -> shared/caddy.sh
  # compose.sh -> shared/container.sh
  # shellcheck source=install/lib/docker.sh
  . "${SUPPORT_DIR}/lib/docker.sh"
  # shellcheck source=install/lib/swap.sh
  . "${SUPPORT_DIR}/lib/swap.sh"
  # shellcheck source=install/lib/caddy.sh
  . "${SUPPORT_DIR}/lib/caddy.sh"
  # shellcheck source=install/lib/compose.sh
  . "${SUPPORT_DIR}/lib/compose.sh"
  # shellcheck source=install/lib/systemd.sh
  . "${SUPPORT_DIR}/lib/systemd.sh"
}

is_inside_container() {
  [[ -f /.dockerenv ]] && return 0
  grep -qaE '(docker|kubepods|containerd|lxc)' /proc/1/cgroup 2>/dev/null
}

ensure_host_install() {
  if is_inside_container; then
    fail "This installer must run on the VM host, not inside a container. The management CLI and systemd service need host-level access."
  fi
}

print_banner() {
  local _bi='\033[1m' _ri='\033[0m'
  echo
  echo -e "${_bi}╔══════════════════════════════════════════╗${_ri}"
  echo -e "${_bi}║   Canvas Notebook  —  Installer          ║${_ri}"
  echo -e "${_bi}╚══════════════════════════════════════════╝${_ri}"
  echo
}

detect_mode() {
  NONINTERACTIVE=false
  if [[ -n "${INSTALL_MODE:-}" || -n "${ADMIN_EMAIL:-}" || -n "${BASE_URL:-}" || "${CLI_UPDATE_ONLY:-false}" == "true" ]]; then
    NONINTERACTIVE=true
  fi

  if [[ "$NONINTERACTIVE" == "true" ]]; then
    MODE_CHOICE="${INSTALL_MODE:-1}"
    if [[ -z "${SETUP_CADDY:-}" ]]; then
      local _domain_candidate
      _domain_candidate="${BASE_URL:-}"
      _domain_candidate="$(printf '%s' "$_domain_candidate" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1)"
      if is_real_domain "$_domain_candidate"; then
        SETUP_CADDY=true
        info "Auto-enabled Caddy setup (domain detected: ${_domain_candidate})"
      else
        SETUP_CADDY=false
      fi
    fi
    info "Non-interactive mode — INSTALL_MODE=${MODE_CHOICE}, SETUP_CADDY=${SETUP_CADDY}"
  else
    echo "How would you like to install Canvas Notebook?"
    echo
    echo "  1) Pre-built image  (recommended — fast, no build required)"
    echo "  2) From source      (for developers or custom builds)"
    echo
    ask "Choice [1/2, default 1]: " MODE_CHOICE "1"

    SETUP_CADDY=false
    if [[ "$MODE_CHOICE" == "1" ]]; then
      echo
      ask "Set up Caddy for public HTTPS access? [y/N]: " CADDY_ANSWER "n"
      if [[ "${CADDY_ANSWER,,}" == "y" || "${CADDY_ANSWER,,}" == "yes" || "${CADDY_ANSWER}" == "1" ]]; then
        SETUP_CADDY=true
      fi
    fi
  fi
  export SETUP_CADDY MODE_CHOICE
}

install_compose_file() {
  section "Compose file"
  if [[ -f "$COMPOSE_FILE" ]]; then
    ok "${COMPOSE_FILE} already exists — keeping existing config"
  else
    curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"
    ok "Downloaded ${COMPOSE_FILE}"
  fi
}

configure_secrets() {
  local auth_secret internal_key
  section "Secrets"
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    auth_secret="$(jq -r '.env.BETTER_AUTH_SECRET // empty' "$CONFIG_JSON_PATH")"
    internal_key="$(jq -r '.env.CANVAS_INTERNAL_API_KEY // empty' "$CONFIG_JSON_PATH")"
  fi
  if [[ -z "$auth_secret" ]]; then
    auth_secret="$(openssl rand -base64 32)"
    config_json_write env.BETTER_AUTH_SECRET "$auth_secret"
    ok "Generated BETTER_AUTH_SECRET"
  else
    ok "BETTER_AUTH_SECRET already set"
  fi
  if [[ -z "$internal_key" ]]; then
    internal_key="$(openssl rand -base64 32)"
    config_json_write env.CANVAS_INTERNAL_API_KEY "$internal_key"
    ok "Generated CANVAS_INTERNAL_API_KEY"
  else
    ok "CANVAS_INTERNAL_API_KEY already set"
  fi
}

configure_compose_values() {
  if [[ -n "${BASE_URL:-}" ]]; then
    config_json_write env.BETTER_AUTH_BASE_URL "$BASE_URL"
    config_json_write env.BASE_URL "$BASE_URL"
    ok "Set BASE_URL / BETTER_AUTH_BASE_URL"
  fi
  local managed_env_key
  for managed_env_key in \
    CANVAS_MANAGED_SERVICES_ENABLED \
    CANVAS_CONTROL_PLANE_URL \
    CANVAS_LICENSE_CONTROL_PLANE_URL \
    NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL \
    CANVAS_INSTANCE_ID \
    CANVAS_INSTANCE_TOKEN \
    CANVAS_LICENSE_CERT \
    CANVAS_LICENSE_PUBLIC_KEY \
    CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS \
    CANVAS_RUNTIME_SCOPE \
    CANVAS_ORGANIZATION_ID \
    CANVAS_TEAM_FEATURES_ENABLED \
    CANVAS_MULTI_USER_ENABLED \
    CANVAS_PERSONAL_WORKSPACES_ENABLED \
    CANVAS_TEAM_WORKSPACE_ENABLED \
    CANVAS_TEAM_KNOWLEDGE_BASE_ENABLED \
    CANVAS_AUDIT_TRAIL_ENABLED \
    CANVAS_MANAGED_BACKUPS_ENABLED; do
    if [[ -n "${!managed_env_key:-}" ]]; then
      config_json_write "env.${managed_env_key}" "${!managed_env_key}"
      ok "Set ${managed_env_key}"
    fi
  done

  local has_placeholders=false
  local url_val domain_val
  url_val="$(jq -r '.env.BETTER_AUTH_BASE_URL // empty' "$CONFIG_JSON_PATH")"
  domain_val="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH")"

  if [[ -z "$url_val" && -z "$domain_val" ]]; then
    has_placeholders=true
  fi

  if [[ "$has_placeholders" == "true" ]]; then
    if [[ "$NONINTERACTIVE" == "true" ]]; then
      fail "Config still contains placeholder values. Required: BASE_URL"
    fi
    section "Configuration"
    echo
    info "Set at minimum:"
    info "  domain                   — public domain (e.g. app.example.com)"
    echo
    info "The first admin can be created in the setup UI after launch."
    info "For automation, pass ADMIN_EMAIL and ADMIN_PASSWORD to this installer; they will be applied once and not stored."
    echo
    info "Config file: ${CONFIG_JSON_PATH}"

    EDITOR_CMD="${EDITOR:-nano}"
    command -v "$EDITOR_CMD" >/dev/null 2>&1 || EDITOR_CMD="vi"
    ask "  Press Enter to open ${CONFIG_JSON_PATH} in ${EDITOR_CMD}, or Ctrl+C to abort: " _dummy ""
    "$EDITOR_CMD" "$CONFIG_JSON_PATH" </dev/tty

    domain_val="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH")"
    if [[ -z "$domain_val" ]]; then
      fail "Config still contains placeholder values. Edit ${CONFIG_JSON_PATH} and re-run: bash install.sh"
    fi
  fi

  ok "Configuration is set"
}

configure_database_values() {
  local current_deployment current_provider deployment_mode provider provider_choice deployment_choice team_features
  local deployment_choice_default provider_choice_default database_env_key

  current_deployment="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  current_deployment="${current_deployment:-single_user}"
  current_provider="$(config_json_read env.CANVAS_DATABASE_PROVIDER)"
  current_provider="$(config_json_normalize_database_provider "${current_provider:-sqlite}")"

  if [[ "$NONINTERACTIVE" == "true" ]]; then
    deployment_mode="${CANVAS_DEPLOYMENT_MODE:-$current_deployment}"
    provider="${CANVAS_DATABASE_PROVIDER:-$current_provider}"
  else
    section "Database"
    echo "Choose the deployment scope:"
    echo
    echo "  1) Single-user / community  (SQLite allowed)"
    echo "  2) Team / advanced          (Postgres + pgvector required)"
    echo
    if config_json_deployment_requires_postgres "$current_deployment" "$(config_json_read env.CANVAS_TEAM_FEATURES_ENABLED)"; then
      deployment_choice_default="2"
    else
      deployment_choice_default="1"
    fi
    ask "Choice [1/2, default ${deployment_choice_default}]: " deployment_choice "$deployment_choice_default"
    if [[ "$deployment_choice" == "2" ]]; then
      deployment_mode="managed-team"
      provider="postgres"
      info "Team/advanced mode requires Postgres; configuring the local pgvector Postgres service."
    else
      deployment_mode="single_user"
      echo
      echo "Choose the database provider:"
      echo
      echo "  1) SQLite    (recommended for single-user installs)"
      echo "  2) Postgres  (required later for team, RAG, and collaboration)"
      echo
      provider_choice_default="1"
      [[ "$current_provider" == "postgres" ]] && provider_choice_default="2"
      ask "Choice [1/2, default ${provider_choice_default}]: " provider_choice "$provider_choice_default"
      if [[ "$provider_choice" == "2" ]]; then
        provider="postgres"
      else
        provider="sqlite"
      fi
    fi
  fi

  provider="$(config_json_normalize_database_provider "$provider")"
  team_features="${CANVAS_TEAM_FEATURES_ENABLED:-$(config_json_read env.CANVAS_TEAM_FEATURES_ENABLED)}"
  if config_json_deployment_requires_postgres "$deployment_mode" "$team_features" && [[ "$provider" != "postgres" ]]; then
    if [[ "$NONINTERACTIVE" == "true" ]]; then
      info "Team/advanced deployment detected; forcing CANVAS_DATABASE_PROVIDER=postgres."
    fi
    provider="postgres"
  fi

  config_json_write env.CANVAS_DEPLOYMENT_MODE "$deployment_mode"
  config_json_write env.CANVAS_DATABASE_PROVIDER "$provider"

  for database_env_key in \
    CANVAS_TEAM_FEATURES_ENABLED \
    DATABASE_URL \
    CANVAS_POSTGRES_IMAGE \
    CANVAS_POSTGRES_DATA_VOLUME \
    CANVAS_POSTGRES_DB \
    CANVAS_POSTGRES_USER \
    CANVAS_POSTGRES_PASSWORD \
    CANVAS_POSTGRES_REQUIRED \
    CANVAS_POSTGRES_VECTOR_ENABLED; do
    if [[ -n "${!database_env_key:-}" ]]; then
      config_json_write "env.${database_env_key}" "${!database_env_key}"
      ok "Set ${database_env_key}"
    fi
  done
  unset database_env_key

  config_json_ensure_database_config
  ok "Database provider: $(config_json_read env.CANVAS_DATABASE_PROVIDER)"
  if [[ "$(config_json_read env.CANVAS_DATABASE_PROVIDER)" == "postgres" ]]; then
    ok "Postgres image: $(config_json_read env.CANVAS_POSTGRES_IMAGE)"
    ok "Postgres volume: $(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  fi
}

apply_transient_admin_credentials() {
  if [[ -z "${ADMIN_EMAIL:-}" && -z "${ADMIN_PASSWORD:-}" ]]; then
    return 0
  fi

  if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
    fail "ADMIN_EMAIL and ADMIN_PASSWORD must be provided together. They are applied once and are not stored."
  fi

  if [[ ! "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    fail "ADMIN_EMAIL must be a valid email address."
  fi

  if [[ "${#ADMIN_PASSWORD}" -lt 8 || "${#ADMIN_PASSWORD}" -gt 128 ]]; then
    fail "ADMIN_PASSWORD must be between 8 and 128 characters."
  fi

  local admin_name cli_path
  admin_name="${ADMIN_NAME:-Administrator}"
  cli_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"

  section "Initial admin"
  "$cli_path" start --no-banner

  if printf '%s\n' "$ADMIN_PASSWORD" | "$cli_path" admin reset-password \
    --email "$ADMIN_EMAIL" \
    --name "$admin_name" \
    --password-stdin \
    --no-banner; then
    ok "Initial admin credentials applied for ${ADMIN_EMAIL}"
  else
    fail "Could not apply initial admin credentials. The password was not stored; retry with: canvas-notebook admin reset-password --email ${ADMIN_EMAIL}"
  fi
}

run_cli_update_only() {
  ensure_host_install

  section "Loading existing config"
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    ok "Found ${CONFIG_JSON_PATH}"
  elif [[ -f "/etc/canvas-notebook/manager.env" ]]; then
    info "Migrating legacy config to config.json..."
    config_json_migrate --force
  else
    config_json_init
  fi

  install_management_cli
  install_systemd_service
  install_update_timer
  ok "Canvas Notebook management CLI updated"
}

run_prebuilt_install() {
  ensure_host_install
  prepare_install_dir
  configure_swap
  install_docker
  stop_legacy_install
  migrate_legacy_data
  install_caddy
  install_compose_file

  config_json_init
  if [[ -f "/etc/canvas-notebook/manager.env" ]]; then
    info "Migrating legacy config..."
    config_json_migrate --force
  fi

  configure_secrets
  configure_compose_values
  configure_database_values

  if [[ -n "$DATA_DIR" ]]; then
    config_json_write dataDir "$DATA_DIR"
  fi

  config_json_to_env
  configure_data_bind_mount
  pull_image_if_needed "${DOCKER_COMPOSE:-docker compose}" "$IMAGE" "${SERVICE:-canvas-notebook}" "${LOG_FILE:-}" "${COMPOSE_FILE:-}"
  cleanup_docker_artifacts
  install_manager_config
  install_management_cli
  install_systemd_service
  install_update_timer
  apply_transient_admin_credentials

  local domain
  domain="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH" 2>/dev/null)"
  configure_caddy "$domain"

  echo
  echo -e "${_OUT_GREEN}${_OUT_BOLD}Canvas Notebook image pulled and CLI installed.${_OUT_RESET}"
  echo
  if [[ "${SETUP_CADDY:-false}" != "true" ]]; then
    info "If you set a domain with SETUP_CADDY=true, run: canvas-notebook caddy-reload"
  fi
  echo
  echo -e "${_OUT_BOLD}Canvas Notebook service is installed.${_OUT_RESET}"
  echo
  info "  canvas-notebook status          Check container and health"
  echo
  echo -e "${_OUT_BOLD}Useful commands:${_OUT_RESET}"
  info "  canvas-notebook logs            Follow container logs"
  info "  canvas-notebook env             Show configuration"
  info "  canvas-notebook config-show     Show config.json"
  info "  canvas-notebook update          Pull latest image and restart"
  info "  canvas-notebook auto-update-status"
  echo
}

run_source_install() {
  if ! command -v git >/dev/null 2>&1; then
    run_root apt-get update -qq
    run_root apt-get install -y git
  fi

  if [[ -d "$DEST/.git" ]]; then
    ok "Repo already exists — pulling latest changes"
    git -C "$DEST" pull
  else
    section "Cloning repository"
    git clone "$REPO" "$DEST"
    ok "Cloned into ./${DEST}"
  fi

  cd "$DEST"
  bash scripts/server-setup.sh
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is for Linux servers only." >&2
  echo "On macOS or Windows, install Docker Desktop and run: npm run setup" >&2
  exit 1
fi

load_existing_manager_config
resolve_support_dir
source_libs

require_jq

print_banner
detect_mode

if [[ "${CLI_UPDATE_ONLY:-false}" == "true" ]]; then
  run_cli_update_only
elif [[ "$MODE_CHOICE" == "1" ]]; then
  run_prebuilt_install
elif [[ "$MODE_CHOICE" == "2" ]]; then
  run_source_install
else
  fail "Invalid choice. Run the script again and enter 1 or 2."
fi

exit 0
