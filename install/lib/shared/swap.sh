#!/usr/bin/env bash

[[ -n "${_SHARED_SWAP_LOADED:-}" ]] && return 0
_SHARED_SWAP_LOADED=1

if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then
  [[ -d "$CANVAS_SWAP_TEST_ROOT" && ! -L "$CANVAS_SWAP_TEST_ROOT" && -O "$CANVAS_SWAP_TEST_ROOT" ]] || {
    printf 'CANVAS_SWAP_TEST_ROOT must be an existing, user-owned directory\n' >&2
    return 1
  }
  CANVAS_SWAP_TEST_ROOT="$(cd -- "$CANVAS_SWAP_TEST_ROOT" >/dev/null 2>&1 && pwd -P)"
  CANVAS_SWAP_FSTAB_PATH="${CANVAS_SWAP_TEST_ROOT}/fstab"
  CANVAS_SWAP_MANAGED_FILE="${CANVAS_SWAP_TEST_ROOT}/swapfile"
  CANVAS_SWAP_PROC_SWAPS_PATH="${CANVAS_SWAP_TEST_ROOT}/proc-swaps"
  CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH="${CANVAS_SWAP_TEST_ROOT}/swappiness"
  CANVAS_SWAP_SYSCTL_PATH="${CANVAS_SWAP_TEST_ROOT}/90-canvas-notebook-swap.conf"
  CANVAS_SWAP_STATE_PATH="${CANVAS_SWAP_TEST_ROOT}/swap.state"
  CANVAS_SWAP_LOCK_PATH="${CANVAS_SWAP_TEST_ROOT}/lock/swap.lock"
  CANVAS_SWAP_DISK_HEADROOM_BYTES=0
else
  CANVAS_SWAP_FSTAB_PATH=/etc/fstab
  CANVAS_SWAP_MANAGED_FILE=/swapfile
  CANVAS_SWAP_PROC_SWAPS_PATH=/proc/swaps
  CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH=/proc/sys/vm/swappiness
  CANVAS_SWAP_SYSCTL_PATH=/etc/sysctl.d/90-canvas-notebook-swap.conf
  CANVAS_SWAP_STATE_PATH=/var/lib/canvas-notebook/swap.state
  CANVAS_SWAP_LOCK_PATH=/run/lock/canvas-notebook/swap.lock
  CANVAS_SWAP_DISK_HEADROOM_BYTES=1073741824
fi
CANVAS_SWAP_MIN_BYTES=134217728
CANVAS_SWAP_MAX_BYTES=17179869184

swap_size_bytes() {
  local value="$1" amount unit bytes
  if [[ ! "$value" =~ ^([0-9]+)([KMGTkmgt])$ ]]; then
    return 1
  fi
  amount="${BASH_REMATCH[1]}"
  unit="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
  [[ "${#amount}" -le 8 ]] || return 1
  amount=$((10#$amount))
  case "$unit" in
    K) bytes=$((amount * 1024)) ;;
    M) bytes=$((amount * 1024 * 1024)) ;;
    G) bytes=$((amount * 1024 * 1024 * 1024)) ;;
    T) return 1 ;;
  esac
  [[ "$bytes" -ge "$CANVAS_SWAP_MIN_BYTES" && "$bytes" -le "$CANVAS_SWAP_MAX_BYTES" ]] || return 1
  printf '%s\n' "$bytes"
}

swap_validate_config() {
  local enabled="$1" size="$2" file="$3" swappiness="$4"
  if [[ "$enabled" != "true" && "$enabled" != "false" ]]; then
    printf 'Swap enabled must be true or false\n' >&2
    return 1
  fi
  if ! swap_size_bytes "$size" >/dev/null; then
    printf 'Swap size must be between 128M and 16G\n' >&2
    return 1
  fi
  if [[ "$file" != "$CANVAS_SWAP_MANAGED_FILE" ]]; then
    printf 'Canvas-managed swap file path must be %s\n' "$CANVAS_SWAP_MANAGED_FILE" >&2
    return 1
  fi
  if [[ ! "$swappiness" =~ ^[0-9]+$ ]] || [[ "$swappiness" -lt 0 || "$swappiness" -gt 200 ]]; then
    printf 'Swap swappiness must be an integer between 0 and 200\n' >&2
    return 1
  fi
}

swap_path_exists() {
  [[ -e "$1" || -L "$1" ]]
}

