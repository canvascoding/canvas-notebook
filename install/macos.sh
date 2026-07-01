#!/usr/bin/env bash
# Local macOS installer for the portable Canvas Notebook server CLI.
# Run from a repository checkout. Release packaging can reuse this flow with a
# prebuilt dist-cli artifact.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
BIN_DIR="${CANVAS_CLI_BIN_DIR:-${HOME}/.local/bin}"
BIN_PATH="${BIN_DIR}/canvas-notebook"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required. Install it and re-run this installer." >&2
    exit 1
  fi
}

wait_for_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if [[ -d "/Applications/Docker.app" ]]; then
    echo "Starting Docker Desktop..."
    open -a Docker >/dev/null 2>&1 || true
  fi

  local attempt=0
  while [[ "$attempt" -lt "${CANVAS_DOCKER_WAIT_ATTEMPTS:-90}" ]]; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  echo "Docker Desktop is not reachable. Start Docker Desktop and re-run this installer." >&2
  exit 1
}

require_command node
require_command docker

wait_for_docker

cd "$ROOT_DIR"
if [[ ! -f "${ROOT_DIR}/dist-cli/main.js" ]]; then
  require_command npm
  npm run cli:build
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_PATH" <<EOF
#!/usr/bin/env sh
exec node "${ROOT_DIR}/dist-cli/main.js" "\$@"
EOF
chmod +x "$BIN_PATH"

echo "Installed CLI wrapper: ${BIN_PATH}"
echo "If needed, add this to PATH: export PATH=\"${BIN_DIR}:\$PATH\""

export CANVAS_CLI_PATH="$BIN_PATH"
node "${ROOT_DIR}/dist-cli/main.js" install

if [[ "${CANVAS_INSTALL_SERVICE:-true}" != "false" ]]; then
  node "${ROOT_DIR}/dist-cli/main.js" service install
fi

echo
echo "Canvas Notebook is available at http://localhost:3456"
