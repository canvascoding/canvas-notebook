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
compose_env="${CANVAS_COMPOSE_ENV:?}"
mutable_ref="${CANVAS_TEST_MUTABLE_IMAGE:?}"
target_ref="${CANVAS_TEST_TARGET_IMAGE:?}"
printf 'docker %s\n' "$*" >> "$log"

case "${1:-}" in
  info)
    exit 0
    ;;
  buildx|manifest)
    exit 1
    ;;
  image)
    case "${2:-}" in
      inspect)
        ref="${3:-}"
        if [[ "$*" == *"{{.Id}}"* ]]; then
          if [[ "$ref" == "$target_ref" ]]; then
            printf 'new-image-id\n'
          elif [[ "$ref" == "$mutable_ref" ]]; then
            cat "$state/mutable-image-id"
          elif [[ "$ref" == "old-image-id" || "$ref" == "new-image-id" ]]; then
            printf '%s\n' "$ref"
          else
            exit 1
          fi
          exit 0
        fi
        exit 1
        ;;
      tag)
        source_id="${3:-}"
        destination="${4:-}"
        [[ "$destination" == "$mutable_ref" ]] || exit 1
        printf '%s\n' "$source_id" > "$state/mutable-image-id"
        exit 0
        ;;
      prune)
        exit 0
        ;;
    esac
    exit 1
    ;;
  compose)
    args="$*"
    if [[ "$args" == *"ps -q postgres"* ]]; then
      printf 'pg-container\n'
      exit 0
    fi
    if [[ "$args" == *"ps -q canvas-notebook"* ]]; then
      printf 'app-container\n'
      exit 0
    fi
    if [[ "$args" == *" pull canvas-notebook"* ]]; then
      printf 'pull-image %s\n' "${CANVAS_IMAGE:-missing}" >> "$log"
      if [[ "${CANVAS_TEST_SLOW_PULL:-false}" == "true" ]]; then
        sleep 10
      fi
      if [[ "${CANVAS_TEST_FAIL_PULL:-false}" == "true" ]]; then
        exit 55
      fi
      touch "$state/pulled"
      exit 0
    fi
    if [[ "$args" == *"up -d --force-recreate --no-deps canvas-notebook"* ]]; then
      image_ref="${CANVAS_IMAGE:-}"
      if [[ -z "$image_ref" ]]; then
        image_ref="$(awk -F= '$1 == "CANVAS_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$compose_env")"
      fi
      if [[ "$image_ref" == "$target_ref" ]]; then
        printf 'new-image-id\n' > "$state/running-image-id"
      elif [[ "$image_ref" == "old-image-id" ]]; then
        printf 'old-image-id\n' > "$state/running-image-id"
      elif [[ "$image_ref" == "$mutable_ref" ]]; then
        cat "$state/mutable-image-id" > "$state/running-image-id"
      else
        exit 56
      fi
      exit 0
    fi
    if [[ "$args" == *"up -d --no-deps canvas-notebook"* ]]; then
      exit 0
    fi
    if [[ "$args" == *"--profile postgres up -d --no-recreate postgres"* ]]; then
      exit 0
    fi
    if [[ "$args" == *"logs -f"* ]]; then
      exit 0
    fi
    exit 0
    ;;
  inspect)
    if [[ "$*" == *"{{.State.Running}}"* && "${CANVAS_TEST_SLOW_INSPECT:-false}" == "true" ]]; then
      sleep 3
    fi
    if [[ "$*" == *"{{.Image}}"* && "$*" == *"app-container"* ]]; then
      cat "$state/running-image-id"
    elif [[ "$*" == *"{{.State.Running}}"* ]]; then
      printf 'true\n'
    elif [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.State.StartedAt}}"* ]]; then
      printf '2026-07-11T00:00:00Z\n'
    elif [[ "$*" == *"{{.Id}}"* ]]; then
      printf 'pg-container\n'
    else
      exit 1
    fi
    ;;
  exec)
    if [[ "$*" == *"pg_isready"* ]]; then
      exit 0
    fi
    if [[ "$*" == *"-u postgres"*" psql "* ]]; then
      cat > /dev/null
      jq -r '.env.CANVAS_POSTGRES_PASSWORD' "${CANVAS_CONFIG_JSON:?}" > "$state/role-password"
      exit 0
    fi
    if [[ "$*" == *" sh -c "* ]]; then
      payload="$(cat)"
      supplied_password="$(printf '%s\n' "$payload" | sed -n '3p')"
      [[ -f "$state/role-password" ]] || exit 28
      [[ "$supplied_password" == "$(cat "$state/role-password")" ]] || exit 28
      exit 0
    fi
    if [[ ! -t 0 ]]; then
      cat > /dev/null || true
    fi
    exit 0
    ;;
