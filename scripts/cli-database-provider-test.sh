#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ "${CANVAS_TEST_PRESERVE_TMP:-false}" == "true" ]]; then
    printf 'preserved test state: %s\n' "$TMP_DIR" >&2
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

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
    if [[ "$*" == *"ps -q postgres"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "${CANVAS_TEST_COMPOSE_LOG:?}"
    if [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.Id}}"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  exec)
    shift
    printf 'exec %s\n' "$*" >> "${CANVAS_TEST_COMPOSE_LOG:?}"
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
set -euo pipefail
if [[ "${CANVAS_TEST_CURL_FAIL:-false}" == "true" ]]; then
  exit 1
fi
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
export CANVAS_TEST_COMPOSE_LOG="$TMP_DIR/compose.log"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

stdin_secret='stdin-secret-value-123'
dynamic_token='dynamic-instance-token-456'
lowercase_api_key='lowercase-api-key-789'
complex_api_key='value"with\backslash'
custom_secret_key='custom-secret-key-321'
printf '%s' "$stdin_secret" | "$cli" config-set env.CANVAS_INTERNAL_API_KEY --stdin --no-banner > "$TMP_DIR/config-set-stdin.txt"
printf '%s' "$dynamic_token" | "$cli" config-set env.CANVAS_INSTANCE_TOKEN --stdin --no-banner > "$TMP_DIR/config-set-token-stdin.txt"
printf '%s' "$lowercase_api_key" | "$cli" config-set env.openai_api_key --stdin --no-banner > "$TMP_DIR/config-set-lowercase-key-stdin.txt"
printf '%s' "$complex_api_key" | "$cli" config-set env.CUSTOM_API_KEY --stdin --no-banner > "$TMP_DIR/config-set-complex-key-stdin.txt"
printf '%s' "$custom_secret_key" | "$cli" config-set env.CUSTOM_SECRET_KEY --stdin --no-banner > "$TMP_DIR/config-set-secret-key-stdin.txt"
jq -e --arg secret "$stdin_secret" '.env.CANVAS_INTERNAL_API_KEY == $secret' "$CANVAS_CONFIG_JSON" >/dev/null
jq -e --arg token "$dynamic_token" '.env.CANVAS_INSTANCE_TOKEN == $token' "$CANVAS_CONFIG_JSON" >/dev/null
jq -e --arg secret "$lowercase_api_key" '.env.openai_api_key == $secret' "$CANVAS_CONFIG_JSON" >/dev/null
jq -e --arg secret "$complex_api_key" '.env.CUSTOM_API_KEY == $secret' "$CANVAS_CONFIG_JSON" >/dev/null
jq -e --arg secret "$custom_secret_key" '.env.CUSTOM_SECRET_KEY == $secret' "$CANVAS_CONFIG_JSON" >/dev/null
if grep -Fq "$complex_api_key" "$TMP_DIR/config-set-complex-key-stdin.txt"; then
  echo "config-set echoed a quoted secret" >&2
  exit 1
fi
if grep -Fq "$stdin_secret" "$TMP_DIR/config-set-stdin.txt"; then
  echo "config-set --stdin echoed the secret" >&2
  exit 1
fi
if grep -Fq "$custom_secret_key" "$TMP_DIR/config-set-secret-key-stdin.txt"; then
  echo "config-set --stdin echoed a SECRET_KEY value" >&2
  exit 1
fi
grep -q 'Set env.CANVAS_INTERNAL_API_KEY from stdin' "$TMP_DIR/config-set-stdin.txt"
if printf '%s' 'secret' | "$cli" config-set env.CANVAS_INTERNAL_API_KEY --stdin positional --no-banner > "$TMP_DIR/config-set-stdin-extra.txt" 2>&1; then
  echo "config-set accepted --stdin with a positional value" >&2
  exit 1
fi
grep -q -- '--stdin is mutually exclusive' "$TMP_DIR/config-set-stdin-extra.txt"
if printf 'line-one\nline-two' | "$cli" config-set env.CANVAS_INTERNAL_API_KEY --stdin --no-banner > "$TMP_DIR/config-set-stdin-multiline.txt" 2>&1; then
  echo "config-set --stdin accepted a multiline value" >&2
  exit 1
fi
grep -q 'accepts a single-line value' "$TMP_DIR/config-set-stdin-multiline.txt"
if "$cli" config-set env.CANVAS_INSTANCE_TOKEN positional-secret-value --no-banner > "$TMP_DIR/config-set-sensitive-positional.txt" 2>&1; then
  echo "config-set accepted a sensitive positional value" >&2
  exit 1
fi
grep -q 'Sensitive config values require --stdin' "$TMP_DIR/config-set-sensitive-positional.txt"
if grep -q 'positional-secret-value' "$TMP_DIR/config-set-sensitive-positional.txt"; then
  echo "config-set leaked a rejected positional secret" >&2
  exit 1
fi
if "$cli" config-set env.CUSTOM_SECRET_KEY positional-secret-key --no-banner > "$TMP_DIR/config-set-secret-key-positional.txt" 2>&1; then
  echo "config-set accepted a SECRET_KEY value positionally" >&2
  exit 1
fi
grep -q 'Sensitive config values require --stdin' "$TMP_DIR/config-set-secret-key-positional.txt"
if grep -q 'positional-secret-key' "$TMP_DIR/config-set-secret-key-positional.txt"; then
  echo "config-set leaked a rejected SECRET_KEY value" >&2
  exit 1
fi

# The remainder of this suite exercises the supported legacy SQLite lifecycle.
"$cli" config-set env.CANVAS_DATABASE_PROVIDER sqlite --no-banner > /dev/null

test ! -e "$CANVAS_CONFIG_ENV"
: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" env --render --json --no-banner > "$TMP_DIR/env-render-first.json"
jq -e '.success == true and .rendered == true and .restarted == false and .filesChanged == true' "$TMP_DIR/env-render-first.json" >/dev/null
test ! -s "$CANVAS_TEST_COMPOSE_LOG"
"$cli" env --render --json --no-banner > "$TMP_DIR/env-render-second.json"
jq -e '.success == true and .filesChanged == false' "$TMP_DIR/env-render-second.json" >/dev/null
grep -q '^LOG_LEVEL=info$' "$CANVAS_CONFIG_ENV"
"$cli" config-set env.LOG_LEVEL debug --no-banner > /dev/null
grep -q '^LOG_LEVEL=info$' "$CANVAS_CONFIG_ENV"
"$cli" env --render --json --no-banner > "$TMP_DIR/env-render-changed.json"
jq -e '.success == true and .filesChanged == true and .restarted == false' "$TMP_DIR/env-render-changed.json" >/dev/null
grep -q '^LOG_LEVEL=debug$' "$CANVAS_CONFIG_ENV"
: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" env --sync --timeout 2 --json --no-banner > "$TMP_DIR/env-default-sync.json"
jq -e '.success == true and .rendered == true and .postgresReconciled == false and .healthy == true and .timeoutSeconds == 2' "$TMP_DIR/env-default-sync.json" >/dev/null
grep -q 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_COMPOSE_LOG"
if grep -q -- '--force-recreate' "$CANVAS_TEST_COMPOSE_LOG"; then
  echo "env --sync force-recreated a service" >&2
  exit 1
fi
"$cli" env --no-banner > "$TMP_DIR/env-default.txt"
grep -q 'CANVAS_DATABASE_PROVIDER[[:space:]]*sqlite' "$TMP_DIR/env-default.txt"
"$cli" env --json --no-banner > "$TMP_DIR/env-default-json.txt"
if grep -Fq "$stdin_secret" "$TMP_DIR/env-default-json.txt"; then
  echo "env --json exposed an unredacted secret" >&2
  exit 1
fi
if grep -Fq "$dynamic_token" "$TMP_DIR/env-default-json.txt"; then
  echo "env --json exposed an unredacted token" >&2
  exit 1
fi
if grep -Fq "$lowercase_api_key" "$TMP_DIR/env-default-json.txt"; then
  echo "env --json exposed a lowercase API key" >&2
  exit 1
fi
if grep -Fq "$complex_api_key" "$TMP_DIR/env-default-json.txt"; then
  echo "env --json exposed a quoted API key" >&2
  exit 1
fi
if grep -Fq "$custom_secret_key" "$TMP_DIR/env-default-json.txt"; then
  echo "env --json exposed a SECRET_KEY value" >&2
  exit 1
fi
grep -q '^COMPOSE_PROFILES=$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_DATABASE_PROVIDER=sqlite$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_POSTGRES_VECTOR_ENABLED=false$' "$CANVAS_CONFIG_ENV"

"$cli" database status --json --no-banner > "$TMP_DIR/database-status-default.json"
grep -q '"databaseProvider":"sqlite"' "$TMP_DIR/database-status-default.json"
grep -q '"postgresProfileEnabled":false' "$TMP_DIR/database-status-default.json"

: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" database prepare-postgres --timeout 2 --json --no-banner > "$TMP_DIR/database-prepare-postgres.json"
grep -q '"success":true' "$TMP_DIR/database-prepare-postgres.json"
grep -q '"databaseProvider":"sqlite"' "$TMP_DIR/database-prepare-postgres.json"
grep -q '"databaseUrlConfigured":true' "$TMP_DIR/database-prepare-postgres.json"
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_COMPOSE_LOG"
if grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_COMPOSE_LOG"; then
  echo "prepare-postgres altered the initialized role outside the reconciliation journal" >&2
  exit 1
fi
grep -q 'exec -i fake-postgres-id sh -c' "$CANVAS_TEST_COMPOSE_LOG"
if grep -Eq 'postgresql://canvas:[^*[:space:]]+@postgres|CANVAS_POSTGRES_PASSWORD|safe-password' "$CANVAS_TEST_COMPOSE_LOG"; then
  echo "Postgres prepare leaked a password-bearing value into docker argv logs" >&2
  exit 1
fi
grep -q '^COMPOSE_PROFILES=$' "$CANVAS_COMPOSE_ENV"

"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > "$TMP_DIR/config-set-provider.txt"
: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" env --sync --timeout=10 --json --no-banner > "$TMP_DIR/env-sync-postgres.json"
jq -e '.success == true and .postgresReconciled == true and .healthy == true and .timeoutSeconds == 10' "$TMP_DIR/env-sync-postgres.json" >/dev/null
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_COMPOSE_LOG"
grep -q 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_COMPOSE_LOG"
if grep -q -- '--force-recreate' "$CANVAS_TEST_COMPOSE_LOG"; then
  echo "postgres env --sync force-recreated a service" >&2
  exit 1
fi
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
if jq -e 'has("secretState")' "$TMP_DIR/config-show.json" >/dev/null; then
  echo "default config-show exposed secret fingerprints" >&2
  exit 1
fi
if grep -Eq 'postgresql://canvas:[^*]' "$TMP_DIR/config-show.json"; then
  echo "DATABASE_URL was not masked in config-show output" >&2
  exit 1
fi
grep -q '"CANVAS_INSTANCE_TOKEN": "dyna\*\*\*"' "$TMP_DIR/config-show.json"
grep -q '"openai_api_key": "lowe\*\*\*"' "$TMP_DIR/config-show.json"
grep -q '"CUSTOM_API_KEY": "valu\*\*\*"' "$TMP_DIR/config-show.json"
grep -q '"CUSTOM_SECRET_KEY": "cust\*\*\*"' "$TMP_DIR/config-show.json"
if grep -Fq "$dynamic_token" "$TMP_DIR/config-show.json"; then
  echo "config-show exposed a dynamic token" >&2
  exit 1
fi
if grep -Fq "$lowercase_api_key" "$TMP_DIR/config-show.json"; then
  echo "config-show exposed a lowercase API key" >&2
  exit 1
fi
if grep -Fq "$complex_api_key" "$TMP_DIR/config-show.json"; then
  echo "config-show exposed a quoted API key" >&2
  exit 1
fi
if grep -Fq "$custom_secret_key" "$TMP_DIR/config-show.json"; then
  echo "config-show exposed a SECRET_KEY value" >&2
  exit 1
fi
"$cli" config-show --json --secret-state --no-banner > "$TMP_DIR/config-show-secret-state.json"
postgres_password="$(jq -r '.env.CANVAS_POSTGRES_PASSWORD' "$CANVAS_CONFIG_JSON")"
database_url="$(jq -r '.env.DATABASE_URL' "$CANVAS_CONFIG_JSON")"
test_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}
expected_password_sha="$(printf '%s' "$postgres_password" | test_sha256)"
expected_database_url_sha="$(printf '%s' "$database_url" | test_sha256)"
expected_internal_key_sha="$(printf '%s' "$stdin_secret" | test_sha256)"
expected_dynamic_token_sha="$(printf '%s' "$dynamic_token" | test_sha256)"
expected_lowercase_api_key_sha="$(printf '%s' "$lowercase_api_key" | test_sha256)"
expected_complex_api_key_sha="$(printf '%s' "$complex_api_key" | test_sha256)"
expected_custom_secret_key_sha="$(printf '%s' "$custom_secret_key" | test_sha256)"
jq -e --arg passwordSha "$expected_password_sha" --arg databaseUrlSha "$expected_database_url_sha" --arg internalKeySha "$expected_internal_key_sha" --arg dynamicTokenSha "$expected_dynamic_token_sha" --arg lowercaseApiKeySha "$expected_lowercase_api_key_sha" --arg complexApiKeySha "$expected_complex_api_key_sha" --arg customSecretKeySha "$expected_custom_secret_key_sha" '
  .secretState.CANVAS_POSTGRES_PASSWORD == {present: true, sha256: $passwordSha} and
  .secretState.DATABASE_URL == {present: true, sha256: $databaseUrlSha} and
  .secretState.BETTER_AUTH_SECRET == {present: false, sha256: null} and
  .secretState.CANVAS_INTERNAL_API_KEY == {present: true, sha256: $internalKeySha} and
  .secretState.CANVAS_INSTANCE_TOKEN == {present: true, sha256: $dynamicTokenSha} and
  .secretState.openai_api_key == {present: true, sha256: $lowercaseApiKeySha} and
  .secretState.CUSTOM_API_KEY == {present: true, sha256: $complexApiKeySha} and
  .secretState.CUSTOM_SECRET_KEY == {present: true, sha256: $customSecretKeySha}
