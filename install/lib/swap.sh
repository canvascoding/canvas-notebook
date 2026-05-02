#!/usr/bin/env bash

swap_is_active() {
  swapon --show=NAME --noheadings 2>/dev/null | awk '{print $1}' | grep -Fxq "$CANVAS_SWAP_FILE"
}

remove_swap_fstab_entry() {
  run_root sed -i '\|[[:space:]]# canvas-notebook swap$|d' /etc/fstab
  run_root sed -i "\|^${CANVAS_SWAP_FILE}[[:space:]]|d" /etc/fstab
}

disable_canvas_swap() {
  section "Swap"
  if swap_is_active; then
    run_root swapoff "$CANVAS_SWAP_FILE"
    ok "Disabled swap at ${CANVAS_SWAP_FILE}"
  else
    ok "Swap already disabled at ${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  if [[ -f "$CANVAS_SWAP_FILE" ]]; then
    run_root rm -f "$CANVAS_SWAP_FILE"
    ok "Removed ${CANVAS_SWAP_FILE}"
  fi
}

enable_canvas_swap() {
  section "Swap"
  if swap_is_active; then
    ok "Swap already enabled at ${CANVAS_SWAP_FILE}"
  else
    if [[ ! -f "$CANVAS_SWAP_FILE" ]]; then
      run_root fallocate -l "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE"
      ok "Created ${CANVAS_SWAP_SIZE} swapfile at ${CANVAS_SWAP_FILE}"
    fi

    run_root chmod 600 "$CANVAS_SWAP_FILE"
    run_root mkswap "$CANVAS_SWAP_FILE" >/dev/null
    run_root swapon "$CANVAS_SWAP_FILE"
    ok "Enabled swap at ${CANVAS_SWAP_FILE}"
  fi

  remove_swap_fstab_entry
  printf '%s none swap sw 0 0 # canvas-notebook swap\n' "$CANVAS_SWAP_FILE" | run_root tee -a /etc/fstab >/dev/null
  ok "Swap will be enabled after reboot"
}

configure_swap() {
  if is_false "$CANVAS_SWAP_ENABLED"; then
    section "Swap"
    ok "Skipped; set CANVAS_SWAP_ENABLED=true to let Canvas manage a host swapfile."
  else
    enable_canvas_swap
  fi
}
