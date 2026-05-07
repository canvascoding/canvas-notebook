#!/usr/bin/env bash

cmd_logs() {
  compose logs -f --tail="${TAIL:-120}" "$SERVICE"
}

cmd_container_logs() {
  cmd_logs
}

cmd_manager_log() {
  show_manager_log
}

cmd_cleanup_logs() {
  pkill -f "docker compose .*logs.*-f.*canvas-notebook" >/dev/null 2>&1 || true
  pkill -f "docker-compose .*logs.* -f.* canvas-notebook" >/dev/null 2>&1 || true
  ok "Killed any orphaned compose-log followers"
}