swap_proc_swaps_observable() {
  [[ -r "$CANVAS_SWAP_PROC_SWAPS_PATH" && ! -L "$CANVAS_SWAP_PROC_SWAPS_PATH" ]]
}

swap_fstab_observable() {
  if swap_path_exists "$CANVAS_SWAP_FSTAB_PATH"; then
    [[ -r "$CANVAS_SWAP_FSTAB_PATH" && -f "$CANVAS_SWAP_FSTAB_PATH" && ! -L "$CANVAS_SWAP_FSTAB_PATH" ]]
  fi
}

swap_is_active() {
  local file="${1:-$CANVAS_SWAP_MANAGED_FILE}"
  [[ -r "$CANVAS_SWAP_PROC_SWAPS_PATH" ]] || return 1
  awk -v file="$file" 'NR > 1 && $1 == file { found = 1 } END { exit found ? 0 : 1 }' "$CANVAS_SWAP_PROC_SWAPS_PATH"
}

swap_fstab_has_file() {
  local file="$1"
  [[ -r "$CANVAS_SWAP_FSTAB_PATH" ]] || return 1
  awk -v file="$file" '$1 == file && $3 == "swap" { found = 1 } END { exit found ? 0 : 1 }' "$CANVAS_SWAP_FSTAB_PATH"
}

swap_fstab_manages_file() {
  local file="$1"
  [[ -r "$CANVAS_SWAP_FSTAB_PATH" ]] || return 1
  awk -v file="$file" '$1 == file && $3 == "swap" && $0 ~ /[[:space:]]# canvas-notebook swap[[:space:]]*$/ { found = 1 } END { exit found ? 0 : 1 }' "$CANVAS_SWAP_FSTAB_PATH"
}

swap_fstab_has_unmanaged_file() {
  local file="$1"
  [[ -r "$CANVAS_SWAP_FSTAB_PATH" ]] || return 1
  awk -v file="$file" '$1 == file && $3 == "swap" && $0 !~ /[[:space:]]# canvas-notebook swap[[:space:]]*$/ { found = 1 } END { exit found ? 0 : 1 }' "$CANVAS_SWAP_FSTAB_PATH"
}

swap_file_nlink() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1" 2>/dev/null
}

swap_file_bytes() {
  stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1" 2>/dev/null
}

swap_file_identity() {
  stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null
}

swap_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

swap_file_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null
}

swap_file_gid() {
  stat -c '%g' "$1" 2>/dev/null || stat -f '%g' "$1" 2>/dev/null
}

swap_expected_uid() {
  if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then id -u; else printf '0\n'; fi
}

swap_expected_gid() {
  if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then id -g; else printf '0\n'; fi
}

swap_file_permissions_are_managed() {
  local file="$1"
  [[ "$(swap_file_mode "$file")" == "600" ]] || return 1
  [[ "$(swap_file_uid "$file")" == "$(swap_expected_uid)" ]] || return 1
  [[ "$(swap_file_gid "$file")" == "$(swap_expected_gid)" ]]
}

apply_swap_file_permissions() {
  local file="$1" uid gid
  uid="$(swap_expected_uid)" || return 1
  gid="$(swap_expected_gid)" || return 1
  run_root chown "${uid}:${gid}" "$file" || return 1
  run_root chmod 600 "$file" || return 1
}

swap_state_exists() {
  [[ -f "$CANVAS_SWAP_STATE_PATH" && ! -L "$CANVAS_SWAP_STATE_PATH" ]]
}

swap_state_matches_file() {
  local file="$1" expected _ actual
  swap_state_exists || return 1
  swap_file_is_safe "$file" || return 1
  read -r expected _ < "$CANVAS_SWAP_STATE_PATH" || return 1
  actual="$(swap_file_identity "$file")" || return 1
  [[ -n "$expected" && "$expected" == "$actual" ]]
}

swap_state_requires_secure_wipe() {
  local _ mode
  swap_state_exists || return 1
  read -r _ mode < "$CANVAS_SWAP_STATE_PATH" || return 1
  [[ "$mode" == "secure" ]]
}

