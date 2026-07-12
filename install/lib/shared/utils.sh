#!/usr/bin/env bash
# Shared utility functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/common.sh

[[ -n "${_SHARED_UTILS_LOADED:-}" ]] && return 0
_SHARED_UTILS_LOADED=1

run_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

is_false() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    false|0|no|off|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

yaml_double_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '"%s"' "$value"
}

sed_replacement_escape() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

set_compose_env() {
  local file="$1" key="$2" value="$3" quoted escaped
  quoted="$(yaml_double_quote "$value")"
  escaped="$(sed_replacement_escape "$quoted")"
  if grep -qE "^[[:space:]]*${key}:" "$file"; then
    sed -i -E "s|^([[:space:]]*${key}:[[:space:]]*).*|\\1${escaped}|" "$file"
  else
    fail "Could not find ${key} in ${file}"
  fi
}

replace_placeholder_for_key() {
  local file="$1" key="$2" placeholder="$3" value="$4" quoted escaped
  quoted="$(yaml_double_quote "$value")"
  escaped="$(sed_replacement_escape "$quoted")"
  sed -i -E "/^[[:space:]]*${key}:/ s|${placeholder}|${escaped}|" "$file"
}

compose_has_placeholders() {
  local file="$1"
  grep -qE 'your-domain\.com|change-me-generate-with-openssl-rand-base64-32' "$file" 2>/dev/null
}

canvas_health_probe() {
  local url="$1" timeout_seconds="${2:-2}"
  if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    timeout_seconds=1
  fi
  curl -fsS --connect-timeout "$timeout_seconds" --max-time "$timeout_seconds" "$url" >/dev/null 2>&1
}

canvas_operation_lock_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null && return 0
  [[ -d "/proc/${pid}" ]] && return 0
  ps -p "$pid" >/dev/null 2>&1
}

canvas_operation_lock_timeout() {
  local timeout_seconds="${CANVAS_OPERATION_LOCK_TIMEOUT:-60}"
  if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || [[ "$timeout_seconds" -gt 7200 ]]; then
    fail "CANVAS_OPERATION_LOCK_TIMEOUT must be an integer from 1 to 7200 seconds."
  fi
  printf '%s\n' "$timeout_seconds"
}

canvas_operation_lock_handle_signal() {
  local signal_name="$1" exit_code="$2"
  trap - "$signal_name"
  canvas_operation_lock_release
  exit "$exit_code"
}

canvas_operation_lock_install_traps() {
  trap canvas_operation_lock_release EXIT
  trap 'canvas_operation_lock_handle_signal HUP 129' HUP
  trap 'canvas_operation_lock_handle_signal INT 130' INT
  trap 'canvas_operation_lock_handle_signal TERM 143' TERM
}