' "$TMP_DIR/config-show-secret-state.json" >/dev/null
if grep -Fq "$postgres_password" "$TMP_DIR/config-show-secret-state.json" || grep -Fq "$database_url" "$TMP_DIR/config-show-secret-state.json"; then
  echo "secret-state output exposed an unredacted secret" >&2
  exit 1
fi
if "$cli" config-show --secret-state --no-banner > "$TMP_DIR/config-show-secret-state-invalid.txt" 2>&1; then
  echo "config-show accepted --secret-state without --json" >&2
  exit 1
fi
grep -q -- '--secret-state requires --json' "$TMP_DIR/config-show-secret-state-invalid.txt"
if "$cli" env --sync --timeout 0 --json --no-banner > "$TMP_DIR/env-invalid-timeout.json" 2>&1; then
  echo "env --sync accepted an invalid timeout" >&2
  exit 1
fi
jq -e '.success == false and .phase == "arguments"' "$TMP_DIR/env-invalid-timeout.json" >/dev/null
if CANVAS_TEST_CURL_FAIL=true "$cli" env --sync --timeout 1 --json --no-banner > "$TMP_DIR/env-health-timeout.json" 2>&1; then
  echo "env --sync succeeded without a healthy app" >&2
  exit 1
fi
if ! jq -e '.success == false and .phase == "health"' "$TMP_DIR/env-health-timeout.json" >/dev/null; then
  echo "env --sync did not report the expected health failure" >&2
  cat "$TMP_DIR/env-health-timeout.json" >&2
  exit 1
