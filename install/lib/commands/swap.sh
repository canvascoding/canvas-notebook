#!/usr/bin/env bash

load_swap_config() {
  local enabled_raw enabled size file swappiness
  enabled_raw="$(config_json_read_raw swap.enabled)" || return 1
  case "$enabled_raw" in
    true|1|'"true"'|'"1"'|'"yes"'|'"on"') enabled=true ;;
    false|0|'"false"'|'"0"'|'"no"'|'"off"'|'"disabled"') enabled=false ;;
    *) return 1 ;;
  esac
  size="$(config_json_read swap.size)" || return 1
  size="${size:-2G}"
  file="$(config_json_read swap.file)" || return 1
  file="${file:-$CANVAS_SWAP_MANAGED_FILE}"
  swappiness="$(config_json_read swap.swappiness)" || return 1
  swappiness="${swappiness:-10}"
  swap_validate_config "$enabled" "$size" "$file" "$swappiness" || return 1
  CANVAS_SWAP_ENABLED="$enabled"
  CANVAS_SWAP_SIZE="$(printf '%s' "$size" | tr '[:lower:]' '[:upper:]')"
  CANVAS_SWAP_FILE="$file"
  CANVAS_SWAP_SWAPPINESS="$swappiness"
  export CANVAS_SWAP_ENABLED CANVAS_SWAP_SIZE CANVAS_SWAP_FILE CANVAS_SWAP_SWAPPINESS
}

persist_swap_config() {
  config_json_write_swap "$CANVAS_SWAP_ENABLED" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" || return 1
  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    ok "Swap settings saved to ${CONFIG_JSON_PATH}"
  fi
}

swap_runtime_swappiness() {
  local value=""
  if [[ -r "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH" ]]; then
    value="$(tr -d '[:space:]' < "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH")"
  elif command -v sysctl >/dev/null 2>&1; then
    value="$(sysctl -n vm.swappiness 2>/dev/null || true)"
  fi
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$CANVAS_SWAP_SWAPPINESS"
    return 1
  fi
}

