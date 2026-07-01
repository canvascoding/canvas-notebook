#!/usr/bin/env bash

database_usage() {
  cat <<'HELP'
Usage:
  canvas-notebook database migrate-sqlite-to-postgres [options]

Options:
  --sqlite-path <path>  Source SQLite path inside the Notebook container
  --verbose            Print per-table copy progress
  --json               Print machine-readable JSON

This command runs inside the active Canvas Notebook container. It requires the
container to have DATABASE_URL configured for Postgres.
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

_database_migrate_sqlite_to_postgres() {
  local cid
  local args=("$@")
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
    migrate-sqlite-to-postgres)
      log_msg "database ${subcommand}"
      _database_migrate_sqlite_to_postgres "$@"
      ;;
    *)
      _database_json_error "Unknown database subcommand: ${subcommand}" 2
      ;;
  esac
}
