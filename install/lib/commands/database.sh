#!/usr/bin/env bash

database_usage() {
  cat <<'HELP'
Usage:
  canvas-notebook database status [--json]
  canvas-notebook database prepare-postgres [--timeout <seconds>] [--json]
  canvas-notebook database reconcile-postgres-auth [--timeout <seconds>] [--json]
  canvas-notebook database migrate-sqlite-to-postgres [options]

Options:
  --sqlite-path <path>  Source SQLite path inside the Notebook container
  --verbose            Print per-table copy progress
  --json               Print machine-readable JSON

The prepare-postgres command starts the local Postgres compose service without
copying SQLite data. The reconcile command updates local Postgres authentication,
verifies it over TCP, renders env files, and only then applies the app service.
The migrate command runs inside the active Canvas Notebook container and requires
DATABASE_URL configured for Postgres.
HELP
}

_database_json_error() {
  local message="$1" code="${2:-1}"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":false,"error":"%s"}\n' "$(json_escape "$message")"
    exit "$code"
  fi
  fail "$message"
}

_database_require_running_container() {
  local cid
  cid="$(container_id)"
  if [[ -z "$cid" ]]; then
    _database_json_error "Canvas Notebook container is not running. Start it first: canvas-notebook start"
  fi
  printf '%s\n' "$cid"
}

_database_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) printf 'true\n' ;;
    *) printf 'false\n' ;;
  esac
}

_database_provider() {
  local provider database_url
  provider="$(config_json_read env.CANVAS_DATABASE_PROVIDER)"
  provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]' | xargs)"
  database_url="$(config_json_read env.DATABASE_URL)"
  if [[ -z "$provider" && "$database_url" =~ ^postgres(ql)?:// ]]; then
    printf 'postgres\n'
  else
    config_json_normalize_database_provider "$provider"
  fi
}

_database_status_json() {
  local provider postgres_mode deployment postgres_required pg_image pg_volume pg_db pg_user database_url pgvector
  provider="$(_database_provider)"
  postgres_mode="$(config_json_read env.CANVAS_POSTGRES_MODE)"
  if [[ "$provider" == "postgres" ]]; then
    postgres_mode="$(config_json_normalize_postgres_mode "$postgres_mode")"
  fi
  deployment="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  deployment="${deployment:-single_user}"
  postgres_required="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)")"
  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  pg_db="$(config_json_read env.CANVAS_POSTGRES_DB)"
  pg_user="$(config_json_read env.CANVAS_POSTGRES_USER)"
  database_url="$(config_json_read env.DATABASE_URL)"
  pgvector="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_VECTOR_ENABLED)")"
  printf '{"databaseProvider":"%s","postgresMode":"%s","deploymentMode":"%s","postgresRequired":%s,"postgresProfileEnabled":%s,"postgres":{"image":"%s","dataVolume":"%s","database":"%s","user":"%s","databaseUrlConfigured":%s,"pgvectorEnabled":%s}}\n' \
    "$(json_escape "$provider")" \
    "$(json_escape "$postgres_mode")" \
    "$(json_escape "$deployment")" \
    "$postgres_required" \
    "$([[ "$provider" == "postgres" && "$postgres_mode" == "managed" ]] && printf true || printf false)" \
    "$(json_escape "$pg_image")" \
    "$(json_escape "$pg_volume")" \
    "$(json_escape "$pg_db")" \
    "$(json_escape "$pg_user")" \
    "$([[ -n "$database_url" ]] && printf true || printf false)" \
    "$pgvector"
}

_database_status() {
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    _database_status_json
    return
  fi

  local provider postgres_mode deployment postgres_required pg_image pg_volume database_url
  provider="$(_database_provider)"
  postgres_mode="$(config_json_read env.CANVAS_POSTGRES_MODE)"
  if [[ "$provider" == "postgres" ]]; then
    postgres_mode="$(config_json_normalize_postgres_mode "$postgres_mode")"
  fi
  deployment="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  deployment="${deployment:-single_user}"
  postgres_required="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)")"
  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  database_url="$(config_json_read env.DATABASE_URL)"
  printf 'Database provider: %s\n' "$provider"
  printf 'Postgres mode: %s\n' "${postgres_mode:-(not set)}"
  printf 'Deployment mode: %s\n' "$deployment"
  printf 'Postgres required: %s\n' "$([[ "$postgres_required" == "true" ]] && printf yes || printf no)"
  printf 'Postgres profile: %s\n' "$([[ "$provider" == "postgres" && "$postgres_mode" == "managed" ]] && printf enabled || printf disabled)"
  printf 'Postgres image: %s\n' "${pg_image:-(not set)}"
  printf 'Postgres volume: %s\n' "${pg_volume:-(not set)}"
  printf 'DATABASE_URL: %s\n' "$([[ -n "$database_url" ]] && printf configured || printf '(not set)')"
}

