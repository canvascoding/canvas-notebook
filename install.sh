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

progress_bar() {
  local current="$1" total="$2" label="${3:-}"
  local width=25 filled=$((current * width / (total > 0 ? total : 1)))
  local bar=""
  for ((i=0; i<width; i++)); do
    [[ $i -lt $filled ]] && bar+="█" || bar+="░"
  done
  printf "\r  [%s] %3d%% %s" "$bar" "$((current * 100 / (total > 0 ? total : 1)))" "$label"
}

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
INSTALL_DIR="${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}"
SYSTEMD_SERVICE="canvas-notebook.service"
INSTALL_USER="${SUDO_USER:-${USER:-$(id -un)}}"
INSTALL_USER_HOME="$(getent passwd "$INSTALL_USER" 2>/dev/null | cut -d: -f6 || true)"
INSTALL_USER_HOME="${INSTALL_USER_HOME:-${HOME:-/opt}}"
DATA_DIR="${CANVAS_DATA_DIR:-${INSTALL_USER_HOME}/canvas-notebook-data}"
MANAGER_CONFIG_FILE="/etc/canvas-notebook/manager.env"
if [[ -f "$MANAGER_CONFIG_FILE" ]]; then
  if [[ -z "${CANVAS_SWAP_ENABLED+x}" ]]; then
    CANVAS_SWAP_ENABLED="$(awk -F= '/^CANVAS_SWAP_ENABLED=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
  if [[ -z "${CANVAS_SWAP_SIZE+x}" ]]; then
    CANVAS_SWAP_SIZE="$(awk -F= '/^CANVAS_SWAP_SIZE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
  if [[ -z "${CANVAS_SWAP_FILE+x}" ]]; then
    CANVAS_SWAP_FILE="$(awk -F= '/^CANVAS_SWAP_FILE=/ {gsub(/'\''|"/, "", $2); print $2; exit}' "$MANAGER_CONFIG_FILE")"
  fi
fi
CANVAS_SWAP_ENABLED="${CANVAS_SWAP_ENABLED:-true}"
CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
LEGACY_COMPOSE_PATH=""
LEGACY_DATA_PATH=""

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
if [[ -n "${INSTALL_MODE:-}" || -n "${ADMIN_EMAIL:-}" || -n "${BASE_URL:-}" || "${CLI_UPDATE_ONLY:-false}" == "true" ]]; then
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
    if [[ "${CADDY_ANSWER,,}" == "y" || "${CADDY_ANSWER,,}" == "yes" || "${CADDY_ANSWER}" == "1" ]]; then
      SETUP_CADDY=true
    fi
  fi
fi

export SETUP_CADDY MODE_CHOICE

run_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
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

