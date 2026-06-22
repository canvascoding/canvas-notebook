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
    printf '%s\n' "$*" >> "${CANVAS_TEST_COMPOSE_LOG:?}"
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
set -euo pipefail
exit 0
SH
chmod +x "$TMP_DIR/bin/curl"

export PATH="$TMP_DIR/bin:$PATH"
export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_COMPOSE_LOG="$TMP_DIR/compose.log"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

"$cli" env --sync --no-banner > "$TMP_DIR/env-default-sync.txt"
"$cli" env --no-banner > "$TMP_DIR/env-default.txt"
grep -q 'CANVAS_DATABASE_PROVIDER[[:space:]]*sqlite' "$TMP_DIR/env-default.txt"
grep -q '^COMPOSE_PROFILES=$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_DATABASE_PROVIDER=sqlite$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_POSTGRES_VECTOR_ENABLED=false$' "$CANVAS_CONFIG_ENV"

"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > "$TMP_DIR/config-set-provider.txt"
"$cli" env --sync --no-banner > "$TMP_DIR/env-sync-postgres.txt"
"$cli" env --no-banner > "$TMP_DIR/env-postgres.txt"
grep -q '^COMPOSE_PROFILES=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_DATABASE_PROVIDER=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_POSTGRES_VECTOR_ENABLED=true$' "$CANVAS_CONFIG_ENV"
grep -q '^CANVAS_POSTGRES_PASSWORD=' "$CANVAS_COMPOSE_ENV"
grep -q '^DATABASE_URL=postgresql://canvas:' "$CANVAS_CONFIG_ENV"
grep -q 'postgresql://\*\*\*' "$TMP_DIR/env-postgres.txt"
if grep -Eq 'DATABASE_URL[[:space:]]+postgresql://canvas:[^*]' "$TMP_DIR/env-postgres.txt"; then
  echo "DATABASE_URL was not masked in env output" >&2
  exit 1
fi

"$cli" config-show --json --no-banner > "$TMP_DIR/config-show.json"
grep -q '"DATABASE_URL": "postgresql://\*\*\*"' "$TMP_DIR/config-show.json"
grep -q '"CANVAS_POSTGRES_PASSWORD": ".*\*\*\*"' "$TMP_DIR/config-show.json"
if grep -Eq 'postgresql://canvas:[^*]' "$TMP_DIR/config-show.json"; then
  echo "DATABASE_URL was not masked in config-show output" >&2
  exit 1
fi
cp "$CANVAS_CONFIG_JSON" "$TMP_DIR/config-postgres.json"
jq 'del(.env.DATABASE_URL, .env.CANVAS_POSTGRES_PASSWORD)' \
  "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-legacy-missing-db-secrets.json"
cp "$TMP_DIR/config-legacy-missing-db-secrets.json" "$CANVAS_CONFIG_JSON"
"$cli" config-show --json --no-banner > "$TMP_DIR/config-show-legacy.json"
grep -q '"DATABASE_URL": "(not set)"' "$TMP_DIR/config-show-legacy.json"
grep -q '"CANVAS_POSTGRES_PASSWORD": "(not set)"' "$TMP_DIR/config-show-legacy.json"
cp "$TMP_DIR/config-postgres.json" "$CANVAS_CONFIG_JSON"

jq '.env.CANVAS_DATABASE_PROVIDER = "sqlite" | .env.CANVAS_DEPLOYMENT_MODE = "managed-team"' \
  "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-inconsistent.json"
cp "$TMP_DIR/config-inconsistent.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/team-sqlite.txt" 2>&1; then
  echo "managed-team accepted sqlite provider" >&2
  exit 1
fi
grep -q 'requires CANVAS_DATABASE_PROVIDER=postgres' "$TMP_DIR/team-sqlite.txt"

"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
"$cli" env --sync --no-banner > /dev/null
grep -q '^COMPOSE_PROFILES=postgres$' "$CANVAS_COMPOSE_ENV"
: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" restart --no-banner > "$TMP_DIR/restart-postgres.txt"
grep -q 'up -d --force-recreate' "$CANVAS_TEST_COMPOSE_LOG"

grep -q 'canvas-notebook-postgres' "$CANVAS_COMPOSE_FILE"
grep -q 'condition: service_healthy' "$CANVAS_COMPOSE_FILE"
grep -q 'required: false' "$CANVAS_COMPOSE_FILE"
grep -q 'profiles:' "$CANVAS_COMPOSE_FILE"
grep -q 'pgvector/pgvector:0.8.3-pg18' "$CANVAS_COMPOSE_FILE"
grep -q 'unused-sqlite-profile-disabled' "$CANVAS_COMPOSE_FILE"

jq '.env.DATABASE_URL = "" | .env.CANVAS_POSTGRES_PASSWORD = "bad/password+"' \
  "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-bad-password.json"
cp "$TMP_DIR/config-bad-password.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/bad-password.txt" 2>&1; then
  echo "unsafe generated DATABASE_URL password was accepted" >&2
  exit 1
fi
grep -q 'URL-reserved characters' "$TMP_DIR/bad-password.txt"
jq '.env.DATABASE_URL = "" | .env.CANVAS_POSTGRES_PASSWORD = "safe-password" | .env.CANVAS_POSTGRES_USER = "bad/user"' \
  "$TMP_DIR/config-postgres.json" > "$TMP_DIR/config-bad-user.json"
cp "$TMP_DIR/config-bad-user.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/bad-user.txt" 2>&1; then
  echo "unsafe generated DATABASE_URL user was accepted" >&2
  exit 1
fi
grep -q 'CANVAS_POSTGRES_USER contains URL-reserved characters' "$TMP_DIR/bad-user.txt"
jq '.env.DATABASE_URL = "" | .env.CANVAS_POSTGRES_PASSWORD = "safe-password" | .env.CANVAS_POSTGRES_DB = "bad/db"' \
  "$TMP_DIR/config-postgres.json" > "$TMP_DIR/config-bad-db.json"
cp "$TMP_DIR/config-bad-db.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/bad-db.txt" 2>&1; then
  echo "unsafe generated DATABASE_URL database name was accepted" >&2
  exit 1
fi
grep -q 'CANVAS_POSTGRES_DB contains URL-reserved characters' "$TMP_DIR/bad-db.txt"

echo "cli database provider tests passed"
