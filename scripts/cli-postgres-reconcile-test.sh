#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/install/lib" "$TMP_DIR/logs" "$TMP_DIR/state"
cp -R "$ROOT_DIR/install/bin" "$TMP_DIR/install/"
cp -R "$ROOT_DIR/install/lib/shared" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install/lib/commands" "$TMP_DIR/install/lib/"

cat > "$TMP_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
log="${CANVAS_TEST_DOCKER_LOG:?}"
state="${CANVAS_TEST_STATE_DIR:?}"

case "${1:-}" in
  info)
    exit 0
    ;;
  compose)
    shift
    printf 'compose %s\n' "$*" >> "$log"
    if [[ "$*" == *"up -d --no-deps canvas-notebook"* && "${CANVAS_TEST_FAIL_FORWARD_HEALTH:-false}" == "true" ]]; then
      app_apply_count=0
      [[ -f "$state/app-apply-count" ]] && app_apply_count="$(cat "$state/app-apply-count")"
      printf '%s\n' "$((app_apply_count + 1))" > "$state/app-apply-count"
    fi
    if [[ "$*" == *"up -d --no-deps canvas-notebook"* && "${CANVAS_TEST_FAIL_APP_APPLY:-false}" == "true" && ! -f "$state/app-apply-failed-once" ]]; then
      touch "$state/app-apply-failed-once"
      exit 43
    fi
    if [[ "$*" == *"ps -q postgres"* ]]; then
      printf 'existing-postgres-container\n'
    elif [[ "$*" == *"ps -q canvas-notebook"* ]]; then
      printf 'existing-app-container\n'
    fi
    exit 0
    ;;
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "$log"
    if [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.State.StartedAt}}"* ]]; then
      printf '2026-07-11T00:00:00Z\n'
    elif [[ "$*" == *"{{.Id}}"* ]]; then
      printf 'existing-postgres-container\n'
    fi
    exit 0
    ;;
  exec)
    shift
    printf 'exec %s\n' "$*" >> "$log"
    if [[ "$*" == *"pg_isready"* ]]; then
      exit 0
    fi
    if [[ "$*" == *"-u postgres"*" psql "* ]] && [[ "${CANVAS_TEST_FAIL_ALTER:-false}" == "true" ]] && [[ ! -f "$state/alter-failed-once" ]]; then
      touch "$state/alter-failed-once"
      cat >/dev/null || true
      exit 41
    fi
    if [[ "$*" == *" sh -c "* ]] && [[ "${CANVAS_TEST_FAIL_VERIFY:-false}" == "true" ]] && [[ ! -f "$state/verify-failed-once" ]]; then
      touch "$state/verify-failed-once"
      cat >/dev/null || true
      exit 42
    fi
    if [[ "$*" == *" sh -c "* ]] && [[ "${CANVAS_TEST_FAIL_ROLLBACK_VERIFY:-false}" == "true" ]] && \
      [[ -f "${CANVAS_POSTGRES_RECONCILE_JOURNAL:-}" ]] && \
      [[ "$(jq -r '.state // empty' "${CANVAS_POSTGRES_RECONCILE_JOURNAL}")" == "rollback" ]]; then
      cat >/dev/null || true
      exit 44
    fi
    if [[ ! -t 0 ]]; then
      cat >/dev/null || true
    fi
    touch "$state/docker-exec-success"
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
failures="${CANVAS_TEST_CURL_FAILURES:-0}"
counter_file="${CANVAS_TEST_STATE_DIR:?}/curl-count"
count=0
[[ -f "$counter_file" ]] && count="$(cat "$counter_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$counter_file"
if [[ "${CANVAS_TEST_FAIL_FORWARD_HEALTH:-false}" == "true" ]]; then
  app_apply_count=0
  [[ -f "${CANVAS_TEST_STATE_DIR}/app-apply-count" ]] && app_apply_count="$(cat "${CANVAS_TEST_STATE_DIR}/app-apply-count")"
  [[ "$app_apply_count" -le 1 ]] && exit 1
  exit 0
fi
if [[ "$count" -le "$failures" ]]; then
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
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_TEST_STATE_DIR="$TMP_DIR/state"
export CANVAS_USE_COLOR=false

cli="$TMP_DIR/install/bin/canvas-notebook"

"$cli" help --no-banner > "$TMP_DIR/help.txt"
test ! -e "$CANVAS_CONFIG_JSON"
grep -q 'env --render .*env --sync --timeout' "$TMP_DIR/help.txt"
grep -q 'config-show .*--secret-state' "$TMP_DIR/help.txt"
grep -q 'config-set .*--stdin' "$TMP_DIR/help.txt"
grep -q 'database reconcile-postgres-auth --timeout' "$TMP_DIR/help.txt"
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database reconcile-postgres-auth --help --no-banner > "$TMP_DIR/reconcile-help.txt"
test ! -s "$CANVAS_TEST_DOCKER_LOG"

