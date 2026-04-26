#!/usr/bin/env bash
# Canvas Notebook — Installer
# Supports two modes:
#   1. Pre-built image (recommended) — pulls ghcr.io image, no build needed
#   2. From source                   — clones repo and builds locally
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh | bash

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()      { echo -e "${GREEN}✓ $*${RESET}"; }
info()    { echo -e "${CYAN}  $*${RESET}"; }
warn()    { echo -e "${YELLOW}! $*${RESET}"; }
fail()    { echo -e "${RED}✗ $*${RESET}"; exit 1; }
section() { echo; echo -e "${YELLOW}$*${RESET}"; }

REPO="https://github.com/canvascoding/canvas-notebook.git"
IMAGE="ghcr.io/canvascoding/canvas-notebook:latest"
COMPOSE_URL="https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/compose.hub.yaml"
DEST="canvas-notebook"
COMPOSE_FILE="canvas-notebook-compose.yaml"

# ── Linux only ────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo -e "${RED}✗ This script is for Linux servers only.${RESET}"
  echo
  info "On macOS or Windows, install Docker Desktop and run: npm run setup"
  exit 1
fi

echo
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Canvas Notebook  —  Installer          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
# ── Non-interactive mode detection ───────────────────────────────────────────
# All prompts can be bypassed via environment variables:
#   INSTALL_MODE=1            (1=prebuilt, 2=source; default: 1)
#   SETUP_CADDY=true|false    (default: false)
#   ADMIN_EMAIL=...           your login email
#   ADMIN_PASSWORD=...        your login password
#   BASE_URL=...              public URL, e.g. https://canvas.example.com
#
# Example launch script:
#   INSTALL_MODE=1 SETUP_CADDY=true BASE_URL=https://canvas.example.com \
#     ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=secret bash install.sh

NONINTERACTIVE=false
if [[ -n "${INSTALL_MODE:-}" || -n "${ADMIN_EMAIL:-}" || -n "${BASE_URL:-}" ]]; then
  NONINTERACTIVE=true
fi

if [[ "$NONINTERACTIVE" == "true" ]]; then
  MODE_CHOICE="${INSTALL_MODE:-1}"
  info "Non-interactive mode (INSTALL_MODE=${MODE_CHOICE})"
else
  echo
  echo "How would you like to install Canvas Notebook?"
  echo
  echo "  1) Pre-built image  (recommended — fast, no build required)"
  echo "  2) From source      (for developers or custom builds)"
  echo
  read -rp "Choice [1/2, default 1]: " MODE_CHOICE
  MODE_CHOICE="${MODE_CHOICE:-1}"
fi

# ── Shared helpers ────────────────────────────────────────────────────────────

install_docker() {
  section "Docker"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "Docker already installed"
  else
    info "Installing Docker..."
    if ! command -v curl >/dev/null 2>&1; then
      sudo apt-get update -qq && sudo apt-get install -y curl
    fi
    curl -fsSL https://get.docker.com | sh >/dev/null
    ok "Docker installed"
    if ! id -nG "$USER" | grep -qw docker; then
      sudo usermod -aG docker "$USER"
      warn "Added '$USER' to the docker group — using sudo docker for this session."
    fi
  fi

  DOCKER_COMPOSE="docker compose"
  if ! docker info >/dev/null 2>&1; then
    if sudo docker info >/dev/null 2>&1; then
      DOCKER_COMPOSE="sudo docker compose"
      info "Using sudo docker for this session."
    else
      fail "Docker is installed but not reachable. Check installation logs."
    fi
  fi
  export DOCKER_COMPOSE
}

