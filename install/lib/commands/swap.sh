#!/usr/bin/env bash

_persist_swap_env() {
  config_json_write swap.enabled "$CANVAS_SWAP_ENABLED"
  config_json_write swap.size "$CANVAS_SWAP_SIZE"
  config_json_write swap.file "$CANVAS_SWAP_FILE"
  ok "Swap settings saved to ${CONFIG_JSON_PATH}"
}

cmd_swap() {
  printf 'Canvas swap enabled setting: %s\n' "$(config_json_read swap.enabled)"
  printf 'Canvas swap file: %s\n' "$(config_json_read swap.file)"
  printf 'Canvas swap size: %s\n' "$(config_json_read swap.size)"
  printf '\n== swapon ==\n'
  swapon --show || true
  printf '\n== memory ==\n'
  free -h || true
}

cmd_swap_enable() {
  local size_arg="" file_arg=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --size) size_arg="$2"; shift ;;
      --file) file_arg="$2"; shift ;;
    esac
    shift
  done

  CANVAS_SWAP_ENABLED=true

  if [[ -n "$size_arg" ]]; then
    if ! printf '%s' "$size_arg" | grep -qE '^[0-9]+[KMGT]?$'; then
      fail "Invalid swap size '${size_arg}'. Expected format: <number>[K|M|G|T] (e.g. 2G, 512M)"
    fi
    CANVAS_SWAP_SIZE="$size_arg"
  else
    CANVAS_SWAP_SIZE="$(config_json_read swap.size)"
    CANVAS_SWAP_SIZE="${CANVAS_SWAP_SIZE:-2G}"
  fi

  if [[ -n "$file_arg" ]]; then
    if [[ "$file_arg" != /* ]]; then
      fail "Swap file path must be absolute (e.g. /swapfile)"
    fi
    CANVAS_SWAP_FILE="$file_arg"
  else
    CANVAS_SWAP_FILE="$(config_json_read swap.file)"
    CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"
  fi

  export CANVAS_SWAP_ENABLED CANVAS_SWAP_SIZE CANVAS_SWAP_FILE
  enable_canvas_swap "_persist_swap_env"
}

cmd_swap_disable() {
  CANVAS_SWAP_FILE="$(config_json_read swap.file)"
  CANVAS_SWAP_FILE="${CANVAS_SWAP_FILE:-/swapfile}"

  disable_canvas_swap "_persist_swap_env"

  CANVAS_SWAP_ENABLED=false
  config_json_write swap.enabled false
  ok "Swap disabled in config"
}