old_password='old-password-123'
old_url="postgresql://canvas:${old_password}@postgres:5432/canvas_notebook"
"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
printf '%s' "$old_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$old_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
"$cli" env --render --json --no-banner > /dev/null

desired_password='desired-password-456'
desired_url="postgresql://canvas:${desired_password}@postgres:5432/canvas_notebook"
printf '%s' "$desired_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$desired_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
if ! "$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-success.json" 2> "$TMP_DIR/reconcile-success.err"; then
  cat "$TMP_DIR/reconcile-success.json" "$TMP_DIR/reconcile-success.err" >&2
  exit 1
fi
jq -e '.success == true and .databaseProvider == "postgres" and .postgresStarted == true and .rolePasswordSynchronized == true and .passwordVerified == true and .envRendered == true and .healthy == true' "$TMP_DIR/reconcile-success.json" >/dev/null
grep -q '^CANVAS_POSTGRES_PASSWORD=desired-password-456$' "$CANVAS_COMPOSE_ENV"
grep -q '^DATABASE_URL=postgresql://canvas:desired-password-456@postgres:5432/canvas_notebook$' "$CANVAS_CONFIG_ENV"
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"
if grep -Eq -- '--force-recreate| compose .* (down|rm) |volume (rm|prune)' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "reconcile used a destructive Docker operation" >&2
  exit 1
fi
if grep -Fq "$desired_password" "$TMP_DIR/reconcile-success.json" || grep -Fq "$desired_password" "$TMP_DIR/reconcile-success.err" || grep -Fq "$desired_password" "$CANVAS_TEST_DOCKER_LOG"; then
  echo "reconcile exposed the desired password" >&2
  exit 1
fi

: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database reconcile-postgres-auth --timeout=5 --json --no-banner > "$TMP_DIR/reconcile-idempotent.json"
jq -e '.success == true and .passwordVerified == true and .healthy == true' "$TMP_DIR/reconcile-idempotent.json" >/dev/null
if grep -Eq -- '--force-recreate| compose .* (down|rm) |volume (rm|prune)' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "idempotent reconcile used a destructive Docker operation" >&2
  exit 1
fi

"$cli" config-set env.CANVAS_DATABASE_PROVIDER sqlite --no-banner > /dev/null
"$cli" config-set env.CANVAS_POSTGRES_REQUIRED true --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-required.json"
jq -e '.success == true and .databaseProvider == "sqlite" and .passwordVerified == true' "$TMP_DIR/reconcile-required.json" >/dev/null
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"

"$cli" config-set env.CANVAS_POSTGRES_REQUIRED false --no-banner > /dev/null
"$cli" config-set env.CANVAS_POSTGRES_VECTOR_ENABLED false --no-banner > /dev/null
"$cli" config-set env.CANVAS_TEAM_FEATURES_ENABLED false --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
if "$cli" database reconcile-postgres-auth --timeout 2 --json --no-banner > "$TMP_DIR/reconcile-disabled.json" 2>&1; then
  echo "reconcile accepted a SQLite-only runtime" >&2
  exit 1
fi
jq -e '.success == false and .phase == "preflight"' "$TMP_DIR/reconcile-disabled.json" >/dev/null
test ! -s "$CANVAS_TEST_DOCKER_LOG"

jq 'del(.env.CANVAS_DATABASE_PROVIDER)' "$CANVAS_CONFIG_JSON" > "$TMP_DIR/config-legacy-url-only.json"
cp "$TMP_DIR/config-legacy-url-only.json" "$CANVAS_CONFIG_JSON"
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-legacy-url-only.json"
jq -e '.success == true and .databaseProvider == "postgres" and .passwordVerified == true' "$TMP_DIR/reconcile-legacy-url-only.json" >/dev/null
jq -e '.env.CANVAS_DATABASE_PROVIDER == "postgres"' "$CANVAS_CONFIG_JSON" >/dev/null
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"

"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
"$cli" config-set env.CANVAS_POSTGRES_REQUIRED true --no-banner > /dev/null

render_password='render-failure-password'
render_url="postgresql://canvas:${render_password}@postgres:5432/canvas_notebook"
printf '%s' "$render_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$render_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
"$cli" config-set env.CANVAS_DATABASE_PROVIDER sqlite --no-banner > /dev/null
"$cli" config-set env.CANVAS_DEPLOYMENT_MODE managed-team --no-banner > /dev/null
env_before_render="$(cksum "$CANVAS_CONFIG_ENV")"
: > "$CANVAS_TEST_DOCKER_LOG"
if "$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-render-failure.json" 2> "$TMP_DIR/reconcile-render-failure.err"; then
  echo "reconcile succeeded after render failure" >&2
  exit 1
