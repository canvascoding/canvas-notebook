#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

INSTALL_FUNCTIONS="$TMP_DIR/install-functions.sh"
sed '/^if \[\[ "$(uname -s)" != "Linux" \]\]/,$d' "$ROOT_DIR/install.sh" > "$INSTALL_FUNCTIONS"

run_case() (
  local name="$1"
  local existing_provider="$2"
  local requested_provider="$3"
  local migrated_provider="$4"
  local expected_provider="$5"
  local case_dir="$TMP_DIR/$name"

  mkdir -p "$case_dir/install"
  export CANVAS_INSTALL_DIR="$case_dir/install"
  export CANVAS_CONFIG_JSON="$case_dir/canvas-notebook-config.json"
  export CANVAS_CONFIG_ENV="$case_dir/canvas-notebook.env"
  export CANVAS_COMPOSE_ENV="$case_dir/.env"
  export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
  export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
  export CANVAS_USE_COLOR=false
  export NONINTERACTIVE=true
  unset CANVAS_DATABASE_PROVIDER CANVAS_DEPLOYMENT_MODE CANVAS_TEAM_FEATURES_ENABLED

  if [[ -n "$existing_provider" ]]; then
    printf '{"env":{"CANVAS_DEPLOYMENT_MODE":"single_user","CANVAS_DATABASE_PROVIDER":"%s"}}\n' "$existing_provider" > "$CANVAS_CONFIG_JSON"
  fi
  if [[ -n "$requested_provider" ]]; then
    export CANVAS_DATABASE_PROVIDER="$requested_provider"
  fi

  # shellcheck source=/dev/null
  . "$INSTALL_FUNCTIONS"
  if [[ -n "$migrated_provider" ]]; then
    printf '{"env":{"CANVAS_DEPLOYMENT_MODE":"single_user","CANVAS_DATABASE_PROVIDER":"%s"}}\n' "$migrated_provider" > "$CANVAS_CONFIG_JSON"
    CONFIG_JSON_WAS_PRESENT=true
  fi
  SUPPORT_DIR="$ROOT_DIR/install"
  # shellcheck source=../install/lib/common.sh
  . "$ROOT_DIR/install/lib/common.sh"
  # shellcheck source=../install/lib/shared/config_json.sh
  . "$ROOT_DIR/install/lib/shared/config_json.sh"
  run_root() { "$@"; }

  config_json_init
  configure_database_values
  [[ "$(config_json_read env.CANVAS_DATABASE_PROVIDER)" == "$expected_provider" ]]
)

run_case fresh-default "" "" "" postgres
run_case existing-sqlite sqlite "" "" sqlite
run_case existing-postgres postgres "" "" postgres
run_case migrated-legacy-sqlite "" "" sqlite sqlite

if run_case fresh-explicit-sqlite "" sqlite "" sqlite >/dev/null 2>&1; then
  echo "fresh SQLite installation was unexpectedly accepted" >&2
  exit 1
fi

run_external_case() (
  local case_dir="$TMP_DIR/external-postgres"
  mkdir -p "$case_dir/install"
  export CANVAS_INSTALL_DIR="$case_dir/install"
  export CANVAS_CONFIG_JSON="$case_dir/canvas-notebook-config.json"
  export CANVAS_CONFIG_ENV="$case_dir/canvas-notebook.env"
  export CANVAS_COMPOSE_ENV="$case_dir/.env"
  export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
  export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
  export CANVAS_USE_COLOR=false
  SUPPORT_DIR="$ROOT_DIR/install"
  # shellcheck source=../install/lib/common.sh
  . "$ROOT_DIR/install/lib/common.sh"
  # shellcheck source=../install/lib/shared/config_json.sh
  . "$ROOT_DIR/install/lib/shared/config_json.sh"
  # shellcheck source=../install/lib/shared/postgres.sh
  . "$ROOT_DIR/install/lib/shared/postgres.sh"
  run_root() { "$@"; }

  config_json_init
  config_json_write env.CANVAS_POSTGRES_MODE external
  config_json_write env.DATABASE_URL 'postgresql://external:external-password@db.example.test:5432/canvas'
  config_json_write env.CANVAS_POSTGRES_PASSWORD duplicate-password
  config_json_ensure_database_config
  config_json_to_env
  [[ "$(config_json_read env.CANVAS_POSTGRES_PASSWORD)" == "" ]]
  grep -q '^COMPOSE_PROFILES=$' "$CANVAS_COMPOSE_ENV"
  grep -q '^CANVAS_POSTGRES_MODE=external$' "$CANVAS_COMPOSE_ENV"
  ! postgres_runtime_desired
  if (config_json_ensure_postgres_infrastructure_config) >/dev/null 2>&1; then
    echo "external Postgres unexpectedly allowed managed infrastructure preparation" >&2
    exit 1
  fi
)

run_external_case

echo "install database default tests passed"