_database_prepare_postgres() {
  local timeout_seconds snapshot_dir=""
  if ! timeout_seconds="$(_database_reconcile_timeout "$@")"; then
    _database_json_error "--timeout must be an integer from 1 to 7200 seconds." 2
  fi
  if [[ -f "$(_database_recovery_journal_path)" ]]; then
    _database_json_error "An interrupted Postgres auth reconciliation is pending. Run database reconcile-postgres-auth first."
  fi
  if [[ -f "$CONFIG_ENV_PATH" && -f "$COMPOSE_ENV_PATH" ]]; then
    if postgres_runtime_desired; then
      if ! CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_ensure_postgres_infrastructure_config; then
        _database_json_error "Desired Postgres credentials are incomplete, masked, or inconsistent."
      fi
      _database_reconcile_postgres_auth_quiet --timeout "$timeout_seconds" || return 1
    else
      snapshot_dir="$(mktemp -d)"
      chmod 700 "$snapshot_dir"
      _read_config_file "$CONFIG_ENV_PATH" > "${snapshot_dir}/container.env"
      _read_config_file "$COMPOSE_ENV_PATH" > "${snapshot_dir}/compose.env"
      chmod 600 "${snapshot_dir}/container.env" "${snapshot_dir}/compose.env"
    fi
  fi
  log_msg "database prepare-postgres"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    migrate_compose_file >/dev/null
  else
    migrate_compose_file
  fi
  config_json_ensure_postgres_infrastructure_config
  CANVAS_ALLOW_SQLITE_POSTGRES_PREPARE=true config_json_to_env
  if ! (postgres_prepare_managed_runtime "$timeout_seconds"); then
    if [[ -n "$snapshot_dir" ]]; then
      _write_secure_config_file "$CONFIG_ENV_PATH" "${snapshot_dir}/container.env" || true
      _write_secure_config_file "$COMPOSE_ENV_PATH" "${snapshot_dir}/compose.env" || true
    fi
    rm -rf "$snapshot_dir"
    _database_json_error "Postgres preparation failed without changing the initialized role."
  fi
  rm -rf "$snapshot_dir"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":true,'
    _database_status_json | sed 's/^{//'
  else
    ok "Postgres service prepared. No SQLite data was migrated."
  fi
}

_database_reconcile_error() {
  local phase="$1" message="$2" rolled_back="${3:-false}"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    jq -nc --arg phase "$phase" --arg error "$message" --argjson rolledBack "$rolled_back" \
      '{success:false, phase:$phase, error:$error, rolledBack:$rolledBack}'
  else
    printf '✗ %s\n' "$message" >&2
  fi
  return 1
}

_database_reconcile_timeout() {
  local timeout_seconds="${CANVAS_POSTGRES_RECONCILE_TIMEOUT:-900}" arg index=0
  local args=("$@")
  while [[ "$index" -lt "${#args[@]}" ]]; do
    arg="${args[$index]}"
    case "$arg" in
      --timeout)
        index=$((index + 1))
        if [[ "$index" -ge "${#args[@]}" ]]; then
          return 2
        fi
        timeout_seconds="${args[$index]}"
        ;;
      --timeout=*) timeout_seconds="${arg#--timeout=}" ;;
      *) return 2 ;;
    esac
    index=$((index + 1))
  done
  if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || [[ "$timeout_seconds" -gt 7200 ]]; then
    return 2
  fi
  printf '%s\n' "$timeout_seconds"
}

_database_snapshot_env_value() {
  local file="$1" key="$2"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$file"
}

_database_wait_app_health() {
  local timeout_seconds="$1" attempt deadline remaining probe_timeout
  deadline=$(($(date +%s) + timeout_seconds))
  for ((attempt=1; attempt<=timeout_seconds; attempt++)); do
    remaining=$((deadline - $(date +%s)))
    [[ "$remaining" -ge 1 ]] || break
    probe_timeout=2
    [[ "$probe_timeout" -le "$remaining" ]] || probe_timeout="$remaining"
    if canvas_health_probe "$(health_url)" "$probe_timeout"; then
      return 0
    fi
    [[ $((deadline - $(date +%s))) -ge 1 ]] || break
    sleep 1
  done
  return 1
}