fi
"$cli" database reconcile-postgres-auth --timeout 10 --json --no-banner > "$TMP_DIR/env-health-recovery.json"
jq -e '.success == true and .recovered == "rollback" and .healthy == true and .rolledBack == true' "$TMP_DIR/env-health-recovery.json" >/dev/null
test ! -e "${CANVAS_POSTGRES_RECONCILE_JOURNAL:-${CANVAS_INSTALL_DIR}/.postgres-auth-reconcile.json}"
cp "$CANVAS_CONFIG_JSON" "$TMP_DIR/config-postgres.json"
jq 'del(.env.DATABASE_URL, .env.CANVAS_POSTGRES_PASSWORD)' \
  "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-legacy-missing-db-secrets.json"
cp "$TMP_DIR/config-legacy-missing-db-secrets.json" "$CANVAS_CONFIG_JSON"
"$cli" config-show --json --no-banner > "$TMP_DIR/config-show-legacy.json"
grep -q '"DATABASE_URL": "(not set)"' "$TMP_DIR/config-show-legacy.json"
grep -q '"CANVAS_POSTGRES_PASSWORD": "(not set)"' "$TMP_DIR/config-show-legacy.json"
if "$cli" env --render --json --no-banner > "$TMP_DIR/env-render-missing-postgres-secrets.json" 2>&1; then
  echo "env --render generated missing Postgres credentials implicitly" >&2
  exit 1
