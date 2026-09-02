#!/usr/bin/env bash
[[ -n "${_SHARED_UI_LOADED:-}" ]] && return 0
_SHARED_UI_LOADED=1

CLI_BOLD='\033[1m'; CLI_DIM='\033[2m'; CLI_RESET='\033[0m'

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
  if [[ "${NO_BANNER:-false}" != "true" ]]; then
    banner
  fi
  cat <<'HELP'
Usage:
  canvas-notebook <command> [options] [--json] [--no-banner]

Commands:
  help       Show this help
  version    Show CLI, pulled image, and running container build info
  install    Pull the image and start/recreate the container
  update [--image <name@sha256>] [--require-pinned]
             Pull and apply an image with rollback protection
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
  env        Show current environment from config.json
  env --render | env --sync --timeout <seconds>
             Render only, or reconcile services and wait for health
  env --edit Open config.json in editor, then sync and restart
  backup create [--output <path>]
             Create/replace the local latest full backup
  database status
             Show configured database provider status
  database prepare-postgres --timeout <seconds>
             Prepare local Postgres service without migrating SQLite data
  database reconcile-postgres-auth --timeout <seconds>
             Reconcile local Postgres auth, then render env and restart the app
  admin reset-password --email <email> [--name <name>] [--password-stdin]
             Reset or create the admin password inside the running container without storing it in env
  swap       Show swap status; use --json for machine-readable output
  swap-sync  Reconcile the host with swap.* from config.json
  swap-apply --enabled true --size 2G --file /swapfile --swappiness 10
               Atomically persist and apply the complete desired swap state
  swap-enable [--size 2G] [--file /swapfile] [--swappiness 10]
               Enable Canvas-managed swap and persist it
  swap-disable [--secure]
               Disable Canvas-managed swap and persist it
  caddy      Check Caddy status and current Caddyfile
  caddy-reload
               Sync Caddy from config.json domain and reload it
  caddy-fix
               Fix known Caddy issues (duplicate definitions, missing headers)
  diagnose   Show host, Docker, memory, OOM, and container diagnostics
  health     Check the local health endpoint; use --json for machine-readable output
  config     Show config paths
  config-show --json --secret-state
               Show masked config plus local secret presence and SHA-256 fingerprints
  config-set <key> <value> | config-set <key> --stdin
               Read a single-line config value from stdin without echoing it
  config-migrate [--force]
               Migrate from legacy manager.env + Compose to config.json
  cli-update Download the latest management CLI and systemd service from GitHub
  auto-update-status
               Show auto-update timer status and last update result
  auto-update-enable [--schedule "..."]
               Enable the pinned-image verification timer for standalone installs
  auto-update-disable
                Disable automatic image updates
  auto-update-sync
                Sync timer state with config (fix inconsistencies)
  cleanup-logs
               Kill orphaned docker compose log followers

Environment:
  CANVAS_HEALTH_MAX_ATTEMPTS=180   Health wait timeout in seconds
  CANVAS_MANAGER_LOG_DIR=/var/log/canvas-notebook
  TAIL=120                         Number of log lines shown before following
HELP
}

progress_bar() {
  local current="$1" total="$2" label="${3:-}"
  local width=25
  local filled=$((current * width / (total > 0 ? total : 1)))
  local bar=""
  for ((i=0; i<width; i++)); do
    [[ $i -lt $filled ]] && bar+="█" || bar+="░"
  done
  printf "\r  ${CLI_DIM}[${CLI_RESET}${bar}${CLI_DIM}]${CLI_RESET} %3d%% %s" "$((current * 100 / (total > 0 ? total : 1)))" "$label"
}