print_swap_status() {
  local error="${1:-}" active=false persistent=false fstab_managed=false managed=false state_matches_transaction=false actual_size_bytes="null" active_file="" runtime_swappiness in_sync=false state_candidate
  if swap_is_active "$CANVAS_SWAP_FILE"; then
    active=true
    active_file="$CANVAS_SWAP_FILE"
  fi
  if ! swap_proc_swaps_observable; then
    error="${error:-Cannot read active swap state from $CANVAS_SWAP_PROC_SWAPS_PATH}"
  fi
  if ! swap_fstab_observable; then
    error="${error:-Cannot safely read swap persistence from $CANVAS_SWAP_FSTAB_PATH}"
  fi
  if swap_fstab_has_file "$CANVAS_SWAP_FILE"; then
    persistent=true
  fi
  if swap_fstab_manages_file "$CANVAS_SWAP_FILE"; then
    fstab_managed=true
    managed=true
  fi
  if swap_state_matches_file "$CANVAS_SWAP_FILE"; then
    managed=true
  fi
  if swap_path_exists "$CANVAS_SWAP_STATE_PATH" && ! swap_state_exists; then
    error="${error:-Unsafe Canvas swap ownership state path: $CANVAS_SWAP_STATE_PATH}"
  elif swap_state_exists; then
    if swap_state_requires_secure_wipe; then
      error="${error:-Canvas swap secure cleanup is pending}"
    fi
    for state_candidate in "$CANVAS_SWAP_FILE" "${CANVAS_SWAP_FILE}.canvas-disabled" "${CANVAS_SWAP_FILE}.canvas-backup" "${CANVAS_SWAP_FILE}.canvas-new"; do
      if swap_state_matches_file "$state_candidate"; then
        state_matches_transaction=true
        break
      fi
    done
    if [[ "$state_matches_transaction" != "true" ]]; then
      error="${error:-Canvas swap transaction is incomplete}"
    fi
  fi
  if swap_path_exists "${CANVAS_SWAP_FILE}.canvas-disabled" || swap_path_exists "${CANVAS_SWAP_FILE}.canvas-backup" || swap_path_exists "${CANVAS_SWAP_FILE}.canvas-new" || swap_path_exists "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"; then
    error="${error:-Canvas swap transaction is incomplete}"
  fi
  if swap_path_exists "$CANVAS_SWAP_FILE" && ! swap_file_is_safe "$CANVAS_SWAP_FILE"; then
    error="${error:-Unsafe Canvas swap path: $CANVAS_SWAP_FILE}"
  elif swap_path_exists "$CANVAS_SWAP_FILE"; then
    actual_size_bytes="$(swap_file_bytes "$CANVAS_SWAP_FILE" 2>/dev/null || printf 'null')"
    if [[ "$managed" != "true" ]]; then
      error="${error:-Unmanaged file occupies Canvas swap path: $CANVAS_SWAP_FILE}"
    elif ! swap_file_permissions_are_managed "$CANVAS_SWAP_FILE"; then
      error="${error:-Canvas swap file permissions or ownership are not secure}"
    fi
  fi
  if swap_fstab_has_unmanaged_file "$CANVAS_SWAP_FILE"; then
    error="${error:-Unmanaged swap entry occupies Canvas swap path: $CANVAS_SWAP_FILE}"
  elif [[ "$active" == "true" && "$managed" != "true" ]]; then
    error="${error:-Unmanaged active swap occupies Canvas swap path: $CANVAS_SWAP_FILE}"
  fi
  if swap_path_exists "$CANVAS_SWAP_SYSCTL_PATH" && [[ -L "$CANVAS_SWAP_SYSCTL_PATH" || ! -f "$CANVAS_SWAP_SYSCTL_PATH" ]]; then
    error="${error:-Unsafe Canvas swap sysctl path: $CANVAS_SWAP_SYSCTL_PATH}"
  fi
  [[ "$actual_size_bytes" =~ ^[0-9]+$ ]] || actual_size_bytes="null"
  if ! runtime_swappiness="$(swap_runtime_swappiness)"; then
    if [[ "$CANVAS_SWAP_ENABLED" == "true" ]]; then
      error="${error:-Cannot read runtime swap swappiness}"
    fi
  fi

  if [[ -z "$error" ]]; then
    if [[ "$CANVAS_SWAP_ENABLED" == "true" ]]; then
      local desired_size_bytes
      desired_size_bytes="$(swap_size_bytes "$CANVAS_SWAP_SIZE" 2>/dev/null || true)"
      if [[ "$managed" == "true" && "$active" == "true" && "$persistent" == "true" && "$fstab_managed" == "true" && "$actual_size_bytes" == "$desired_size_bytes" && "$runtime_swappiness" == "$CANVAS_SWAP_SWAPPINESS" ]] && swap_file_permissions_are_managed "$CANVAS_SWAP_FILE" && swap_sysctl_matches "$CANVAS_SWAP_SWAPPINESS"; then
        in_sync=true
      fi
    elif [[ "$active" == "false" && "$persistent" == "false" && "$actual_size_bytes" == "null" ]] && ! swap_path_exists "$CANVAS_SWAP_SYSCTL_PATH" && ! swap_path_exists "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"; then
      in_sync=true
    fi
  fi

  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    jq -n \
      --argjson enabled "$CANVAS_SWAP_ENABLED" \
      --argjson active "$active" \
      --arg file "$CANVAS_SWAP_FILE" \
      --arg activeFile "$active_file" \
      --arg configuredSize "$CANVAS_SWAP_SIZE" \
      --argjson actualSizeBytes "$actual_size_bytes" \
      --argjson persistent "$persistent" \
      --argjson swappiness "$runtime_swappiness" \
      --argjson configuredSwappiness "$CANVAS_SWAP_SWAPPINESS" \
      --argjson inSync "$in_sync" \
      --arg error "$error" \
      '{
        enabled: $enabled,
        active: $active,
        file: $file,
        activeFile: (if $activeFile == "" then null else $activeFile end),
        configuredSize: $configuredSize,
        actualSizeBytes: $actualSizeBytes,
        persistent: $persistent,
        swappiness: $swappiness,
        configuredSwappiness: $configuredSwappiness,
        inSync: $inSync,
        error: (if $error == "" then null else $error end)
      }'
    return
  fi

  printf 'Canvas swap enabled setting: %s\n' "$CANVAS_SWAP_ENABLED"
  printf 'Canvas swap file: %s\n' "$CANVAS_SWAP_FILE"
  printf 'Canvas swap size: %s\n' "$CANVAS_SWAP_SIZE"
  printf 'Canvas swap swappiness: %s\n' "$CANVAS_SWAP_SWAPPINESS"
  printf 'Canvas swap active: %s\n' "$active"
  printf 'Canvas swap persistent: %s\n' "$persistent"
  printf 'Canvas swap in sync: %s\n' "$in_sync"
  [[ -n "$error" ]] && printf 'Canvas swap error: %s\n' "$error" >&2
  printf '\n== swapon ==\n'
  swapon --show || true
  printf '\n== memory ==\n'
  free -h || true
}

