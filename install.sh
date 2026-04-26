#!/usr/bin/env bash
# Canvas Notebook — Installer
# Supports two modes:
#   1. Pre-built image (recommended) — pulls ghcr.io image, no build needed
#   2. From source                   — clones repo and builds locally
#
# Usage (interactive):
#   bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
#
# Usage (non-interactive / launch script):
#   INSTALL_MODE=1 SETUP_CADDY=true BASE_URL=https://canvas.example.com \
#     ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=secret \
#     bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()      { echo -e "${GREEN}✓ $*${RESET}"; }
info()    { echo -e "${CYAN}  $*${RESET}"; }
warn()    { echo -e "${YELLOW}! $*${RESET}"; }
fail()    { echo -e "${RED}✗ $*${RESET}"; exit 1; }
section() { echo; echo -e "${YELLOW}$*${RESET}"; }

# read from /dev/tty so prompts work even when piped through curl | bash
ask() {
  local prompt="$1" var="$2" default="${3:-}"
  local answer
  read -rp "$prompt" answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}

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
echo

# ── Non-interactive detection ─────────────────────────────────────────────────
# Non-interactive mode is active when env vars are provided.
# Env vars available:
#   INSTALL_MODE=1|2          (1=prebuilt, 2=source; default: 1)
#   SETUP_CADDY=true|false    (default: false)
#   ADMIN_EMAIL=...
#   ADMIN_PASSWORD=...
#   BASE_URL=...              e.g. https://canvas.example.com

NONINTERACTIVE=false
if [[ -n "${INSTALL_MODE:-}" || -n "${ADMIN_EMAIL:-}" || -n "${BASE_URL:-}" ]]; then
  NONINTERACTIVE=true
fi

# ── Collect all choices upfront ───────────────────────────────────────────────
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

  if [[ "$MODE_CHOICE" == "1" ]]; then
    echo
    ask "Set up Caddy for public HTTPS access? [y/N]: " CADDY_ANSWER "n"
    SETUP_CADDY=false
    if [[ "${CADDY_ANSWER,,}" == "y" || "${CADDY_ANSWER,,}" == "yes" ]]; then
      SETUP_CADDY=true
    fi
  fi
fi

export SETUP_CADDY MODE_CHOICE

# ── Shared: install Docker ────────────────────────────────────────────────────
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

# ── Shared: install Caddy ─────────────────────────────────────────────────────
install_caddy() {
  section "Caddy (HTTPS reverse proxy)"
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
}

