#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/install/lib" "$TMP_DIR/logs" "$TMP_DIR/latest/install/lib"
cp -R "$ROOT_DIR/install/bin" "$TMP_DIR/install/"
cp -R "$ROOT_DIR/install/lib/shared" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install/lib/commands" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install/bin" "$TMP_DIR/latest/install/"
cp -R "$ROOT_DIR/install/lib/shared" "$TMP_DIR/latest/install/lib/"
cp -R "$ROOT_DIR/install/lib/commands" "$TMP_DIR/latest/install/lib/"

sed -i.bak 's/^CANVAS_CLI_VERSION=.*/CANVAS_CLI_VERSION="2026.7.8.1"/' "$TMP_DIR/install/bin/canvas-notebook"
rm -f "$TMP_DIR/install/bin/canvas-notebook.bak"
printf '\n# old update command marker\n' >> "$TMP_DIR/install/lib/commands/update.sh"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -z "$out" ]]; then
  exit 0
fi
cat > "$out" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
cp "$CANVAS_TEST_LATEST_DIR/install/bin/canvas-notebook" "$CANVAS_CLI_PATH"
mkdir -p "$CANVAS_INSTALL_DIR/lib/shared" "$CANVAS_INSTALL_DIR/lib/commands"
cp "$CANVAS_TEST_LATEST_DIR/install/lib/shared/"*.sh "$CANVAS_INSTALL_DIR/lib/shared/"
cp "$CANVAS_TEST_LATEST_DIR/install/lib/commands/"*.sh "$CANVAS_INSTALL_DIR/lib/commands/"
INSTALLER
SH
chmod +x "$TMP_DIR/bin/curl"

cat > "$TMP_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  info)
    exit 0
    ;;
  buildx|manifest|image)
    exit 1
    ;;
  compose)
    shift
    printf '%s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"ps -q postgres"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.Id}}"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  exec)
    shift
    printf 'exec %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ ! -t 0 ]]; then
      cat >/dev/null || true
    fi
    exit 0
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$TMP_DIR/bin/docker"

export PATH="$TMP_DIR/bin:$PATH"
export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_CLI_PATH="$TMP_DIR/install/bin/canvas-notebook"
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_TEST_LATEST_DIR="$TMP_DIR/latest"
export CANVAS_USE_COLOR=false

"$CANVAS_CLI_PATH" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
"$CANVAS_CLI_PATH" env --sync --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"

"$CANVAS_CLI_PATH" update --no-banner > "$TMP_DIR/update.txt" 2>&1

grep -q 'Management CLI updated 2026.7.8.1 -> 2026.7.9.3' "$TMP_DIR/update.txt"
grep -q 'Restarting update with updated CLI' "$TMP_DIR/update.txt"
grep -q '^CANVAS_CLI_VERSION="2026.7.9.3"$' "$CANVAS_CLI_PATH"
grep -q -- '--profile postgres up -d postgres' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'up -d --force-recreate' "$CANVAS_TEST_DOCKER_LOG"

echo "cli update reexec test passed"