apply_swap_desired_unlocked() {
  local secure="${1:-false}"
  if [[ "$secure" == "true" && "$CANVAS_SWAP_ENABLED" == "false" ]]; then
    journal_secure_swap_intent "$CANVAS_SWAP_FILE" || return 1
  fi
  persist_swap_config || return 1
  if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" && "${CANVAS_SWAP_TEST_FAIL_AFTER_PERSIST:-false}" == "true" ]]; then
    printf 'Injected failure after persisting swap config\n' >&2
    return 1
  fi
  reconcile_canvas_swap_unlocked "$CANVAS_SWAP_ENABLED" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" "$secure"
}

sync_swap_from_config_unlocked() {
  load_swap_config || {
    printf 'Invalid or unreadable swap configuration\n' >&2
    return 1
  }
  reconcile_canvas_swap_unlocked "$CANVAS_SWAP_ENABLED" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS"
}

locked_swap_operation_with_status() {
  local callback="$1" stdout_file stderr_file error="" rc=0 restore_errexit=false
  shift
  stdout_file="$(mktemp)" || {
    print_swap_status "Could not create swap operation output file"
    return 1
  }
  stderr_file="$(mktemp)" || {
    rm -f "$stdout_file"
    print_swap_status "Could not create swap operation error file"
    return 1
  }
  [[ $- == *e* ]] && restore_errexit=true
  set +e
  "$callback" "$@" >"$stdout_file" 2>"$stderr_file"
  rc=$?
  [[ "$restore_errexit" == "true" ]] && set -e
  if [[ "$rc" -ne 0 ]]; then
    error="$(tail -n 1 "$stderr_file" | tr -d '\r')"
    error="${error:-Swap reconciliation failed}"
  fi
  if ! load_swap_config; then
    rc=1
    error="${error:-Invalid or unreadable swap configuration after reconciliation}"
  fi
  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    cat "$stdout_file"
    cat "$stderr_file" >&2
  fi
  rm -f "$stdout_file" "$stderr_file"
  print_swap_status "$error"
  return "$rc"
}

run_locked_swap_operation() {
  local callback="$1" stdout_file stderr_file error="" rc=0 restore_errexit=false
  shift
  stdout_file="$(mktemp)" || return 1
  stderr_file="$(mktemp)" || {
    rm -f "$stdout_file"
    return 1
  }
  [[ $- == *e* ]] && restore_errexit=true
  set +e
  with_canvas_swap_lock locked_swap_operation_with_status "$callback" "$@" >"$stdout_file" 2>"$stderr_file"
  rc=$?
  [[ "$restore_errexit" == "true" ]] && set -e
  if [[ -s "$stdout_file" ]]; then
    cat "$stdout_file"
  else
    error="$(tail -n 1 "$stderr_file" | tr -d '\r')"
    error="${error:-Swap reconciliation failed}"
    print_swap_status "$error"
  fi
  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    cat "$stderr_file" >&2
  fi
  rm -f "$stdout_file" "$stderr_file"
  return "$rc"
}