fi
jq -e '.success == false and .phase == "render" and .rolledBack == true' "$TMP_DIR/reconcile-render-failure.json" >/dev/null || { cat "$TMP_DIR/reconcile-render-failure.json" "$TMP_DIR/reconcile-render-failure.err" >&2; exit 1; }
[[ "$env_before_render" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
jq -e --arg password "$desired_password" --arg url "$desired_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null

"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
"$cli" config-set env.CANVAS_DEPLOYMENT_MODE single_user --no-banner > /dev/null
app_password='app-failure-password'
app_url="postgresql://canvas:${app_password}@postgres:5432/canvas_notebook"
printf '%s' "$app_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$app_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
env_before_app="$(cksum "$CANVAS_CONFIG_ENV")"
rm -f "$CANVAS_TEST_STATE_DIR/app-apply-failed-once"
: > "$CANVAS_TEST_DOCKER_LOG"
if CANVAS_TEST_FAIL_APP_APPLY=true "$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-app-failure.json" 2> "$TMP_DIR/reconcile-app-failure.err"; then
  echo "reconcile succeeded after app apply failure" >&2
  exit 1
fi
jq -e '.success == false and .phase == "app" and .rolledBack == true' "$TMP_DIR/reconcile-app-failure.json" >/dev/null
[[ "$env_before_app" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
jq -e --arg password "$desired_password" --arg url "$desired_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null

alter_password='alter-failure-password'
alter_url="postgresql://canvas:${alter_password}@postgres:5432/canvas_notebook"
printf '%s' "$alter_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$alter_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
env_before_alter="$(cksum "$CANVAS_CONFIG_ENV")"
rm -f "$CANVAS_TEST_STATE_DIR/alter-failed-once"
: > "$CANVAS_TEST_DOCKER_LOG"
if CANVAS_TEST_FAIL_ALTER=true "$cli" database reconcile-postgres-auth --timeout 2 --json --no-banner > "$TMP_DIR/reconcile-alter-failure.json" 2> "$TMP_DIR/reconcile-alter-failure.err"; then
  echo "reconcile succeeded after ALTER ROLE failure" >&2
  exit 1
fi
jq -e '.success == false and .phase == "alter_role"' "$TMP_DIR/reconcile-alter-failure.json" >/dev/null
[[ "$env_before_alter" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
jq -e --arg password "$desired_password" --arg url "$desired_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null
if grep -q 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "ALTER ROLE failure reached app cutover" >&2
  exit 1
fi

verify_password='verify-failure-password'
verify_url="postgresql://canvas:${verify_password}@postgres:5432/canvas_notebook"
printf '%s' "$verify_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$verify_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
env_before_verify="$(cksum "$CANVAS_CONFIG_ENV")"
rm -f "$CANVAS_TEST_STATE_DIR/verify-failed-once"
: > "$CANVAS_TEST_DOCKER_LOG"
if CANVAS_TEST_FAIL_VERIFY=true "$cli" database reconcile-postgres-auth --timeout 2 --json --no-banner > "$TMP_DIR/reconcile-verify-failure.json" 2> "$TMP_DIR/reconcile-verify-failure.err"; then
  echo "reconcile succeeded after TCP verification failure" >&2
  exit 1
fi
jq -e '.success == false and .phase == "verify"' "$TMP_DIR/reconcile-verify-failure.json" >/dev/null
[[ "$env_before_verify" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
jq -e --arg password "$desired_password" --arg url "$desired_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null
if grep -q 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"; then
  echo "verification failure reached app cutover" >&2
  exit 1
fi

health_password='health-retry-password'
health_url="postgresql://canvas:${health_password}@postgres:5432/canvas_notebook"
printf '%s' "$health_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$health_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
env_before_health="$(cksum "$CANVAS_CONFIG_ENV")"
rm -f "$CANVAS_TEST_STATE_DIR/curl-count"
rm -f "$CANVAS_TEST_STATE_DIR/app-apply-count"
: > "$CANVAS_TEST_DOCKER_LOG"
if CANVAS_TEST_FAIL_FORWARD_HEALTH=true "$cli" database reconcile-postgres-auth --timeout 2 --json --no-banner > "$TMP_DIR/reconcile-health-failure.json" 2> "$TMP_DIR/reconcile-health-failure.err"; then
  echo "reconcile succeeded after app health failure" >&2
  exit 1
fi
jq -e '.success == false and .phase == "health" and .rolledBack == true' "$TMP_DIR/reconcile-health-failure.json" >/dev/null
[[ "$env_before_health" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
jq -e --arg password "$desired_password" --arg url "$desired_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null
if grep -Fq "$health_password" "$TMP_DIR/reconcile-health-failure.json" || grep -Fq "$health_password" "$TMP_DIR/reconcile-health-failure.err" || grep -Fq "$health_password" "$CANVAS_TEST_DOCKER_LOG"; then
  echo "health failure exposed the desired password" >&2
  exit 1
fi

rm -f "$CANVAS_TEST_STATE_DIR/curl-count"
rm -f "$CANVAS_TEST_STATE_DIR/app-apply-count"
printf '%s' "$health_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$health_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
"$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-retry.json"
jq -e '.success == true and .passwordVerified == true and .healthy == true' "$TMP_DIR/reconcile-retry.json" >/dev/null
grep -q '^CANVAS_POSTGRES_PASSWORD=health-retry-password$' "$CANVAS_COMPOSE_ENV"

rollback_crash_password='rollback-crash-password'
rollback_crash_url="postgresql://canvas:${rollback_crash_password}@postgres:5432/canvas_notebook"
printf '%s' "$rollback_crash_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$rollback_crash_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
rm -f "$CANVAS_TEST_STATE_DIR/app-apply-failed-once"
export CANVAS_POSTGRES_RECONCILE_JOURNAL="$TMP_DIR/postgres-recovery.json"
export CANVAS_POSTGRES_RECONCILE_STATE_DIR="$TMP_DIR/postgres-recovery-state"
if CANVAS_TEST_FAIL_APP_APPLY=true CANVAS_TEST_FAIL_ROLLBACK_VERIFY=true \
  "$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-interrupted-rollback.json" 2> "$TMP_DIR/reconcile-interrupted-rollback.err"; then
  echo "interrupted rollback unexpectedly succeeded" >&2
  exit 1
fi
jq -e '.success == false and .phase == "app" and .rolledBack == false' "$TMP_DIR/reconcile-interrupted-rollback.json" >/dev/null
jq -e '.state == "rollback" and .operation == "postgres_auth_reconcile"' "$CANVAS_POSTGRES_RECONCILE_JOURNAL" >/dev/null
if grep -Fq "$rollback_crash_password" "$CANVAS_POSTGRES_RECONCILE_JOURNAL"; then
  echo "recovery journal exposed a password" >&2
  exit 1
fi
test "$(stat -c '%a' "$CANVAS_POSTGRES_RECONCILE_JOURNAL" 2>/dev/null || stat -f '%Lp' "$CANVAS_POSTGRES_RECONCILE_JOURNAL")" = "600"
test "$(stat -c '%a' "$CANVAS_POSTGRES_RECONCILE_STATE_DIR" 2>/dev/null || stat -f '%Lp' "$CANVAS_POSTGRES_RECONCILE_STATE_DIR")" = "700"
for recovery_file in rollback-config.json container.env compose.env; do
  test "$(stat -c '%a' "$CANVAS_POSTGRES_RECONCILE_STATE_DIR/$recovery_file" 2>/dev/null || stat -f '%Lp' "$CANVAS_POSTGRES_RECONCILE_STATE_DIR/$recovery_file")" = "600"
done
pending_config_checksum="$(cksum "$CANVAS_CONFIG_JSON")"
if "$cli" config-set env.LOG_LEVEL debug --no-banner > "$TMP_DIR/pending-config-set.out" 2> "$TMP_DIR/pending-config-set.err"; then
  echo "config-set bypassed a pending Postgres recovery" >&2
  exit 1
fi
grep -q 'interrupted Postgres auth reconciliation is pending' "$TMP_DIR/pending-config-set.err"
[[ "$pending_config_checksum" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
if "$cli" env --render --json --no-banner > "$TMP_DIR/pending-render.json" 2> "$TMP_DIR/pending-render.err"; then
  echo "env --render bypassed a pending Postgres recovery" >&2
  exit 1
fi
[[ "$pending_config_checksum" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
"$cli" database reconcile-postgres-auth --timeout 5 --json --no-banner > "$TMP_DIR/reconcile-rollback-recovered.json"
jq -e '.success == true and .recovered == "rollback" and .healthy == true and .rolledBack == true' "$TMP_DIR/reconcile-rollback-recovered.json" >/dev/null
test ! -e "$CANVAS_POSTGRES_RECONCILE_JOURNAL"
test ! -e "$CANVAS_POSTGRES_RECONCILE_STATE_DIR"
jq -e --arg password "$health_password" --arg url "$health_url" '.env.CANVAS_POSTGRES_PASSWORD == $password and .env.DATABASE_URL == $url' "$CANVAS_CONFIG_JSON" >/dev/null
grep -q '^CANVAS_POSTGRES_PASSWORD=health-retry-password$' "$CANVAS_COMPOSE_ENV"

echo "cli postgres reconcile tests passed"
