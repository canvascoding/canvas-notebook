#!/usr/bin/env bash

ensure_manager_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    run_root mkdir -p "$(dirname "$CONFIG_FILE")"
    run_root touch "$CONFIG_FILE"
  fi
}

show_auto_update_status() {
  local timer_active next_run last_result
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — auto-update timer requires systemd"
    return 1
  fi

  if [[ ! -f /etc/systemd/system/canvas-notebook-update.timer ]]; then
    info "Auto-update timer unit not installed. Run: canvas-notebook cli-update"
    return 1
  fi

  printf '\n== Auto-Update Status ==\n'
  printf 'Config file: %s\n' "$CONFIG_FILE"

  local enabled_val
  enabled_val="$(grep '^CANVAS_AUTO_UPDATE_ENABLED=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2 | tr -d "\"'")"
  enabled_val="${enabled_val:-true}"
  printf 'CANVAS_AUTO_UPDATE_ENABLED=%s\n' "$enabled_val"

  local schedule_val
  schedule_val="$(grep '^CANVAS_AUTO_UPDATE_SCHEDULE=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2 | tr -d "\"'")"
  schedule_val="${schedule_val:-*-*-* 04:00:00}"
  printf 'CANVAS_AUTO_UPDATE_SCHEDULE=%s\n' "$schedule_val"

  timer_active="$(systemctl is-active canvas-notebook-update.timer 2>/dev/null || true)"
  if [[ "$timer_active" == "active" ]]; then
    ok "Timer is active"
    next_run="$(systemctl show canvas-notebook-update.timer --property=NextElapseUSecRealtime 2>/dev/null | cut -d= -f2-)"
    if [[ -n "$next_run" ]]; then
      printf '  Next scheduled run: %s\n' "$next_run"
    fi
  else
    info "Timer is inactive (auto-update disabled)"
  fi

  printf '\n== Timer Unit ==\n'
  systemctl list-timers canvas-notebook-update.timer --no-pager 2>/dev/null || true

  printf '\n== Last Auto-Update Result ==\n'
  last_result="$(journalctl -u canvas-notebook-update.service --no-pager -n 10 -o short-precise 2>/dev/null || true)"
  if [[ -n "$last_result" ]]; then
    printf '%s\n' "$last_result"
  else
    info "No auto-update runs recorded yet"
  fi
}

enable_auto_update() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd not found — auto-update timer requires systemd"
  fi

  if [[ ! -f /etc/systemd/system/canvas-notebook-update.timer ]]; then
    fail "Auto-update timer unit not installed. Run: canvas-notebook cli-update first"
  fi

  ensure_manager_config
  set_manager_env CANVAS_AUTO_UPDATE_ENABLED true

  run_root systemctl enable canvas-notebook-update.timer >/dev/null
  run_root systemctl start canvas-notebook-update.timer >/dev/null 2>&1 || \
    run_root systemctl restart canvas-notebook-update.timer >/dev/null

  ok "Auto-update enabled (schedule: $(grep '^CANVAS_AUTO_UPDATE_SCHEDULE=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2 | tr -d "\"'") || echo '*-*-* 04:00:00')"
  info "View schedule: systemctl list-timers canvas-notebook-update.timer"
}

disable_auto_update() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd not found — auto-update timer requires systemd"
  fi

  ensure_manager_config
  set_manager_env CANVAS_AUTO_UPDATE_ENABLED false

  if [[ -f /etc/systemd/system/canvas-notebook-update.timer ]]; then
    run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
    run_root systemctl disable canvas-notebook-update.timer >/dev/null 2>&1 || true
  fi

  ok "Auto-update disabled"
}

cmd_auto_update_status() {
  show_auto_update_status
}

cmd_auto_update_enable() {
  log_msg "auto-update-enable"
  enable_auto_update
}

cmd_auto_update_disable() {
  log_msg "auto-update-disable"
  disable_auto_update
}