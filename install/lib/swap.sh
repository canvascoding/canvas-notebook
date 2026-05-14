#!/usr/bin/env bash
# Installer swap functions. Sources shared/swap.sh for core swap operations.

# shellcheck source=lib/shared/swap.sh
. "${SUPPORT_DIR}/lib/shared/swap.sh"

configure_swap() {
  if is_false "$CANVAS_SWAP_ENABLED"; then
    section "Swap"
    ok "Skipped; set CANVAS_SWAP_ENABLED=false to disable swap."
  else
    enable_canvas_swap
  fi
}