run_with_spinner() {
  local msg="$1"; shift
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' tmp_log pid rc
  local i=0
  tmp_log="$(mktemp)"
  "$@" >"$tmp_log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} %s" "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" || rc=$?
  if [[ -n "${rc:-}" ]] && [[ "$rc" -ne 0 ]]; then
    printf "\r  ✗ %s\n" "$msg"
    cat "$tmp_log"
    rm -f "$tmp_log"
    return "$rc"
  fi
  printf "\r  ✓ %s\n" "$msg"
  cat "$tmp_log" >> "$LOG_FILE" 2>/dev/null || true
  rm -f "$tmp_log"
}

recreate_container() {
  local recreate_log spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0 timeout_seconds="${1:-0}" started_at
  recreate_log="$(mktemp)"
  compose up -d --force-recreate --no-deps "$SERVICE" >"$recreate_log" 2>&1 &
  local rec_pid=$!
  started_at="$SECONDS"
  while kill -0 "$rec_pid" 2>/dev/null; do
    if [[ "$timeout_seconds" -gt 0 && $((SECONDS - started_at)) -ge "$timeout_seconds" ]]; then
      kill "$rec_pid" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "$rec_pid" >/dev/null 2>&1 || true
      wait "$rec_pid" >/dev/null 2>&1 || true
      rm -f "$recreate_log"
      return 124
    fi
    printf "\r  ${spin:$((i % ${#spin})):1} Recreating container..."
    i=$((i + 1))
    sleep 0.08
  done
  wait "$rec_pid" || { cat "$recreate_log"; rm -f "$recreate_log"; fail "Container recreate failed"; }
  cat "$recreate_log" >> "$LOG_FILE" 2>/dev/null || true
  rm -f "$recreate_log"
  printf "\r  ✓ Container recreated\n"
  log_msg "container recreated"
}

wait_until_healthy() {
  local url attempts attempt elapsed deadline_seconds="${2:-0}" remaining probe_timeout
  url="$(health_url)"
  attempts="${1:-$DEFAULT_HEALTH_ATTEMPTS}"
  info "Waiting for Canvas Notebook health check: $url"

  for ((attempt=1; attempt<=attempts; attempt++)); do
    probe_timeout=2
    if [[ "$deadline_seconds" -gt 0 ]]; then
      remaining=$((deadline_seconds - $(date +%s)))
      [[ "$remaining" -ge 1 ]] || break
      [[ "$probe_timeout" -le "$remaining" ]] || probe_timeout="$remaining"
    fi
    if canvas_health_probe "$url" "$probe_timeout"; then
      progress_bar "$attempt" "$attempts" ""
      printf "\n"
      ok "Canvas Notebook is healthy"
      return 0
    fi
    elapsed=$attempt
    progress_bar "$elapsed" "$attempts" "Waiting for healthy (${elapsed}s/${attempts}s)"
    if [[ "$deadline_seconds" -gt 0 && $((deadline_seconds - $(date +%s))) -lt 1 ]]; then
      break
    fi
    sleep 1
  done

  printf "\n"
  fail "Canvas Notebook did not become healthy within ${attempts}s. Run: canvas-notebook logs"
}

follow_until_healthy() {
  local compose_cmd="compose -f ${COMPOSE_FILE}"
  wait_for_healthy "$compose_cmd" "$SERVICE" "$(health_url)" "${1:-$DEFAULT_HEALTH_ATTEMPTS}" "$LOG_FILE" "" "${2:-0}"
}

cleanup_docker_artifacts() {
  local prune_output reclaimed
  section "Docker cleanup"
  info "Removing unused Docker images after update..."
  prune_output="$(docker_cmd image prune -af 2>&1 || true)"
  reclaimed="$(printf '%s' "$prune_output" | grep -oE '[0-9]+(\.[0-9]+)?(kB|MB|GB)' | tail -1 || true)"
  if [[ -n "$reclaimed" ]]; then
    ok "Cleaned up unused Docker images (reclaimed ${reclaimed})"
  else
    ok "No unused Docker images to clean up"
  fi
  log_msg "docker image prune completed flags=-af reclaimed=${reclaimed:-0}"
}
