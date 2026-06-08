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
  case "${1,,}" in
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