canvas_operation_lock_acquire() {
  local operation="${1:-mutation}" timeout_seconds lock_path started_at now nonce owner_file
  local owner_pid owner_nonce lock_mtime entry_count abandoned_path moved_nonce owner_unreadable=false
  timeout_seconds="$(canvas_operation_lock_timeout)"
  lock_path="${CANVAS_OPERATION_LOCK_PATH:-${INSTALL_DIR:-/opt/canvas-notebook}/.canvas-notebook-operation.lock}"
  if [[ "${CANVAS_OPERATION_LOCK_ACQUIRED:-false}" == "true" ]]; then
    owner_file="${CANVAS_OPERATION_LOCK_PATH:?}/owner.json"
    owner_pid="$(cat "$owner_file" 2>/dev/null | jq -r '.pid // empty' 2>/dev/null || true)"
    owner_nonce="$(cat "$owner_file" 2>/dev/null | jq -r '.nonce // empty' 2>/dev/null || true)"
    if [[ "$owner_pid" == "$$" && -n "${CANVAS_OPERATION_LOCK_NONCE:-}" && "$owner_nonce" == "$CANVAS_OPERATION_LOCK_NONCE" ]]; then
      canvas_operation_lock_install_traps
      return 0
    fi
    if [[ -n "$owner_pid" && -n "${CANVAS_OPERATION_LOCK_INHERIT_TOKEN:-}" && \
      "$owner_nonce" == "$CANVAS_OPERATION_LOCK_INHERIT_TOKEN" ]] && canvas_operation_lock_pid_alive "$owner_pid"; then
      CANVAS_OPERATION_LOCK_BORROWED=true
      export CANVAS_OPERATION_LOCK_BORROWED
      return 0
    fi
    if [[ "$owner_pid" != "$$" || -z "${CANVAS_OPERATION_LOCK_NONCE:-}" || "$owner_nonce" != "$CANVAS_OPERATION_LOCK_NONCE" ]]; then
      fail "Inherited Canvas Notebook operation lock ownership is invalid."
    fi
  fi
  if [[ ! -d "$(dirname "$lock_path")" || ! -w "$(dirname "$lock_path")" ]]; then
    fail "Canvas Notebook mutations require root access to the protected install directory."
  fi
  lock_path="$(cd "$(dirname "$lock_path")" && pwd)/$(basename "$lock_path")"
  nonce="$(command -v openssl >/dev/null 2>&1 && openssl rand -hex 16 || printf '%s:%s:%s' "$$" "$(date +%s%N)" "$RANDOM" | cksum | awk '{print $1 $2}')"
  started_at="$(date +%s)"
  while ! (umask 077 && mkdir "$lock_path") 2>/dev/null; do
    if [[ ! -d "$lock_path" ]]; then
      fail "Canvas Notebook operation lock path exists but is not a directory: ${lock_path}"
    fi
    owner_file="${lock_path}/owner.json"
    owner_unreadable=false
    if [[ -e "$owner_file" && ! -r "$owner_file" ]]; then
      owner_unreadable=true
    fi
    owner_pid="$(cat "$owner_file" 2>/dev/null | jq -r '.pid // empty' 2>/dev/null || true)"
    owner_nonce="$(cat "$owner_file" 2>/dev/null | jq -r '.nonce // empty' 2>/dev/null || true)"
    lock_mtime="$(stat -c '%Y' "$lock_path" 2>/dev/null || stat -f '%m' "$lock_path" 2>/dev/null || printf '%s' "$(date +%s)")"
    now="$(date +%s)"
    entry_count="$(find "$lock_path" -mindepth 1 -maxdepth 1 -print 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$owner_unreadable" != "true" && $((now - lock_mtime)) -ge 2 ]] && { [[ -n "$owner_pid" && ! "$owner_pid" =~ ^[1-9][0-9]*$ ]] || [[ -z "$owner_pid" ]] || ! canvas_operation_lock_pid_alive "$owner_pid"; }; then
      if [[ "$entry_count" -eq 0 || ( "$entry_count" -eq 1 && -e "$owner_file" ) ]]; then
        abandoned_path="${lock_path}.abandoned-$$-${RANDOM}"
        if mv "$lock_path" "$abandoned_path" 2>/dev/null; then
          moved_nonce="$(cat "${abandoned_path}/owner.json" 2>/dev/null | jq -r '.nonce // empty' 2>/dev/null || true)"
          if [[ -z "$owner_nonce" || "$moved_nonce" == "$owner_nonce" ]]; then
            rm -rf "$abandoned_path"
            continue
          fi
          mv "$abandoned_path" "$lock_path" 2>/dev/null || true
        fi
      fi
    fi
    if [[ $((now - started_at)) -ge "$timeout_seconds" ]]; then
      fail "Another Canvas Notebook mutation is still running; lock wait exceeded ${timeout_seconds}s."
    fi
    sleep 0.1
  done
  chmod 700 "$lock_path"
  owner_file="${lock_path}/owner.json"
  jq -nc \
    --argjson pid "$$" \
    --arg nonce "$nonce" \
    --arg operation "$operation" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version:1,pid:$pid,nonce:$nonce,operation:$operation,createdAt:$createdAt}' > "$owner_file"
  chmod 600 "$owner_file"
  CANVAS_OPERATION_LOCK_ACQUIRED=true
  CANVAS_OPERATION_LOCK_PATH="$lock_path"
  CANVAS_OPERATION_LOCK_NONCE="$nonce"
  export CANVAS_OPERATION_LOCK_ACQUIRED CANVAS_OPERATION_LOCK_PATH CANVAS_OPERATION_LOCK_NONCE
  canvas_operation_lock_install_traps
}

canvas_operation_lock_release() {
  local owner_nonce=""
  if declare -f canvas_operation_cleanup_before_unlock >/dev/null 2>&1; then
    canvas_operation_cleanup_before_unlock || true
    unset -f canvas_operation_cleanup_before_unlock
  fi
  [[ "${CANVAS_OPERATION_LOCK_BORROWED:-false}" == "true" ]] && return 0
  if [[ "${CANVAS_OPERATION_LOCK_ACQUIRED:-false}" == "true" && -n "${CANVAS_OPERATION_LOCK_PATH:-}" ]]; then
    owner_nonce="$(cat "${CANVAS_OPERATION_LOCK_PATH}/owner.json" 2>/dev/null | jq -r '.nonce // empty' 2>/dev/null || true)"
    if [[ -n "${CANVAS_OPERATION_LOCK_NONCE:-}" && "$owner_nonce" == "$CANVAS_OPERATION_LOCK_NONCE" ]]; then
      rm -rf "$CANVAS_OPERATION_LOCK_PATH"
    fi
  fi
  CANVAS_OPERATION_LOCK_ACQUIRED=false
  unset CANVAS_OPERATION_LOCK_PATH CANVAS_OPERATION_LOCK_NONCE
  export CANVAS_OPERATION_LOCK_ACQUIRED
}