prepare_install_dir() {
  local source_dir target_dir
  source_dir="$(pwd)"
  target_dir="$INSTALL_DIR"

  if [[ "$target_dir" != /* ]]; then
    fail "CANVAS_INSTALL_DIR must be an absolute path."
  fi
  if [[ "$DATA_DIR" != /* ]]; then
    fail "CANVAS_DATA_DIR must be an absolute path."
  fi

  section "Install directory"
  run_root mkdir -p "$target_dir"
  run_root chown "$(id -u):$(id -g)" "$target_dir"

  if [[ "$source_dir" != "$target_dir" ]]; then
    if [[ -f "${source_dir}/${COMPOSE_FILE}" ]]; then
      LEGACY_COMPOSE_PATH="${source_dir}/${COMPOSE_FILE}"

      if [[ ! -f "${target_dir}/${COMPOSE_FILE}" ]]; then
        cp "${LEGACY_COMPOSE_PATH}" "${target_dir}/${COMPOSE_FILE}"
        ok "Migrated existing ${COMPOSE_FILE} to ${target_dir}"
      fi
    fi

    if [[ -d "${source_dir}/data" && "${source_dir}/data" != "$DATA_DIR" ]]; then
      LEGACY_DATA_PATH="${source_dir}/data"
      info "Existing data directory will be migrated after any legacy container is stopped."
    fi
  fi

  if [[ -z "$LEGACY_DATA_PATH" && -d "${target_dir}/data" && "${target_dir}/data" != "$DATA_DIR" ]]; then
    LEGACY_DATA_PATH="${target_dir}/data"
    info "Existing managed data directory will be migrated to ${DATA_DIR}."
  fi

  cd "$target_dir"
  ok "Using ${target_dir}"
}

stop_legacy_install() {
  if [[ -z "$LEGACY_COMPOSE_PATH" ]]; then
    return 0
  fi

  section "Legacy install"
  info "Stopping previous Compose project before starting the managed install..."
  if $DOCKER_COMPOSE -f "$LEGACY_COMPOSE_PATH" down --remove-orphans; then
    ok "Stopped previous Compose project"
  else
    warn "Could not stop previous Compose project automatically."
    warn "If port 3456 is still allocated, run: $DOCKER_COMPOSE -f ${LEGACY_COMPOSE_PATH} down --remove-orphans"
  fi
}

migrate_legacy_data() {
  if [[ -z "$LEGACY_DATA_PATH" ]]; then
    return 0
  fi

  section "Data migration"
  if [[ -e "$DATA_DIR" ]]; then
    ok "${DATA_DIR} already exists — keeping it"
    return 0
  fi

  run_root mkdir -p "$(dirname "$DATA_DIR")"
  mv "$LEGACY_DATA_PATH" "$DATA_DIR"
  ok "Migrated existing data directory to ${DATA_DIR}"
}

configure_data_bind_mount() {
  local escaped_data_dir

  section "Data directory"
  run_root mkdir -p "$DATA_DIR"
  run_root chown -R 1000:1000 "$DATA_DIR"

  escaped_data_dir="$(printf '%s' "$DATA_DIR" | sed 's/[&|]/\\&/g')"
  sed -i -E "s|^([[:space:]]*-[[:space:]]*).+:/data([[:space:]]*)$|\\1${escaped_data_dir}:/data\\2|" "$COMPOSE_FILE"

  ok "Persistent data bind mount: ${DATA_DIR} -> /data"
}

is_false() {
  case "${1,,}" in
    false|0|no|off|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

swap_is_active() {
  swapon --show=NAME --noheadings 2>/dev/null | awk '{print $1}' | grep -Fxq "$CANVAS_SWAP_FILE"
}

remove_swap_fstab_entry() {
  run_root sed -i '\|[[:space:]]# canvas-notebook swap$|d' /etc/fstab
  run_root sed -i "\|^${CANVAS_SWAP_FILE}[[:space:]]|d" /etc/fstab
}

disable_canvas_swap() {
  section "Swap"
  if swap_is_active; then
    run_root swapoff "$CANVAS_SWAP_FILE"
    ok "Disabled swap at ${CANVAS_SWAP_FILE}"
  else
    ok "Swap already disabled at ${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  if [[ -f "$CANVAS_SWAP_FILE" ]]; then
    run_root rm -f "$CANVAS_SWAP_FILE"
    ok "Removed ${CANVAS_SWAP_FILE}"
  fi
}

enable_canvas_swap() {
  section "Swap"
  if swap_is_active; then
    ok "Swap already enabled at ${CANVAS_SWAP_FILE}"
  else
    if [[ ! -f "$CANVAS_SWAP_FILE" ]]; then
      run_root fallocate -l "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE"
      ok "Created ${CANVAS_SWAP_SIZE} swapfile at ${CANVAS_SWAP_FILE}"
    fi

    run_root chmod 600 "$CANVAS_SWAP_FILE"
    run_root mkswap "$CANVAS_SWAP_FILE" >/dev/null
    run_root swapon "$CANVAS_SWAP_FILE"
    ok "Enabled swap at ${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  printf '%s none swap sw 0 0 # canvas-notebook swap\n' "$CANVAS_SWAP_FILE" | run_root tee -a /etc/fstab >/dev/null
  ok "Swap will be enabled after reboot"
}

configure_swap() {
  if is_false "$CANVAS_SWAP_ENABLED"; then
    disable_canvas_swap
  else
    enable_canvas_swap
  fi
}

cleanup_docker_artifacts() {
  section "Docker cleanup"
  info "Removing stopped containers and unused images..."

  if docker container prune -f >/dev/null 2>&1 || sudo docker container prune -f >/dev/null 2>&1; then
    ok "Removed stopped containers"
  else
    warn "Could not prune stopped containers"
  fi

  if docker image prune -a -f >/dev/null 2>&1 || sudo docker image prune -a -f >/dev/null 2>&1; then
    ok "Removed unused images"
  else
    warn "Could not prune unused images"
  fi
}

docker_image_digest() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker image inspect "$IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print $2}'
  elif sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
    sudo docker image inspect "$IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print $2}'
  fi
}

remote_image_digest() {
  if docker buildx imagetools inspect "$IMAGE" >/dev/null 2>&1; then
    docker buildx imagetools inspect "$IMAGE" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
  elif sudo docker buildx imagetools inspect "$IMAGE" >/dev/null 2>&1; then
    sudo docker buildx imagetools inspect "$IMAGE" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
  elif docker manifest inspect -v "$IMAGE" >/dev/null 2>&1; then
    docker manifest inspect -v "$IMAGE" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  elif sudo docker manifest inspect -v "$IMAGE" >/dev/null 2>&1; then
    sudo docker manifest inspect -v "$IMAGE" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  fi
}

pull_image_if_needed() {
  local remote_digest

  section "Image"
  remote_digest="$(remote_image_digest || true)"
  if [[ -n "$remote_digest" ]] && docker_image_digest | grep -Fxq "$remote_digest"; then
    ok "Already up to date (${IMAGE}@${remote_digest:0:19}…)"
    return 0
  fi

  local pull_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 layers size_msg
  pull_log="$(mktemp)"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" pull >"$pull_log" 2>&1 &
  local pull_pid=$!
  while kill -0 "$pull_pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} Pulling latest image…"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pull_pid" || { cat "$pull_log"; rm -f "$pull_log"; fail "Image pull failed"; }
  layers=$(grep -cE 'Pulling fs layer|Already exists' "$pull_log" 2>/dev/null || true)
  size_msg=$(grep -oP '\d+\.\d+MB|\d+MB|\d+\.\d+kB|\d+kB|\d+\.\d+GB|\d+GB' "$pull_log" 2>/dev/null \
    | awk '{sum+=$1; u=$2; if(u=="kB") sum+=$1/1024; else if(u=="GB") sum+=$1*1024} END {printf "%.0f", sum}')
  rm -f "$pull_log"
  printf "\r  ✓ Image pulled (%s layers, %s MB)\n" "${layers:-0}" "${size_msg:-0}"
}

install_manager_config() {
  local config_dir config_path install_dir_q compose_path_q data_dir_q swap_enabled_q swap_size_q swap_file_q log_dir_q
  config_dir="/etc/canvas-notebook"
  config_path="${config_dir}/manager.env"

  printf -v install_dir_q '%q' "$INSTALL_DIR"
  printf -v compose_path_q '%q' "${INSTALL_DIR}/${COMPOSE_FILE}"
  printf -v data_dir_q '%q' "$DATA_DIR"
  printf -v swap_enabled_q '%q' "$CANVAS_SWAP_ENABLED"
  printf -v swap_size_q '%q' "$CANVAS_SWAP_SIZE"
  printf -v swap_file_q '%q' "$CANVAS_SWAP_FILE"
  printf -v log_dir_q '%q' "/var/log/canvas-notebook"

  section "Manager config"
  run_root mkdir -p "$config_dir" /var/log/canvas-notebook
  run_root tee "$config_path" > /dev/null <<EOF
INSTALL_DIR=${install_dir_q}
COMPOSE_FILE=${compose_path_q}
DATA_DIR=${data_dir_q}
CANVAS_SWAP_ENABLED=${swap_enabled_q}
CANVAS_SWAP_SIZE=${swap_size_q}
CANVAS_SWAP_FILE=${swap_file_q}
SERVICE=canvas-notebook
CANVAS_MANAGER_LOG_DIR=${log_dir_q}
EOF
  ok "Wrote ${config_path}"
}

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
  local host_port health_url log_pgid attempt max_attempts since_ts

  host_port="$($DOCKER_COMPOSE -f "$COMPOSE_FILE" port canvas-notebook 3000 2>/dev/null | tail -1 | awk -F: '{print $NF}')"
  host_port="${host_port:-3456}"
  health_url="http://127.0.0.1:${host_port}/api/health"
  max_attempts="${INSTALL_HEALTH_MAX_ATTEMPTS:-180}"
  since_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  stop_log_stream() {
    if [[ -n "${log_pgid:-}" ]]; then
      kill -- "-$log_pgid" >/dev/null 2>&1 || true
      wait "-$log_pgid" >/dev/null 2>&1 || true
    fi
  }

  _wait_filter() {
    local line strip_ansi
    strip_ansi='s/\x1b\[[0-9;]*[a-zA-Z]//g'
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | sed "$strip_ansi")"
      line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
      [[ -z "$line" ]] && continue
      case "$line" in
        *Pulling*fs*layer*|*Pulling*layer*|*Downloading*|*Download*complete*|*Extracting*|*Pull*complete*|*Already*exists*) continue ;;
        *Recreating*|*Recreated*|*Starting*|*Started*) continue ;;
        *canvas-notebook*" | "*) line="$(printf '%s' "$line" | sed 's/^.*canvas-notebook[[:space:]]*|[[:space:]]*//')" ;;
      esac
      printf '%s\n' "$line"
    done
  }

  section "Container startup"
  info "Streaming startup logs…"
  pkill -f "docker[- ]compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
  pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true
  set -m
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" logs -f --since="$since_ts" canvas-notebook 2>&1 | _wait_filter &
  log_pgid=$(ps -o pgid= $! 2>/dev/null | tr -d ' ') || true
  set +m

  trap 'stop_log_stream' RETURN

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      stop_log_stream
      ok "Canvas Notebook is healthy (${health_url})"
      return 0
    fi
    sleep 1
  done

  stop_log_stream
  fail "Canvas Notebook did not become healthy within ${max_attempts}s. Run: $DOCKER_COMPOSE -f ${COMPOSE_FILE} logs canvas-notebook"
}

install_management_cli() {
  local install_dir compose_path bin_path fallback_bin_path tmp_path install_dir_q compose_path_q data_dir_q swap_enabled_q swap_size_q swap_file_q

  install_dir="$(pwd)"
  compose_path="${install_dir}/${COMPOSE_FILE}"
  bin_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  fallback_bin_path="/usr/bin/canvas-notebook"
  tmp_path="$(mktemp)"

  printf -v install_dir_q '%q' "$install_dir"
  printf -v compose_path_q '%q' "$compose_path"
  printf -v data_dir_q '%q' "$DATA_DIR"
  printf -v swap_enabled_q '%q' "$CANVAS_SWAP_ENABLED"
  printf -v swap_size_q '%q' "$CANVAS_SWAP_SIZE"
  printf -v swap_file_q '%q' "$CANVAS_SWAP_FILE"

  cat > "$tmp_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${install_dir_q}
COMPOSE_FILE=${compose_path_q}
DATA_DIR=${data_dir_q}
CANVAS_SWAP_ENABLED=${swap_enabled_q}
CANVAS_SWAP_SIZE=${swap_size_q}
CANVAS_SWAP_FILE=${swap_file_q}
SERVICE="canvas-notebook"
IMAGE_REF="${IMAGE}"
INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh"
CONFIG_FILE="\${CANVAS_MANAGER_CONFIG:-/etc/canvas-notebook/manager.env}"

if [[ -f "\$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "\$CONFIG_FILE"
  set +a
fi

DEFAULT_HEALTH_ATTEMPTS="\${CANVAS_HEALTH_MAX_ATTEMPTS:-180}"
LOG_DIR="\${CANVAS_MANAGER_LOG_DIR:-/var/log/canvas-notebook}"
LOG_FILE="\${LOG_DIR}/manager.log"

ok()      { printf '✓ %s\n' "\$*"; }
info()    { printf '  %s\n' "\$*"; }
warn()    { printf '! %s\n' "\$*" >&2; }
fail()    { printf '✗ %s\n' "\$*" >&2; exit 1; }

CLI_GREEN='\033[0;32m'; CLI_CYAN='\033[0;36m'; CLI_BOLD='\033[1m'; CLI_DIM='\033[2m'; CLI_RESET='\033[0m'

progress_bar() {
  local current="\$1" total="\$2" label="\${3:-}"
  local width=25 filled=\$((current * width / (total > 0 ? total : 1)))
  local bar=""
  for ((i=0; i<width; i++)); do
    [[ \$i -lt \$filled ]] && bar+="█" || bar+="░"
  done
  printf "\r  \${CLI_DIM}[\${CLI_RESET}\${bar}\${CLI_DIM}]\${CLI_RESET} %3d%% %s" "\$((current * 100 / (total > 0 ? total : 1)))" "\$label"
}

run_with_spinner() {
  local msg="\$1"; shift
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' tmp_log pid i=0 rc
  tmp_log="\$(mktemp)"
  "\$@" >"\$tmp_log" 2>&1 &
  pid=\$!
  while kill -0 "\$pid" 2>/dev/null; do
    printf "\r  \${spin:\$((i % \${#spin})):1} %s" "\$msg"
    i=\$((i + 1))
    sleep 0.08
  done
  wait "\$pid" || rc=\$?
  if [[ -n "\${rc:-}" ]] && [[ "\$rc" -ne 0 ]]; then
    printf "\r  ✗ %s\n" "\$msg"
    cat "\$tmp_log"
    rm -f "\$tmp_log"
    return "\$rc"
  fi
  printf "\r  ✓ %s\n" "\$msg"
  cat "\$tmp_log" >> "\$LOG_FILE" 2>/dev/null || true
  rm -f "\$tmp_log"
}

count_pull_layers() {
  local log_file="\$1" count
  count=\$(grep -cE 'Pulling fs layer|Already exists' "\$log_file" 2>/dev/null || true)
  printf '%s' "\${count:-0}"
}

pull_size_mb() {
  local log_file="\$1" total
  total=\$(grep -oP '\d+\.\d+MB|\d+MB|\d+\.\d+kB|\d+kB|\d+\.\d+GB|\d+GB' "\$log_file" 2>/dev/null \
    | awk '{sum+=\$1; u=\$2; if(u=="kB") sum+=\$1/1024; else if(u=="GB") sum+=\$1*1024} END {printf "%.0f", sum}')
  printf '%s' "\${total:-0}"
}

ensure_log_file() {
  if mkdir -p "\$LOG_DIR" >/dev/null 2>&1; then
    :
  elif command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "\$LOG_DIR" >/dev/null 2>&1 || true
    sudo touch "\$LOG_FILE" >/dev/null 2>&1 || true
    sudo chown -R "\$(id -u):\$(id -g)" "\$LOG_DIR" >/dev/null 2>&1 || true
  fi

  if ! touch "\$LOG_FILE" >/dev/null 2>&1; then
    LOG_DIR="\${HOME}/.local/state/canvas-notebook"
    LOG_FILE="\${LOG_DIR}/manager.log"
    mkdir -p "\$LOG_DIR" >/dev/null 2>&1 || true
    touch "\$LOG_FILE" >/dev/null 2>&1 || true
  fi
}

log_msg() {
  ensure_log_file
  printf '%s %s\n' "\$(date -Is)" "\$*" >> "\$LOG_FILE" 2>/dev/null || true
}

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
  if [[ "\${NO_BANNER:-false}" != "true" ]]; then
    banner
  fi
  cat <<'HELP'
Usage:
  canvas-notebook <command> [--json] [--no-banner]

Commands:
  help       Show this help
  install    Pull the image and start/recreate the container
  update     Pull the latest image, recreate the container, and wait until healthy
  start      Start the container and wait until healthy
  restart    Restart the container and wait until healthy
  stop       Stop the container
  down       Stop and remove the container
  status     Show compose status; use --json for machine-readable output
  logs       Follow container logs
  container-logs
             Alias for logs
  manager-log
             Show the host-side CLI management log
  env        Edit the Compose environment, sync Caddy, and restart
  swap       Show swap status
  swap-enable
             Enable Canvas-managed swap and persist it
  swap-disable
             Disable Canvas-managed swap and persist it
  caddy      Check Caddy status and current Caddyfile
  caddy-reload
             Sync Caddy from BETTER_AUTH_BASE_URL and reload it
  diagnose   Show host, Docker, memory, OOM, and container diagnostics
  health     Check the local health endpoint; use --json for machine-readable output
  config     Show the compose file path
  cli-update Download the latest management CLI and systemd service from GitHub
  cleanup-logs
             Kill orphaned docker compose log followers

Environment:
  CANVAS_HEALTH_MAX_ATTEMPTS=180   Health wait timeout in seconds
  CANVAS_MANAGER_LOG_DIR=/var/log/canvas-notebook
  CANVAS_SWAP_ENABLED=true         Enable Canvas-managed swap by default
  CANVAS_SWAP_SIZE=2G              Canvas-managed swapfile size
  CANVAS_SWAP_FILE=/swapfile       Canvas-managed swapfile path
  TAIL=120                         Number of log lines shown before following
HELP
}

compose_optional() {
  cd "\$INSTALL_DIR"
  if docker info >/dev/null 2>&1; then
    docker compose -f "\$COMPOSE_FILE" "\$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker compose -f "\$COMPOSE_FILE" "\$@"
  else
    return 1
  fi
}

compose() {
  compose_optional "\$@" || fail "Docker is not reachable. Try logging out/in for docker group changes, or run with a user that can access Docker."
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "\$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker "\$@"
  else
    return 1
  fi
}

run_root() {
  if [[ "\${EUID:-\$(id -u)}" -eq 0 ]]; then
    "\$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "\$@"
  else
    return 1
  fi
}

is_false() {
  case "\${1,,}" in
    false|0|no|off|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

set_manager_env() {
  local key="\$1" value="\$2" escaped
  run_root mkdir -p "\$(dirname "\$CONFIG_FILE")"
  run_root touch "\$CONFIG_FILE"
  escaped="\$(printf '%s' "\$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^\${key}=" "\$CONFIG_FILE" 2>/dev/null; then
    run_root sed -i "s|^\${key}=.*|\${key}=\${escaped}|" "\$CONFIG_FILE"
  else
    printf '%s=%s\n' "\$key" "\$value" | run_root tee -a "\$CONFIG_FILE" >/dev/null
  fi
}

swap_is_active() {
  swapon --show=NAME --noheadings 2>/dev/null | awk '{print \$1}' | grep -Fxq "\$CANVAS_SWAP_FILE"
}

remove_swap_fstab_entry() {
  run_root sed -i '\|[[:space:]]# canvas-notebook swap$|d' /etc/fstab
  run_root sed -i "\|^\${CANVAS_SWAP_FILE}[[:space:]]|d" /etc/fstab
}

show_swap_status() {
  printf 'Canvas swap enabled setting: %s\n' "\$CANVAS_SWAP_ENABLED"
  printf 'Canvas swap file: %s\n' "\$CANVAS_SWAP_FILE"
  printf 'Canvas swap size: %s\n' "\$CANVAS_SWAP_SIZE"
  printf '\n== swapon ==\n'
  swapon --show || true
  printf '\n== memory ==\n'
  free -h || true
}

enable_canvas_swap() {
  if swap_is_active; then
    ok "Swap already enabled at \${CANVAS_SWAP_FILE}"
  else
    if [[ ! -f "\$CANVAS_SWAP_FILE" ]]; then
      run_root fallocate -l "\$CANVAS_SWAP_SIZE" "\$CANVAS_SWAP_FILE"
      ok "Created \${CANVAS_SWAP_SIZE} swapfile at \${CANVAS_SWAP_FILE}"
    fi
    run_root chmod 600 "\$CANVAS_SWAP_FILE"
    run_root mkswap "\$CANVAS_SWAP_FILE" >/dev/null
    run_root swapon "\$CANVAS_SWAP_FILE"
    ok "Enabled swap at \${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  printf '%s none swap sw 0 0 # canvas-notebook swap\n' "\$CANVAS_SWAP_FILE" | run_root tee -a /etc/fstab >/dev/null
  set_manager_env CANVAS_SWAP_ENABLED true
  set_manager_env CANVAS_SWAP_SIZE "\$CANVAS_SWAP_SIZE"
  set_manager_env CANVAS_SWAP_FILE "\$CANVAS_SWAP_FILE"
  ok "Swap setting saved to \${CONFIG_FILE}"
}

disable_canvas_swap() {
  if swap_is_active; then
    run_root swapoff "\$CANVAS_SWAP_FILE"
    ok "Disabled swap at \${CANVAS_SWAP_FILE}"
  else
    ok "Swap already disabled at \${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  if [[ -f "\$CANVAS_SWAP_FILE" ]]; then
    run_root rm -f "\$CANVAS_SWAP_FILE"
    ok "Removed \${CANVAS_SWAP_FILE}"
  fi
  set_manager_env CANVAS_SWAP_ENABLED false
  set_manager_env CANVAS_SWAP_SIZE "\$CANVAS_SWAP_SIZE"
  set_manager_env CANVAS_SWAP_FILE "\$CANVAS_SWAP_FILE"
  ok "Swap setting saved to \${CONFIG_FILE}"
}

run_compose() {
  log_msg "compose \$*"
  compose "\$@" 2>&1 | tee -a "\$LOG_FILE"
  return "\${PIPESTATUS[0]}"
}

image_digest() {
  docker_cmd image inspect "\$IMAGE_REF" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -F@ 'NF == 2 {print \$2}' || true
}

remote_image_digest() {
  if docker_cmd buildx imagetools inspect "\$IMAGE_REF" >/dev/null 2>&1; then
    docker_cmd buildx imagetools inspect "\$IMAGE_REF" 2>/dev/null | awk '/^Digest:/ {print \$2; exit}'
  elif docker_cmd manifest inspect -v "\$IMAGE_REF" >/dev/null 2>&1; then
    docker_cmd manifest inspect -v "\$IMAGE_REF" 2>/dev/null | sed -n 's/.*"Descriptor":{.*"digest":"\([^"]*\)".*/\1/p' | head -1
  fi
}

pull_image_if_needed() {
  local remote_digest
  remote_digest="\$(remote_image_digest || true)"
  if [[ -n "\$remote_digest" ]] && image_digest | grep -Fxq "\$remote_digest"; then
    ok "Already up to date (\${IMAGE_REF}@\${remote_digest:0:19}…)"
    log_msg "pull skipped image current \$remote_digest"
    return 0
  fi

  local pull_log layers size_msg
  pull_log="\$(mktemp)"
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  compose pull "\$SERVICE" >"\$pull_log" 2>&1 &
  local pull_pid=\$!
  while kill -0 "\$pull_pid" 2>/dev/null; do
    printf "\r  \${spin:\$((i % \${#spin})):1} Pulling latest image…"
    i=\$((i + 1))
    sleep 0.08
  done
  wait "\$pull_pid" || { cat "\$pull_log"; rm -f "\$pull_log"; fail "Image pull failed"; }

  layers=\$(count_pull_layers "\$pull_log")
  size_msg=\$(pull_size_mb "\$pull_log")
  cat "\$pull_log" >> "\$LOG_FILE" 2>/dev/null || true
  rm -f "\$pull_log"
  printf "\r  ✓ Image pulled (%s layers, %s MB)\n" "\$layers" "\$size_msg"
  log_msg "pull completed layers=\$layers size_mb=\$size_msg"
}

cleanup_docker_artifacts() {
  log_msg "docker cleanup"
  docker_cmd container prune -f >/dev/null 2>&1 || true
  docker_cmd image prune -a -f >/dev/null 2>&1 || true
}

host_port() {
  compose_optional port "\$SERVICE" 3000 2>/dev/null | tail -1 | awk -F: '{print \$NF}' || true
}

health_url() {
  local port
  port="\$(host_port)"
  port="\${port:-3456}"
  printf 'http://127.0.0.1:%s/api/health\n' "\$port"
}

compose_env_value() {
  local key="\$1"
  sed -n -E "/^[[:space:]]*\${key}:/ {
    s|^[^:]*:[[:space:]]*||
    s|[[:space:]]+#.*$||
    s|^[\"']||
    s|[\"'][[:space:]]*$||
    s|[[:space:]]*$||
    p
    q
  }" "\$COMPOSE_FILE"
}

configured_base_url() {
  local url
  url="\$(compose_env_value BETTER_AUTH_BASE_URL)"
  if [[ -z "\$url" ]]; then
    url="\$(compose_env_value BASE_URL)"
  fi
  printf '%s\n' "\$url"
}

configured_domain() {
  local url
  url="\$(configured_base_url)"
  printf '%s\n' "\$url" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1
}

is_real_domain() {
  local domain="\$1"
  [[ -n "\$domain" ]] && [[ "\$domain" != "localhost" ]] && ! [[ "\$domain" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\$ ]]
}

sync_caddy_from_compose() {
  local domain caddyfile
  domain="\$(configured_domain)"
  caddyfile="/etc/caddy/Caddyfile"

  if ! is_real_domain "\$domain"; then
    info "No public domain configured in BETTER_AUTH_BASE_URL or BASE_URL; skipping Caddy sync."
    return 0
  fi

  if ! command -v caddy >/dev/null 2>&1 && ! command -v systemctl >/dev/null 2>&1; then
    info "Caddy is not installed; skipping Caddy sync."
    return 0
  fi

  printf '%s {\n    reverse_proxy localhost:3456\n}\n' "\$domain" | run_root tee "\$caddyfile" >/dev/null
  if command -v caddy >/dev/null 2>&1; then
    run_root caddy validate --config "\$caddyfile" >/dev/null 2>&1 || fail "Caddyfile validation failed."
  fi
  run_root systemctl reload caddy >/dev/null 2>&1 || run_root systemctl restart caddy >/dev/null 2>&1 || warn "Could not reload Caddy."
  ok "Caddy synced for https://\${domain}"
}

show_caddy_status() {
  printf 'Configured base URL: %s\n' "\$(configured_base_url)"
  printf 'Configured Caddy domain: %s\n\n' "\$(configured_domain)"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --no-pager status caddy || true
  else
    warn "systemctl is not available."
  fi

  if [[ -f /etc/caddy/Caddyfile ]]; then
    printf '\n== /etc/caddy/Caddyfile ==\n'
    cat /etc/caddy/Caddyfile
  fi
}

edit_env() {
  local editor
  editor="\${EDITOR:-nano}"
  command -v "\$editor" >/dev/null 2>&1 || editor="vi"
  "\$editor" "\$COMPOSE_FILE"
  sync_caddy_from_compose
  run_compose up -d --force-recreate "\$SERVICE"
  follow_until_healthy
}

recreate_container() {
  local recreate_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  recreate_log="\$(mktemp)"
  compose up -d --force-recreate "\$SERVICE" >"\$recreate_log" 2>&1 &
  local rec_pid=\$!
  while kill -0 "\$rec_pid" 2>/dev/null; do
    printf "\r  \${spin:\$((i % \${#spin})):1} Recreating container…"
    i=\$((i + 1))
    sleep 0.08
  done
  wait "\$rec_pid" || { cat "\$recreate_log"; rm -f "\$recreate_log"; fail "Container recreate failed"; }
  cat "\$recreate_log" >> "\$LOG_FILE" 2>/dev/null || true
  rm -f "\$recreate_log"
  printf "\r  ✓ Container recreated\n"
  log_msg "container recreated"
}

wait_until_healthy() {
  local url attempts attempt elapsed
  url="\$(health_url)"
  attempts="\$DEFAULT_HEALTH_ATTEMPTS"
  info "Waiting for Canvas Notebook health check: \$url"

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS "\$url" >/dev/null 2>&1; then
      progress_bar "\$attempt" "\$attempts" ""
      printf "\n"
      ok "Canvas Notebook is healthy"
      return 0
    fi
    elapsed=\$attempt
    progress_bar "\$elapsed" "\$attempts" "Waiting for healthy (\${elapsed}s/\${attempts}s)"
    sleep 1
  done

  printf "\n"
  fail "Canvas Notebook did not become healthy within \${attempts}s. Run: canvas-notebook logs"
}

follow_until_healthy() {
  local log_pgid attempts attempt url since_ts
  attempts="\$DEFAULT_HEALTH_ATTEMPTS"
  url="\$(health_url)"
  since_ts="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  stop_log_stream() {
    if [[ -n "\${log_pgid:-}" ]]; then
      kill -- "-\$log_pgid" >/dev/null 2>&1 || true
      wait "-\$log_pgid" >/dev/null 2>&1 || true
    fi
  }

  info "Streaming startup logs…"

  pkill -f "docker[- ]compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
  pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true

  _follow_filter() {
    local line strip_ansi
    strip_ansi='s/\x1b\[[0-9;]*[a-zA-Z]//g'
    while IFS= read -r line; do
      line="\$(printf '%s' "\$line" | sed "\$strip_ansi")"
      line="\$(printf '%s' "\$line" | sed 's/^[[:space:]]*//')"
      [[ -z "\$line" ]] && continue
      case "\$line" in
        *Pulling*fs*layer*|*Pulling*layer*|*Downloading*|*Download*complete*|*Extracting*|*Pull*complete*|*Already*exists*) continue ;;
        *Recreating*|*Recreated*|*Starting*|*Started*) continue ;;
        *canvas-notebook*" | "*) line="\$(printf '%s' "\$line" | sed 's/^.*canvas-notebook[[:space:]]*|[[:space:]]*//')" ;;
      esac
      printf '%s\n' "\$line"
    done
  }

  set -m
  compose logs -f --since="\$since_ts" "\$SERVICE" 2>&1 | _follow_filter | tee -a "\$LOG_FILE" &
  log_pgid=\$(ps -o pgid= \$! 2>/dev/null | tr -d ' ') || true
  set +m

  trap 'stop_log_stream' RETURN

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS "\$url" >/dev/null 2>&1; then
      stop_log_stream
      ok "Canvas Notebook is healthy"
      return 0
    fi
    sleep 1
  done

  stop_log_stream
  fail "Canvas Notebook did not become healthy within \${attempts}s. Run: canvas-notebook logs"
}

container_id() {
  compose_optional ps -q "\$SERVICE" 2>/dev/null || true
}

show_manager_log() {
  ensure_log_file
  tail -n "\${TAIL:-200}" "\$LOG_FILE"
}

diagnose() {
  local cid url
  ensure_log_file
  log_msg "diagnose"
  url="\$(health_url)"
  cid="\$(container_id)"

  printf '\n== Canvas Notebook ==\n'
  printf 'Install dir: %s\n' "\$INSTALL_DIR"
  printf 'Compose file: %s\n' "\$COMPOSE_FILE"
  printf 'Manager log: %s\n' "\$LOG_FILE"
  printf 'Health URL: %s\n' "\$url"
  if curl -fsS "\$url" >/dev/null 2>&1; then
    printf 'Health: ok\n'
  else
    printf 'Health: failed\n'
  fi

  printf '\n== VM resources ==\n'
  uptime || true
  free -h || true
  df -h / "\$INSTALL_DIR" 2>/dev/null || df -h / || true

  printf '\n== Docker compose ==\n'
  compose_optional ps || true

  if [[ -n "\$cid" ]]; then
    printf '\n== Container state ==\n'
    docker_cmd inspect --format 'Name={{.Name}} Status={{.State.Status}} Running={{.State.Running}} Restarting={{.State.Restarting}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Started={{.State.StartedAt}} Finished={{.State.FinishedAt}} RestartCount={{.RestartCount}}' "\$cid" 2>/dev/null || true

    printf '\n== Container resource snapshot ==\n'
    docker_cmd stats --no-stream "\$cid" 2>/dev/null || true
  fi

  printf '\n== Recent container logs ==\n'
  compose_optional logs --tail="\${TAIL:-120}" "\$SERVICE" || true

  printf '\n== Possible OOM / kernel crash evidence ==\n'
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -k -b --no-pager 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
    if journalctl --list-boots >/dev/null 2>&1; then
      printf '\n== Previous boot crash evidence ==\n'
      journalctl -k -b -1 --no-pager 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
    fi
  else
    dmesg 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
  fi
}

json_escape() {
  printf '%s' "\$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

status_json() {
  local cid url healthy service_active container_json install_dir_json compose_file_json data_dir_json log_file_json service_active_json

  ensure_log_file
  url="\$(health_url)"
  healthy=false
  if curl -fsS "\$url" >/dev/null 2>&1; then
    healthy=true
  fi

  cid="\$(container_id)"
  container_json="null"
  if [[ -n "\$cid" ]]; then
    container_json="\$(docker_cmd inspect --format '{"id":"{{.Id}}","name":"{{.Name}}","status":"{{.State.Status}}","running":{{.State.Running}},"restarting":{{.State.Restarting}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}}}' "\$cid" 2>/dev/null || printf 'null')"
  fi

  service_active="unknown"
  if command -v systemctl >/dev/null 2>&1; then
    service_active="\$(systemctl is-active canvas-notebook.service 2>/dev/null || true)"
  fi

  install_dir_json="\$(json_escape "\$INSTALL_DIR")"
  compose_file_json="\$(json_escape "\$COMPOSE_FILE")"
  data_dir_json="\$(json_escape "\${DATA_DIR:-}")"
  log_file_json="\$(json_escape "\$LOG_FILE")"
  service_active_json="\$(json_escape "\$service_active")"

  printf '{"healthy":%s,"serviceActive":"%s","installDir":"%s","composeFile":"%s","dataDir":"%s","managerLog":"%s","container":%s}\n' \
    "\$healthy" "\$service_active_json" "\$install_dir_json" "\$compose_file_json" "\$data_dir_json" "\$log_file_json" "\$container_json"
}

diagnose_json() {
  local status mem_total mem_available disk_total disk_available
  mem_total="\$(awk '/MemTotal/ {print \$2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)"
  mem_available="\$(awk '/MemAvailable/ {print \$2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)"
  disk_total="\$(df -P / 2>/dev/null | awk 'NR==2 {print \$2 * 1024}' || printf 0)"
  disk_available="\$(df -P / 2>/dev/null | awk 'NR==2 {print \$4 * 1024}' || printf 0)"
  status="\$(status_json)"
  printf '{"status":%s,"vm":{"memoryTotalBytes":%s,"memoryAvailableBytes":%s,"diskTotalBytes":%s,"diskAvailableBytes":%s}}\n' \
    "\$status" "\${mem_total:-0}" "\${mem_available:-0}" "\${disk_total:-0}" "\${disk_available:-0}"
}

cmd="\${1:-help}"
if [[ "\$#" -gt 0 ]]; then
  shift
fi

OUTPUT_JSON=false
NO_BANNER=false
while [[ "\$#" -gt 0 ]]; do
  case "\$1" in
    --json)
      OUTPUT_JSON=true
      NO_BANNER=true
      ;;
    --no-banner)
      NO_BANNER=true
      ;;
    *)
      fail "Unknown option: \$1"
      ;;
  esac
  shift
