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
  env        Show current environment from config.json
  env --sync Generate .env from config.json, sync Caddy, and restart
  env --edit Open config.json in editor, then sync and restart
  swap       Show swap status
  swap-enable [--size 2G] [--file /swapfile]
               Enable Canvas-managed swap and persist it
  swap-disable
               Disable Canvas-managed swap and persist it
  caddy      Check Caddy status and current Caddyfile
  caddy-reload
               Sync Caddy from config.json domain and reload it
  caddy-fix
               Fix known Caddy issues (duplicate definitions, missing headers)
  diagnose   Show host, Docker, memory, OOM, and container diagnostics
  health     Check the local health endpoint; use --json for machine-readable output
  config     Show config paths
  config-show
               Show config.json contents; use --json for machine-readable output
  config-set <key> <value>
               Set a config value (dot notation, e.g. env.BETTER_AUTH_BASE_URL)
  config-migrate [--force]
               Migrate from legacy manager.env + Compose to config.json
  cli-update Download the latest management CLI and systemd service from GitHub
  auto-update-status
               Show auto-update timer status and last update result
  auto-update-enable [--schedule "..."]
               Enable automatic image updates via systemd timer
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
  local i=0
  recreate_log="$(mktemp)"
  compose up -d --force-recreate "$SERVICE" >"$recreate_log" 2>&1 &
  local rec_pid=$!
  while kill -0 "$rec_pid" 2>/dev/null; do
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
  local url attempts attempt elapsed
  url="$(health_url)"
  attempts="$DEFAULT_HEALTH_ATTEMPTS"
  info "Waiting for Canvas Notebook health check: $url"

  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      progress_bar "$attempt" "$attempts" ""
      printf "\n"
      ok "Canvas Notebook is healthy"
      return 0
    fi
    elapsed=$attempt
    progress_bar "$elapsed" "$attempts" "Waiting for healthy (${elapsed}s/${attempts}s)"
    sleep 1
  done

  printf "\n"
  fail "Canvas Notebook did not become healthy within ${attempts}s. Run: canvas-notebook logs"
}

follow_until_healthy() {
  local compose_cmd="compose -f ${COMPOSE_FILE}"
  wait_for_healthy "$compose_cmd" "$SERVICE" "$(health_url)" "$DEFAULT_HEALTH_ATTEMPTS" "$LOG_FILE"
}

cleanup_docker_artifacts() {
  local prune_output reclaimed
  prune_output="$(docker_cmd image prune -f 2>&1 || true)"
  reclaimed="$(printf '%s' "$prune_output" | grep -oE '[0-9]+(\.[0-9]+)?(kB|MB|GB)' | tail -1 || true)"
  if [[ -n "$reclaimed" ]]; then
    ok "Cleaned up dangling images (reclaimed ${reclaimed})"
  else
    ok "No dangling images to clean up"
  fi
  log_msg "docker image prune completed reclaimed=${reclaimed:-0}"
}