fi
if ! jq -e '.success == false and .phase == "render"' "$TMP_DIR/env-render-missing-postgres-secrets.json" >/dev/null; then
  echo "env --render did not return a single JSON render failure" >&2
  cat "$TMP_DIR/env-render-missing-postgres-secrets.json" >&2
  exit 1
fi
jq -e '(.env | has("DATABASE_URL") | not) and (.env | has("CANVAS_POSTGRES_PASSWORD") | not)' "$CANVAS_CONFIG_JSON" >/dev/null
cp "$TMP_DIR/config-postgres.json" "$CANVAS_CONFIG_JSON"

jq '.env.CANVAS_DATABASE_PROVIDER = "sqlite"
  | .env.CANVAS_DEPLOYMENT_MODE = "managed-team"
  | .env.CANVAS_POSTGRES_REQUIRED = false
  | .env.CANVAS_POSTGRES_VECTOR_ENABLED = false
  | .env.CANVAS_TEAM_FEATURES_ENABLED = false' \
  "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-inconsistent.json"
cp "$TMP_DIR/config-inconsistent.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/team-sqlite.txt" 2>&1; then
  echo "managed-team accepted sqlite provider" >&2
  exit 1
fi
if ! grep -q 'requires CANVAS_DATABASE_PROVIDER=postgres' "$TMP_DIR/team-sqlite.txt"; then
  echo "managed-team SQLite rejection did not report the expected validation error" >&2
  cat "$TMP_DIR/team-sqlite.txt" >&2
  exit 1
