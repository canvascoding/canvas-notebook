#!/usr/bin/env bash
# Canvas Notebook — Linux Server Setup
# Installs Node.js, Docker, and Caddy on a fresh Linux server,
# then builds and starts the app via npm run setup.
#
# Usage: bash scripts/server-setup.sh
#        or: npm run server:setup

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✓ $*${RESET}"; }
info() { echo -e "${CYAN}  $*${RESET}"; }
warn() { echo -e "${YELLOW}! $*${RESET}"; }
fail() { echo -e "${RED}✗ $*${RESET}"; exit 1; }

section() { echo; echo -e "${YELLOW}$*${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Linux only ────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo -e "${RED}✗ This script is for Linux servers only.${RESET}"
  echo
  info "On macOS or Windows, install Docker Desktop and run: npm run setup"
  exit 1
fi

echo
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Canvas Notebook  —  Server Setup       ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo
info "Installs Node.js, Docker, and Caddy on a fresh Linux (Ubuntu/Debian) server,"
info "then builds and starts Canvas Notebook."
echo

# ── Step 1: Node.js ───────────────────────────────────────────────────────────
section "Step 1: Node.js"
if command -v node >/dev/null 2>&1; then
  ok "Node.js $(node --version) already installed"
else
  info "Installing Node.js LTS..."
  if ! command -v curl >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y curl
  fi
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
  ok "Node.js $(node --version) installed"
fi

# ── Step 2: Docker ────────────────────────────────────────────────────────────
section "Step 2: Docker"
DOCKER_CMD="docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker already installed"
else
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh >/dev/null
  ok "Docker installed"

  if id -nG "$USER" | grep -qw docker; then
    ok "User '$USER' already in docker group"
  else
    sudo usermod -aG docker "$USER"
    warn "Added '$USER' to the docker group."
    warn "Group change takes effect after re-login — using sudo docker for now."
  fi
fi

# If current session does not have docker group yet, prefix with sudo
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
    info "Using sudo docker for this session."
  else
    fail "Docker is installed but not reachable. Check installation logs."
  fi
fi

export DOCKER_CMD

# ── Step 3: Caddy ─────────────────────────────────────────────────────────────
section "Step 3: Caddy (HTTPS reverse proxy)"
echo
read -rp "  Set up Caddy for public HTTPS access? [y/N]: " CADDY_ANSWER
SETUP_CADDY=false
if [[ "${CADDY_ANSWER,,}" == "y" || "${CADDY_ANSWER,,}" == "yes" ]]; then
  SETUP_CADDY=true
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

# ── Step 4: npm dependencies ──────────────────────────────────────────────────
section "Step 4: Installing npm dependencies"
cd "$ROOT_DIR"
npm install --legacy-peer-deps --silent
ok "Dependencies installed"

# ── Step 5: Configuration ─────────────────────────────────────────────────────
section "Step 5: Configuration"
ENV_FILE="$ROOT_DIR/.env.docker.local"
ENV_EXAMPLE="$ROOT_DIR/.env.docker.example"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    info "Created .env.docker.local from template."
  else
    fail ".env.docker.local not found and no template available."
  fi
fi

env_has_placeholders() {
  grep -qE 'admin@example\.com|BOOTSTRAP_ADMIN_PASSWORD\s*=\s*admin$|c9PkVtSazPhUtmcKsjau1w2uONuBZKiUvgFaHGXz2kZE=' "$ENV_FILE" 2>/dev/null
}

# Auto-generate secrets if still placeholders
for SECRET_KEY in BETTER_AUTH_SECRET CANVAS_INTERNAL_API_KEY; do
  if grep -qE "^${SECRET_KEY}=your-secret-genereate-please" "$ENV_FILE" 2>/dev/null; then
    GENERATED="$(openssl rand -base64 32)"
    sed -i "s|^${SECRET_KEY}=your-secret-genereate-please|${SECRET_KEY}=${GENERATED}|" "$ENV_FILE"
    ok "Generated ${SECRET_KEY}"
  fi
done

if env_has_placeholders; then
  echo
  echo -e "${BOLD}  You need to configure .env.docker.local before the app can start.${RESET}"
  echo
  info "Set at minimum:"
  info "  BOOTSTRAP_ADMIN_EMAIL    — your login email"
  info "  BOOTSTRAP_ADMIN_PASSWORD — your login password"
  info "  BETTER_AUTH_BASE_URL     — public URL (e.g. https://canvas.example.com)"
  echo

  EDITOR_CMD="${EDITOR:-nano}"
  if ! command -v "$EDITOR_CMD" >/dev/null 2>&1; then
    EDITOR_CMD="vi"
  fi

  read -rp "  Press Enter to open the config file in ${EDITOR_CMD}, or Ctrl+C to abort: "
  "$EDITOR_CMD" "$ENV_FILE"

  if env_has_placeholders; then
    echo
    fail "Config still contains placeholder values. Edit .env.docker.local and re-run: npm run server:setup"
  fi
fi

ok ".env.docker.local is configured"

# ── Step 6: Data directory ────────────────────────────────────────────────────
section "Step 6: Data directory"
mkdir -p "$ROOT_DIR/data"
sudo chown -R 1000:1000 "$ROOT_DIR/data"
ok "./data ready (owned by container user)"

# ── Step 7: Build & start via existing setup script ───────────────────────────
section "Step 7: Building and starting Canvas Notebook"
npm run setup

# ── Step 8: Public access via Caddy ──────────────────────────────────────────
section "Step 8: Public access"

if [[ "$SETUP_CADDY" != "true" ]]; then
  SERVER_IP=$(curl -sf4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  ok "App available at http://${SERVER_IP}:3456"
  echo
  info "To enable HTTPS later, re-run: npm run server:setup"
  echo
  exit 0
fi

# Extract hostname from BETTER_AUTH_BASE_URL in the env file
BASE_URL="$(grep -E '^BETTER_AUTH_BASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
DOMAIN="$(echo "$BASE_URL" | sed 's|^https\?://||' | cut -d/ -f1 | cut -d: -f1)"

# Determine if it's a real domain (not localhost, not a plain IP)
is_real_domain() {
  local host="$1"
  [[ -n "$host" ]] \
    && [[ "$host" != "localhost" ]] \
    && ! [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

if is_real_domain "$DOMAIN"; then
  CADDYFILE="/etc/caddy/Caddyfile"

  # Extract domain currently in Caddyfile (first block header)
  CADDY_CURRENT_DOMAIN=""
  if [[ -f "$CADDYFILE" ]]; then
    CADDY_CURRENT_DOMAIN="$(grep -oE '^[a-zA-Z0-9._-]+' "$CADDYFILE" | head -1 || true)"
  fi

  if [[ "$CADDY_CURRENT_DOMAIN" == "$DOMAIN" ]]; then
    ok "Caddy already configured for ${DOMAIN} — skipping"
  else
    if [[ -n "$CADDY_CURRENT_DOMAIN" ]]; then
      info "Domain changed: ${CADDY_CURRENT_DOMAIN} → ${DOMAIN}"
    fi
    sudo tee "$CADDYFILE" > /dev/null <<EOF
${DOMAIN} {
    reverse_proxy localhost:3456
}
EOF
    sudo systemctl reload caddy || sudo systemctl restart caddy
    ok "Caddy configured — https://${DOMAIN} → localhost:3456"
    info "Let's Encrypt certificate will be obtained automatically on the first request."
  fi

  SERVER_IP=$(curl -sf4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  warn "Make sure ports 80 and 443 are open in your firewall / security group."
  warn "Make sure your DNS A record points '${DOMAIN}' to ${SERVER_IP}"
else
  SERVER_IP=$(curl -sf4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  ok "App available at http://${SERVER_IP}:3456"
  echo
  info "To enable HTTPS: set BETTER_AUTH_BASE_URL=https://your-domain.com in"
  info ".env.docker.local and re-run: npm run server:setup"
  info "Make sure port 3456 is open in your firewall / security group."
fi

echo