write_swap_state() {
  local file="$1" mode="${2:-normal}" identity local_tmp root_tmp
  [[ "$mode" == "normal" || "$mode" == "secure" ]] || return 1
  swap_file_is_safe "$file" || return 1
  identity="$(swap_file_identity "$file")" || return 1
  run_root mkdir -p "$(dirname "$CANVAS_SWAP_STATE_PATH")" || return 1
  local_tmp="$(mktemp)" || return 1
  if ! printf '%s %s\n' "$identity" "$mode" > "$local_tmp"; then
    rm -f "$local_tmp"
    return 1
  fi
  root_tmp="${CANVAS_SWAP_STATE_PATH}.canvas-notebook.$$"
  if ! run_root install -m 644 "$local_tmp" "$root_tmp"; then
    rm -f "$local_tmp"
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
  rm -f "$local_tmp"
  if ! run_root mv -f "$root_tmp" "$CANVAS_SWAP_STATE_PATH"; then
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
}

remove_swap_state() {
  if [[ -e "$CANVAS_SWAP_STATE_PATH" || -L "$CANVAS_SWAP_STATE_PATH" ]]; then
    [[ ! -L "$CANVAS_SWAP_STATE_PATH" && -f "$CANVAS_SWAP_STATE_PATH" ]] || return 1
    run_root rm -f "$CANVAS_SWAP_STATE_PATH" || return 1
  fi
}

swap_file_is_safe() {
  local file="$1" links
  swap_path_exists "$file" || return 1
  [[ ! -L "$file" && -f "$file" ]] || return 1
  links="$(swap_file_nlink "$file")" || return 1
  [[ "$links" == "1" ]]
}

swap_file_has_signature() {
  local file="$1" type
  command -v blkid >/dev/null 2>&1 || return 1
  type="$(run_root blkid -p -s TYPE -o value "$file" 2>/dev/null || true)"
  [[ "$type" == "swap" ]]
}

swap_file_is_managed() {
  local file="$1"
  swap_file_is_safe "$file" && { swap_fstab_manages_file "$file" || swap_state_matches_file "$file"; }
}

swap_sysctl_matches() {
  local value="$1" actual
  [[ -f "$CANVAS_SWAP_SYSCTL_PATH" && ! -L "$CANVAS_SWAP_SYSCTL_PATH" ]] || return 1
  actual="$(tr -d '[:space:]' < "$CANVAS_SWAP_SYSCTL_PATH")" || return 1
  [[ "$actual" == "vm.swappiness=${value}" ]]
}

remove_canvas_swap_sysctl() {
  local path
  for path in "$CANVAS_SWAP_SYSCTL_PATH" "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"; do
    if swap_path_exists "$path"; then
      if [[ -L "$path" || ! -f "$path" ]]; then
        printf 'Unsafe Canvas swap sysctl path: %s\n' "$path" >&2
        return 1
      fi
      run_root rm -f "$path" || return 1
    fi
  done
}

journal_secure_swap_intent() {
  local file="$1" candidate candidate_exists=false
  if swap_state_requires_secure_wipe; then
    return 0
  fi
  if swap_state_exists; then
    for candidate in "$file" "${file}.canvas-disabled" "${file}.canvas-backup" "${file}.canvas-new"; do
      swap_path_exists "$candidate" && candidate_exists=true
      if swap_state_matches_file "$candidate"; then
        write_swap_state "$candidate" secure
        return
      fi
    done
    [[ "$candidate_exists" == "false" ]] && return 0
    printf 'Canvas swap ownership state does not match any transaction file\n' >&2
    return 1
  fi
  if swap_fstab_manages_file "$file"; then
    candidate_exists=false
    for candidate in "$file" "${file}.canvas-disabled" "${file}.canvas-backup" "${file}.canvas-new"; do
      swap_path_exists "$candidate" && candidate_exists=true
      if swap_file_is_safe "$candidate"; then
        write_swap_state "$candidate" secure
        return
      fi
    done
    [[ "$candidate_exists" == "false" ]] && return 0
    printf 'Canvas swap ownership marker has no safe transaction file\n' >&2
    return 1
  fi
  return 0
}

swap_fstab_mode() {
  stat -c '%a' "$CANVAS_SWAP_FSTAB_PATH" 2>/dev/null || stat -f '%Lp' "$CANVAS_SWAP_FSTAB_PATH" 2>/dev/null || printf '644\n'
}

capture_swap_fstab() {
  local destination="$1"
  if ! swap_fstab_observable; then
    printf 'Cannot safely read swap persistence from %s\n' "$CANVAS_SWAP_FSTAB_PATH" >&2
    return 1
  fi
  if [[ -e "$CANVAS_SWAP_FSTAB_PATH" ]]; then
    if ! run_root cat "$CANVAS_SWAP_FSTAB_PATH" > "$destination"; then
      printf 'Could not read %s\n' "$CANVAS_SWAP_FSTAB_PATH" >&2
      return 1
    fi
  elif ! : > "$destination"; then
    return 1
  fi
}

