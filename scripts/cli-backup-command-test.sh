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

# Exercise the retained backup path for an existing SQLite installation.
"$cli" config-set env.CANVAS_DATABASE_PROVIDER sqlite --no-banner > /dev/null

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
jq -se 'length == 1 and .[0].success == true and .[0].job.id == "backup-job"' "$TMP_DIR/json.txt" >/dev/null

test_postgres_backup_json_contract() (
  OUTPUT_JSON=true
  CONFIG_ENV_PATH="$CANVAS_CONFIG_ENV"
  COMPOSE_ENV_PATH="$CANVAS_COMPOSE_ENV"
  DATA_DIR="$CANVAS_DATA_DIR"
  . "$TMP_DIR/install/lib/commands/database.sh"
  . "$TMP_DIR/install/lib/commands/backup.sh"

  postgres_runtime_desired() { return 0; }
  _database_reconcile_postgres_auth() {
    printf '{"success":true,"databaseProvider":"postgres","healthy":true}\n'
  }
  log_msg() { return 0; }
  migrate_compose_file() { return 0; }
  config_json_to_env() { return 0; }
  postgres_prepare_managed_runtime() { return 0; }
  container_id() { printf 'fake-container-id\n'; }
  config_json_read() { return 1; }
  docker_cmd() {
    printf '{"success":true,"job":{"id":"backup-job","status":"completed"},"latest":{"backupId":"backup-job","fileName":"canvas-notebook-backup-latest.zip","archiveSha256":"sha","size":14}}\n'
  }

  : > "$CANVAS_CONFIG_ENV"
  : > "$CANVAS_COMPOSE_ENV"
  _backup_create
)

test_postgres_backup_json_contract > "$TMP_DIR/postgres-json.txt"
jq -se 'length == 1 and .[0].success == true and .[0].job.id == "backup-job"' "$TMP_DIR/postgres-json.txt" >/dev/null

test_postgres_reconcile_error_contract() (
  OUTPUT_JSON=true
  CONFIG_ENV_PATH="$CANVAS_CONFIG_ENV"
  COMPOSE_ENV_PATH="$CANVAS_COMPOSE_ENV"
  DATA_DIR="$CANVAS_DATA_DIR"
  . "$TMP_DIR/install/lib/commands/database.sh"
  . "$TMP_DIR/install/lib/commands/backup.sh"

  postgres_runtime_desired() { return 0; }
  _database_reconcile_postgres_auth() {
    printf '{"success":false,"phase":"verify","error":"Postgres verification failed","rolledBack":true}\n'
    return 1
  }
  log_msg() { return 0; }

  : > "$CANVAS_CONFIG_ENV"
  : > "$CANVAS_COMPOSE_ENV"
  _backup_create
)

if test_postgres_reconcile_error_contract > "$TMP_DIR/postgres-error.json"; then
  echo "backup unexpectedly continued after Postgres reconciliation failed" >&2
  exit 1
fi
jq -se 'length == 1 and .[0].success == false and .[0].phase == "verify" and .[0].rolledBack == true' "$TMP_DIR/postgres-error.json" >/dev/null

if "$cli" backup create --output "$TMP_DIR/export.zip" --no-wait --no-banner >/dev/null 2>"$TMP_DIR/error.txt"; then
  echo "backup create unexpectedly allowed --output with --no-wait" >&2
  exit 1
fi
grep -q -- '--output cannot be combined with --no-wait' "$TMP_DIR/error.txt"

echo "cli backup command tests passed"
