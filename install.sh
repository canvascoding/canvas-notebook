#!/usr/bin/env bash
# Canvas Notebook installer.
# Thin entrypoint; implementation lives in install/lib and install/bin.

set -euo pipefail

REPO="https://github.com/canvascoding/canvas-notebook.git"
ARCHIVE_URL="https://github.com/canvascoding/canvas-notebook/archive/refs/heads/main.tar.gz"
COMPOSE_URL="https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/compose.hub.yaml"
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
  CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-false}"
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
    SETUP_CADDY="${SETUP_CADDY:-false}"
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
  [[ -n "${ADMIN_EMAIL:-}" ]] && config_json_write env.BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL" && ok "Set BOOTSTRAP_ADMIN_EMAIL"
  [[ -n "${ADMIN_PASSWORD:-}" ]] && config_json_write env.BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD" && ok "Set BOOTSTRAP_ADMIN_PASSWORD"
  if [[ -n "${BASE_URL:-}" ]]; then
    config_json_write env.BETTER_AUTH_BASE_URL "$BASE_URL"
    config_json_write env.BASE_URL "$BASE_URL"
    ok "Set BASE_URL / BETTER_AUTH_BASE_URL"
  fi

  local has_placeholders=false
  local email_val pw_val url_val
  email_val="$(jq -r '.env.BOOTSTRAP_ADMIN_EMAIL // empty' "$CONFIG_JSON_PATH")"
  pw_val="$(jq -r '.env.BOOTSTRAP_ADMIN_PASSWORD // empty' "$CONFIG_JSON_PATH")"
  url_val="$(jq -r '.env.BETTER_AUTH_BASE_URL // empty' "$CONFIG_JSON_PATH")"
  domain_val="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH")"

  if [[ -z "$email_val" || "$email_val" == "admin@example.com" ]] || \
     [[ -z "$pw_val" || "$pw_val" == "change-me" ]] || \
     [[ -z "$url_val" && -z "$domain_val" ]]; then
    has_placeholders=true
  fi

  if [[ "$has_placeholders" == "true" ]]; then
    if [[ "$NONINTERACTIVE" == "true" ]]; then
      fail "Config still contains placeholder values. Required: ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL"
    fi
    section "Configuration"
    echo
    info "Set at minimum:"
    info "  BOOTSTRAP_ADMIN_EMAIL    — your login email"
    info "  BOOTSTRAP_ADMIN_PASSWORD — your login password"
    info "  domain                   — public domain (e.g. app.example.com)"
    echo
    info "Config file: ${CONFIG_JSON_PATH}"

    EDITOR_CMD="${EDITOR:-nano}"
    command -v "$EDITOR_CMD" >/dev/null 2>&1 || EDITOR_CMD="vi"
    ask "  Press Enter to open ${CONFIG_JSON_PATH} in ${EDITOR_CMD}, or Ctrl+C to abort: " _dummy ""
    "$EDITOR_CMD" "$CONFIG_JSON_PATH" </dev/tty

    email_val="$(jq -r '.env.BOOTSTRAP_ADMIN_EMAIL // empty' "$CONFIG_JSON_PATH")"
    pw_val="$(jq -r '.env.BOOTSTRAP_ADMIN_PASSWORD // empty' "$CONFIG_JSON_PATH")"
    domain_val="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH")"
    if [[ -z "$email_val" || -z "$pw_val" || -z "$domain_val" ]]; then
      fail "Config still contains placeholder values. Edit ${CONFIG_JSON_PATH} and re-run: bash install.sh"
    fi
  fi

  ok "Configuration is set"
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

  if [[ -n "$DATA_DIR" ]]; then
    config_json_write dataDir "$DATA_DIR"
  fi

  config_json_to_env
  configure_data_bind_mount
  pull_image_if_needed
  start_canvas_container
  cleanup_docker_artifacts
  install_manager_config
  install_management_cli
  install_systemd_service
  install_update_timer

  local domain
  domain="$(jq -r '.domain // empty' "$CONFIG_JSON_PATH" 2>/dev/null)"
  configure_caddy "$domain"

  echo
  echo -e "${_OUT_GREEN}${_OUT_BOLD}Canvas Notebook is running.${_OUT_RESET}"
  echo
  info "Auto-update is enabled — the image updates automatically every day."
  info "Manage with: canvas-notebook auto-update-status | auto-update-enable | auto-update-disable"
  echo
  info "To update manually:"
  info "  canvas-notebook update"
  info "Useful management commands:"
  info "  canvas-notebook status"
  info "  canvas-notebook logs"
  info "  canvas-notebook env"
  info "  canvas-notebook config-show"
  info "  canvas-notebook swap"
  info "  canvas-notebook caddy"
  info "  canvas-notebook diagnose"
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