install_swap_fstab_snapshot() {
  local snapshot="$1" root_tmp mode
  mode="$(swap_fstab_mode)"
  root_tmp="${CANVAS_SWAP_FSTAB_PATH}.canvas-notebook.$$"
  if ! run_root install -m "$mode" "$snapshot" "$root_tmp"; then
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
  if ! run_root mv -f "$root_tmp" "$CANVAS_SWAP_FSTAB_PATH"; then
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
}

write_swap_fstab() {
  local desired_file="${1:-}" source_tmp next_tmp
  source_tmp="$(mktemp)" || return 1
  next_tmp="$(mktemp)" || {
    rm -f "$source_tmp"
    return 1
  }
  if ! capture_swap_fstab "$source_tmp"; then
    rm -f "$source_tmp" "$next_tmp"
    return 1
  fi
  if ! awk -v managed="$CANVAS_SWAP_MANAGED_FILE" '
    $1 == managed && $3 == "swap" && $0 ~ /[[:space:]]# canvas-notebook swap[[:space:]]*$/ { next }
    { print }
  ' "$source_tmp" > "$next_tmp"; then
    rm -f "$source_tmp" "$next_tmp"
    return 1
  fi
  if [[ -n "$desired_file" ]] && ! printf '%s none swap sw 0 0 # canvas-notebook swap\n' "$desired_file" >> "$next_tmp"; then
    rm -f "$source_tmp" "$next_tmp"
    return 1
  fi
  if ! install_swap_fstab_snapshot "$next_tmp"; then
    rm -f "$source_tmp" "$next_tmp"
    return 1
  fi
  rm -f "$source_tmp" "$next_tmp" || true
}

swap_available_bytes() {
  local directory="$1"
  df -Pk "$directory" | awk 'NR > 1 { available = $4 } END { if (available != "") printf "%.0f\n", available * 1024 }'
}

swap_check_disk_space() {
  local file="$1" desired_bytes="$2" available required
  available="$(swap_available_bytes "$(dirname "$file")")" || return 1
  if [[ ! "$available" =~ ^[0-9]+$ ]]; then
    printf 'Could not determine free disk space for %s\n' "$file" >&2
    return 1
  fi
  required=$((desired_bytes + CANVAS_SWAP_DISK_HEADROOM_BYTES))
  if [[ "$available" -lt "$required" ]]; then
    printf 'Not enough free disk space for swap: need %s bytes including headroom, have %s\n' "$required" "$available" >&2
    return 1
  fi
}

prepare_swap_file() {
  local file="$1" size="$2" desired_bytes="$3" temp_file output count
  temp_file="${file}.canvas-new"
  if swap_path_exists "$temp_file"; then
    if ! swap_file_is_safe "$temp_file" || ! run_root rm -f "$temp_file"; then
      printf 'Unsafe leftover Canvas swap staging file: %s\n' "$temp_file" >&2
      return 1
    fi
  fi
  swap_check_disk_space "$file" "$desired_bytes" || return 1
  if ! output="$(run_root fallocate -l "$size" "$temp_file" 2>&1)"; then
    if printf '%s' "$output" | grep -qi 'no space left'; then
      printf '%s\n' "$output" >&2
      return 1
    fi
    count=$(((desired_bytes + 1048575) / 1048576))
    if ! run_root dd if=/dev/zero of="$temp_file" bs=1M count="$count" status=none; then
      run_root rm -f "$temp_file" >/dev/null 2>&1 || true
      return 1
    fi
    if ! run_root truncate -s "$desired_bytes" "$temp_file"; then
      run_root rm -f "$temp_file" >/dev/null 2>&1 || true
      return 1
    fi
  fi
  if ! run_root chmod 600 "$temp_file"; then
    run_root rm -f "$temp_file" >/dev/null 2>&1 || true
    return 1
  fi
  if ! run_root mkswap "$temp_file" >/dev/null; then
    run_root rm -f "$temp_file" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s\n' "$temp_file"
}