# ── Shared: configure Caddy ───────────────────────────────────────────────────
configure_caddy() {
  local domain="$1"
  if [[ "$SETUP_CADDY" != "true" ]]; then return; fi

  is_real_domain() {
    local host="$1"
    [[ -n "$host" ]] \
      && [[ "$host" != "localhost" ]] \
      && ! [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
  }

  detect_public_ip() {
    curl -sf4 https://ifconfig.me 2>/dev/null \
      || curl -sf4 https://api.ipify.org 2>/dev/null \
      || curl -sf4 https://checkip.amazonaws.com 2>/dev/null \
      || true
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

    SERVER_IP="$(detect_public_ip)"
    echo
    warn "Make sure ports 80 and 443 are open in your firewall / security group."
    warn "Make sure your DNS A record points '${domain}' to the public IP of this VM/server."
    if [[ -n "$SERVER_IP" ]]; then
      info "Best-effort detected public IP: ${SERVER_IP}"
      info "Verify it against your cloud provider before changing DNS."
    else
      info "Could not detect a public IP from here. Use the public IP shown by your VM/cloud provider."
    fi
  else
    SERVER_IP="$(detect_public_ip)"
    if [[ -n "$SERVER_IP" ]]; then
      ok "App available at http://${SERVER_IP}:3456"
      info "If this server is behind NAT, use the public IP shown by your VM/cloud provider instead."
    else
      ok "App available at http://<your-public-server-ip>:3456"
      info "Use the public IP shown by your VM/cloud provider."
    fi
    info "To enable HTTPS: set your domain in the config and re-run."
    info "Make sure port 3456 is open in your firewall / security group."
  fi
}

wait_for_canvas_startup() {
  local host_port health_url log_pid attempt max_attempts

  host_port="$($DOCKER_COMPOSE -f "$COMPOSE_FILE" port canvas-notebook 3000 2>/dev/null | tail -1 | awk -F: '{print $NF}')"
  host_port="${host_port:-3456}"
  health_url="http://127.0.0.1:${host_port}/api/health"
  max_attempts="${INSTALL_HEALTH_MAX_ATTEMPTS:-180}"

  section "Container startup logs"
  info "Streaming container logs until Canvas Notebook is healthy..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" logs -f --tail=80 canvas-notebook &
  log_pid=$!

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      kill "$log_pid" >/dev/null 2>&1 || true
      wait "$log_pid" >/dev/null 2>&1 || true
      ok "Canvas Notebook health check passed (${health_url})"
      return 0
    fi

    if ! kill -0 "$log_pid" >/dev/null 2>&1; then
      fail "Container logs stopped before the app became healthy. Run: $DOCKER_COMPOSE -f ${COMPOSE_FILE} logs canvas-notebook"
    fi

    sleep 1
  done

  kill "$log_pid" >/dev/null 2>&1 || true
  wait "$log_pid" >/dev/null 2>&1 || true
  fail "Canvas Notebook did not become healthy within ${max_attempts}s. Run: $DOCKER_COMPOSE -f ${COMPOSE_FILE} logs canvas-notebook"
}

install_management_cli() {
  local install_dir compose_path bin_path tmp_path install_dir_q compose_path_q

  install_dir="$(pwd)"
  compose_path="${install_dir}/${COMPOSE_FILE}"
  bin_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  tmp_path="$(mktemp)"

  printf -v install_dir_q '%q' "$install_dir"
  printf -v compose_path_q '%q' "$compose_path"

  cat > "$tmp_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${install_dir_q}
COMPOSE_FILE=${compose_path_q}
SERVICE="canvas-notebook"
DEFAULT_HEALTH_ATTEMPTS="\${CANVAS_HEALTH_MAX_ATTEMPTS:-180}"

ok()      { printf '✓ %s\n' "\$*"; }
info()    { printf '  %s\n' "\$*"; }
warn()    { printf '! %s\n' "\$*" >&2; }
fail()    { printf '✗ %s\n' "\$*" >&2; exit 1; }

banner() {
  cat <<'BANNER'

   ██████╗ █████╗ ███╗   ██╗██╗   ██╗ █████╗ ███████╗
  ██╔════╝██╔══██╗████╗  ██║██║   ██║██╔══██╗██╔════╝
  ██║     ███████║██╔██╗ ██║██║   ██║███████║███████╗
  ██║     ██╔══██║██║╚██╗██║╚██╗ ██╔╝██╔══██║╚════██║
  ╚██████╗██║  ██║██║ ╚████║ ╚████╔╝ ██║  ██║███████║
   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝  ╚═══╝  ╚═╝  ╚═╝╚══════╝

  Canvas Notebook VM Manager

BANNER
}

usage() {
  banner
  cat <<'HELP'
Usage:
  canvas-notebook <command>

Commands:
  help       Show this help
  install    Pull the image and start/recreate the container
  update     Pull the latest image, recreate the container, and wait until healthy
  start      Start the container and wait until healthy
  restart    Restart the container and wait until healthy
  stop       Stop the container
  down       Stop and remove the container
  status     Show compose status
  logs       Follow container logs
  health     Check the local health endpoint
  config     Show the compose file path

Environment:
  CANVAS_HEALTH_MAX_ATTEMPTS=180   Health wait timeout in seconds
  TAIL=120                         Number of log lines shown before following
HELP
}

compose() {
  cd "\$INSTALL_DIR"
  if docker info >/dev/null 2>&1; then
    docker compose -f "\$COMPOSE_FILE" "\$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker compose -f "\$COMPOSE_FILE" "\$@"
  else
    fail "Docker is not reachable. Try logging out/in for docker group changes, or run with a user that can access Docker."
  fi
}

host_port() {
  compose port "\$SERVICE" 3000 2>/dev/null | tail -1 | awk -F: '{print \$NF}'
}

health_url() {
  local port
  port="\$(host_port)"
  port="\${port:-3456}"
  printf 'http://127.0.0.1:%s/api/health\n' "\$port"
}

wait_until_healthy() {
  local url attempts attempt
  url="\$(health_url)"
  attempts="\$DEFAULT_HEALTH_ATTEMPTS"
  info "Waiting for Canvas Notebook health check: \$url"

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS "\$url" >/dev/null 2>&1; then
      ok "Canvas Notebook is healthy"
      return 0
    fi
    sleep 1
  done

  fail "Canvas Notebook did not become healthy within \${attempts}s. Run: canvas-notebook logs"
}

follow_until_healthy() {
  local log_pid attempts attempt url
  attempts="\$DEFAULT_HEALTH_ATTEMPTS"
  url="\$(health_url)"

  info "Streaming startup logs until Canvas Notebook is healthy..."
  compose logs -f --tail="\${TAIL:-120}" "\$SERVICE" &
  log_pid=\$!

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS "\$url" >/dev/null 2>&1; then
      kill "\$log_pid" >/dev/null 2>&1 || true
      wait "\$log_pid" >/dev/null 2>&1 || true
      ok "Canvas Notebook is healthy"
      return 0
    fi

    if ! kill -0 "\$log_pid" >/dev/null 2>&1; then
      fail "Container logs stopped before the app became healthy. Run: canvas-notebook logs"
    fi

    sleep 1
  done

  kill "\$log_pid" >/dev/null 2>&1 || true
  wait "\$log_pid" >/dev/null 2>&1 || true
  fail "Canvas Notebook did not become healthy within \${attempts}s. Run: canvas-notebook logs"
}

cmd="\${1:-help}"
case "\$cmd" in
  install|update|start|restart|stop|down|status|ps|logs|health|config)
    banner
    ;;
esac

case "\$cmd" in
  help|-h|--help)
    usage
    ;;
  install|update)
    compose pull "\$SERVICE"
    compose up -d --force-recreate "\$SERVICE"
    follow_until_healthy
    ;;
  start)
    compose up -d "\$SERVICE"
    wait_until_healthy
    ;;
  restart)
    compose restart "\$SERVICE"
    wait_until_healthy
    ;;
  stop)
    compose stop "\$SERVICE"
    ;;
  down)
    compose down
    ;;
  status|ps)
    compose ps
    ;;
  logs)
    compose logs -f --tail="\${TAIL:-120}" "\$SERVICE"
    ;;
  health)
    curl -fsS "\$(health_url)" && printf '\n'
    ;;
  config)
    printf 'Install dir: %s\nCompose file: %s\n' "\$INSTALL_DIR" "\$COMPOSE_FILE"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