done

case "\$cmd" in
  install|update|start|restart|stop|down|status|ps|logs|container-logs|manager-log|env|swap|swap-enable|swap-disable|caddy|caddy-reload|diagnose|health|config|cli-update|cleanup-logs)
    if [[ "\$NO_BANNER" != "true" ]]; then
      banner
    fi
    ;;
esac

case "\$cmd" in
  help|-h|--help)
    usage
    ;;
  install|update)
    log_msg "\$cmd started"
    info "Phase 1/3: Image"
    pull_image_if_needed
    info "Phase 2/3: Container"
    recreate_container
    info "Phase 3/3: Health check"
    follow_until_healthy
    cleanup_docker_artifacts
    log_msg "\$cmd completed"
    ;;
  start)
    log_msg "start"
    run_compose up -d "\$SERVICE"
    wait_until_healthy
    ;;
  restart)
    log_msg "restart"
    run_compose restart "\$SERVICE"
    wait_until_healthy
    ;;
  stop)
    log_msg "stop"
    run_compose stop "\$SERVICE"
    ;;
  down)
    log_msg "down"
    run_compose down
    ;;
  status|ps)
    if [[ "\$OUTPUT_JSON" == "true" ]]; then
      status_json
    else
      compose ps
    fi
    ;;
  logs|container-logs)
    compose logs -f --tail="\${TAIL:-120}" "\$SERVICE"
    ;;
  manager-log)
    show_manager_log
    ;;
  env)
    edit_env
    ;;
  swap)
    show_swap_status
    ;;
  swap-enable)
    enable_canvas_swap
    ;;
  swap-disable)
    disable_canvas_swap
    ;;
  caddy)
    show_caddy_status
    ;;
  caddy-reload)
    sync_caddy_from_compose
    ;;
  diagnose)
    if [[ "\$OUTPUT_JSON" == "true" ]]; then
      diagnose_json
    else
      diagnose
    fi
    ;;
  health)
    log_msg "health"
    if curl -fsS "\$(health_url)" >/dev/null 2>&1; then
      if [[ "\$OUTPUT_JSON" == "true" ]]; then
        printf '{"healthy":true}\n'
      else
        curl -fsS "\$(health_url)" && printf '\n'
      fi
    else
      if [[ "\$OUTPUT_JSON" == "true" ]]; then
        printf '{"healthy":false}\n'
      fi
      exit 1
    fi
    ;;
  config)
    ensure_log_file
    printf 'Install dir: %s\nCompose file: %s\nData dir: %s\nConfig file: %s\nManager log: %s\n' "\$INSTALL_DIR" "\$COMPOSE_FILE" "\${DATA_DIR:-}" "\$CONFIG_FILE" "\$LOG_FILE"
    ;;
  cli-update)
    log_msg "cli-update started"
    tmp_installer="$(mktemp /tmp/canvas-notebook-install.XXXXXX.sh)"
    info "Downloading latest installer from GitHub..."
    if ! curl -fsSL "\$INSTALL_SCRIPT_URL" -o "\$tmp_installer"; then
      rm -f "\$tmp_installer"
      fail "Failed to download installer from \$INSTALL_SCRIPT_URL"
    fi
    chmod +x "\$tmp_installer"
    info "Installing updated CLI and systemd service..."
    if CLI_UPDATE_ONLY=true bash "\$tmp_installer"; then
      rm -f "\$tmp_installer"
      ok "Canvas Notebook management CLI updated successfully"
      log_msg "cli-update completed"
    else
      rm -f "\$tmp_installer"
      fail "CLI update failed — previous version is still in place"
    fi
    ;;
  cleanup-logs)
    pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true
    pkill -f "docker-compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
    ok "Killed any orphaned compose-log followers"
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

  if [[ "$bin_path" != "$fallback_bin_path" ]]; then
    if [[ -w "$(dirname "$fallback_bin_path")" ]]; then
      ln -sf "$bin_path" "$fallback_bin_path" 2>/dev/null || true
    else
      sudo ln -sf "$bin_path" "$fallback_bin_path" 2>/dev/null || true
    fi
  fi

  ok "Installed management CLI: ${bin_path}"
  [[ -x "$fallback_bin_path" ]] && info "Also available as: ${fallback_bin_path}"
  info "Run: canvas-notebook help"
}