apply_swap_swappiness() {
  local value="$1" local_tmp root_tmp
  if ! run_root mkdir -p "$(dirname "$CANVAS_SWAP_SYSCTL_PATH")"; then
    return 1
  fi
  local_tmp="$(mktemp)" || return 1
  if ! printf 'vm.swappiness=%s\n' "$value" > "$local_tmp"; then
    rm -f "$local_tmp"
    return 1
  fi
  root_tmp="${CANVAS_SWAP_SYSCTL_PATH}.canvas-notebook.$$"
  if ! run_root install -m 644 "$local_tmp" "$root_tmp"; then
    rm -f "$local_tmp"
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
  rm -f "$local_tmp" || true
  if ! run_root mv -f "$root_tmp" "$CANVAS_SWAP_SYSCTL_PATH"; then
    run_root rm -f "$root_tmp" >/dev/null 2>&1 || true
    return 1
  fi
  if ! run_root sysctl -w "vm.swappiness=${value}" >/dev/null; then
    return 1
  fi
}

rollback_swap_replacement() {
  local file="$1" backup="$2" was_active="$3"
  if swap_is_active "$file"; then
    if ! run_root swapoff "$file"; then
      printf 'Could not roll back active replacement swap file: %s\n' "$file" >&2
      return 1
    fi
  fi
  run_root rm -f "$file" || return 1
  if [[ -n "$backup" ]] && swap_path_exists "$backup"; then
    run_root mv -f "$backup" "$file" || return 1
    write_swap_state "$file" || return 1
    if [[ "$was_active" == "true" ]]; then
      run_root swapon "$file" || return 1
    fi
  else
    remove_swap_state || return 1
  fi
}

enable_canvas_swap_unlocked() {
  local file="$1" size="$2" swappiness="$3" desired_bytes actual_bytes temp_file="" staging="${1}.canvas-new" backup="${1}.canvas-backup" was_active=false file_changed=false
  desired_bytes="$(swap_size_bytes "$size")" || return 1

  if swap_state_requires_secure_wipe || swap_path_exists "${file}.canvas-disabled" || swap_path_exists "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"; then
    disable_canvas_swap_unlocked "$file" false || return 1
  fi

  if swap_path_exists "$staging"; then
    if ! swap_file_is_safe "$staging" || swap_is_active "$staging" || { ! swap_state_exists && ! swap_fstab_manages_file "$file"; }; then
      printf 'Unsafe leftover Canvas swap staging file: %s\n' "$staging" >&2
      return 1
    fi
    run_root rm -f "$staging" || return 1
  fi

  if swap_fstab_has_unmanaged_file "$file"; then
    printf 'Refusing unmanaged swap entry for Canvas path: %s\n' "$file" >&2
    return 1
  fi

  if swap_path_exists "$file"; then
    if ! swap_file_is_safe "$file"; then
      printf 'Refusing to replace unsafe swap path: %s\n' "$file" >&2
      return 1
    fi
    if ! swap_file_is_managed "$file"; then
      printf 'Refusing to replace an unmanaged file: %s\n' "$file" >&2
      return 1
    fi
    write_swap_state "$file" || return 1
    actual_bytes="$(swap_file_bytes "$file")" || return 1
    if [[ "$actual_bytes" != "$desired_bytes" ]] || ! swap_file_has_signature "$file"; then
      temp_file="$(prepare_swap_file "$file" "$size" "$desired_bytes")" || return 1
    fi
  else
    temp_file="$(prepare_swap_file "$file" "$size" "$desired_bytes")" || return 1
  fi

  if swap_is_active "$file"; then
    was_active=true
    if [[ -n "$temp_file" ]] && ! run_root swapoff "$file"; then
      run_root rm -f "$temp_file" >/dev/null 2>&1 || true
      return 1
    fi
  fi

  if [[ -n "$temp_file" ]]; then
    if ! write_swap_state "$temp_file"; then
      run_root rm -f "$temp_file" >/dev/null 2>&1 || true
      [[ "$was_active" == "true" ]] && run_root swapon "$file" >/dev/null 2>&1 || true
      return 1
    fi
    if swap_path_exists "$backup"; then
      if ! swap_file_is_safe "$backup" || ! wipe_swap_file "$backup" || ! run_root rm -f "$backup"; then
        run_root rm -f "$temp_file" >/dev/null 2>&1 || true
        swap_path_exists "$file" && write_swap_state "$file" >/dev/null 2>&1 || true
        [[ "$was_active" == "true" ]] && run_root swapon "$file" >/dev/null 2>&1 || true
        return 1
      fi
    fi
    if swap_path_exists "$file" && ! run_root mv -f "$file" "$backup"; then
      run_root rm -f "$temp_file" >/dev/null 2>&1 || true
      write_swap_state "$file" >/dev/null 2>&1 || true
      [[ "$was_active" == "true" ]] && run_root swapon "$file" >/dev/null 2>&1 || true
      return 1
    fi
    if ! run_root mv -f "$temp_file" "$file"; then
      if swap_path_exists "$backup"; then
        run_root mv -f "$backup" "$file" >/dev/null 2>&1 || true
        write_swap_state "$file" >/dev/null 2>&1 || true
      else
        remove_swap_state >/dev/null 2>&1 || true
      fi
      [[ "$was_active" == "true" ]] && run_root swapon "$file" >/dev/null 2>&1 || true
      return 1
    fi
    file_changed=true
    if ! write_swap_state "$file"; then
      rollback_swap_replacement "$file" "$backup" "$was_active" || true
      return 1
    fi
  fi

  if ! apply_swap_file_permissions "$file"; then
    [[ "$file_changed" == "true" ]] && rollback_swap_replacement "$file" "$backup" "$was_active"
    return 1
  fi
  if ! swap_is_active "$file" && ! run_root swapon "$file"; then
    [[ "$file_changed" == "true" ]] && rollback_swap_replacement "$file" "$backup" "$was_active"
    return 1
  fi
  if ! apply_swap_swappiness "$swappiness"; then
    [[ "$file_changed" == "true" ]] && rollback_swap_replacement "$file" "$backup" "$was_active"
    return 1
  fi
  if ! write_swap_fstab "$file"; then
    [[ "$file_changed" == "true" ]] && rollback_swap_replacement "$file" "$backup" "$was_active"
    return 1
  fi
  if swap_path_exists "$backup"; then
    swap_file_is_safe "$backup" || return 1
    wipe_swap_file "$backup" || return 1
    run_root rm -f "$backup" || return 1
  fi
}

