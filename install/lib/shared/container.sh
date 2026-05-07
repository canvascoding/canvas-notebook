#!/usr/bin/env bash
# Shared container health-check and startup functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/compose.sh

[[ -n "${_SHARED_CONTAINER_LOADED:-}" ]] && return 0
_SHARED_CONTAINER_LOADED=1

wait_for_healthy() {
  local compose_cmd="$1"
  local service="$2"
  local health_url="$3"
  local max_attempts="$4"
  local log_file="${5:-}"
  local since_ts="${6:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

  local log_pgid attempt

  _wait_stop_log_stream() {
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

  info "Streaming startup logs..."

  pkill -f "docker[- ]compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
  pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true

  set -m
  $compose_cmd logs -f --since="$since_ts" "$service" 2>&1 | _wait_filter | tee -a "${log_file:-/dev/null}" &
  log_pgid=$(ps -o pgid= $! 2>/dev/null | tr -d ' ') || true
  set +m

  trap '_wait_stop_log_stream' RETURN

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      _wait_stop_log_stream
      ok "Canvas Notebook is healthy"
      return 0
    fi
    sleep 1
  done

  _wait_stop_log_stream
  fail "Canvas Notebook did not become healthy within ${max_attempts}s. Run: canvas-notebook logs"
}