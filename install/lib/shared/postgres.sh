#!/usr/bin/env bash
[[ -n "${_SHARED_POSTGRES_LOADED:-}" ]] && return 0
_SHARED_POSTGRES_LOADED=1

postgres_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

postgres_runtime_desired() {
  local provider database_url
  provider="$(config_json_read env.CANVAS_DATABASE_PROVIDER)"
  provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]' | xargs)"
  postgres_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)" && return 0
  postgres_bool "$(config_json_read env.CANVAS_POSTGRES_VECTOR_ENABLED)" && return 0
  postgres_bool "$(config_json_read env.CANVAS_TEAM_FEATURES_ENABLED)" && return 0
  case "$provider" in
    postgres) return 0 ;;
    sqlite) return 1 ;;
    "")
      database_url="$(config_json_read env.DATABASE_URL)"
      [[ "$database_url" =~ ^postgres(ql)?:// ]]
      return
      ;;
    *) fail "Invalid CANVAS_DATABASE_PROVIDER '${provider}'. Expected sqlite or postgres." ;;
  esac
}

postgres_load_runtime_env_unredacted() {
  config_json_read "env.${1}"
}

postgres_container_name() {
  local name
  name="$(postgres_load_runtime_env_unredacted CANVAS_POSTGRES_CONTAINER_NAME)"
  printf '%s\n' "${name:-canvas-notebook-postgres}"
}

postgres_runtime_password() {
  postgres_load_runtime_env_unredacted CANVAS_POSTGRES_PASSWORD
}

postgres_runtime_user() {
  local user
  user="$(postgres_load_runtime_env_unredacted CANVAS_POSTGRES_USER)"
  printf '%s\n' "${user:-canvas}"
}

postgres_runtime_database() {
  local db
  db="$(postgres_load_runtime_env_unredacted CANVAS_POSTGRES_DB)"
  printf '%s\n' "${db:-canvas_notebook}"
}

postgres_secret_is_invalid() {
  local value="$1"
  [[ "${#value}" -lt 8 ]] && return 0
  [[ "$value" == "(not set)" ]] && return 0
  [[ "$value" == *"***"* ]] && return 0
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]] && return 0
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    redacted|masked|filtered) return 0 ;;
  esac
  return 1
}

postgres_assert_unredacted_runtime_env() {
  local pg_password database_url
  pg_password="$(postgres_runtime_password)"
  database_url="$(postgres_load_runtime_env_unredacted DATABASE_URL)"
  if postgres_secret_is_invalid "$pg_password"; then
    fail "Postgres prepare requires an unredacted CANVAS_POSTGRES_PASSWORD with at least 8 characters."
  fi
  if [[ "$database_url" == "postgresql://***" || "$database_url" == *"***"* ]]; then
    fail "Postgres prepare requires an unredacted DATABASE_URL."
  fi
}

