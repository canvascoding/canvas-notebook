#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/install/lib" "$TMP_DIR/logs" "$TMP_DIR/data"
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
    if [[ "$*" == *"scripts/create-full-backup.ts"* ]]; then
      if [[ "$*" == *"--latest"* ]]; then
        mkdir -p "${CANVAS_DATA_DIR:?}/system/backups/latest"
        printf 'latest backup\n' > "${CANVAS_DATA_DIR}/system/backups/latest/canvas-notebook-backup-latest.zip"
      fi
      printf '{"success":true,"job":{"id":"backup-job","status":"completed"},"latest":{"backupId":"backup-job","fileName":"canvas-notebook-backup-latest.zip","archiveSha256":"sha","size":14},"prunedBackupIds":["old-job"]}\n'
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
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
export CANVAS_DATA_DIR="$TMP_DIR/data"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

"$cli" backup --no-banner > "$TMP_DIR/help.txt"
grep -q 'backup create' "$TMP_DIR/help.txt"

"$cli" backup create --output "$TMP_DIR/export.zip" --no-banner > "$TMP_DIR/stdout.txt"
grep -q -- 'exec fake-container-id npx tsx --conditions react-server scripts/create-full-backup.ts --latest --json' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'Full backup completed:' "$TMP_DIR/stdout.txt"
test -f "$TMP_DIR/export.zip"
grep -q 'latest backup' "$TMP_DIR/export.zip"

: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" backup create --json --no-banner > "$TMP_DIR/json.txt"
grep -q -- 'exec fake-container-id npx tsx --conditions react-server scripts/create-full-backup.ts --latest --json' "$CANVAS_TEST_DOCKER_LOG"
grep -q '"success":true' "$TMP_DIR/json.txt"

if "$cli" backup create --output "$TMP_DIR/export.zip" --no-wait --no-banner >/dev/null 2>"$TMP_DIR/error.txt"; then
  echo "backup create unexpectedly allowed --output with --no-wait" >&2
  exit 1
fi
grep -q -- '--output cannot be combined with --no-wait' "$TMP_DIR/error.txt"

echo "cli backup command tests passed"
