#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/install/lib" "$TMP_DIR/logs"
cp -R "$ROOT_DIR/install/bin" "$TMP_DIR/install/"
cp -R "$ROOT_DIR/install/lib/shared" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install/lib/commands" "$TMP_DIR/install/lib/"

cat > "$TMP_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  info)
    exit 0
    ;;
  compose)
    shift
    printf 'compose %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"ps -q canvas-notebook"* ]]; then
      printf 'fake-container-id\n'
    fi
    exit 0
    ;;
  exec)
    shift
    printf 'exec %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
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
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

"$cli" database --no-banner > "$TMP_DIR/help.txt"
grep -q 'migrate-sqlite-to-postgres' "$TMP_DIR/help.txt"

"$cli" database migrate-sqlite-to-postgres --sqlite-path /data/backups/snapshot.sqlite --verbose --no-banner
grep -q 'exec fake-container-id npx tsx --conditions react-server scripts/migrate-sqlite-to-postgres.ts --sqlite-path /data/backups/snapshot.sqlite --verbose' "$CANVAS_TEST_DOCKER_LOG"

: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database migrate-sqlite-to-postgres --json --no-banner > /dev/null
grep -q 'exec fake-container-id npx tsx --conditions react-server scripts/migrate-sqlite-to-postgres.ts --json' "$CANVAS_TEST_DOCKER_LOG"

echo "cli database command tests passed"
