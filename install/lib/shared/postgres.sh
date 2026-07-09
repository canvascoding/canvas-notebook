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
  local provider
  provider="$(config_json_normalize_database_provider "$(config_json_read env.CANVAS_DATABASE_PROVIDER)")"
  [[ "$provider" == "postgres" ]] && return 0
  postgres_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)" && return 0
  postgres_bool "$(config_json_read env.CANVAS_POSTGRES_VECTOR_ENABLED)" && return 0
  postgres_bool "$(config_json_read env.CANVAS_TEAM_FEATURES_ENABLED)" && return 0
  return 1
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

postgres_start_profile() {
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    compose --profile postgres up -d postgres >/dev/null
  else
    compose --profile postgres up -d postgres
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

postgres_wait_ready() {
  local container="$1" attempt status
  for attempt in $(seq 1 60); do
    status="$(docker_cmd inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    if [[ "$status" == "running" ]]; then
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

postgres_sync_role_password() {
  local container="$1" pg_user pg_db pg_password sql
  pg_user="$(postgres_runtime_user)"
  pg_db="$(postgres_runtime_database)"
  pg_password="$(postgres_runtime_password)"
  sql="SELECT format('ALTER ROLE %I PASSWORD %L', $(postgres_sql_literal "$pg_user"), $(postgres_sql_literal "$pg_password")) \\gexec"
  printf '%s\n' "$sql" | docker_cmd exec -i -u postgres "$container" psql -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" >/dev/null
}

postgres_verify_runtime_password() {
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
exec psql -h 127.0.0.1 -U "$CANVAS_PG_USER" -d "$CANVAS_PG_DB" -v ON_ERROR_STOP=1 -Atc "select 1"
' >/dev/null
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
  postgres_runtime_desired || return 0

  postgres_assert_unredacted_runtime_env
  postgres_start_profile

  local container
  container="$(postgres_container_id)"
  if [[ -z "$container" ]]; then
    fail "Postgres container was not found after prepare-postgres."
  fi

  postgres_wait_ready "$container"
  postgres_sync_role_password "$container"
  postgres_verify_runtime_password "$container"
  if postgres_pgvector_desired; then
    postgres_ensure_pgvector "$container"
  fi

  if [[ "${OUTPUT_JSON:-false}" != "true" ]]; then
    ok "Postgres service prepared and credentials verified"
  fi
}