esac

exit 1
SH
chmod +x "$TMP_DIR/bin/docker"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
running="$(cat "${CANVAS_TEST_STATE_DIR:?}/running-image-id")"
if [[ "${CANVAS_TEST_SLOW_HEALTH:-false}" == "true" && "$running" == "new-image-id" ]]; then
  sleep 2
fi
case "${CANVAS_TEST_HEALTH_MODE:-healthy}" in
  healthy)
    exit 0
    ;;
  new-unhealthy)
    [[ "$running" != "new-image-id" ]]
    ;;
  all-unhealthy)
    exit 1
    ;;
esac
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
export CANVAS_CLI_SELF_UPDATE=false
export CANVAS_HEALTH_MAX_ATTEMPTS=1
export CANVAS_UPDATE_POSTGRES_TIMEOUT=5
export CANVAS_TEST_MUTABLE_IMAGE='ghcr.io/canvascoding/canvas-notebook:latest'
export CANVAS_TEST_TARGET_IMAGE="ghcr.io/canvascoding/canvas-notebook:release_1@sha256:$(printf 'a%.0s' {1..64})"

cli="$TMP_DIR/install/bin/canvas-notebook"

mkdir -p "$TMP_DIR/nonroot-bin"
cat > "$TMP_DIR/nonroot-bin/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${CANVAS_TEST_SUDO_LOG:?}"
exit 0
SH
chmod +x "$TMP_DIR/nonroot-bin/sudo"
touch "$TMP_DIR/nonroot-config.env" "$TMP_DIR/nonroot-compose.env" "$TMP_DIR/nonroot-compose.yaml"
chmod 000 "$TMP_DIR/nonroot-config.env" "$TMP_DIR/nonroot-compose.env"
: > "$TMP_DIR/sudo.log"
CANVAS_TEST_SUDO_LOG="$TMP_DIR/sudo.log" \
CANVAS_IMAGE="$CANVAS_TEST_TARGET_IMAGE" \
CONFIG_ENV_PATH="$TMP_DIR/nonroot-config.env" \
COMPOSE_ENV_PATH="$TMP_DIR/nonroot-compose.env" \
COMPOSE_FILE="$TMP_DIR/nonroot-compose.yaml" \
INSTALL_DIR="$TMP_DIR" \
PATH="$TMP_DIR/nonroot-bin:$PATH" \
bash -c '. "$1"; compose_optional pull canvas-notebook' bash "$TMP_DIR/install/lib/shared/compose.sh"
grep -Fxq "env CANVAS_INSTALL_DIR=$TMP_DIR CANVAS_IMAGE=$CANVAS_TEST_TARGET_IMAGE docker compose -f $TMP_DIR/nonroot-compose.yaml --project-directory $TMP_DIR pull canvas-notebook" "$TMP_DIR/sudo.log"
if CANVAS_TEST_SUDO_LOG="$TMP_DIR/sudo.log" \
  CANVAS_IMAGE='ghcr.io/canvascoding/canvas-notebook:latest;invalid' \
  CONFIG_ENV_PATH="$TMP_DIR/nonroot-config.env" \
  COMPOSE_ENV_PATH="$TMP_DIR/nonroot-compose.env" \
  COMPOSE_FILE="$TMP_DIR/nonroot-compose.yaml" \
  INSTALL_DIR="$TMP_DIR" \
  PATH="$TMP_DIR/nonroot-bin:$PATH" \
  bash -c '. "$1"; compose_optional pull canvas-notebook' bash "$TMP_DIR/install/lib/shared/compose.sh"; then
  echo 'unsafe CANVAS_IMAGE override crossed the sudo boundary' >&2
  exit 1
fi
chmod 600 "$TMP_DIR/nonroot-config.env" "$TMP_DIR/nonroot-compose.env"

