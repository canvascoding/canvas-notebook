#!/usr/bin/env bash
# Shared output functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/common.sh

[[ -n "${_SHARED_OUTPUT_LOADED:-}" ]] && return 0
CANVAS_CLI_VERSION="${CANVAS_CLI_VERSION:-2026.5.30.1}"
_SHARED_OUTPUT_LOADED=1

CANVAS_USE_COLOR="${CANVAS_USE_COLOR:-true}"

if [[ "$CANVAS_USE_COLOR" == "true" ]]; then
  _OUT_GREEN='\033[0;32m'
  _OUT_CYAN='\033[0;36m'
  _OUT_YELLOW='\033[1;33m'
  _OUT_RED='\033[0;31m'
  _OUT_BOLD='\033[1m'
  _OUT_RESET='\033[0m'
else
  _OUT_GREEN=''
  _OUT_CYAN=''
  _OUT_YELLOW=''
  _OUT_RED=''
  _OUT_BOLD=''
  _OUT_RESET=''
fi

ok()      { echo -e "${_OUT_GREEN}✓ $*${_OUT_RESET}"; }
info()    { echo -e "${_OUT_CYAN}  $*${_OUT_RESET}"; }
warn()    { echo -e "${_OUT_YELLOW}! $*${_OUT_RESET}" >&2; }
fail()    { echo -e "${_OUT_RED}✗ $*${_OUT_RESET}" >&2; exit 1; }
section() { echo; echo -e "${_OUT_YELLOW}$*${_OUT_RESET}"; }

spinner_step() {
  local msg="$1"; shift
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 tmp rc
  tmp="$(mktemp)"
  "$@" >"$tmp" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${spin:$((i % ${#spin})):1} %s" "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" || rc=$?
  if [[ -n "${rc:-}" ]] && [[ "$rc" -ne 0 ]]; then
    printf "\r  ✗ %s\n" "$msg"
    cat "$tmp"
    rm -f "$tmp"
    return "$rc"
  fi
  printf "\r  ✓ %s\n" "$msg"
  rm -f "$tmp"
}