_database_restore_env_files() {
  local snapshot_dir="$1"
  _write_secure_config_file "$CONFIG_ENV_PATH" "${snapshot_dir}/container.env"
  _write_secure_config_file "$COMPOSE_ENV_PATH" "${snapshot_dir}/compose.env"
}

_database_restore_raw_credentials() {
  local pg_user="$1" pg_db="$2" pg_password="$3" database_url="$4" snapshot_dir="$5" values_file raw_tmp
  if [[ -f "${snapshot_dir}/rollback-config.json" ]]; then
    _write_secure_config_file "$CONFIG_JSON_PATH" "${snapshot_dir}/rollback-config.json"
    return
  fi
  values_file="${snapshot_dir}/rollback-credentials.json"
  raw_tmp="${snapshot_dir}/rollback-config.json"
  printf '%s\0%s\0%s\0%s\0' "$pg_user" "$pg_db" "$pg_password" "$database_url" | jq -Rs '
    split("\u0000") as $values
    | {user: $values[0], database: $values[1], password: $values[2], databaseUrl: $values[3]}
  ' > "$values_file"
  chmod 600 "$values_file"
  _read_config_file "$CONFIG_JSON_PATH" | jq --slurpfile rollback "$values_file" '
    .env.CANVAS_POSTGRES_USER = $rollback[0].user
    | .env.CANVAS_POSTGRES_DB = $rollback[0].database
    | .env.CANVAS_POSTGRES_PASSWORD = $rollback[0].password
    | .env.DATABASE_URL = $rollback[0].databaseUrl
  ' > "$raw_tmp"
  chmod 600 "$raw_tmp"
  _write_secure_config_file "$CONFIG_JSON_PATH" "$raw_tmp"
}

_database_remaining_seconds() {
  local deadline="$1" now remaining
  now="$(date +%s)"
  remaining=$((deadline - now))
  [[ "$remaining" -ge 0 ]] || return 1
  [[ "$remaining" -eq 0 ]] && remaining=1
  printf '%s\n' "$remaining"
}

_database_recovery_journal_path() {
  printf '%s\n' "${CANVAS_POSTGRES_RECONCILE_JOURNAL:-${INSTALL_DIR}/.postgres-auth-reconcile.json}"
}

_database_recovery_state_path() {
  printf '%s\n' "${CANVAS_POSTGRES_RECONCILE_STATE_DIR:-${INSTALL_DIR}/.postgres-auth-reconcile-state}"
}

_database_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | awk '{print $NF}'
  else
    return 1
  fi
}

_database_credentials_fingerprint() {
  printf '%s\0%s\0%s\0%s\0' "$1" "$2" "$3" "$4" | _database_sha256_stream
}

_database_current_credentials_fingerprint() {
  _database_credentials_fingerprint \
    "$(postgres_runtime_user)" \
    "$(postgres_runtime_database)" \
    "$(postgres_runtime_password)" \
    "$(config_json_read env.DATABASE_URL)"
}

_database_recovery_journal_validate() {
  local journal_path="$1" current_fingerprint target_fingerprint rollback_fingerprint
  chmod 600 "$journal_path" 2>/dev/null || run_root chmod 600 "$journal_path" 2>/dev/null || return 1
  if ! _read_config_file "$journal_path" | jq -e '
    .version == 1 and .operation == "postgres_auth_reconcile"
    and (.state == "forward" or .state == "rollback")
    and (.targetFingerprint | test("^[a-f0-9]{64}$"))
    and (.rollbackFingerprint | test("^[a-f0-9]{64}$"))
    and (.createdAt | type == "string") and (.updatedAt | type == "string")
  ' >/dev/null 2>&1; then
    return 1
  fi
  current_fingerprint="$(_database_current_credentials_fingerprint)" || return 1
  target_fingerprint="$(_read_config_file "$journal_path" | jq -r '.targetFingerprint')"
  rollback_fingerprint="$(_read_config_file "$journal_path" | jq -r '.rollbackFingerprint')"
  [[ "$current_fingerprint" == "$target_fingerprint" || "$current_fingerprint" == "$rollback_fingerprint" ]]
}

