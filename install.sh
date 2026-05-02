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
MANAGER_CONFIG_FILE="/etc/canvas-notebook/manager.env"
CANVAS_SWAP_ENABLED_WAS_SET="${CANVAS_SWAP_ENABLED+x}"
CANVAS_SWAP_SIZE_WAS_SET="${CANVAS_SWAP_SIZE+x}"
CANVAS_SWAP_FILE_WAS_SET="${CANVAS_SWAP_FILE+x}"
CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-false}"
CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
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
  if [[ ! -f "$MANAGER_CONFIG_FILE" ]]; then
    return 0
  fi

  if [[ -z "$CANVAS_SWAP_ENABLED_WAS_SET" ]]; then
    CANVAS_SWAP_ENABLED="$(awk -F= '/^CANVAS_SWAP_ENABLED=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
  if [[ -z "$CANVAS_SWAP_SIZE_WAS_SET" ]]; then
    CANVAS_SWAP_SIZE="$(awk -F= '/^CANVAS_SWAP_SIZE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
  if [[ -z "$CANVAS_SWAP_FILE_WAS_SET" ]]; then
    CANVAS_SWAP_FILE="$(awk -F= '/^CANVAS_SWAP_FILE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
  CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-false}"
  CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
  CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
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

print_banner() {
  echo
  echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Canvas Notebook  —  Installer          ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
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
  if grep -qE '^[[:space:]]*BETTER_AUTH_SECRET:.*change-me-generate-with-openssl-rand-base64-32' "$COMPOSE_FILE"; then
    auth_secret="$(openssl rand -base64 32)"
    set_compose_env "$COMPOSE_FILE" BETTER_AUTH_SECRET "$auth_secret"
    ok "Generated BETTER_AUTH_SECRET"
  fi
  if grep -qE '^[[:space:]]*CANVAS_INTERNAL_API_KEY:.*change-me-generate-with-openssl-rand-base64-32' "$COMPOSE_FILE"; then
    internal_key="$(openssl rand -base64 32)"
    set_compose_env "$COMPOSE_FILE" CANVAS_INTERNAL_API_KEY "$internal_key"
    ok "Generated CANVAS_INTERNAL_API_KEY"
  fi
}

configure_compose_values() {
  [[ -n "${ADMIN_EMAIL:-}" ]] && set_compose_env "$COMPOSE_FILE" BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL" && ok "Set BOOTSTRAP_ADMIN_EMAIL"
  [[ -n "${ADMIN_PASSWORD:-}" ]] && set_compose_env "$COMPOSE_FILE" BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD" && ok "Set BOOTSTRAP_ADMIN_PASSWORD"
  if [[ -n "${BASE_URL:-}" ]]; then
    set_compose_env "$COMPOSE_FILE" BETTER_AUTH_BASE_URL "$BASE_URL"
    set_compose_env "$COMPOSE_FILE" BASE_URL "$BASE_URL"
    ok "Set BASE_URL / BETTER_AUTH_BASE_URL"
  fi

  if compose_has_placeholders "$COMPOSE_FILE"; then
    if [[ "$NONINTERACTIVE" == "true" ]]; then
      fail "Config still contains placeholder values. Required env vars: ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL (e.g. BASE_URL=https://canvas.example.com)"
    fi
    section "Configuration"
    echo
    info "Set at minimum:"
    info "  BOOTSTRAP_ADMIN_EMAIL    — your login email"
    info "  BOOTSTRAP_ADMIN_PASSWORD — your login password"
    info "  BETTER_AUTH_BASE_URL     — public URL (e.g. https://canvas.example.com)"
    echo

    EDITOR_CMD="${EDITOR:-nano}"
    command -v "$EDITOR_CMD" >/dev/null 2>&1 || EDITOR_CMD="vi"
    ask "  Press Enter to open ${COMPOSE_FILE} in ${EDITOR_CMD}, or Ctrl+C to abort: " _dummy ""
    "$EDITOR_CMD" "$COMPOSE_FILE" </dev/tty

    if compose_has_placeholders "$COMPOSE_FILE"; then
      fail "Config still contains placeholder values. Edit ${COMPOSE_FILE} and re-run: bash install.sh"
    fi
  fi

  ok "${COMPOSE_FILE} is configured"
}

configured_domain_from_compose() {
  grep 'BETTER_AUTH_BASE_URL:' "$COMPOSE_FILE" | head -1 | sed 's/.*"\(.*\)"/\1/' | tr -d '[:space:]' | sed 's|^https\?://||' | cut -d/ -f1 | cut -d: -f1
}

run_cli_update_only() {
  ensure_host_install
  if [[ ! -f "$MANAGER_CONFIG_FILE" ]]; then
    fail "Manager config not found at ${MANAGER_CONFIG_FILE}. Run the full installer first."
  fi

  section "Loading existing config"
  set -a
  # shellcheck disable=SC1090
  . "$MANAGER_CONFIG_FILE"
  set +a
  ok "Loaded ${MANAGER_CONFIG_FILE}"

  install_management_cli
  install_systemd_service
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
  configure_secrets
  configure_compose_values
  configure_data_bind_mount
  pull_image_if_needed
  start_canvas_container
  cleanup_docker_artifacts
  install_manager_config
  install_management_cli
  install_systemd_service
  configure_caddy "$(configured_domain_from_compose)"

  echo
  echo -e "${GREEN}${BOLD}Canvas Notebook is running.${RESET}"
  echo
  info "To update to the latest version:"
  info "  canvas-notebook update"
  info "Useful management commands:"
  info "  canvas-notebook status"
  info "  canvas-notebook logs"
  info "  canvas-notebook env"
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