fi

cp "$TMP_DIR/config-postgres.json" "$CANVAS_CONFIG_JSON"
"$cli" env --sync --no-banner > /dev/null
grep -q '^COMPOSE_PROFILES=postgres$' "$CANVAS_COMPOSE_ENV"
: > "$CANVAS_TEST_COMPOSE_LOG"
"$cli" restart --no-banner > "$TMP_DIR/restart-postgres.txt"
grep -q 'up -d --force-recreate' "$CANVAS_TEST_COMPOSE_LOG"
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_COMPOSE_LOG"
grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_COMPOSE_LOG"

grep -q 'canvas-notebook-postgres' "$CANVAS_COMPOSE_FILE"
grep -q 'condition: service_healthy' "$CANVAS_COMPOSE_FILE"
grep -q 'required: false' "$CANVAS_COMPOSE_FILE"
grep -q 'profiles:' "$CANVAS_COMPOSE_FILE"
grep -q 'pgvector/pgvector:0.8.3-pg18' "$CANVAS_COMPOSE_FILE"
grep -q 'unused-sqlite-profile-disabled' "$CANVAS_COMPOSE_FILE"

jq '.env.CANVAS_DATABASE_PROVIDER = "postgres" | .env.DATABASE_URL = "postgresql://can%76as:secret%31xx@postgres:5432/canvas%5Fnotebook" | .env.CANVAS_POSTGRES_PASSWORD = ""' \
  "$TMP_DIR/config-postgres.json" > "$TMP_DIR/config-encoded-database-url.json"
