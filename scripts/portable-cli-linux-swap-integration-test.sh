#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist-cli/main.js"

[[ "$(uname -s)" == "Linux" ]] || {
  printf 'portable-cli-linux-swap-integration-test requires Linux\n' >&2
  exit 2
}
[[ "$(id -u)" == "0" ]] || {
  printf 'portable-cli-linux-swap-integration-test must run as root\n' >&2
  exit 2
}
[[ -f "$CLI" ]] || {
  printf 'Build the portable CLI first with npm run cli:build\n' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required for the Linux swap integration test\n' >&2
  exit 2
}

for path_to_check in \
  /swapfile \
  /swapfile.canvas-new \
  /swapfile.canvas-backup \
  /swapfile.canvas-disabled \
  /etc/sysctl.d/90-canvas-notebook-swap.conf \
  /etc/sysctl.d/90-canvas-notebook-swap.conf.canvas-disabled \
  /var/lib/canvas-notebook/swap.state; do
  if [[ -e "$path_to_check" || -L "$path_to_check" ]]; then
    printf 'Refusing to test because an existing Canvas swap path is occupied: %s\n' "$path_to_check" >&2
    exit 2
  fi
done
unset path_to_check

if awk '$1 == "/swapfile" && $3 == "swap" { found=1 } END { exit found ? 0 : 1 }' /etc/fstab; then
  printf 'Refusing to test because /etc/fstab already contains a /swapfile entry\n' >&2
  exit 2
fi

TEST_ROOT="$(mktemp -d)"
FSTAB_BEFORE="$TEST_ROOT/fstab.before"
SWAPS_BEFORE="$TEST_ROOT/swaps.before"
cp /etc/fstab "$FSTAB_BEFORE"
awk 'NR > 1 { print $1 }' /proc/swaps | sort -u > "$SWAPS_BEFORE"
SWAPPINESS_BEFORE="$(sysctl -n vm.swappiness)"

export CANVAS_INSTALL_DIR="$TEST_ROOT/install"
export CANVAS_DATA_DIR="$TEST_ROOT/data"
export CANVAS_CONFIG_JSON="$TEST_ROOT/install/canvas-notebook-config.json"
export CANVAS_COMPOSE_FILE="$TEST_ROOT/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_ENV="$TEST_ROOT/install/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TEST_ROOT/install/.env"
export CANVAS_MANAGER_LOG_FILE="$TEST_ROOT/manager.log"
export CANVAS_OPERATION_LOCK_PATH="$TEST_ROOT/operation.lock"
export CANVAS_SWAP_MANAGED_FILE=/swapfile

cleanup() {
  local cleanup_rc=0
  set +e
  if [[ -e /swapfile || -L /swapfile || -e /var/lib/canvas-notebook/swap.state ]]; then
    node "$CLI" swap-disable --secure --json --no-banner >/dev/null 2>&1 || cleanup_rc=1
  fi
  if ! cmp -s "$FSTAB_BEFORE" /etc/fstab; then
    printf 'Linux swap integration cleanup detected an unexpected /etc/fstab difference\n' >&2
    cleanup_rc=1
  fi
  if [[ "$(sysctl -n vm.swappiness 2>/dev/null)" != "$SWAPPINESS_BEFORE" ]]; then
    sysctl -w "vm.swappiness=$SWAPPINESS_BEFORE" >/dev/null 2>&1 || cleanup_rc=1
  fi
  rm -rf "$TEST_ROOT"
  return "$cleanup_rc"
}
trap cleanup EXIT

disabled_json="$(node "$CLI" swap --json --no-banner)"
jq -e '.enabled == false and .active == false and .persistent == false and .inSync == true and .error == null' \
  <<<"$disabled_json" >/dev/null

enabled_json="$(node "$CLI" swap-apply \
  --enabled true \
  --size 128M \
  --file /swapfile \
  --swappiness "$SWAPPINESS_BEFORE" \
  --json \
  --no-banner)"
jq -e '
  .enabled == true and
  .active == true and
  .persistent == true and
  .actualSizeBytes == 134217728 and
  .inSync == true and
  .error == null
' <<<"$enabled_json" >/dev/null

while IFS= read -r foreign_swap; do
  [[ -z "$foreign_swap" ]] && continue
  awk -v expected="$foreign_swap" 'NR > 1 && $1 == expected { found=1 } END { exit found ? 0 : 1 }' /proc/swaps || {
    printf 'Foreign swap disappeared during Canvas swap enable: %s\n' "$foreign_swap" >&2
    exit 1
  }
done < "$SWAPS_BEFORE"

disabled_json="$(node "$CLI" swap-disable --secure --json --no-banner)"
jq -e '.enabled == false and .active == false and .persistent == false and .actualSizeBytes == null and .inSync == true and .error == null' \
  <<<"$disabled_json" >/dev/null

[[ ! -e /swapfile && ! -L /swapfile ]]
[[ ! -e /var/lib/canvas-notebook/swap.state && ! -L /var/lib/canvas-notebook/swap.state ]]
cmp -s "$FSTAB_BEFORE" /etc/fstab
[[ "$(sysctl -n vm.swappiness)" == "$SWAPPINESS_BEFORE" ]]

while IFS= read -r foreign_swap; do
  [[ -z "$foreign_swap" ]] && continue
  awk -v expected="$foreign_swap" 'NR > 1 && $1 == expected { found=1 } END { exit found ? 0 : 1 }' /proc/swaps || {
    printf 'Foreign swap disappeared during Canvas swap disable: %s\n' "$foreign_swap" >&2
    exit 1
  }
done < "$SWAPS_BEFORE"

printf 'portable-cli-linux-swap-integration-test: ok\n'

