#!/usr/bin/env bash
[[ -n "${_SHARED_LOGGING_LOADED:-}" ]] && return 0
_SHARED_LOGGING_LOADED=1

ensure_log_file() {
  if mkdir -p "$LOG_DIR" >/dev/null 2>&1; then
    :
  elif command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$LOG_DIR" >/dev/null 2>&1 || true
    sudo touch "$LOG_FILE" >/dev/null 2>&1 || true
    sudo chown -R "$(id -u):$(id -g)" "$LOG_DIR" >/dev/null 2>&1 || true
  fi

  if ! touch "$LOG_FILE" >/dev/null 2>&1; then
    LOG_DIR="${HOME}/.local/state/canvas-notebook"
    LOG_FILE="${LOG_DIR}/manager.log"
    mkdir -p "$LOG_DIR" >/dev/null 2>&1 || true
    touch "$LOG_FILE" >/dev/null 2>&1 || true
  fi
}

log_msg() {
  ensure_log_file
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

show_manager_log() {
  ensure_log_file
  tail -n "${TAIL:-200}" "$LOG_FILE"
}