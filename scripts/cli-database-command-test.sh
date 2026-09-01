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
    if [[ "$*" == *"up -d --no-recreate postgres"* ]]; then
      grep -Eq '^CANVAS_POSTGRES_PASSWORD=.{8,}$' "${CANVAS_COMPOSE_ENV:?}"
      grep -Eq '^DATABASE_URL=postgres(ql)?://' "${CANVAS_CONFIG_ENV:?}"
      : > "${CANVAS_TEST_POSTGRES_STATE:?}"
    fi
    if [[ "$*" == *"ps -q canvas-notebook"* ]]; then
      printf 'fake-container-id\n'
    elif [[ "$*" == *"ps -q postgres"* && -f "${CANVAS_TEST_POSTGRES_STATE:?}" ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.Id}}"* && -f "${CANVAS_TEST_POSTGRES_STATE:?}" ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  volume)
    shift
    printf 'volume %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    [[ -f "${CANVAS_TEST_POSTGRES_STATE:?}" ]]
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

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$TMP_DIR/bin/curl"

export PATH="$TMP_DIR/bin:$PATH"
export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_TEST_POSTGRES_STATE="$TMP_DIR/postgres.initialized"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

"$cli" database --no-banner > "$TMP_DIR/help.txt"
grep -q 'migrate-sqlite-to-postgres' "$TMP_DIR/help.txt"

"$cli" database migrate-sqlite-to-postgres --sqlite-path /data/backups/snapshot.sqlite --verbose --no-banner
grep -q -- 'compose -f .* --profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'exec -i fake-postgres-id sh -c' "$CANVAS_TEST_DOCKER_LOG"
if grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "generic database prepare rotated the Postgres role outside reconciliation" >&2
  exit 1
fi
grep -q 'exec fake-container-id npx tsx --conditions react-server scripts/migrate-sqlite-to-postgres.ts --sqlite-path /data/backups/snapshot.sqlite --verbose' "$CANVAS_TEST_DOCKER_LOG"
if grep -Eq 'postgresql://canvas:[^*[:space:]]+@postgres|CANVAS_POSTGRES_PASSWORD' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "database migrate prepare leaked a password-bearing value into docker argv logs" >&2
  exit 1
fi

: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database migrate-sqlite-to-postgres --json --no-banner > /dev/null
grep -q 'exec fake-container-id npx tsx --conditions react-server scripts/migrate-sqlite-to-postgres.ts --json' "$CANVAS_TEST_DOCKER_LOG"

fresh_password='fresh-postgres-password'
printf '%s' "$fresh_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '' | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
for env_file in "$CANVAS_CONFIG_ENV" "$CANVAS_COMPOSE_ENV"; do
  sed -i.bak -e '/^CANVAS_POSTGRES_PASSWORD=/d' -e '/^DATABASE_URL=/d' "$env_file"
  rm -f "${env_file}.bak"
done
rm -f "$CANVAS_TEST_POSTGRES_STATE"
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database prepare-postgres --timeout 5 --json --no-banner > "$TMP_DIR/prepare-fresh.json"
jq -e '.success == true' "$TMP_DIR/prepare-fresh.json" >/dev/null
grep -q 'volume inspect canvas-postgres-data' "$CANVAS_TEST_DOCKER_LOG"
if grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "fresh Postgres preparation unexpectedly attempted role reconciliation" >&2
  exit 1
fi
grep -q '^CANVAS_POSTGRES_PASSWORD=fresh-postgres-password$' "$CANVAS_COMPOSE_ENV"
test ! -e "$CANVAS_INSTALL_DIR/.postgres-auth-reconcile.json"
test ! -e "$CANVAS_INSTALL_DIR/.postgres-auth-reconcile-state"

prepare_password='prepare-reconcile-password'
printf '%s' "$prepare_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "postgresql://canvas:${prepare_password}@postgres:5432/canvas_notebook" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database prepare-postgres --timeout 5 --json --no-banner > "$TMP_DIR/prepare-existing.json"
jq -e '.success == true' "$TMP_DIR/prepare-existing.json" >/dev/null
grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_DOCKER_LOG"
grep -q '^CANVAS_POSTGRES_PASSWORD=prepare-reconcile-password$' "$CANVAS_COMPOSE_ENV"
test ! -e "$CANVAS_INSTALL_DIR/.postgres-auth-reconcile.json"
test ! -e "$CANVAS_INSTALL_DIR/.postgres-auth-reconcile-state"

echo "cli database command tests passed"