wipe_swap_file() {
  local file="$1" bytes count
  if swap_is_active "$file"; then
    printf 'Refusing to wipe active swap file: %s\n' "$file" >&2
    return 1
  fi
  if command -v shred >/dev/null 2>&1; then
    run_root shred --force --iterations=1 "$file" || return 1
  else
    bytes="$(swap_file_bytes "$file")" || return 1
    count=$(((bytes + 1048575) / 1048576))
    run_root dd if=/dev/zero of="$file" bs=1M count="$count" conv=fsync,notrunc status=none || return 1
    run_root truncate -s "$bytes" "$file" || return 1
  fi
  run_root sync || return 1
}

restore_disabled_swap() {
  local file="$1" file_backup="$2" sysctl_backup="$3" fstab_snapshot="$4" was_active="$5"
  if [[ -n "$sysctl_backup" ]] && swap_path_exists "$sysctl_backup"; then
    run_root mv -f "$sysctl_backup" "$CANVAS_SWAP_SYSCTL_PATH" >/dev/null 2>&1 || true
  fi
  if [[ -n "$file_backup" ]] && swap_path_exists "$file_backup"; then
    run_root mv -f "$file_backup" "$file" >/dev/null 2>&1 || true
  fi
  install_swap_fstab_snapshot "$fstab_snapshot" >/dev/null 2>&1 || true
  if [[ "$was_active" == "true" ]] && swap_path_exists "$file"; then
    run_root swapon "$file" >/dev/null 2>&1 || true
  fi
}