cp "$TMP_DIR/config-encoded-database-url.json" "$CANVAS_CONFIG_JSON"
"$cli" env --sync --no-banner > "$TMP_DIR/encoded-database-url.txt"
grep -q '^CANVAS_POSTGRES_USER=canvas$' "$CANVAS_CONFIG_ENV"
grep -q '^CANVAS_POSTGRES_PASSWORD=secret1xx$' "$CANVAS_CONFIG_ENV"
grep -q '^CANVAS_POSTGRES_DB=canvas_notebook$' "$CANVAS_CONFIG_ENV"

jq '.env.CANVAS_DATABASE_PROVIDER = "postgres" | .env.DATABASE_URL = "postgresql://canvas:legacy%40password@postgres:5432/canvas_notebook" | .env.CANVAS_POSTGRES_PASSWORD = ""' \
  "$TMP_DIR/config-postgres.json" > "$TMP_DIR/config-encoded-reserved-password.json"
cp "$TMP_DIR/config-encoded-reserved-password.json" "$CANVAS_CONFIG_JSON"
"$cli" env --sync --no-banner > "$TMP_DIR/encoded-reserved-password.txt"
grep -q '^CANVAS_POSTGRES_PASSWORD=legacy@password$' "$CANVAS_CONFIG_ENV"
grep -q '^DATABASE_URL=postgresql://canvas:legacy%40password@postgres:5432/canvas_notebook$' "$CANVAS_CONFIG_ENV"
jq -e '.env.CANVAS_POSTGRES_PASSWORD == "legacy@password" and .env.DATABASE_URL == "postgresql://canvas:legacy%40password@postgres:5432/canvas_notebook"' "$CANVAS_CONFIG_JSON" >/dev/null

jq '.env.CANVAS_DATABASE_PROVIDER = "postgres" | .env.DATABASE_URL = "postgresql://canvas:secret%0Axx@postgres:5432/canvas_db" | .env.CANVAS_POSTGRES_PASSWORD = ""' \
  "$TMP_DIR/config-postgres.json" > "$TMP_DIR/config-encoded-bad-database-url.json"
cp "$TMP_DIR/config-encoded-bad-database-url.json" "$CANVAS_CONFIG_JSON"
if "$cli" env --sync --no-banner > "$TMP_DIR/encoded-bad-database-url.txt" 2>&1; then
  echo "encoded unsafe DATABASE_URL password was accepted" >&2
  exit 1
fi
if ! grep -q 'CANVAS_POSTGRES_PASSWORD contains unsafe control characters' "$TMP_DIR/encoded-bad-database-url.txt"; then
  echo "unsafe encoded DATABASE_URL rejection did not report the expected validation error" >&2
  cat "$TMP_DIR/encoded-bad-database-url.txt" >&2
  exit 1
fi

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
