#!/usr/bin/env bash
# Installer-specific utilities. Sources shared output.sh, utils.sh and config.sh.

# shellcheck source=lib/shared/output.sh
. "${SUPPORT_DIR}/lib/shared/output.sh"
# shellcheck source=lib/shared/utils.sh
. "${SUPPORT_DIR}/lib/shared/utils.sh"
# shellcheck source=lib/shared/config.sh
. "${SUPPORT_DIR}/lib/shared/config.sh"

ask() {
  local prompt="$1" var="$2" default="${3:-}" answer
  read -rp "$prompt" answer </dev/tty || true
  printf -v "$var" '%s' "${answer:-$default}"
}