#!/usr/bin/env bash

database_usage() {
  cat <<'HELP'
Usage:
  canvas-notebook database status [--json]
  canvas-notebook database prepare-postgres [--json]
  canvas-notebook database migrate-sqlite-to-postgres [options]

Options:
  --sqlite-path <path>  Source SQLite path inside the Notebook container
  --verbose            Print per-table copy progress
  --json               Print machine-readable JSON

The prepare-postgres command starts the local Postgres compose service without
copying SQLite data. The migrate command runs inside the active Canvas Notebook
container and requires DATABASE_URL configured for Postgres.
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

_database_status_json() {
  local provider deployment postgres_required pg_image pg_volume pg_db pg_user pg_password database_url pgvector
  provider="$(config_json_normalize_database_provider "$(config_json_read env.CANVAS_DATABASE_PROVIDER)")"
  deployment="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  deployment="${deployment:-single_user}"
  postgres_required="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)")"
  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  pg_db="$(config_json_read env.CANVAS_POSTGRES_DB)"
  pg_user="$(config_json_read env.CANVAS_POSTGRES_USER)"
  pg_password="$(config_json_read env.CANVAS_POSTGRES_PASSWORD)"
  database_url="$(config_json_read env.DATABASE_URL)"
  pgvector="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_VECTOR_ENABLED)")"
  printf '{"databaseProvider":"%s","deploymentMode":"%s","postgresRequired":%s,"postgresProfileEnabled":%s,"postgres":{"image":"%s","dataVolume":"%s","database":"%s","user":"%s","passwordConfigured":%s,"databaseUrlConfigured":%s,"pgvectorEnabled":%s}}\n' \
    "$(json_escape "$provider")" \
    "$(json_escape "$deployment")" \
    "$postgres_required" \
    "$([[ "$provider" == "postgres" ]] && printf true || printf false)" \
    "$(json_escape "$pg_image")" \
    "$(json_escape "$pg_volume")" \
    "$(json_escape "$pg_db")" \
    "$(json_escape "$pg_user")" \
    "$([[ -n "$pg_password" ]] && printf true || printf false)" \
    "$([[ -n "$database_url" ]] && printf true || printf false)" \
    "$pgvector"
}

_database_status() {
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    _database_status_json
    return
  fi

  local provider deployment postgres_required pg_image pg_volume database_url
  provider="$(config_json_normalize_database_provider "$(config_json_read env.CANVAS_DATABASE_PROVIDER)")"
  deployment="$(config_json_read env.CANVAS_DEPLOYMENT_MODE)"
  deployment="${deployment:-single_user}"
  postgres_required="$(_database_bool "$(config_json_read env.CANVAS_POSTGRES_REQUIRED)")"
  pg_image="$(config_json_read env.CANVAS_POSTGRES_IMAGE)"
  pg_volume="$(config_json_read env.CANVAS_POSTGRES_DATA_VOLUME)"
  database_url="$(config_json_read env.DATABASE_URL)"
  printf 'Database provider: %s\n' "$provider"
  printf 'Deployment mode: %s\n' "$deployment"
  printf 'Postgres required: %s\n' "$([[ "$postgres_required" == "true" ]] && printf yes || printf no)"
  printf 'Postgres profile: %s\n' "$([[ "$provider" == "postgres" ]] && printf enabled || printf disabled)"
  printf 'Postgres image: %s\n' "${pg_image:-(not set)}"
  printf 'Postgres volume: %s\n' "${pg_volume:-(not set)}"
  printf 'DATABASE_URL: %s\n' "$([[ -n "$database_url" ]] && printf configured || printf '(not set)')"
}

_database_prepare_postgres() {
  log_msg "database prepare-postgres"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    migrate_compose_file >/dev/null
  else
    migrate_compose_file
  fi
  config_json_ensure_postgres_infrastructure_config
  CANVAS_ALLOW_SQLITE_POSTGRES_PREPARE=true config_json_to_env
  postgres_prepare_managed_runtime
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    printf '{"success":true,'
    _database_status_json | sed 's/^{//'
  else
    ok "Postgres service prepared. No SQLite data was migrated."
  fi
}

_database_migrate_sqlite_to_postgres() {
  local cid
  local args=("$@")
  config_json_ensure_postgres_infrastructure_config
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
      _database_prepare_postgres
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
