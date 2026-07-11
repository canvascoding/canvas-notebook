#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
export CANVAS_TEST_REAL_CAT="$(command -v cat)"
export CANVAS_TEST_REAL_INSTALL="$(command -v install)"
export CANVAS_TEST_REAL_MV="$(command -v mv)"

cat > "$FAKE_BIN/fallocate" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-l" ]]
truncate -s "$2" "$3"
EOF

cat > "$FAKE_BIN/mkswap" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/shred" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
file="${!#}"
size="$(stat -c '%s' "$file" 2>/dev/null || stat -f '%z' "$file")"
: > "$file"
truncate -s "$size" "$file"
printf 'wiped\n' > "$CANVAS_TEST_SHRED_MARKER"
[[ "${CANVAS_TEST_FAIL_SHRED:-false}" != "true" ]]
EOF

cat > "$FAKE_BIN/blkid" <<'EOF'
#!/usr/bin/env bash
printf 'swap\n'
EOF

cat > "$FAKE_BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'test 100000000 0 100000000 0%% /\n'
EOF

cat > "$FAKE_BIN/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
lock_dir="$CANVAS_SWAP_TEST_ROOT/flock-held"
if [[ "${1:-}" == "-u" ]]; then
  rmdir "$lock_dir"
  exit 0
fi
for _ in $(seq 1 600); do
  if mkdir "$lock_dir" 2>/dev/null; then
    exit 0
  fi
  sleep 0.05
done
exit 1
EOF

cat > "$FAKE_BIN/cat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${CANVAS_TEST_FAIL_CAT_PATH:-}" && "${1:-}" == "$CANVAS_TEST_FAIL_CAT_PATH" ]]; then
  exit 1
fi
exec "$CANVAS_TEST_REAL_CAT" "$@"
EOF

cat > "$FAKE_BIN/install" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${!#}"
if [[ -n "${CANVAS_TEST_FAIL_INSTALL_TARGET:-}" && "$target" == "$CANVAS_TEST_FAIL_INSTALL_TARGET" ]]; then
  exit 1
fi
exec "$CANVAS_TEST_REAL_INSTALL" "$@"
EOF

cat > "$FAKE_BIN/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${!#}"
if [[ -n "${CANVAS_TEST_FAIL_MV_TARGET:-}" && "$target" == "$CANVAS_TEST_FAIL_MV_TARGET" ]]; then
  exit 1
fi
exec "$CANVAS_TEST_REAL_MV" "$@"
EOF

cat > "$FAKE_BIN/swapon" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--show" ]]; then
  cat "$CANVAS_SWAP_PROC_SWAPS_PATH"
  exit 0
fi
file="$1"
size="$(stat -c '%s' "$file" 2>/dev/null || stat -f '%z' "$file")"
tmp="${CANVAS_SWAP_PROC_SWAPS_PATH}.tmp"
awk -v file="$file" 'NR == 1 || $1 != file { print }' "$CANVAS_SWAP_PROC_SWAPS_PATH" > "$tmp"
printf '%s file %s 0 -2\n' "$file" "$((size / 1024))" >> "$tmp"
mv "$tmp" "$CANVAS_SWAP_PROC_SWAPS_PATH"
EOF

cat > "$FAKE_BIN/swapoff" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
file="$1"
if [[ -n "${CANVAS_TEST_SWAPOFF_FAIL_AFTER:-}" ]]; then
  count=0
  [[ -f "$CANVAS_TEST_SWAPOFF_COUNTER" ]] && count="$(cat "$CANVAS_TEST_SWAPOFF_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$CANVAS_TEST_SWAPOFF_COUNTER"
  if [[ "$count" -ge "$CANVAS_TEST_SWAPOFF_FAIL_AFTER" ]]; then
    exit 1
  fi
fi
tmp="${CANVAS_SWAP_PROC_SWAPS_PATH}.tmp"
awk -v file="$file" 'NR == 1 || $1 != file { print }' "$CANVAS_SWAP_PROC_SWAPS_PATH" > "$tmp"
mv "$tmp" "$CANVAS_SWAP_PROC_SWAPS_PATH"
EOF

cat > "$FAKE_BIN/sysctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-w" ]]; then
  printf '%s\n' "${2#*=}" > "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"
  exit 0
fi
cat "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"
EOF

cat > "$FAKE_BIN/free" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$@"
EOF