reset_runtime() {
  "$cli" config-set image "$CANVAS_TEST_MUTABLE_IMAGE" --no-banner > /dev/null
  "$cli" config-set env.CANVAS_DATABASE_PROVIDER sqlite --no-banner > /dev/null
  "$cli" config-set env.CANVAS_POSTGRES_REQUIRED false --no-banner > /dev/null
  "$cli" config-set env.CANVAS_POSTGRES_VECTOR_ENABLED false --no-banner > /dev/null
  "$cli" config-set env.CANVAS_TEAM_FEATURES_ENABLED false --no-banner > /dev/null
  "$cli" config-set env.CANVAS_MANAGED_SERVICES_ENABLED false --no-banner > /dev/null
  "$cli" config-set env.CANVAS_CONTROL_PLANE_URL '' --no-banner > /dev/null
  "$cli" env --render --json --no-banner > /dev/null
  printf 'old-image-id\n' > "$CANVAS_TEST_STATE_DIR/running-image-id"
  printf 'old-image-id\n' > "$CANVAS_TEST_STATE_DIR/mutable-image-id"
  rm -f "$CANVAS_TEST_STATE_DIR/pulled" "$CANVAS_TEST_STATE_DIR/role-password"
  : > "$CANVAS_TEST_DOCKER_LOG"
}

reset_runtime
expired_deadline="$(( $(date +%s) * 1000 - 1000 ))"
if CANVAS_UPDATE_DEADLINE_EPOCH_MS="$expired_deadline" CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS=120 \
  "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/deadline-invalid.json" 2> "$TMP_DIR/deadline-invalid.err"; then
  echo 'expired update deadline was accepted' >&2
  exit 1
fi
jq -e '.success == false and .phase == "arguments" and .rolledBack == false' < <(tail -1 "$TMP_DIR/deadline-invalid.json") > /dev/null
test ! -s "$CANVAS_TEST_DOCKER_LOG"

reset_runtime
if "$cli" update --require-pinned --json --no-banner > "$TMP_DIR/required-pinned.json" 2> "$TMP_DIR/required-pinned.err"; then
  echo 'scheduled update accepted a mutable configured image' >&2
  exit 1
fi
jq -e '.success == false and .phase == "arguments" and .rolledBack == false' < <(tail -1 "$TMP_DIR/required-pinned.json") > /dev/null
grep -q 'Managed and scheduled updates require an image pinned to a sha256 digest' "$TMP_DIR/required-pinned.json"
test ! -s "$CANVAS_TEST_DOCKER_LOG"

reset_runtime
"$cli" config-set env.CANVAS_MANAGED_SERVICES_ENABLED true --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"
if "$cli" update --json --no-banner > "$TMP_DIR/managed-mutable.json" 2> "$TMP_DIR/managed-mutable.err"; then
  echo 'managed update accepted a mutable configured image' >&2
  exit 1
fi
jq -e '.success == false and .phase == "arguments" and .rolledBack == false' < <(tail -1 "$TMP_DIR/managed-mutable.json") > /dev/null
grep -q 'Managed and scheduled updates require an image pinned to a sha256 digest' "$TMP_DIR/managed-mutable.json"
test ! -s "$CANVAS_TEST_DOCKER_LOG"

reset_runtime
deadline_config_before="$(cksum "$CANVAS_CONFIG_JSON")"
deadline_container_env_before="$(cksum "$CANVAS_CONFIG_ENV")"
deadline_compose_env_before="$(cksum "$CANVAS_COMPOSE_ENV")"
short_deadline="$(( ( $(date +%s) + 32 ) * 1000 ))"
started_at="$(date +%s)"
if CANVAS_TEST_SLOW_PULL=true CANVAS_UPDATE_DEADLINE_EPOCH_MS="$short_deadline" CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS=30 \
  "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/deadline-pull.json" 2> "$TMP_DIR/deadline-pull.err"; then
  echo 'slow pull exceeded its forward deadline' >&2
  exit 1
