#!/usr/bin/env bash

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()      { echo -e "${GREEN}✓ $*${RESET}"; }
info()    { echo -e "${CYAN}  $*${RESET}"; }
warn()    { echo -e "${YELLOW}! $*${RESET}"; }
fail()    { echo -e "${RED}✗ $*${RESET}"; exit 1; }
section() { echo; echo -e "${YELLOW}$*${RESET}"; }

ask() {
  local prompt="$1" var="$2" default="${3:-}" answer
  read -rp "$prompt" answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}

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

is_inside_container() {
  [[ -f /.dockerenv ]] && return 0
  grep -qaE '(docker|kubepods|containerd|lxc)' /proc/1/cgroup 2>/dev/null
}

ensure_host_install() {
  if is_inside_container; then
    fail "This installer must run on the VM host, not inside a container. The management CLI and systemd service need host-level access."
  fi
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
  grep -qE 'admin@example\.com|BOOTSTRAP_ADMIN_PASSWORD:.*"change-me"|your-domain\.com|change-me-generate-with-openssl-rand-base64-32' "$file" 2>/dev/null
}