install_caddy() {
  section "Caddy (HTTPS reverse proxy)"

  if [[ "$NONINTERACTIVE" == "true" ]]; then
    SETUP_CADDY="${SETUP_CADDY:-false}"
  else
    echo
    read -rp "  Set up Caddy for public HTTPS access? [y/N]: " CADDY_ANSWER
    SETUP_CADDY=false
    if [[ "${CADDY_ANSWER,,}" == "y" || "${CADDY_ANSWER,,}" == "yes" ]]; then
      SETUP_CADDY=true
    fi
  fi

  if [[ "$SETUP_CADDY" == "true" ]]; then
    if command -v caddy >/dev/null 2>&1; then
      ok "Caddy already installed"
    else
      info "Installing Caddy..."
      sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1 || true
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      sudo apt-get update -qq >/dev/null
      sudo apt-get install -y caddy >/dev/null
      ok "Caddy installed"
    fi
  else
    ok "Skipped"
  fi
  export SETUP_CADDY
}

configure_caddy() {
  local domain="$1"
  if [[ "$SETUP_CADDY" != "true" ]]; then return; fi

  is_real_domain() {
    local host="$1"
    [[ -n "$host" ]] \
      && [[ "$host" != "localhost" ]] \
      && ! [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
  }

  section "Public access"
  if is_real_domain "$domain"; then
    CADDYFILE="/etc/caddy/Caddyfile"
    CADDY_CURRENT_DOMAIN=""
    if [[ -f "$CADDYFILE" ]]; then
      CADDY_CURRENT_DOMAIN="$(grep -oE '^[a-zA-Z0-9._-]+' "$CADDYFILE" | head -1 || true)"
    fi

    if [[ "$CADDY_CURRENT_DOMAIN" == "$domain" ]]; then
      ok "Caddy already configured for ${domain} — skipping"
    else
      [[ -n "$CADDY_CURRENT_DOMAIN" ]] && info "Domain changed: ${CADDY_CURRENT_DOMAIN} → ${domain}"
      sudo tee "$CADDYFILE" > /dev/null <<EOF
${domain} {
    reverse_proxy localhost:3456
}
EOF
      sudo systemctl reload caddy || sudo systemctl restart caddy
      ok "Caddy configured — https://${domain} → localhost:3456"
      info "Let's Encrypt certificate will be obtained automatically on the first request."
    fi

    SERVER_IP=$(curl -sf4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo
    warn "Make sure ports 80 and 443 are open in your firewall / security group."
    warn "Make sure your DNS A record points '${domain}' to ${SERVER_IP}"
  else
    SERVER_IP=$(curl -sf4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    ok "App available at http://${SERVER_IP}:3456"
    info "To enable HTTPS: set your domain in the config and re-run: bash install.sh"
    info "Make sure port 3456 is open in your firewall / security group."
  fi
}

# ── Mode 1: Pre-built image ───────────────────────────────────────────────────
if [[ "$MODE_CHOICE" == "1" ]]; then
  echo
  info "Using pre-built image: ${IMAGE}"

  install_docker
  install_caddy

  # Download compose file
  section "Compose file"
  if [[ -f "$COMPOSE_FILE" ]]; then
    ok "${COMPOSE_FILE} already exists — keeping existing config"
  else
    curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_FILE"
    ok "Downloaded ${COMPOSE_FILE}"
  fi

  # Auto-generate secrets
  section "Secrets"
  for SECRET_KEY in BETTER_AUTH_SECRET CANVAS_INTERNAL_API_KEY; do
    if grep -q "change-me-generate-with-openssl-rand-base64-32" "$COMPOSE_FILE" 2>/dev/null; then
      GENERATED="$(openssl rand -base64 32)"
      sed -i "s|change-me-generate-with-openssl-rand-base64-32|${GENERATED}|" "$COMPOSE_FILE"
      ok "Generated ${SECRET_KEY}"
    fi
  done

  # Check for remaining placeholders
  compose_has_placeholders() {
    grep -qE 'admin@example\.com|BOOTSTRAP_ADMIN_PASSWORD:.*"change-me"' "$COMPOSE_FILE" 2>/dev/null
  }

  # Inject env vars directly if provided (non-interactive mode)
  if [[ -n "${ADMIN_EMAIL:-}" ]]; then
    sed -i "s|BOOTSTRAP_ADMIN_EMAIL:.*|BOOTSTRAP_ADMIN_EMAIL: \"${ADMIN_EMAIL}\"|" "$COMPOSE_FILE"
    ok "Set BOOTSTRAP_ADMIN_EMAIL"
  fi
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    sed -i "s|BOOTSTRAP_ADMIN_PASSWORD:.*|BOOTSTRAP_ADMIN_PASSWORD: \"${ADMIN_PASSWORD}\"|" "$COMPOSE_FILE"
    ok "Set BOOTSTRAP_ADMIN_PASSWORD"
  fi
  if [[ -n "${BASE_URL:-}" ]]; then
    sed -i "s|BETTER_AUTH_BASE_URL:.*|BETTER_AUTH_BASE_URL: \"${BASE_URL}\"|" "$COMPOSE_FILE"
    sed -i "s|BASE_URL:.*\"http|BASE_URL: \"${BASE_URL}\" #http|" "$COMPOSE_FILE"
    ok "Set BASE_URL / BETTER_AUTH_BASE_URL"
  fi

  if compose_has_placeholders; then
    if [[ "$NONINTERACTIVE" == "true" ]]; then
      fail "Config still contains placeholder values. Set ADMIN_EMAIL, ADMIN_PASSWORD, and BASE_URL env vars."
    fi
    echo
    echo -e "${BOLD}  Configure your credentials in ${COMPOSE_FILE}${RESET}"
    echo
    info "Set at minimum:"
    info "  BOOTSTRAP_ADMIN_EMAIL    — your login email"
    info "  BOOTSTRAP_ADMIN_PASSWORD — your login password"
    info "  BETTER_AUTH_BASE_URL     — public URL (e.g. https://canvas.example.com)"
    echo

    EDITOR_CMD="${EDITOR:-nano}"
    command -v "$EDITOR_CMD" >/dev/null 2>&1 || EDITOR_CMD="vi"

    read -rp "  Press Enter to open ${COMPOSE_FILE} in ${EDITOR_CMD}, or Ctrl+C to abort: "
    "$EDITOR_CMD" "$COMPOSE_FILE"

    if compose_has_placeholders; then
      fail "Config still contains placeholder values. Edit ${COMPOSE_FILE} and re-run: bash install.sh"
    fi
  fi

  ok "${COMPOSE_FILE} is configured"

  # Pull and start
  section "Starting Canvas Notebook"
  info "Pulling latest image..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" pull
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --force-recreate
  ok "Container started"

  # Extract domain for Caddy
  BASE_URL="$(grep 'BETTER_AUTH_BASE_URL:' "$COMPOSE_FILE" | head -1 | sed 's/.*"\(.*\)"/\1/' | tr -d '[:space:]')"
  DOMAIN="$(echo "$BASE_URL" | sed 's|^https\?://||' | cut -d/ -f1 | cut -d: -f1)"
  configure_caddy "$DOMAIN"

  echo
  echo -e "${GREEN}${BOLD}Canvas Notebook is running.${RESET}"
  echo
  info "To update to the latest version:"
  info "  $DOCKER_COMPOSE -f ${COMPOSE_FILE} pull && $DOCKER_COMPOSE -f ${COMPOSE_FILE} up -d"
  echo

# ── Mode 2: From source ───────────────────────────────────────────────────────
elif [[ "$MODE_CHOICE" == "2" ]]; then
  echo
  info "Building from source — cloning ${REPO}"

  if ! command -v git >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y git
  fi

  if [[ -d "$DEST/.git" ]]; then
    ok "Repo already exists — pulling latest changes"
    git -C "$DEST" pull
  else
    git clone "$REPO" "$DEST"
    ok "Cloned into ./${DEST}"
  fi

  cd "$DEST"
  bash scripts/server-setup.sh

else
  fail "Invalid choice. Run the script again and enter 1 or 2."
fi