fi
elapsed="$(( $(date +%s) - started_at ))"
[[ "$elapsed" -lt 8 ]]
jq -e '.success == false and .phase == "pull" and .rolledBack == false' < <(tail -1 "$TMP_DIR/deadline-pull.json") > /dev/null
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
[[ "$deadline_config_before" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
[[ "$deadline_container_env_before" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
[[ "$deadline_compose_env_before" == "$(cksum "$CANVAS_COMPOSE_ENV")" ]]

reset_runtime
deadline_config_before="$(cksum "$CANVAS_CONFIG_JSON")"
deadline_container_env_before="$(cksum "$CANVAS_CONFIG_ENV")"
deadline_compose_env_before="$(cksum "$CANVAS_COMPOSE_ENV")"
short_deadline="$(( ( $(date +%s) + 32 ) * 1000 ))"
if CANVAS_TEST_SLOW_INSPECT=true CANVAS_UPDATE_DEADLINE_EPOCH_MS="$short_deadline" CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS=30 \
  "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/deadline-apply.json" 2> "$TMP_DIR/deadline-apply.err"; then
  echo 'update applied after its forward deadline expired' >&2
  exit 1
fi
jq -e '.success == false and .phase == "deadline" and .rolledBack == false' < <(tail -1 "$TMP_DIR/deadline-apply.json") > /dev/null
test -f "$CANVAS_TEST_STATE_DIR/pulled"
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
[[ "$deadline_config_before" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
[[ "$deadline_container_env_before" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
[[ "$deadline_compose_env_before" == "$(cksum "$CANVAS_COMPOSE_ENV")" ]]
if grep -Fq 'up -d --force-recreate --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"; then
  echo 'deadline-before-apply recreated the app container' >&2
  exit 1
fi

reset_runtime
config_before="$(cksum "$CANVAS_CONFIG_JSON")"
env_before="$(cksum "$CANVAS_CONFIG_ENV")"
compose_env_before="$(cksum "$CANVAS_COMPOSE_ENV")"
if "$cli" update --image "${CANVAS_TEST_TARGET_IMAGE};touch /tmp/canvas-update-pwned" --json --no-banner > "$TMP_DIR/invalid.json" 2> "$TMP_DIR/invalid.err"; then
  echo 'invalid pinned image was accepted' >&2
  exit 1
fi
jq -e '.success == false and .phase == "arguments" and .rolledBack == false' < <(tail -1 "$TMP_DIR/invalid.json") > /dev/null
test ! -s "$CANVAS_TEST_DOCKER_LOG"
test ! -e /tmp/canvas-update-pwned
[[ "$config_before" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
[[ "$env_before" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
[[ "$compose_env_before" == "$(cksum "$CANVAS_COMPOSE_ENV")" ]]

reset_runtime
"$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/success.json" 2> "$TMP_DIR/success.err"
jq -e '.success == true and .recreated == true and .healthy == true and .rolledBack == false' < <(tail -1 "$TMP_DIR/success.json") > /dev/null
jq -e --arg image "$CANVAS_TEST_MUTABLE_IMAGE" '.image == $image' "$CANVAS_CONFIG_JSON" > /dev/null
grep -Fxq "CANVAS_IMAGE=$CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_COMPOSE_ENV"
grep -Fxq 'new-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
grep -Fxq 'new-image-id' "$CANVAS_TEST_STATE_DIR/mutable-image-id"
grep -Fq "pull canvas-notebook" "$CANVAS_TEST_DOCKER_LOG"
grep -Fxq "pull-image $CANVAS_TEST_TARGET_IMAGE" "$CANVAS_TEST_DOCKER_LOG"
grep -Fq "up -d --force-recreate --no-deps canvas-notebook" "$CANVAS_TEST_DOCKER_LOG"
grep -Fq "image tag new-image-id $CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_TEST_DOCKER_LOG"
grep -Fq -- '--connect-timeout' "$CANVAS_TEST_DOCKER_LOG"
grep -Fq -- '--max-time' "$CANVAS_TEST_DOCKER_LOG"
if grep -Eq 'compose .* (down|rm) |volume (rm|prune)|--force-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"; then
  echo 'pinned update used a destructive Docker operation' >&2
  exit 1
fi

reset_runtime
signal_config_before="$(cksum "$CANVAS_CONFIG_JSON")"
signal_env_before="$(cksum "$CANVAS_CONFIG_ENV")"
signal_compose_env_before="$(cksum "$CANVAS_COMPOSE_ENV")"
CANVAS_TEST_SLOW_HEALTH=true "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/signal.json" 2> "$TMP_DIR/signal.err" &
signal_pid=$!
signal_applied=false
for _ in $(seq 1 100); do
  if [[ "$(cat "$CANVAS_TEST_STATE_DIR/running-image-id")" == "new-image-id" ]]; then
    signal_applied=true
    break
  fi
  sleep 0.05
done
if [[ "$signal_applied" != "true" ]]; then
  echo 'SIGTERM test update did not reach the apply phase' >&2
  kill -9 "$signal_pid" >/dev/null 2>&1 || true
  wait "$signal_pid" >/dev/null 2>&1 || true
  exit 1
fi
kill -TERM "$signal_pid"
if wait "$signal_pid"; then
  echo 'SIGTERM update unexpectedly exited successfully' >&2
  exit 1
fi
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/mutable-image-id"
[[ "$signal_config_before" == "$(cksum "$CANVAS_CONFIG_JSON")" ]]
[[ "$signal_env_before" == "$(cksum "$CANVAS_CONFIG_ENV")" ]]
[[ "$signal_compose_env_before" == "$(cksum "$CANVAS_COMPOSE_ENV")" ]]
test ! -e "${CANVAS_OPERATION_LOCK_PATH:-${CANVAS_INSTALL_DIR}/.canvas-notebook-operation.lock}"

reset_runtime
if CANVAS_TEST_HEALTH_MODE=new-unhealthy "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/rollback.json" 2> "$TMP_DIR/rollback.err"; then
  echo 'unhealthy image update unexpectedly succeeded' >&2
  exit 1
fi
jq -e '.success == false and .phase == "health" and .rolledBack == true' < <(tail -1 "$TMP_DIR/rollback.json") > /dev/null
jq -e --arg image "$CANVAS_TEST_MUTABLE_IMAGE" '.image == $image' "$CANVAS_CONFIG_JSON" > /dev/null
grep -Fxq "CANVAS_IMAGE=$CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_COMPOSE_ENV"
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/mutable-image-id"
grep -Fq "image tag old-image-id $CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_TEST_DOCKER_LOG"

reset_runtime
if CANVAS_TEST_HEALTH_MODE=all-unhealthy "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/rollback-failed.json" 2> "$TMP_DIR/rollback-failed.err"; then
  echo 'rollback failure update unexpectedly succeeded' >&2
  exit 1
fi
jq -e '.success == false and .phase == "rollback_failed" and .rolledBack == false' < <(tail -1 "$TMP_DIR/rollback-failed.json") > /dev/null

reset_runtime
if CANVAS_TEST_FAIL_PULL=true "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/pull-failed.json" 2> "$TMP_DIR/pull-failed.err"; then
  echo 'pull failure update unexpectedly succeeded' >&2
  exit 1
fi
jq -e '.success == false and .phase == "pull" and .rolledBack == false' < <(tail -1 "$TMP_DIR/pull-failed.json") > /dev/null
jq -e --arg image "$CANVAS_TEST_MUTABLE_IMAGE" '.image == $image' "$CANVAS_CONFIG_JSON" > /dev/null
grep -Fxq "CANVAS_IMAGE=$CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_COMPOSE_ENV"
grep -Fxq 'old-image-id' "$CANVAS_TEST_STATE_DIR/running-image-id"
if grep -Fq 'up -d --force-recreate --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"; then
  echo 'pull failure recreated the app container' >&2
  exit 1
fi

reset_runtime
desired_password='new-role-password-456'
desired_url="postgresql://canvas:${desired_password}@postgres:5432/canvas_notebook"
"$cli" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
printf '%s' "$desired_password" | "$cli" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' "$desired_url" | "$cli" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
"$cli" env --render --json --no-banner > /dev/null
printf 'old-role-password-123\n' > "$CANVAS_TEST_STATE_DIR/role-password"
: > "$CANVAS_TEST_DOCKER_LOG"
if CANVAS_TEST_FAIL_PULL=true "$cli" update --image "$CANVAS_TEST_TARGET_IMAGE" --json --no-banner > "$TMP_DIR/postgres-recovered.json" 2> "$TMP_DIR/postgres-recovered.err"; then
  echo 'Postgres recovery pull failure unexpectedly succeeded' >&2
  exit 1
fi
jq -e '.success == false and .phase == "pull" and .rolledBack == false' < <(tail -1 "$TMP_DIR/postgres-recovered.json") > /dev/null
grep -Fxq "$desired_password" "$CANVAS_TEST_STATE_DIR/role-password"
grep -Fxq "CANVAS_POSTGRES_PASSWORD=$desired_password" "$CANVAS_COMPOSE_ENV"
grep -Fxq "DATABASE_URL=$desired_url" "$CANVAS_CONFIG_ENV"
grep -Fxq "CANVAS_IMAGE=$CANVAS_TEST_MUTABLE_IMAGE" "$CANVAS_COMPOSE_ENV"
alter_line="$(grep -n 'exec -i -u postgres pg-container psql' "$CANVAS_TEST_DOCKER_LOG" | head -1 | cut -d: -f1)"
pull_line="$(grep -n 'pull canvas-notebook' "$CANVAS_TEST_DOCKER_LOG" | head -1 | cut -d: -f1)"
[[ -n "$alter_line" && -n "$pull_line" && "$alter_line" -lt "$pull_line" ]]
grep -Fq 'up -d --no-deps canvas-notebook' "$CANVAS_TEST_DOCKER_LOG"
if grep -Fq "$desired_password" "$TMP_DIR/postgres-recovered.json" || grep -Fq "$desired_password" "$TMP_DIR/postgres-recovered.err" || grep -Fq "$desired_password" "$CANVAS_TEST_DOCKER_LOG"; then
  echo 'Postgres recovery exposed the password' >&2
  exit 1
fi

echo 'cli update rollback tests passed'
