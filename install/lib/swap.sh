#!/usr/bin/env bash
# Installer swap functions. Sources shared/swap.sh for core swap operations.

# shellcheck source=lib/shared/swap.sh
. "${SUPPORT_DIR}/lib/shared/swap.sh"

configure_swap_unlocked() {
  local enabled="$1"
  config_json_write_swap "$enabled" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" || return 1
  reconcile_canvas_swap_unlocked "$enabled" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS"
}

configure_swap() {
  local enabled
  section "Swap"
  case "$(printf '%s' "$CANVAS_SWAP_ENABLED" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) enabled=true ;;
    false|0|no|off|disabled) enabled=false ;;
    *) fail "CANVAS_SWAP_ENABLED must be true or false" ;;
  esac
  CANVAS_SWAP_ENABLED="$enabled"
  export CANVAS_SWAP_ENABLED
  with_canvas_swap_lock configure_swap_unlocked "$enabled" || return 1
  if [[ "$enabled" == "false" ]]; then
    ok "Canvas-managed swap is disabled"
  else
    ok "Canvas-managed swap is enabled at ${CANVAS_SWAP_FILE}"
  fi
}