_database_recovery_journal_write() {
  local state="$1" target_fingerprint="$2" rollback_fingerprint="$3" journal_path created_at now tmp
  journal_path="$(_database_recovery_journal_path)"
  created_at=""
  if [[ -f "$journal_path" ]]; then
    created_at="$(_read_config_file "$journal_path" | jq -r '.createdAt // empty' 2>/dev/null || true)"
  fi
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  created_at="${created_at:-$now}"
  tmp="$(mktemp)"
  jq -nc \
    --arg state "$state" \
    --arg targetFingerprint "$target_fingerprint" \
    --arg rollbackFingerprint "$rollback_fingerprint" \
    --arg createdAt "$created_at" \
    --arg updatedAt "$now" \
    '{version:1,operation:"postgres_auth_reconcile",state:$state,targetFingerprint:$targetFingerprint,rollbackFingerprint:$rollbackFingerprint,createdAt:$createdAt,updatedAt:$updatedAt}' > "$tmp"
  if ! _write_secure_config_file "$journal_path" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  if command -v sync >/dev/null 2>&1; then
    sync -f "$journal_path" 2>/dev/null || return 1
    sync -f "$(dirname "$journal_path")" 2>/dev/null || true
  fi
}

_database_recovery_state_create() {
  local source_dir="$1" pg_user="$2" pg_db="$3" pg_password="$4" database_url="$5"
  local state_path next_path values_file
  state_path="$(_database_recovery_state_path)"
  next_path="${state_path}.next-$$-${RANDOM}"
  rm -rf "$next_path"
  (umask 077 && mkdir -p "$next_path")
  chmod 700 "$next_path"
  cp "${source_dir}/container.env" "${next_path}/container.env"
  cp "${source_dir}/compose.env" "${next_path}/compose.env"
  values_file="${next_path}/rollback-values.json"
  printf '%s\0%s\0%s\0%s\0' "$pg_user" "$pg_db" "$pg_password" "$database_url" | jq -Rs '
    split("\u0000") as $values
    | {user: $values[0], database: $values[1], password: $values[2], databaseUrl: $values[3]}
  ' > "$values_file"
  _read_config_file "$CONFIG_JSON_PATH" | jq --slurpfile rollback "$values_file" '
    .env.CANVAS_POSTGRES_USER = $rollback[0].user
    | .env.CANVAS_POSTGRES_DB = $rollback[0].database
    | .env.CANVAS_POSTGRES_PASSWORD = $rollback[0].password
    | .env.DATABASE_URL = $rollback[0].databaseUrl
  ' > "${next_path}/rollback-config.json"
  rm -f "$values_file"
  chmod 600 "${next_path}/container.env" "${next_path}/compose.env" "${next_path}/rollback-config.json"
  command -v sync >/dev/null 2>&1 && sync -f "${next_path}/container.env" 2>/dev/null || true
  command -v sync >/dev/null 2>&1 && sync -f "${next_path}/compose.env" 2>/dev/null || true
  command -v sync >/dev/null 2>&1 && sync -f "${next_path}/rollback-config.json" 2>/dev/null || true
  rm -rf "$state_path"
  mv "$next_path" "$state_path"
  command -v sync >/dev/null 2>&1 && sync -f "$(dirname "$state_path")" 2>/dev/null || true
}

_database_recovery_state_validate() {
  local journal_path="$1" state_path rollback_fingerprint actual_fingerprint entry_count
  state_path="$(_database_recovery_state_path)"
  [[ -d "$state_path" ]] || return 1
  entry_count="$(find "$state_path" -mindepth 1 -maxdepth 1 -type f -print | wc -l | tr -d ' ')"
  [[ "$entry_count" -eq 3 ]] || return 1
  [[ -f "${state_path}/container.env" && -f "${state_path}/compose.env" && -f "${state_path}/rollback-config.json" ]] || return 1
  chmod 700 "$state_path" 2>/dev/null || run_root chmod 700 "$state_path" 2>/dev/null || return 1
  chmod 600 "${state_path}/container.env" "${state_path}/compose.env" "${state_path}/rollback-config.json" 2>/dev/null || \
    run_root chmod 600 "${state_path}/container.env" "${state_path}/compose.env" "${state_path}/rollback-config.json" 2>/dev/null || return 1
  rollback_fingerprint="$(_read_config_file "$journal_path" | jq -r '.rollbackFingerprint')"
  actual_fingerprint="$(_database_credentials_fingerprint \
    "$(_read_config_file "${state_path}/rollback-config.json" | jq -r '.env.CANVAS_POSTGRES_USER // "canvas"')" \
    "$(_read_config_file "${state_path}/rollback-config.json" | jq -r '.env.CANVAS_POSTGRES_DB // "canvas_notebook"')" \
    "$(_read_config_file "${state_path}/rollback-config.json" | jq -r '.env.CANVAS_POSTGRES_PASSWORD // empty')" \
    "$(_read_config_file "${state_path}/rollback-config.json" | jq -r '.env.DATABASE_URL // empty')")"
  [[ "$actual_fingerprint" == "$rollback_fingerprint" ]]
}

