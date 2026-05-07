#!/usr/bin/env bash
# Shared output functions for Canvas Notebook CLI and installer.
# Sourced by both install/bin/canvas-notebook and install/lib/common.sh

[[ -n "${_SHARED_OUTPUT_LOADED:-}" ]] && return 0
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