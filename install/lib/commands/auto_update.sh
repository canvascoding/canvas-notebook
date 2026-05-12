#!/usr/bin/env bash

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
  printf 'Config file: %s\n' "$CONFIG_JSON_PATH"

  local enabled_val schedule_val
  enabled_val="$(config_json_read autoUpdate.enabled)"
  enabled_val="${enabled_val:-true}"
  printf 'autoUpdate.enabled=%s\n' "$enabled_val"

  schedule_val="$(config_json_read autoUpdate.schedule)"
  schedule_val="${schedule_val:-*-*-* 04:00:00}"
  printf 'autoUpdate.schedule=%s\n' "$schedule_val"

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

  local config_true
  config_true="$(is_false "$enabled_val" && printf 'false' || printf 'true')"
  if [[ "$config_true" == "true" && "$timer_active" != "active" ]]; then
    warn "Config says enabled but timer is inactive — run: canvas-notebook auto-update-enable"
  elif [[ "$config_true" == "false" && "$timer_active" == "active" ]]; then
    warn "Config says disabled but timer is active — run: canvas-notebook auto-update-disable"
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
  local schedule_arg=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --schedule) schedule_arg="$2"; shift ;;
    esac
    shift
  done

  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd not found — auto-update timer requires systemd"
  fi

  if [[ ! -f /etc/systemd/system/canvas-notebook-update.timer ]]; then
    fail "Auto-update timer unit not installed. Run: canvas-notebook cli-update first"
  fi

  if [[ -n "$schedule_arg" ]]; then
    if ! printf '%s' "$schedule_arg" | grep -qE '^[*0-9]{1,2}-[*0-9]{1,2}-[*0-9]{1,2} [*0-9:,]+'; then
      fail "Invalid schedule format '${schedule_arg}'. Example: '*-*-* 04:00:00'"
    fi
    config_json_write autoUpdate.schedule "$schedule_arg"
  fi

  local current_schedule
  current_schedule="$(config_json_read autoUpdate.schedule)"
  current_schedule="${current_schedule:-*-*-* 04:00:00}"

  CANVAS_AUTO_UPDATE_SCHEDULE="$current_schedule"
  export CANVAS_AUTO_UPDATE_SCHEDULE

  install_update_timer

  run_root systemctl enable canvas-notebook-update.timer >/dev/null
  run_root systemctl start canvas-notebook-update.timer >/dev/null 2>&1 || \
    run_root systemctl restart canvas-notebook-update.timer >/dev/null

  config_json_write autoUpdate.enabled true

  ok "Auto-update enabled (schedule: ${current_schedule})"
  info "View schedule: systemctl list-timers canvas-notebook-update.timer"
}

disable_auto_update() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemd not found — auto-update timer requires systemd"
  fi

  if [[ -f /etc/systemd/system/canvas-notebook-update.timer ]]; then
    run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
    run_root systemctl disable canvas-notebook-update.timer >/dev/null 2>&1 || true
  fi

  config_json_write autoUpdate.enabled false

  ok "Auto-update disabled"
}

sync_auto_update() {
  local enabled_val timer_active
  enabled_val="$(config_json_read autoUpdate.enabled)"
  enabled_val="${enabled_val:-true}"
  timer_active="$(systemctl is-active canvas-notebook-update.timer 2>/dev/null || true)"

  if [[ "$(is_false "$enabled_val" && printf 'false' || printf 'true')" == "true" && "$timer_active" != "active" ]]; then
    info "Config says enabled but timer inactive — enabling..."
    enable_auto_update
  elif [[ "$(is_false "$enabled_val" && printf 'false' || printf 'true')" == "false" && "$timer_active" == "active" ]]; then
    info "Config says disabled but timer active — disabling..."
    disable_auto_update
  else
    ok "Auto-update config and timer are in sync"
  fi
}

cmd_auto_update_status() {
  show_auto_update_status
}

cmd_auto_update_enable() {
  log_msg "auto-update-enable"
  enable_auto_update "$@"
}

cmd_auto_update_disable() {
  log_msg "auto-update-disable"
  disable_auto_update
}

cmd_auto_update_sync() {
  log_msg "auto-update-sync"
  sync_auto_update
}