install_systemd_service() {
  local service_path cli_path
  service_path="/etc/systemd/system/${SYSTEMD_SERVICE}"
  cli_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — skipping host service installation."
    return 0
  fi

  section "System service"
  run_root tee "$service_path" > /dev/null <<EOF
[Unit]
Description=Canvas Notebook
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-/etc/canvas-notebook/manager.env
Environment=CANVAS_MANAGER_LOG_DIR=/var/log/canvas-notebook
ExecStart=${cli_path} start --no-banner
ExecStop=${cli_path} stop --no-banner
ExecReload=${cli_path} restart --no-banner
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

  run_root systemctl daemon-reload
  if [[ "${CLI_UPDATE_ONLY:-false}" != "true" ]]; then
    run_root systemctl enable "$SYSTEMD_SERVICE" >/dev/null
    run_root systemctl start "$SYSTEMD_SERVICE"
    ok "Installed and enabled ${SYSTEMD_SERVICE}"
    info "Service logs: journalctl -u ${SYSTEMD_SERVICE}"
  else
    ok "Reloaded ${SYSTEMD_SERVICE} unit (no restart)"
  fi
}

# ── CLI-only update mode ─────────────────────────────────────────────────────
if [[ "${CLI_UPDATE_ONLY:-false}" == "true" ]]; then
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

  # install_management_cli uses pwd + COMPOSE_FILE basename to build the path
  COMPOSE_FILE="$(basename "${COMPOSE_FILE:-canvas-notebook-compose.yaml}")"
  DOCKER_COMPOSE="${DOCKER_COMPOSE:-docker compose}"

  if [[ -n "${INSTALL_DIR:-}" && -d "$INSTALL_DIR" ]]; then
    cd "$INSTALL_DIR"
  fi

  install_management_cli
  install_systemd_service

  ok "Canvas Notebook management CLI updated"
  exit 0
