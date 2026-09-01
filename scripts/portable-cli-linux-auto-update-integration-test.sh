#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist-cli/main.js"

[[ "$(uname -s)" == "Linux" ]] || {
  printf 'portable-cli-linux-auto-update-integration-test requires Linux\n' >&2
  exit 2
}
[[ -f "$CLI" ]] || {
  printf 'Build the portable CLI first with npm run cli:build\n' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 && command -v systemd-analyze >/dev/null 2>&1 || {
  printf 'jq and systemd-analyze are required for the Linux auto-update integration test\n' >&2
  exit 2
}

TEST_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/systemd" "$TEST_ROOT/install" "$TEST_ROOT/data" "$TEST_ROOT/home"
export CANVAS_INSTALL_DIR="$TEST_ROOT/install"
export CANVAS_DATA_DIR="$TEST_ROOT/data"
export CANVAS_CONFIG_JSON="$TEST_ROOT/install/canvas-notebook-config.json"
export CANVAS_COMPOSE_FILE="$TEST_ROOT/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_ENV="$TEST_ROOT/install/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TEST_ROOT/install/.env"
export CANVAS_MANAGER_LOG_FILE="$TEST_ROOT/manager.log"
export CANVAS_OPERATION_LOCK_PATH="$TEST_ROOT/operation.lock"
export CANVAS_SYSTEMD_TEST_ROOT="$TEST_ROOT/systemd"
export CANVAS_CLI_PATH="$TEST_ROOT/bin/canvas-notebook"
export CANVAS_TEST_SYSTEMD_STATE="$TEST_ROOT/systemd.state"
export HOME="$TEST_ROOT/home"
export PATH="$TEST_ROOT/bin:$PATH"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CANVAS_CLI_PATH"
chmod 755 "$CANVAS_CLI_PATH"
printf 'inactive\n' > "$CANVAS_TEST_SYSTEMD_STATE"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'command_name="${1:-}"' \
  'unit="${2:-}"' \
  'state="$(cat "$CANVAS_TEST_SYSTEMD_STATE")"' \
  'case "$command_name" in' \
  '  --version) printf "systemd 999\\n" ;;' \
  '  is-active) printf "%s\\n" "$state"; [[ "$state" == "active" ]] ;;' \
  '  show) printf "Sat 2026-08-29 04:00:00 CEST\\n" ;;' \
  '  start|restart) printf "active\\n" > "$CANVAS_TEST_SYSTEMD_STATE" ;;' \
  '  stop) [[ "$unit" == *.timer ]] && printf "inactive\\n" > "$CANVAS_TEST_SYSTEMD_STATE" ;;' \
  '  enable|disable|reset-failed|daemon-reload) ;;' \
  '  *) printf "unexpected systemctl command: %s\\n" "$*" >&2; exit 1 ;;' \
  'esac' \
  > "$TEST_ROOT/bin/systemctl"
chmod 755 "$TEST_ROOT/bin/systemctl"

PINNED_IMAGE="ghcr.io/canvascoding/canvas-notebook@sha256:$(printf 'a%.0s' {1..64})"
node "$CLI" config-set image "$PINNED_IMAGE" --no-banner >/dev/null

enabled_json="$(node "$CLI" auto-update-enable --schedule '*-*-* 05:15:00' --json --no-banner)"
jq -e '
  .success == true and
  .configuredEnabled == true and
  .configuredSchedule == "*-*-* 05:15:00" and
  .timerUnitInstalled == true and
  .serviceUnitInstalled == true and
  .timerActive == true and
  .inSync == true and
  .error == null
' <<<"$enabled_json" >/dev/null
jq -e '.autoUpdate.enabled == true and .autoUpdate.schedule == "*-*-* 05:15:00"' "$CANVAS_CONFIG_JSON" >/dev/null
grep -q '^OnCalendar=\*-\*-\* 05:15:00$' "$TEST_ROOT/systemd/canvas-notebook-update.timer"
grep -Fq "ExecStart=\"$CANVAS_CLI_PATH\" update --require-pinned --no-banner" "$TEST_ROOT/systemd/canvas-notebook-update.service"
systemd-analyze verify \
  "$TEST_ROOT/systemd/canvas-notebook-update.timer" \
  "$TEST_ROOT/systemd/canvas-notebook-update.service" >/dev/null

node "$CLI" config-set env.CANVAS_MANAGED_SERVICES_ENABLED true --no-banner >/dev/null
sync_json="$(node "$CLI" auto-update-sync --json --no-banner)"
jq -e '.success == true and .effectiveEnabled == false and .managedByControlPlane == true and .timerActive == false and .inSync == true' <<<"$sync_json" >/dev/null
jq -e '.autoUpdate.enabled == false' "$CANVAS_CONFIG_JSON" >/dev/null

if node "$CLI" auto-update-enable --json --no-banner > "$TEST_ROOT/managed-refusal.json"; then
  printf 'Managed auto-update enable unexpectedly succeeded\n' >&2
  exit 1
fi
jq -e '.error | contains("Control Plane handles updates")' "$TEST_ROOT/managed-refusal.json" >/dev/null
jq -e '.autoUpdate.enabled == false' "$CANVAS_CONFIG_JSON" >/dev/null

printf 'portable-cli-linux-auto-update-integration-test: ok\n'