_database_recovery_state_restore() {
  local state_path
  state_path="$(_database_recovery_state_path)"
  _write_secure_config_file "$CONFIG_JSON_PATH" "${state_path}/rollback-config.json"
  _write_secure_config_file "$CONFIG_ENV_PATH" "${state_path}/container.env"
  _write_secure_config_file "$COMPOSE_ENV_PATH" "${state_path}/compose.env"
}

_database_recovery_journal_clear() {
  local journal_path state_path
  journal_path="$(_database_recovery_journal_path)"
  state_path="$(_database_recovery_state_path)"
  if [[ -e "$journal_path" ]]; then
    rm -f "$journal_path" 2>/dev/null || run_root rm -f "$journal_path"
    command -v sync >/dev/null 2>&1 && sync -f "$(dirname "$journal_path")" 2>/dev/null || true
  fi
  if [[ -e "$state_path" ]]; then
    rm -rf "$state_path" 2>/dev/null || run_root rm -rf "$state_path"
    command -v sync >/dev/null 2>&1 && sync -f "$(dirname "$state_path")" 2>/dev/null || true
  fi
}

_database_resume_postgres_auth_rollback() {
  local deadline="$1" remaining container state_path
  state_path="$(_database_recovery_state_path)"
  _database_recovery_state_restore || return 1
  migrate_compose_file >/dev/null 2>&1 || return 1
  postgres_start_profile >/dev/null 2>&1 || return 1
  container="$(postgres_container_id)"
  remaining="$(_database_remaining_seconds "$deadline")" || return 1
  [[ -n "$container" ]] && postgres_wait_ready "$container" "$remaining" >/dev/null 2>&1 || return 1
  postgres_sync_role_password "$container" >/dev/null 2>&1 || return 1
  postgres_verify_runtime_password "$container" >/dev/null 2>&1 || return 1
  compose up -d --no-deps "$SERVICE" >/dev/null 2>&1 || return 1
  remaining="$(_database_remaining_seconds "$deadline")" || return 1
  _database_wait_app_health "$remaining" >/dev/null 2>&1 || return 1
  _database_recovery_journal_clear
}

_database_rollback_postgres_auth() {
  local container="$1" pg_user="$2" pg_db="$3" pg_password="$4" database_url="$5" snapshot_dir="$6" deadline="$7" restore_app="$8" remaining
  postgres_sync_role_password_value "$container" "$pg_user" "$pg_db" "$pg_password" >/dev/null 2>&1 || return 1
  postgres_verify_password_value "$container" "$pg_user" "$pg_db" "$pg_password" >/dev/null 2>&1 || return 1
  _database_restore_raw_credentials "$pg_user" "$pg_db" "$pg_password" "$database_url" "$snapshot_dir" >/dev/null 2>&1 || return 1
  if [[ "$restore_app" == "true" ]]; then
    _database_restore_env_files "$snapshot_dir" >/dev/null 2>&1 || return 1
    (compose up -d --no-deps "$SERVICE") >/dev/null 2>&1 || return 1
    remaining="$(_database_remaining_seconds "$deadline")" || return 1
    _database_wait_app_health "$remaining" >/dev/null 2>&1 || return 1
  fi
}

_database_rollback_postgres_auth_with_journal() {
  local target_fingerprint="$1" rollback_fingerprint="$2"
  shift 2
  _database_recovery_journal_write rollback "$target_fingerprint" "$rollback_fingerprint" || return 1
  _database_rollback_postgres_auth "$@" || return 1
  _database_recovery_journal_clear
}