EOF

  chmod +x "$tmp_path"
  if [[ -w "$(dirname "$bin_path")" ]]; then
    mv "$tmp_path" "$bin_path"
  else
    sudo mv "$tmp_path" "$bin_path"
  fi

  ok "Installed management CLI: ${bin_path}"
  info "Run: canvas-notebook help"
}

# ── Mode 1: Pre-built image ───────────────────────────────────────────────────
if [[ "$MODE_CHOICE" == "1" ]]; then

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

  compose_has_placeholders() {
    grep -qE 'admin@example\.com|BOOTSTRAP_ADMIN_PASSWORD:.*"change-me"|your-domain\.com' "$COMPOSE_FILE" 2>/dev/null
  }

  # Inject env vars (non-interactive)
  [[ -n "${ADMIN_EMAIL:-}" ]]    && sed -i "s|BOOTSTRAP_ADMIN_EMAIL:.*|BOOTSTRAP_ADMIN_EMAIL: \"${ADMIN_EMAIL}\"|" "$COMPOSE_FILE"    && ok "Set BOOTSTRAP_ADMIN_EMAIL"
  [[ -n "${ADMIN_PASSWORD:-}" ]] && sed -i "s|BOOTSTRAP_ADMIN_PASSWORD:.*|BOOTSTRAP_ADMIN_PASSWORD: \"${ADMIN_PASSWORD}\"|" "$COMPOSE_FILE" && ok "Set BOOTSTRAP_ADMIN_PASSWORD"
  if [[ -n "${BASE_URL:-}" ]]; then
    sed -i "s|BETTER_AUTH_BASE_URL:.*|BETTER_AUTH_BASE_URL: \"${BASE_URL}\"|" "$COMPOSE_FILE"
    sed -i "s|BASE_URL:.*\"http|BASE_URL: \"${BASE_URL}\" #http|" "$COMPOSE_FILE"
    ok "Set BASE_URL / BETTER_AUTH_BASE_URL"
  fi

  # Interactive config if placeholders remain
  if compose_has_placeholders; then
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

    if compose_has_placeholders; then
      fail "Config still contains placeholder values. Edit ${COMPOSE_FILE} and re-run: bash install.sh"
    fi
  fi

  ok "${COMPOSE_FILE} is configured"

  # Ensure data directory exists with correct permissions
  # Container runs as node (UID 1000) — host directory must be owned by that UID
  section "Data directory"
  mkdir -p ./data
  sudo chown -R 1000:1000 ./data
  ok "./data ready (owned by container user)"

  # Pull and start
  section "Starting Canvas Notebook"
  info "Pulling latest image..."
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" pull
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --force-recreate
  ok "Container started"
  wait_for_canvas_startup
  install_management_cli

  # Configure Caddy
  CONFIGURED_BASE_URL="$(grep 'BETTER_AUTH_BASE_URL:' "$COMPOSE_FILE" | head -1 | sed 's/.*"\(.*\)"/\1/' | tr -d '[:space:]')"
  DOMAIN="$(echo "$CONFIGURED_BASE_URL" | sed 's|^https\?://||' | cut -d/ -f1 | cut -d: -f1)"
  configure_caddy "$DOMAIN"

  echo
  echo -e "${GREEN}${BOLD}Canvas Notebook is running.${RESET}"
  echo
  info "To update to the latest version:"
  info "  canvas-notebook update"
  info "To inspect or manage the service:"
  info "  canvas-notebook help"
  echo

# ── Mode 2: From source ───────────────────────────────────────────────────────
elif [[ "$MODE_CHOICE" == "2" ]]; then

  if ! command -v git >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y git
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

else
  fail "Invalid choice. Run the script again and enter 1 or 2."
fi