postgres_assert_database_url_matches_runtime() {
  local database_url url_user url_password url_database
  database_url="$(postgres_load_runtime_env_unredacted DATABASE_URL)"
  [[ -z "$database_url" ]] && return 0
  if [[ "$database_url" =~ ^postgres(ql)?://([^:/@]+):([^@]+)@[^/]+/([^/?#]+) ]]; then
    url_user="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_USER "${BASH_REMATCH[2]}")" || return 1
    url_password="$(config_json_decode_postgres_password "${BASH_REMATCH[3]}")" || return 1
    url_database="$(config_json_decode_postgres_url_part CANVAS_POSTGRES_DB "${BASH_REMATCH[4]}")" || return 1
  else
    fail "DATABASE_URL must include user, password, host, and database for managed Postgres."
  fi
  if [[ "$url_user" != "$(postgres_runtime_user)" || "$url_password" != "$(postgres_runtime_password)" || "$url_database" != "$(postgres_runtime_database)" ]]; then
    fail "DATABASE_URL credentials must match CANVAS_POSTGRES_USER, CANVAS_POSTGRES_PASSWORD, and CANVAS_POSTGRES_DB."
  fi
}

postgres_start_profile() {
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    compose --profile postgres up -d --no-recreate postgres >/dev/null
  else
    compose --profile postgres up -d --no-recreate postgres
  fi
}

postgres_container_id() {
  local cid name
  cid="$(compose ps -q postgres 2>/dev/null || true)"
  if [[ -n "$cid" ]]; then
    printf '%s\n' "$cid"
    return 0
  fi

  name="$(postgres_container_name)"
  cid="$(docker_cmd inspect --format '{{.Id}}' "$name" 2>/dev/null || true)"
  printf '%s\n' "$cid"
}

postgres_runtime_initialized() {
  local container volume
  container="$(postgres_container_id)"
  [[ -n "$container" ]] && return 0
  volume="$(postgres_load_runtime_env_unredacted CANVAS_POSTGRES_DATA_VOLUME)"
  volume="${volume:-canvas-postgres-data}"
  docker_cmd volume inspect "$volume" >/dev/null 2>&1
}

postgres_wait_ready() {
  local container="$1" timeout_seconds="${2:-60}" attempt status pg_user pg_db
  pg_user="$(postgres_runtime_user)"
  pg_db="$(postgres_runtime_database)"
  for attempt in $(seq 1 "$timeout_seconds"); do
    status="$(docker_cmd inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    if [[ "$status" == "running" ]] && docker_cmd exec -u postgres "$container" pg_isready -U "$pg_user" -d "$pg_db" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Postgres container did not become running after prepare-postgres."
}

postgres_sql_literal() {
  local escaped
  escaped="$(printf '%s' "$1" | sed "s/'/''/g")"
  printf "'%s'" "$escaped"
}

postgres_sync_role_password_value() {
  local container="$1" pg_user="$2" pg_db="$3" pg_password="$4" sql
  sql="SELECT format('ALTER ROLE %I PASSWORD %L', $(postgres_sql_literal "$pg_user"), $(postgres_sql_literal "$pg_password")) \\gexec"
  printf '%s\n' "$sql" | docker_cmd exec -i -u postgres "$container" psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" >/dev/null
}

postgres_sync_role_password() {
  postgres_sync_role_password_value "$1" "$(postgres_runtime_user)" "$(postgres_runtime_database)" "$(postgres_runtime_password)"
}

postgres_verify_password_value() {
  local container="$1" pg_user="$2" pg_db="$3" pg_password="$4"
  printf '%s\n%s\n%s\n' "$pg_user" "$pg_db" "$pg_password" | docker_cmd exec -i "$container" sh -c '
set -eu
IFS= read -r CANVAS_PG_USER
IFS= read -r CANVAS_PG_DB
IFS= read -r CANVAS_PG_PASSWORD
export PGPASSWORD="$CANVAS_PG_PASSWORD"
exec psql -h 127.0.0.1 -U "$CANVAS_PG_USER" -d "$CANVAS_PG_DB" -v ON_ERROR_STOP=1 -Atc "select 1"
' >/dev/null
}

postgres_verify_runtime_password() {
  postgres_verify_password_value "$1" "$(postgres_runtime_user)" "$(postgres_runtime_database)" "$(postgres_runtime_password)"
}

postgres_ensure_pgvector() {
  local container="$1" pg_user pg_db pg_password
  pg_user="$(postgres_runtime_user)"
  pg_db="$(postgres_runtime_database)"
  pg_password="$(postgres_runtime_password)"
  printf '%s\n%s\n%s\n' "$pg_user" "$pg_db" "$pg_password" | docker_cmd exec -i "$container" sh -c '
set -eu
IFS= read -r CANVAS_PG_USER
IFS= read -r CANVAS_PG_DB
IFS= read -r CANVAS_PG_PASSWORD
export PGPASSWORD="$CANVAS_PG_PASSWORD"
exec psql -h 127.0.0.1 -U "$CANVAS_PG_USER" -d "$CANVAS_PG_DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector"
' >/dev/null
}

postgres_pgvector_desired() {
  postgres_bool "$(postgres_load_runtime_env_unredacted CANVAS_POSTGRES_VECTOR_ENABLED)"
}

postgres_prepare_managed_runtime() {
  local timeout_seconds="${1:-60}" reconcile_auth="${2:-false}"
  postgres_runtime_desired || return 0

  postgres_assert_unredacted_runtime_env
  postgres_assert_database_url_matches_runtime
  postgres_start_profile

  local container
  container="$(postgres_container_id)"
  if [[ -z "$container" ]]; then
    fail "Postgres container was not found after prepare-postgres."
  fi

  postgres_wait_ready "$container" "$timeout_seconds"
  if [[ "$reconcile_auth" == "true" ]]; then
    postgres_sync_role_password "$container"
  fi
  if ! postgres_verify_runtime_password "$container"; then
    if [[ "$reconcile_auth" != "true" ]]; then
      fail "Postgres credentials do not match the initialized role. Run: canvas-notebook database reconcile-postgres-auth"
    fi
    return 1
  fi
  if postgres_pgvector_desired; then
    postgres_ensure_pgvector "$container"
  fi

  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    ok "Postgres service prepared and credentials verified"
  fi
}
