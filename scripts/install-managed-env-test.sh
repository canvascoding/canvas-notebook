#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_CONFIG_JSON="$TMP_DIR/canvas-notebook-config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_USE_COLOR=false
export INSTALL_MODE=1
export NONINTERACTIVE=true
export SETUP_CADDY=false
export BASE_URL="https://team.example.test"
export CANVAS_DEPLOYMENT_MODE=managed-team
export CANVAS_DATABASE_PROVIDER=postgres
export CANVAS_MANAGED_SERVICES_ENABLED=true
export CANVAS_CONTROL_PLANE_URL="https://control.example.test"
export CANVAS_INSTANCE_ID="00000000-0000-4000-8000-000000000001"
export CANVAS_RUNTIME_SCOPE=organization
export CANVAS_ORGANIZATION_ID="00000000-0000-4000-8000-000000000002"
export CANVAS_TEAM_FEATURES_ENABLED=true
export CANVAS_MULTI_USER_ENABLED=true
export CANVAS_PERSONAL_WORKSPACES_ENABLED=true
export CANVAS_TEAM_WORKSPACE_ENABLED=true
export CANVAS_TEAM_KNOWLEDGE_BASE_ENABLED=true
export CANVAS_AUDIT_TRAIL_ENABLED=true
export CANVAS_MANAGED_BACKUPS_ENABLED=true
export CANVAS_POSTGRES_REQUIRED=true
export CANVAS_POSTGRES_VECTOR_ENABLED=true
export CANVAS_POSTGRES_IMAGE="pgvector/pgvector:0.8.3-pg18"
export CANVAS_POSTGRES_DATA_VOLUME="canvas-postgres-data"
export CANVAS_POSTGRES_DB="canvas_notebook"
export CANVAS_POSTGRES_USER="canvas"
export CANVAS_POSTGRES_PASSWORD="safe-postgres-password"
export DATABASE_URL="postgresql://canvas:safe-postgres-password@postgres:5432/canvas_notebook"

mkdir -p "$CANVAS_INSTALL_DIR"

INSTALL_FUNCTIONS="$TMP_DIR/install-functions.sh"
sed '/^if \[\[ "$(uname -s)" != "Linux" \]\]/,$d' "$ROOT_DIR/install.sh" > "$INSTALL_FUNCTIONS"

# shellcheck source=/dev/null
. "$INSTALL_FUNCTIONS"

SUPPORT_DIR="$ROOT_DIR/install"
# shellcheck source=../install/lib/common.sh
. "$ROOT_DIR/install/lib/common.sh"
# shellcheck source=../install/lib/shared/config_json.sh
. "$ROOT_DIR/install/lib/shared/config_json.sh"

config_json_init
configure_compose_values
configure_database_values
config_json_to_env

jq -e '
  .env.CANVAS_DEPLOYMENT_MODE == "managed-team" and
  .env.CANVAS_RUNTIME_SCOPE == "organization" and
  .env.CANVAS_ORGANIZATION_ID == "00000000-0000-4000-8000-000000000002" and
  .env.CANVAS_TEAM_FEATURES_ENABLED == true and
  .env.CANVAS_MULTI_USER_ENABLED == true and
  .env.CANVAS_PERSONAL_WORKSPACES_ENABLED == true and
  .env.CANVAS_TEAM_WORKSPACE_ENABLED == true and
  .env.CANVAS_TEAM_KNOWLEDGE_BASE_ENABLED == true and
  .env.CANVAS_AUDIT_TRAIL_ENABLED == true and
  .env.CANVAS_MANAGED_BACKUPS_ENABLED == true and
  .env.CANVAS_DATABASE_PROVIDER == "postgres" and
  .env.CANVAS_POSTGRES_REQUIRED == true and
  .env.CANVAS_POSTGRES_VECTOR_ENABLED == true and
  .env.DATABASE_URL == "postgresql://canvas:safe-postgres-password@postgres:5432/canvas_notebook"
' "$CANVAS_CONFIG_JSON" >/dev/null

grep -q '^COMPOSE_PROFILES=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_DATABASE_PROVIDER=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_TEAM_WORKSPACE_ENABLED=true$' "$CANVAS_CONFIG_ENV"
grep -q '^CANVAS_ORGANIZATION_ID=00000000-0000-4000-8000-000000000002$' "$CANVAS_CONFIG_ENV"
grep -q '^DATABASE_URL=postgresql://canvas:safe-postgres-password@postgres:5432/canvas_notebook$' "$CANVAS_CONFIG_ENV"

echo "install managed env tests passed"