disable_canvas_swap_unlocked() {
  local file="$1" secure="${2:-false}" managed=false was_active=false fstab_snapshot file_backup="" sysctl_backup="" artifact state_mode=normal
  local disabled_backup="${file}.canvas-disabled"

  if [[ "$secure" == "true" ]]; then
    journal_secure_swap_intent "$file" || return 1
  fi
  if swap_state_requires_secure_wipe; then
    secure=true
  fi
  [[ "$secure" == "true" ]] && state_mode=secure

  if swap_path_exists "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"; then
    if [[ -L "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled" || ! -f "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled" ]]; then
      printf 'Unsafe Canvas swap sysctl path: %s\n' "${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled" >&2
      return 1
    fi
    if swap_path_exists "$CANVAS_SWAP_SYSCTL_PATH"; then
      printf 'Conflicting Canvas swap sysctl transaction files\n' >&2
      return 1
    fi
    sysctl_backup="${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"
  fi

  if swap_fstab_has_unmanaged_file "$file"; then
    printf 'Refusing unmanaged swap entry for Canvas path: %s\n' "$file" >&2
    return 1
  fi

  for artifact in "${file}.canvas-backup" "${file}.canvas-new"; do
    if swap_path_exists "$artifact"; then
      if ! swap_file_is_safe "$artifact" || { ! swap_state_exists && ! swap_fstab_manages_file "$file"; }; then
        printf 'Unsafe leftover Canvas swap staging file: %s\n' "$artifact" >&2
        return 1
      fi
      if [[ "$artifact" == "${file}.canvas-backup" || "$secure" == "true" ]] && ! wipe_swap_file "$artifact"; then
        return 1
      fi
      run_root rm -f "$artifact" || return 1
    fi
  done

  if swap_path_exists "$disabled_backup"; then
    if ! swap_file_is_safe "$disabled_backup" || ! swap_state_matches_file "$disabled_backup"; then
      printf 'Unsafe leftover Canvas swap file: %s\n' "$disabled_backup" >&2
      return 1
    fi
    if [[ "$secure" == "true" ]] && ! wipe_swap_file "$disabled_backup"; then
      return 1
    fi
    run_root rm -f "$disabled_backup" || return 1
  fi

  if swap_path_exists "$file"; then
    if ! swap_file_is_safe "$file"; then
      printf 'Refusing to modify unsafe swap path: %s\n' "$file" >&2
      return 1
    fi
    if swap_file_is_managed "$file"; then
      managed=true
    elif swap_state_exists; then
      printf 'Canvas swap ownership state does not match %s\n' "$file" >&2
      return 1
    else
      printf 'Refusing to remove an unmanaged file: %s\n' "$file" >&2
      return 1
    fi
  elif swap_fstab_manages_file "$file" || swap_state_exists; then
    managed=true
  fi

  if [[ "$managed" != "true" ]]; then
    remove_canvas_swap_sysctl
    return
  fi
  if swap_path_exists "$file"; then
    write_swap_state "$file" "$state_mode" || return 1
  fi
  fstab_snapshot="$(mktemp)" || return 1
  if ! capture_swap_fstab "$fstab_snapshot"; then
    rm -f "$fstab_snapshot"
    return 1
  fi
  if swap_is_active "$file"; then
    was_active=true
    if ! run_root swapoff "$file"; then
      rm -f "$fstab_snapshot"
      return 1
    fi
  fi
  if swap_path_exists "$file"; then
    file_backup="$disabled_backup"
    if ! run_root mv -f "$file" "$file_backup"; then
      restore_disabled_swap "$file" "$file_backup" "$sysctl_backup" "$fstab_snapshot" "$was_active"
      rm -f "$fstab_snapshot"
      return 1
    fi
  fi
  if swap_path_exists "$CANVAS_SWAP_SYSCTL_PATH"; then
    if [[ -L "$CANVAS_SWAP_SYSCTL_PATH" || ! -f "$CANVAS_SWAP_SYSCTL_PATH" ]]; then
      restore_disabled_swap "$file" "$file_backup" "$sysctl_backup" "$fstab_snapshot" "$was_active"
      rm -f "$fstab_snapshot"
      return 1
    fi
    if [[ -n "$sysctl_backup" ]]; then
      printf 'Conflicting Canvas swap sysctl transaction files\n' >&2
      rm -f "$fstab_snapshot"
      return 1
    fi
    sysctl_backup="${CANVAS_SWAP_SYSCTL_PATH}.canvas-disabled"
    if ! run_root mv -f "$CANVAS_SWAP_SYSCTL_PATH" "$sysctl_backup"; then
      restore_disabled_swap "$file" "$file_backup" "$sysctl_backup" "$fstab_snapshot" "$was_active"
      rm -f "$fstab_snapshot"
      return 1
    fi
  fi
  if ! write_swap_fstab ""; then
    restore_disabled_swap "$file" "$file_backup" "$sysctl_backup" "$fstab_snapshot" "$was_active"
    rm -f "$fstab_snapshot"
    return 1
  fi

  if [[ "$secure" == "true" && -n "$file_backup" ]] && ! wipe_swap_file "$file_backup"; then
    rm -f "$fstab_snapshot"
    return 1
  fi
  if [[ -n "$file_backup" ]] && ! run_root rm -f "$file_backup"; then
    rm -f "$fstab_snapshot"
    return 1
  fi
  if ! remove_canvas_swap_sysctl; then
    rm -f "$fstab_snapshot"
    return 1
  fi
  if ! remove_swap_state; then
    rm -f "$fstab_snapshot"
    return 1
  fi
  rm -f "$fstab_snapshot" || true
}