_database_reconcile_postgres_auth() (
  local timeout_seconds provider snapshot_dir old_user old_db old_password old_database_url desired_user desired_db
  local container before_container before_started after_container after_started app_restarted=false rolled_back=false
  local started_at deadline rollback_reserve forward_deadline remaining
  local journal_path journal_state journal_pending=false journal_armed=false target_fingerprint rollback_fingerprint snapshot_is_temporary=false fresh_initialization=false
  local desired_config_output
  if ! timeout_seconds="$(_database_reconcile_timeout "$@")"; then
    _database_reconcile_error arguments "--timeout must be an integer from 1 to 7200 seconds."
    return 1
  fi
  started_at="$(date +%s)"
  deadline=$((started_at + timeout_seconds))
  rollback_reserve=0
  if [[ "$timeout_seconds" -gt 1 ]]; then
    rollback_reserve=$((timeout_seconds / 5))
    [[ "$rollback_reserve" -lt 1 ]] && rollback_reserve=1
    [[ "$rollback_reserve" -gt 30 ]] && rollback_reserve=30
  fi
  forward_deadline=$((deadline - rollback_reserve))
  provider="$(_database_provider)"
  if ! postgres_runtime_desired; then
    _database_reconcile_error preflight "Managed Postgres is not enabled for this installation."
    return 1
  fi
  local config_ensure_error
  if ! config_ensure_error="$(CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_ensure_postgres_infrastructure_config 2>&1)"; then
    if [[ -n "$config_ensure_error" ]]; then
      _database_reconcile_error preflight "$config_ensure_error"
      return 1
    fi
    local config_validation_error
    config_validation_error="$(postgres_assert_database_url_matches_runtime 2>&1)" || {
      _database_reconcile_error preflight "$config_validation_error"
      return 1
    }
    _database_reconcile_error preflight "Desired Postgres credentials are incomplete, masked, or inconsistent."
    return 1
  fi
  journal_path="$(_database_recovery_journal_path)"
  if [[ -f "$journal_path" ]]; then
    journal_pending=true
    if ! _database_recovery_journal_validate "$journal_path"; then
      _database_reconcile_error recovery "Postgres credentials changed or the interrupted recovery journal is invalid; refusing automatic recovery."
      return 1
    fi
    if ! _database_recovery_state_validate "$journal_path"; then
      _database_reconcile_error recovery "Postgres recovery state is incomplete or does not match its journal; refusing automatic recovery."
      return 1
    fi
    journal_state="$(_read_config_file "$journal_path" | jq -r '.state')"
    if [[ "$journal_state" == "rollback" ]]; then
      if ! _database_resume_postgres_auth_rollback "$deadline"; then
        _database_reconcile_error recovery_rollback "Interrupted Postgres rollback could not be completed; recovery state was preserved."
        return 1
      fi
      if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        jq -nc '{success:true,recovered:"rollback",healthy:true,rolledBack:true}'
      else
        ok "Interrupted Postgres rollback recovered and verified"
      fi
      return 0
    fi
  else
    _database_recovery_journal_clear
    if [[ -z "$(config_json_read env.CANVAS_DATABASE_PROVIDER)" || -z "$(config_json_read env.CANVAS_POSTGRES_USER)" || \
      -z "$(config_json_read env.CANVAS_POSTGRES_DB)" || -z "$(config_json_read env.CANVAS_POSTGRES_PASSWORD)" || \
      -z "$(config_json_read env.DATABASE_URL)" ]]; then
      if ! desired_config_output="$(CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_ensure_database_config 2>&1)"; then
        if [[ "${OUTPUT_JSON:-false}" != "true" && -n "$desired_config_output" ]]; then
          printf '%s\n' "$desired_config_output" >&2
        fi
        _database_reconcile_error preflight "Desired Postgres credentials are incomplete, masked, or inconsistent."
        return 1
      fi
    fi
  fi
  if [[ ! -f "$CONFIG_ENV_PATH" || ! -f "$COMPOSE_ENV_PATH" ]]; then
    _database_reconcile_error preflight "Existing environment files are required before Postgres auth reconciliation."
    return 1
  fi
  if [[ "$journal_pending" == "true" ]]; then
    snapshot_dir="$(_database_recovery_state_path)"
  else
    snapshot_dir="$(mktemp -d)"
    snapshot_is_temporary=true
    chmod 700 "$snapshot_dir"
    trap 'if [[ "$snapshot_is_temporary" == "true" ]]; then rm -rf "$snapshot_dir"; fi' EXIT
    _read_config_file "$CONFIG_ENV_PATH" > "${snapshot_dir}/container.env"
    _read_config_file "$COMPOSE_ENV_PATH" > "${snapshot_dir}/compose.env"
    chmod 600 "${snapshot_dir}/container.env" "${snapshot_dir}/compose.env"
  fi

  old_user="$(_database_snapshot_env_value "${snapshot_dir}/compose.env" CANVAS_POSTGRES_USER)"
  old_db="$(_database_snapshot_env_value "${snapshot_dir}/compose.env" CANVAS_POSTGRES_DB)"
  old_password="$(_database_snapshot_env_value "${snapshot_dir}/compose.env" CANVAS_POSTGRES_PASSWORD)"
  old_database_url="$(_database_snapshot_env_value "${snapshot_dir}/container.env" DATABASE_URL)"
  if [[ -z "$old_database_url" ]]; then
    old_database_url="postgresql://${old_user}:${old_password}@postgres:5432/${old_db}"
  fi
  desired_user="$(postgres_runtime_user)"
  desired_db="$(postgres_runtime_database)"
  if [[ -z "$old_user" || -z "$old_db" ]] || postgres_secret_is_invalid "$old_password"; then
    if [[ "$journal_pending" == "true" ]] || postgres_runtime_initialized; then
      _database_reconcile_error preflight "Existing Postgres credentials are unavailable for safe rollback."
      return 1
    fi
    fresh_initialization=true
  else
    if [[ "$old_user" != "$desired_user" || "$old_db" != "$desired_db" ]]; then
      _database_reconcile_error preflight "CANVAS_POSTGRES_USER and CANVAS_POSTGRES_DB cannot be changed after initialization."
      return 1
    fi
    target_fingerprint="$(_database_credentials_fingerprint "$desired_user" "$desired_db" "$(postgres_runtime_password)" "$(config_json_read env.DATABASE_URL)")"
    rollback_fingerprint="$(_database_credentials_fingerprint "$old_user" "$old_db" "$old_password" "$old_database_url")"
  fi
  if [[ "$fresh_initialization" != "true" && "$journal_pending" != "true" ]]; then
    if ! _database_recovery_state_create "$snapshot_dir" "$old_user" "$old_db" "$old_password" "$old_database_url"; then
      _database_reconcile_error recovery "Postgres rollback recovery state could not be persisted."
      return 1
    fi
    snapshot_is_temporary=false
    rm -rf "$snapshot_dir"
    snapshot_dir="$(_database_recovery_state_path)"
  fi
  if ! (postgres_assert_unredacted_runtime_env && postgres_assert_database_url_matches_runtime) >/dev/null 2>&1; then
    _database_reconcile_error preflight "Desired Postgres credentials are incomplete, masked, or inconsistent."
    return 1
  fi
  if ! (migrate_compose_file) >/dev/null 2>&1; then
    _database_reconcile_error compose "Compose configuration failed."
    return 1
  fi
  if [[ "$fresh_initialization" == "true" ]] && ! (CANVAS_ALLOW_SQLITE_POSTGRES_PREPARE=true config_json_to_env) >/dev/null 2>&1; then
    _database_reconcile_error render "Environment render failed before initial Postgres startup."
    return 1
  fi
  if ! (postgres_start_profile) >/dev/null 2>&1; then
    _database_reconcile_error postgres_start "Postgres service could not be started without recreation."
    return 1
  fi
  container="$(postgres_container_id)"
  remaining="$(_database_remaining_seconds "$forward_deadline")" || true
  if [[ -z "$container" || -z "$remaining" ]] || ! (postgres_wait_ready "$container" "$remaining") >/dev/null 2>&1; then
    _database_reconcile_error postgres_ready "Postgres did not become ready within the configured timeout."
    return 1
  fi
  if [[ "$fresh_initialization" != "true" ]]; then
    if ! _database_recovery_journal_write forward "$target_fingerprint" "$rollback_fingerprint"; then
      _database_reconcile_error recovery "Postgres recovery journal could not be persisted before role mutation."
      return 1
    fi
    journal_armed=true
    if ! postgres_sync_role_password "$container" >/dev/null 2>&1; then
      if _database_rollback_postgres_auth_with_journal "$target_fingerprint" "$rollback_fingerprint" "$container" "$old_user" "$old_db" "$old_password" "$old_database_url" "$snapshot_dir" "$deadline" false; then
        rolled_back=true
        journal_armed=false
      fi
      _database_reconcile_error alter_role "Postgres role password reconciliation failed." "$rolled_back"
      return 1
    fi
  fi
  if ! postgres_verify_runtime_password "$container" >/dev/null 2>&1; then
    if [[ "$fresh_initialization" != "true" ]] && _database_rollback_postgres_auth_with_journal "$target_fingerprint" "$rollback_fingerprint" "$container" "$old_user" "$old_db" "$old_password" "$old_database_url" "$snapshot_dir" "$deadline" false; then
      rolled_back=true
      journal_armed=false
    fi
    _database_reconcile_error verify "Postgres TCP login verification failed." "$rolled_back"
    return 1
  fi
  if ! (config_json_to_env) >/dev/null 2>&1; then
    if [[ "$fresh_initialization" != "true" ]] && _database_rollback_postgres_auth_with_journal "$target_fingerprint" "$rollback_fingerprint" "$container" "$old_user" "$old_db" "$old_password" "$old_database_url" "$snapshot_dir" "$deadline" true; then
      rolled_back=true
      journal_armed=false
    fi
    _database_reconcile_error render "Environment render failed after Postgres verification." "$rolled_back"
    return 1
  fi
  before_container="$(container_id)"
  before_started="$(container_started_at "$before_container")"
  if ! (compose up -d --no-deps "$SERVICE") >/dev/null 2>&1; then
    if [[ "$fresh_initialization" != "true" ]] && _database_rollback_postgres_auth_with_journal "$target_fingerprint" "$rollback_fingerprint" "$container" "$old_user" "$old_db" "$old_password" "$old_database_url" "$snapshot_dir" "$deadline" true; then
      rolled_back=true
      journal_armed=false
    fi
    _database_reconcile_error app "Canvas Notebook apply failed after Postgres verification." "$rolled_back"
    return 1
  fi
  after_container="$(container_id)"
  after_started="$(container_started_at "$after_container")"
  if [[ "$before_container" != "$after_container" || "$before_started" != "$after_started" ]]; then
    app_restarted=true
  fi
  remaining="$(_database_remaining_seconds "$forward_deadline")" || true
  if [[ -z "$remaining" ]] || ! _database_wait_app_health "$remaining"; then
    if [[ "$fresh_initialization" != "true" ]] && _database_rollback_postgres_auth_with_journal "$target_fingerprint" "$rollback_fingerprint" "$container" "$old_user" "$old_db" "$old_password" "$old_database_url" "$snapshot_dir" "$deadline" true; then
      rolled_back=true
      journal_armed=false
    fi
    _database_reconcile_error health "Canvas Notebook did not become healthy within the configured timeout." "$rolled_back"
    return 1
  fi
  if [[ "$fresh_initialization" != "true" ]]; then
    _database_recovery_journal_clear
  fi
  journal_armed=false
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    jq -nc \
      --arg databaseProvider "$provider" \
      --argjson appRestarted "$app_restarted" \
      '{success:true, databaseProvider:$databaseProvider, postgresStarted:true, roleAuthSynchronized:true, authVerified:true, envRendered:true, appRestarted:$appRestarted, healthy:true}'
  else
    ok "Postgres credentials reconciled, verified, and applied"
  fi
)