fi

# ── Mode 1: Pre-built image ───────────────────────────────────────────────────
if [[ "$MODE_CHOICE" == "1" ]]; then

  ensure_host_install
  prepare_install_dir
  configure_swap
  install_docker
  stop_legacy_install
  migrate_legacy_data
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

  # Ensure /data is a persistent bind mount in the VM user's home directory.
  configure_data_bind_mount

  # Pull and start
  section "Starting Canvas Notebook"
  pull_image_if_needed
  local _rec_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' _i=0
  _rec_log="$(mktemp)"
  $DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --force-recreate >"$_rec_log" 2>&1 &
  local _rec_pid=$!
  while kill -0 "$_rec_pid" 2>/dev/null; do
    printf "\r  ${spin:$((_i % ${#spin})):1} Creating container…"
    _i=$((_i + 1))
    sleep 0.08
  done
  wait "$_rec_pid" || { cat "$_rec_log"; rm -f "$_rec_log"; fail "Container start failed"; }
  rm -f "$_rec_log"
  printf "\r  ✓ Container created\n"
  wait_for_canvas_startup
  cleanup_docker_artifacts
  install_manager_config
  install_management_cli
  install_systemd_service

  # Configure Caddy
  CONFIGURED_BASE_URL="$(grep 'BETTER_AUTH_BASE_URL:' "$COMPOSE_FILE" | head -1 | sed 's/.*"\(.*\)"/\1/' | tr -d '[:space:]')"
  DOMAIN="$(echo "$CONFIGURED_BASE_URL" | sed 's|^https\?://||' | cut -d/ -f1 | cut -d: -f1)"
  configure_caddy "$DOMAIN"

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
