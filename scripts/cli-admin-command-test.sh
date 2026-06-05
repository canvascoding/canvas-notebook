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
LOG_FILE="${CANVAS_TEST_DOCKER_LOG:?}"

case "${1:-}" in
  info)
    exit 0
    ;;
  compose)
    shift
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        -f|--project-directory)
          shift 2
          ;;
        ps)
          shift
          if [[ "${1:-}" == "-q" ]]; then
            printf 'mock-container-id\n'
            exit 0
          fi
          ;;
        *)
          shift
          ;;
      esac
    done
    exit 0
    ;;
  exec)
    shift
    printf '%s\n' "$*" > "$LOG_FILE"
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        -i)
          shift
          ;;
        mock-container-id)
          shift
          break
          ;;
        *)
          shift
          ;;
      esac
    done
    if [[ "${1:-}" != "node" || "${2:-}" != "scripts/bootstrap-admin.js" ]]; then
      echo "unexpected exec command: $*" >&2
      exit 1
    fi
    if [[ "${3:-}" != "--email" || "${4:-}" != "test@example.com" ]]; then
      echo "missing bootstrap email args: $*" >&2
      exit 1
    fi
    if [[ "${5:-}" != "--name" || "${6:-}" != "Test Admin" ]]; then
      echo "missing bootstrap name args: $*" >&2
      exit 1
    fi
    if [[ "${7:-}" != "--password-stdin" ]]; then
      echo "missing bootstrap stdin arg: $*" >&2
      exit 1
    fi
    cat > "${CANVAS_TEST_DOCKER_STDIN:?}"
    echo "[bootstrap-admin] Synced bootstrap admin user: test@example.com"
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
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker-exec.log"
export CANVAS_TEST_DOCKER_STDIN="$TMP_DIR/docker-stdin.log"
export CANVAS_USE_COLOR=false

output="$(printf '%s\n' 'RecoveryPassword123!' | "$TMP_DIR/install/bin/canvas-notebook" admin reset-password --email test@example.com --name 'Test Admin' --password-stdin --json --no-banner)"

printf '%s' "$output" | grep -q '"success":true'
printf '%s' "$output" | grep -q '"email":"test@example.com"'

grep -q -- '-i mock-container-id node scripts/bootstrap-admin.js' "$CANVAS_TEST_DOCKER_LOG"
grep -q -- '--email test@example.com' "$CANVAS_TEST_DOCKER_LOG"
grep -q -- '--name Test Admin' "$CANVAS_TEST_DOCKER_LOG"
grep -q -- '--password-stdin' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'node scripts/bootstrap-admin.js' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'RecoveryPassword123!' "$CANVAS_TEST_DOCKER_STDIN"

if grep -q 'BOOTSTRAP_ADMIN_' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "bootstrap env vars were passed to docker exec" >&2
  exit 1
fi

if grep -q 'RecoveryPassword123!' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "password was written to docker exec args" >&2
  exit 1
fi

if grep -q 'RecoveryPassword123!' "$CANVAS_CONFIG_JSON" 2>/dev/null; then
  echo "password was written to config.json" >&2
  exit 1
fi

if grep -q 'RecoveryPassword123!' "$CANVAS_MANAGER_LOG_DIR/manager.log" 2>/dev/null; then
  echo "password was written to manager log" >&2
  exit 1
fi

echo "cli admin command tests passed"