_database_reconcile_postgres_auth_quiet() {
  local output
  if ! output="$(_database_reconcile_postgres_auth "$@")"; then
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output"
    fi
    return 1
  fi
}

_database_migrate_sqlite_to_postgres() {
  local cid
  local args=("$@")
  if [[ -f "$(_database_recovery_journal_path)" ]]; then
    _database_json_error "An interrupted Postgres auth reconciliation is pending. Run database reconcile-postgres-auth first."
  fi
  if postgres_runtime_desired && [[ -f "$CONFIG_ENV_PATH" && -f "$COMPOSE_ENV_PATH" ]]; then
    _database_reconcile_postgres_auth_quiet --timeout "${CANVAS_POSTGRES_RECONCILE_TIMEOUT:-900}" || return 1
  fi
  if [[ "$(config_json_read env.CANVAS_POSTGRES_MODE)" != "external" ]]; then
    config_json_ensure_postgres_infrastructure_config
  fi
  CANVAS_ALLOW_SQLITE_POSTGRES_PREPARE=true config_json_to_env
  postgres_prepare_managed_runtime
  cid="$(_database_require_running_container)"

  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    args+=("--json")
  fi

  docker_cmd exec "$cid" npx tsx --conditions react-server scripts/migrate-sqlite-to-postgres.ts "${args[@]}"
}

cmd_database() {
  local subcommand="${1:-}"
  if [[ -z "$subcommand" || "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
    database_usage
    return 0
  fi
  shift || true

  case "$subcommand" in
    status)
      _database_status
      ;;
    prepare-postgres)
      _database_prepare_postgres "$@"
      ;;
    reconcile-postgres-auth)
      log_msg "database reconcile-postgres-auth"
      _database_reconcile_postgres_auth "$@"
      ;;
    migrate-sqlite-to-postgres)
      log_msg "database ${subcommand}"
      _database_migrate_sqlite_to_postgres "$@"
      ;;
    *)
      _database_json_error "Unknown database subcommand: ${subcommand}" 2
      ;;
  esac
}