with_canvas_swap_lock() {
  local callback="$1" lock_dir owner local_tmp rc=0
  shift
  lock_dir="$(dirname "$CANVAS_SWAP_LOCK_PATH")"
  if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then
    mkdir -p "$lock_dir" || return 1
  else
    if [[ -L "$lock_dir" || ( -e "$lock_dir" && ! -d "$lock_dir" ) ]]; then
      printf 'Unsafe Canvas swap lock directory: %s\n' "$lock_dir" >&2
      return 1
    fi
    run_root install -d -m 755 -o root -g root "$lock_dir" || return 1
  fi
  if [[ -L "$CANVAS_SWAP_LOCK_PATH" || ( -e "$CANVAS_SWAP_LOCK_PATH" && ! -f "$CANVAS_SWAP_LOCK_PATH" ) ]]; then
    printf 'Unsafe Canvas swap lock file: %s\n' "$CANVAS_SWAP_LOCK_PATH" >&2
    return 1
  fi
  if [[ ! -e "$CANVAS_SWAP_LOCK_PATH" ]]; then
    local_tmp="$(mktemp)" || return 1
    if [[ -n "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then
      install -m 600 "$local_tmp" "$CANVAS_SWAP_LOCK_PATH" || {
        rm -f "$local_tmp"
        return 1
      }
    else
      run_root install -m 600 "$local_tmp" "$CANVAS_SWAP_LOCK_PATH" || {
        rm -f "$local_tmp"
        return 1
      }
    fi
    rm -f "$local_tmp"
  fi
  if [[ -z "${CANVAS_SWAP_TEST_ROOT:-}" ]]; then
    owner="$(_install_user)" || return 1
    run_root chown "$owner" "$CANVAS_SWAP_LOCK_PATH" || return 1
    run_root chmod 600 "$CANVAS_SWAP_LOCK_PATH" || return 1
  fi
  if ! exec 9>>"$CANVAS_SWAP_LOCK_PATH"; then
    printf 'Cannot open Canvas swap lock; run the command with sudo\n' >&2
    return 1
  fi
  if ! flock -w 30 9; then
    exec 9>&-
    printf 'Timed out waiting for the Canvas swap lock\n' >&2
    return 1
  fi
  "$callback" "$@" || rc=$?
  flock -u 9 || rc=1
  exec 9>&-
  return "$rc"
}

reconcile_canvas_swap_unlocked() {
  local enabled="$1" size="$2" file="$3" swappiness="$4" secure="${5:-false}"
  if ! swap_proc_swaps_observable; then
    printf 'Cannot read active swap state from %s\n' "$CANVAS_SWAP_PROC_SWAPS_PATH" >&2
    return 1
  fi
  if ! swap_fstab_observable; then
    printf 'Cannot safely read swap persistence from %s\n' "$CANVAS_SWAP_FSTAB_PATH" >&2
    return 1
  fi
  if swap_path_exists "$CANVAS_SWAP_STATE_PATH" && ! swap_state_exists; then
    printf 'Unsafe Canvas swap ownership state path: %s\n' "$CANVAS_SWAP_STATE_PATH" >&2
    return 1
  fi
  if [[ "$enabled" == "true" ]]; then
    enable_canvas_swap_unlocked "$file" "$size" "$swappiness"
  else
    disable_canvas_swap_unlocked "$file" "$secure"
  fi
}

reconcile_canvas_swap() {
  local enabled="$1" size="$2" file="$3" swappiness="$4" secure="${5:-false}"
  swap_validate_config "$enabled" "$size" "$file" "$swappiness" || return 1
  with_canvas_swap_lock reconcile_canvas_swap_unlocked "$enabled" "$size" "$file" "$swappiness" "$secure"
}

enable_canvas_swap() {
  reconcile_canvas_swap true "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS"
}

disable_canvas_swap() {
  reconcile_canvas_swap false "$CANVAS_SWAP_SIZE" "$CANVAS_SWAP_FILE" "$CANVAS_SWAP_SWAPPINESS" "${1:-false}"
}