set_swap_status_defaults() {
  CANVAS_SWAP_ENABLED=false
  CANVAS_SWAP_SIZE=2G
  CANVAS_SWAP_FILE="$CANVAS_SWAP_MANAGED_FILE"
  CANVAS_SWAP_SWAPPINESS=10
  export CANVAS_SWAP_ENABLED CANVAS_SWAP_SIZE CANVAS_SWAP_FILE CANVAS_SWAP_SWAPPINESS
}

cmd_swap() {
  if ! load_swap_config; then
    set_swap_status_defaults
    print_swap_status "Invalid or unreadable swap configuration"
    return 1
  fi
  print_swap_status
}

cmd_swap_sync() {
  set_swap_status_defaults
  run_locked_swap_operation sync_swap_from_config_unlocked
}

cmd_swap_apply() {
  local enabled_arg="" size_arg="" file_arg="" swappiness_arg=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --enabled)
        [[ $# -ge 2 ]] || fail "--enabled requires a value"
        enabled_arg="$2"
        shift 2
        ;;
      --size)
        [[ $# -ge 2 ]] || fail "--size requires a value"
        size_arg="$2"
        shift 2
        ;;
      --file)
        [[ $# -ge 2 ]] || fail "--file requires a value"
        file_arg="$2"
        shift 2
        ;;
      --swappiness)
        [[ $# -ge 2 ]] || fail "--swappiness requires a value"
        swappiness_arg="$2"
        shift 2
        ;;
      *) fail "Unknown swap-apply option: $1" ;;
    esac
  done
  [[ "$enabled_arg" == "true" || "$enabled_arg" == "false" ]] || fail "--enabled must be true or false"
  [[ -n "$size_arg" && -n "$file_arg" && -n "$swappiness_arg" ]] || fail "swap-apply requires --enabled, --size, --file, and --swappiness"
  CANVAS_SWAP_ENABLED="$enabled_arg"
  CANVAS_SWAP_SIZE="$(printf '%s' "$size_arg" | tr '[:lower:]' '[:upper:]')"
  CANVAS_SWAP_FILE="$file_arg"
  CANVAS_SWAP_SWAPPINESS="$swappiness_arg"
  export CANVAS_SWAP_ENABLED CANVAS_SWAP_SIZE CANVAS_SWAP_FILE CANVAS_SWAP_SWAPPINESS
  swap_validate_config "$CANVAS_SWAP_ENABLED" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" || return 1
  run_locked_swap_operation apply_swap_desired_unlocked false
}

cmd_swap_enable() {
  local size_arg="" file_arg="" swappiness_arg=""
  load_swap_config || fail "Invalid or unreadable swap configuration"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --size)
        [[ $# -ge 2 ]] || fail "--size requires a value"
        size_arg="$2"
        shift 2
        ;;
      --file)
        [[ $# -ge 2 ]] || fail "--file requires a value"
        file_arg="$2"
        shift 2
        ;;
      --swappiness)
        [[ $# -ge 2 ]] || fail "--swappiness requires a value"
        swappiness_arg="$2"
        shift 2
        ;;
      *) fail "Unknown swap-enable option: $1" ;;
    esac
  done
  CANVAS_SWAP_ENABLED=true
  CANVAS_SWAP_SIZE="$(printf '%s' "${size_arg:-$CANVAS_SWAP_SIZE}" | tr '[:lower:]' '[:upper:]')"
  CANVAS_SWAP_FILE="${file_arg:-$CANVAS_SWAP_FILE}"
  CANVAS_SWAP_SWAPPINESS="${swappiness_arg:-$CANVAS_SWAP_SWAPPINESS}"
  swap_validate_config "$CANVAS_SWAP_ENABLED" "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" || return 1
  run_locked_swap_operation apply_swap_desired_unlocked false
}

cmd_swap_disable() {
  local secure=false
  load_swap_config || fail "Invalid or unreadable swap configuration"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --secure) secure=true; shift ;;
      *) fail "Unknown swap-disable option: $1" ;;
    esac
  done
  CANVAS_SWAP_ENABLED=false
  run_locked_swap_operation apply_swap_desired_unlocked "$secure"
}
