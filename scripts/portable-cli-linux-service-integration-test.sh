#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist-cli/main.js"
[[ "$(uname -s)" == "Linux" && -f "$CLI" ]] || {
  printf 'Linux and a built portable CLI are required\n' >&2
  exit 2
}
command -v systemd-analyze >/dev/null 2>&1 || {
  printf 'systemd-analyze is required\n' >&2
  exit 2
}

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
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
export HOME="$TEST_ROOT/home"
export PATH="$TEST_ROOT/bin:$PATH"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CANVAS_CLI_PATH"
chmod 755 "$CANVAS_CLI_PATH"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' '[[ "${1:-}" == "is-active" ]] && { printf "inactive\\n"; exit 3; }' 'exit 0' > "$TEST_ROOT/bin/systemctl"
chmod 755 "$TEST_ROOT/bin/systemctl"

node "$CLI" service install --no-banner | grep -q 'installed and enabled'
SERVICE_FILE="$TEST_ROOT/systemd/canvas-notebook.service"
grep -q '^# Managed by Canvas Notebook$' "$SERVICE_FILE"
grep -Fq "WorkingDirectory=$CANVAS_INSTALL_DIR" "$SERVICE_FILE"
grep -Fq "ExecStart=\"$CANVAS_CLI_PATH\" start --no-banner" "$SERVICE_FILE"
printf '%s\n' '[Service]' 'Type=oneshot' 'ExecStart=/bin/true' > "$TEST_ROOT/systemd/docker.service"
systemd-analyze verify "$SERVICE_FILE" "$TEST_ROOT/systemd/docker.service" >/dev/null
rm "$TEST_ROOT/systemd/docker.service"
node "$CLI" service uninstall --no-banner | grep -q 'removed'
[[ ! -e "$SERVICE_FILE" ]]

printf 'portable-cli-linux-service-integration-test: ok\n'