chmod +x "$FAKE_BIN"/*
export PATH="$FAKE_BIN:$PATH"

export CANVAS_CONFIG_JSON="$TMP/canvas-notebook-config.json"
export CANVAS_INSTALL_DIR="$TMP/install"
export CANVAS_SWAP_TEST_ROOT="$TMP"
export CANVAS_TEST_SHRED_MARKER="$TMP/shred-marker"
export CANVAS_TEST_SWAPOFF_COUNTER="$TMP/swapoff-counter"
export OUTPUT_JSON=true
export NO_BANNER=true
export CANVAS_USE_COLOR=false

source "$ROOT/install/lib/shared/output.sh"
source "$ROOT/install/lib/shared/utils.sh"
source "$ROOT/install/lib/shared/config_json.sh"
source "$ROOT/install/lib/shared/swap.sh"
source "$ROOT/install/lib/commands/swap.sh"

export CANVAS_SWAP_MANAGED_FILE CANVAS_SWAP_FSTAB_PATH CANVAS_SWAP_PROC_SWAPS_PATH
export CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH CANVAS_SWAP_SYSCTL_PATH CANVAS_SWAP_LOCK_PATH

printf 'Filename Type Size Used Priority\n' > "$CANVAS_SWAP_PROC_SWAPS_PATH"
printf '# test fstab\n' > "$CANVAS_SWAP_FSTAB_PATH"
printf '60\n' > "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"

run_root() {
  "$@"
}

config_json_init
[[ "$(swap_file_mode "$CANVAS_CONFIG_JSON")" == "600" ]]
cp "$CANVAS_CONFIG_JSON" "$TMP/config-before-invalid-boolean"
set +e
(config_json_write swap.enabled flase) >/dev/null 2>&1
invalid_boolean_rc=$?
set -e
[[ "$invalid_boolean_rc" -ne 0 ]]
cmp -s "$TMP/config-before-invalid-boolean" "$CANVAS_CONFIG_JSON"
cp "$CANVAS_CONFIG_JSON" "$TMP/config-before-migration-failure"
export CANVAS_MANAGER_ENV_PATH="$TMP/missing-manager.env"
export COMPOSE_FILE="$TMP/missing-compose.yaml"
export CANVAS_TEST_FAIL_MV_TARGET="$CANVAS_CONFIG_JSON"
set +e
config_json_migrate --force >/dev/null 2>&1
migration_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_MV_TARGET
unset CANVAS_MANAGER_ENV_PATH COMPOSE_FILE
[[ "$migration_failure_rc" -ne 0 ]]
cmp -s "$TMP/config-before-migration-failure" "$CANVAS_CONFIG_JSON"
[[ -z "$(compgen -G "${CANVAS_CONFIG_JSON}.migration.*" || true)" ]]
config_json_write swap.enabled true
config_json_write swap.size 128M
config_json_write swap.file "$CANVAS_SWAP_MANAGED_FILE"
config_json_write swap.swappiness 10

enabled_json="$(cmd_swap_sync)"
jq -e '
  .enabled == true and
  .active == true and
  .file == $file and
  .configuredSize == "128M" and
  .actualSizeBytes == 134217728 and
  .persistent == true and
  .swappiness == 10 and
  .configuredSwappiness == 10 and
  .inSync == true and
  .error == null
' --arg file "$CANVAS_SWAP_MANAGED_FILE" <<<"$enabled_json" >/dev/null
grep -Fq "$CANVAS_SWAP_MANAGED_FILE none swap sw 0 0 # canvas-notebook swap" "$CANVAS_SWAP_FSTAB_PATH"
cli_status_json="$("$ROOT/install/bin/canvas-notebook" swap --json --no-banner)"
jq -e '.enabled == true and .active == true and .inSync == true and .error == null' <<<"$cli_status_json" >/dev/null

chmod 644 "$CANVAS_SWAP_MANAGED_FILE"
permission_drift_json="$(cmd_swap)"
jq -e '.enabled == true and .inSync == false and (.error | type == "string")' <<<"$permission_drift_json" >/dev/null
permission_repaired_json="$(cmd_swap_sync)"
jq -e '.enabled == true and .inSync == true and .error == null' <<<"$permission_repaired_json" >/dev/null
[[ "$(swap_file_mode "$CANVAS_SWAP_MANAGED_FILE")" == "600" ]]

mv "$CANVAS_SWAP_PROC_SWAPS_PATH" "$TMP/proc-swaps-hidden"
unknown_active_json="$(cmd_swap)"
jq -e '.inSync == false and (.error | type == "string")' <<<"$unknown_active_json" >/dev/null
mv "$TMP/proc-swaps-hidden" "$CANVAS_SWAP_PROC_SWAPS_PATH"
mv "$CANVAS_SWAP_FSTAB_PATH" "$TMP/fstab-hidden"
ln -s "$TMP/fstab-hidden" "$CANVAS_SWAP_FSTAB_PATH"
unknown_fstab_json="$(cmd_swap)"
jq -e '.inSync == false and (.error | type == "string")' <<<"$unknown_fstab_json" >/dev/null
cp "$TMP/fstab-hidden" "$TMP/fstab-before-unsafe-sync"
set +e
unknown_fstab_sync_json="$(cmd_swap_sync)"
unknown_fstab_sync_rc=$?
set -e
[[ "$unknown_fstab_sync_rc" -ne 0 ]]
jq -e '.inSync == false and (.error | type == "string")' <<<"$unknown_fstab_sync_json" >/dev/null
[[ -L "$CANVAS_SWAP_FSTAB_PATH" ]]
cmp -s "$TMP/fstab-before-unsafe-sync" "$TMP/fstab-hidden"
rm -f "$CANVAS_SWAP_FSTAB_PATH"
mv "$TMP/fstab-hidden" "$CANVAS_SWAP_FSTAB_PATH"
rm -f "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"
unknown_swappiness_json="$(cmd_swap)"
jq -e '.enabled == true and .inSync == false and (.error | type == "string")' <<<"$unknown_swappiness_json" >/dev/null
printf '10\n' > "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"

truncate -s 268435456 "${CANVAS_SWAP_MANAGED_FILE}.canvas-new"
staged_resize_json="$(cmd_swap)"
jq -e '.inSync == false and .error == "Canvas swap transaction is incomplete"' <<<"$staged_resize_json" >/dev/null
recovered_staging_json="$(cmd_swap_sync)"
jq -e '.enabled == true and .actualSizeBytes == 134217728 and .inSync == true and .error == null' <<<"$recovered_staging_json" >/dev/null
[[ ! -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-new" ]]

truncate -s 134217728 "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup"
swapon "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup"
config_json_write swap.enabled false
set +e
active_backup_json="$(cmd_swap_sync)"
active_backup_rc=$?
set -e
[[ "$active_backup_rc" -ne 0 ]]
jq -e '.enabled == false and .inSync == false and (.error | type == "string")' <<<"$active_backup_json" >/dev/null
[[ -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup" ]]
swap_is_active "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup"
swapoff "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup"
rm -f "$CANVAS_TEST_SHRED_MARKER"
disabled_with_backup_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .inSync == true and .error == null' <<<"$disabled_with_backup_json" >/dev/null
[[ "$(cat "$CANVAS_TEST_SHRED_MARKER")" == "wiped" ]]
[[ ! -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup" ]]
config_json_write swap.enabled true
cmd_swap_sync >/dev/null

cp "$CANVAS_SWAP_FSTAB_PATH" "$TMP/fstab-before-disable-failure"
config_json_write swap.enabled false
export CANVAS_TEST_FAIL_INSTALL_TARGET="${CANVAS_SWAP_FSTAB_PATH}.canvas-notebook.$$"
set +e
disable_failure_json="$(cmd_swap_sync)"
disable_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_INSTALL_TARGET
[[ "$disable_failure_rc" -ne 0 ]]
cmp -s "$TMP/fstab-before-disable-failure" "$CANVAS_SWAP_FSTAB_PATH"
swap_is_active "$CANVAS_SWAP_MANAGED_FILE"
jq -e '.enabled == false and .active == true and .inSync == false and (.error | type == "string")' <<<"$disable_failure_json" >/dev/null
cmd_swap_sync >/dev/null

config_json_write swap.enabled true
cp "$CANVAS_SWAP_FSTAB_PATH" "$TMP/fstab-before-read-failure"
export CANVAS_TEST_FAIL_CAT_PATH="$CANVAS_SWAP_FSTAB_PATH"
set +e
read_failure_json="$(cmd_swap_sync)"
read_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_CAT_PATH
[[ "$read_failure_rc" -ne 0 ]]
cmp -s "$TMP/fstab-before-read-failure" "$CANVAS_SWAP_FSTAB_PATH"
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
[[ ! -e "$CANVAS_SWAP_STATE_PATH" ]]
jq -e '.inSync == false and (.error | type == "string")' <<<"$read_failure_json" >/dev/null

config_json_write swap.enabled false
sysctl_cleanup_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .inSync == true and .error == null' <<<"$sysctl_cleanup_json" >/dev/null
[[ ! -e "$CANVAS_SWAP_SYSCTL_PATH" ]]
config_json_write swap.enabled true

export CANVAS_TEST_FAIL_INSTALL_TARGET="${CANVAS_SWAP_FSTAB_PATH}.canvas-notebook.$$"
set +e
install_failure_json="$(cmd_swap_sync)"
install_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_INSTALL_TARGET
[[ "$install_failure_rc" -ne 0 ]]
cmp -s "$TMP/fstab-before-read-failure" "$CANVAS_SWAP_FSTAB_PATH"
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
jq -e '.inSync == false and (.error | type == "string")' <<<"$install_failure_json" >/dev/null

export CANVAS_TEST_FAIL_MV_TARGET="$CANVAS_SWAP_FSTAB_PATH"
set +e
rename_failure_json="$(cmd_swap_sync)"
rename_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_MV_TARGET
[[ "$rename_failure_rc" -ne 0 ]]
cmp -s "$TMP/fstab-before-read-failure" "$CANVAS_SWAP_FSTAB_PATH"
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
jq -e '.inSync == false and (.error | type == "string")' <<<"$rename_failure_json" >/dev/null

cmd_swap_sync >/dev/null

config_json_write swap.size 256M
rm -f "$CANVAS_TEST_SWAPOFF_COUNTER"
export CANVAS_TEST_SWAPOFF_FAIL_AFTER=2
export CANVAS_TEST_FAIL_INSTALL_TARGET="${CANVAS_SWAP_FSTAB_PATH}.canvas-notebook.$$"
set +e
rollback_failure_json="$(cmd_swap_sync)"
rollback_failure_rc=$?
set -e
unset CANVAS_TEST_SWAPOFF_FAIL_AFTER CANVAS_TEST_FAIL_INSTALL_TARGET
[[ "$rollback_failure_rc" -ne 0 ]]
swap_is_active "$CANVAS_SWAP_MANAGED_FILE"
[[ "$(swap_file_bytes "$CANVAS_SWAP_MANAGED_FILE")" == "268435456" ]]
[[ -f "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup" ]]
jq -e '.active == true and .inSync == false and (.error | type == "string")' <<<"$rollback_failure_json" >/dev/null
staged_status_json="$(cmd_swap)"
jq -e '.inSync == false and .error == "Canvas swap transaction is incomplete"' <<<"$staged_status_json" >/dev/null
resized_json="$(cmd_swap_sync)"
jq -e '.actualSizeBytes == 268435456 and .inSync == true and .error == null' <<<"$resized_json" >/dev/null
[[ ! -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-backup" ]]

config_json_write swap.enabled false
disabled_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .actualSizeBytes == null and .persistent == false and .inSync == true and .error == null' <<<"$disabled_json" >/dev/null
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
if grep -Fq 'canvas-notebook swap' "$CANVAS_SWAP_FSTAB_PATH"; then
  printf 'Canvas swap fstab entry was not removed\n' >&2
  exit 1
fi

truncate -s 134217728 "$CANVAS_SWAP_MANAGED_FILE"
swapon "$CANVAS_SWAP_MANAGED_FILE"
set +e
foreign_active_json="$(cmd_swap_sync)"
foreign_active_rc=$?
set -e
[[ "$foreign_active_rc" -ne 0 ]]
jq -e '.enabled == false and .active == true and .inSync == false and (.error | type == "string")' <<<"$foreign_active_json" >/dev/null
[[ -f "$CANVAS_SWAP_MANAGED_FILE" ]]
swap_is_active "$CANVAS_SWAP_MANAGED_FILE"
swapoff "$CANVAS_SWAP_MANAGED_FILE"
set +e
foreign_inactive_json="$(cmd_swap_sync)"
foreign_inactive_rc=$?
set -e
[[ "$foreign_inactive_rc" -ne 0 ]]
jq -e '.enabled == false and .active == false and .actualSizeBytes == 134217728 and .inSync == false and (.error | type == "string")' <<<"$foreign_inactive_json" >/dev/null
[[ -f "$CANVAS_SWAP_MANAGED_FILE" ]]
rm -f "$CANVAS_SWAP_MANAGED_FILE"

printf '%s none swap sw 0 0\n' "$CANVAS_SWAP_MANAGED_FILE" >> "$CANVAS_SWAP_FSTAB_PATH"
config_json_write swap.enabled true
set +e
fstab_collision_json="$(cmd_swap_sync)"
fstab_collision_rc=$?
set -e
[[ "$fstab_collision_rc" -ne 0 ]]
jq -e '.enabled == true and .active == false and .inSync == false and (.error | type == "string")' <<<"$fstab_collision_json" >/dev/null
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
awk -v file="$CANVAS_SWAP_MANAGED_FILE" '$1 != file || $3 != "swap" { print }' "$CANVAS_SWAP_FSTAB_PATH" > "$TMP/fstab-without-collision"
mv "$TMP/fstab-without-collision" "$CANVAS_SWAP_FSTAB_PATH"

target="$TMP/foreign-file"
printf 'do-not-touch\n' > "$target"
ln -s "$target" "$CANVAS_SWAP_MANAGED_FILE"
config_json_write swap.enabled true
set +e
unsafe_json="$(cmd_swap_sync)"
unsafe_rc=$?
set -e
[[ "$unsafe_rc" -ne 0 ]]
jq -e '.active == false and .inSync == false and (.error | type == "string")' <<<"$unsafe_json" >/dev/null
[[ "$(cat "$target")" == "do-not-touch" ]]
rm -f "$CANVAS_SWAP_MANAGED_FILE" "$target"
ln -s "$TMP/missing-target" "$CANVAS_SWAP_MANAGED_FILE"
config_json_write swap.enabled false
set +e
broken_symlink_json="$(cmd_swap_sync)"
broken_symlink_rc=$?
set -e
[[ "$broken_symlink_rc" -ne 0 ]]
jq -e '.enabled == false and .inSync == false and (.error | type == "string")' <<<"$broken_symlink_json" >/dev/null
[[ -L "$CANVAS_SWAP_MANAGED_FILE" ]]
rm -f "$CANVAS_SWAP_MANAGED_FILE"

printf '60\n' > "$CANVAS_SWAP_RUNTIME_SWAPPINESS_PATH"
disabled_default_swappiness_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .swappiness == 60 and .configuredSwappiness == 10 and .inSync == true and .error == null' <<<"$disabled_default_swappiness_json" >/dev/null

cp "$CANVAS_CONFIG_JSON" "$TMP/config-before-atomic-failure"
export CANVAS_TEST_FAIL_MV_TARGET="$CANVAS_CONFIG_JSON"
set +e
atomic_failure_json="$(cmd_swap_apply --enabled true --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10)"
atomic_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_MV_TARGET
[[ "$atomic_failure_rc" -ne 0 ]]
cmp -s "$TMP/config-before-atomic-failure" "$CANVAS_CONFIG_JSON"
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
jq -e '.active == false and .inSync == false and (.error | type == "string")' <<<"$atomic_failure_json" >/dev/null

"$ROOT/install/bin/canvas-notebook" swap-apply --enabled true --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10 --json > "$TMP/concurrent-enable.json" &
enable_pid=$!
"$ROOT/install/bin/canvas-notebook" swap-apply --enabled false --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10 --json > "$TMP/concurrent-disable.json" &
disable_pid=$!
set +e
wait "$enable_pid"
enable_rc=$?
wait "$disable_pid"
disable_rc=$?
set -e
if [[ "$enable_rc" -ne 0 || "$disable_rc" -ne 0 ]]; then
  cat "$TMP/concurrent-enable.json" >&2
  cat "$TMP/concurrent-disable.json" >&2
  exit 1
fi
jq -e '.enabled == true and .active == true and .inSync == true and .error == null' "$TMP/concurrent-enable.json" >/dev/null
jq -e '.enabled == false and .active == false and .inSync == true and .error == null' "$TMP/concurrent-disable.json" >/dev/null
final_json="$(cmd_swap)"
jq -e '
  .inSync == true and
  .error == null and
  ((.enabled == true and .active == true and .actualSizeBytes == 134217728) or
   (.enabled == false and .active == false and .actualSizeBytes == null))
' <<<"$final_json" >/dev/null
final_enabled="$(jq -r '.enabled' <<<"$final_json")"
[[ "$(jq -r '.swap.enabled' "$CANVAS_CONFIG_JSON")" == "$final_enabled" ]]

cmd_swap_apply --enabled true --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10 >/dev/null
export CANVAS_TEST_FAIL_MV_TARGET="$CANVAS_CONFIG_JSON"
set +e
secure_config_failure_json="$(cmd_swap_disable --secure)"
secure_config_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_MV_TARGET
[[ "$secure_config_failure_rc" -ne 0 ]]
[[ "$(jq -r '.swap.enabled' "$CANVAS_CONFIG_JSON")" == "true" ]]
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "secure" ]]
jq -e '.enabled == true and .active == true and .inSync == false and (.error | type == "string")' <<<"$secure_config_failure_json" >/dev/null
secure_pending_status_json="$(cmd_swap)"
jq -e '.enabled == true and .active == true and .inSync == false and .error == "Canvas swap secure cleanup is pending"' <<<"$secure_pending_status_json" >/dev/null
rm -f "$CANVAS_TEST_SHRED_MARKER"
secure_reactivated_json="$(cmd_swap_sync)"
jq -e '.enabled == true and .active == true and .inSync == true and .error == null' <<<"$secure_reactivated_json" >/dev/null
[[ "$(cat "$CANVAS_TEST_SHRED_MARKER")" == "wiped" ]]
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "normal" ]]

export CANVAS_SWAP_TEST_FAIL_AFTER_PERSIST=true
set +e
secure_persist_failure_json="$(cmd_swap_disable --secure)"
secure_persist_failure_rc=$?
set -e
unset CANVAS_SWAP_TEST_FAIL_AFTER_PERSIST
[[ "$secure_persist_failure_rc" -ne 0 ]]
jq -e '.enabled == false and .active == true and .inSync == false and (.error | type == "string")' <<<"$secure_persist_failure_json" >/dev/null
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "secure" ]]
rm -f "$CANVAS_TEST_SHRED_MARKER"
secure_persist_recovered_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .inSync == true and .error == null' <<<"$secure_persist_recovered_json" >/dev/null
[[ "$(cat "$CANVAS_TEST_SHRED_MARKER")" == "wiped" ]]

cmd_swap_apply --enabled true --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10 >/dev/null
export CANVAS_TEST_FAIL_SHRED=true
set +e
secure_failure_json="$(cmd_swap_disable --secure)"
secure_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_SHRED
[[ "$secure_failure_rc" -ne 0 ]]
jq -e '.enabled == false and .inSync == false and (.error | type == "string")' <<<"$secure_failure_json" >/dev/null
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "secure" ]]
[[ -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-disabled" ]]
rm -f "$CANVAS_TEST_SHRED_MARKER"
secure_disabled_json="$(cmd_swap_sync)"
jq -e '.enabled == false and .active == false and .actualSizeBytes == null and .inSync == true and .error == null' <<<"$secure_disabled_json" >/dev/null
[[ "$(cat "$CANVAS_TEST_SHRED_MARKER")" == "wiped" ]]
[[ ! -e "$CANVAS_SWAP_MANAGED_FILE" ]]
[[ ! -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-disabled" ]]
[[ ! -e "$CANVAS_SWAP_STATE_PATH" ]]

cmd_swap_apply --enabled true --size 128M --file "$CANVAS_SWAP_MANAGED_FILE" --swappiness 10 >/dev/null
export CANVAS_TEST_FAIL_SHRED=true
set +e
cmd_swap_disable --secure >/dev/null
secure_reenable_failure_rc=$?
set -e
unset CANVAS_TEST_FAIL_SHRED
[[ "$secure_reenable_failure_rc" -ne 0 ]]
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "secure" ]]
rm -f "$CANVAS_TEST_SHRED_MARKER"
config_json_write swap.enabled true
secure_reenabled_json="$(cmd_swap_sync)"
jq -e '.enabled == true and .active == true and .actualSizeBytes == 134217728 and .inSync == true and .error == null' <<<"$secure_reenabled_json" >/dev/null
[[ "$(cat "$CANVAS_TEST_SHRED_MARKER")" == "wiped" ]]
[[ ! -e "${CANVAS_SWAP_MANAGED_FILE}.canvas-disabled" ]]
[[ "$(awk '{ print $2 }' "$CANVAS_SWAP_STATE_PATH")" == "normal" ]]
cmd_swap_disable --secure >/dev/null

printf 'cli-swap-command-test: ok\n'
