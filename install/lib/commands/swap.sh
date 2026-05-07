#!/usr/bin/env bash

_persist_swap_env() {
  set_manager_env CANVAS_SWAP_ENABLED "$CANVAS_SWAP_ENABLED"
  set_manager_env CANVAS_SWAP_SIZE "$CANVAS_SWAP_SIZE"
  set_manager_env CANVAS_SWAP_FILE "$CANVAS_SWAP_FILE"
  ok "Swap setting saved to ${CONFIG_FILE}"
}

cmd_swap() {
  printf 'Canvas swap enabled setting: %s\n' "$CANVAS_SWAP_ENABLED"
  printf 'Canvas swap file: %s\n' "$CANVAS_SWAP_FILE"
  printf 'Canvas swap size: %s\n' "$CANVAS_SWAP_SIZE"
  printf '\n== swapon ==\n'
  swapon --show || true
  printf '\n== memory ==\n'
  free -h || true
}

cmd_swap_enable() {
  enable_canvas_swap "_persist_swap_env"
}

cmd_swap_disable() {
  disable_canvas_swap "_persist_swap_env"
}