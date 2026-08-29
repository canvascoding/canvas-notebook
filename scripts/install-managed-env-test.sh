#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_CONFIG_JSON="$TMP_DIR/canvas-notebook-config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_CLI_PATH="$CANVAS_INSTALL_DIR/bin/canvas-notebook"
export CANVAS_LINUX_CLI_ROOT="$TMP_DIR/linux-cli"
export CANVAS_LINUX_CLI_INSTALLER_PATH="$TMP_DIR/fake-linux-cli-installer.sh"
export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
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
mkdir -p "$CANVAS_LINUX_CLI_ROOT" "$(dirname "$CANVAS_CLI_PATH")"

cat > "$CANVAS_LINUX_CLI_INSTALLER_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "install" ]]
[[ -n "${CANVAS_LINUX_CLI_ROOT:-}" ]]
[[ -n "${CANVAS_LINUX_CLI_BIN_PATH:-}" ]]
mkdir -p "${CANVAS_LINUX_CLI_ROOT}/bin" "$(dirname "$CANVAS_LINUX_CLI_BIN_PATH")"
printf '#!/usr/bin/env bash\nprintf '\''{"cliGeneration":"typescript"}\\n'\''\n' > "${CANVAS_LINUX_CLI_ROOT}/bin/canvas-notebook"
chmod 755 "${CANVAS_LINUX_CLI_ROOT}/bin/canvas-notebook"
ln -sfn "${CANVAS_LINUX_CLI_ROOT}/bin/canvas-notebook" "$CANVAS_LINUX_CLI_BIN_PATH"
EOF
chmod 755 "$CANVAS_LINUX_CLI_INSTALLER_PATH"

INSTALL_FUNCTIONS="$TMP_DIR/install-functions.sh"
sed '/^if \[\[ "$(uname -s)" != "Linux" \]\]/,$d' "$ROOT_DIR/install.sh" > "$INSTALL_FUNCTIONS"

# shellcheck source=/dev/null
. "$INSTALL_FUNCTIONS"

SUPPORT_DIR="$ROOT_DIR/install"
# shellcheck source=../install/lib/common.sh
. "$ROOT_DIR/install/lib/common.sh"
# shellcheck source=../install/lib/shared/config_json.sh
. "$ROOT_DIR/install/lib/shared/config_json.sh"
# shellcheck source=../install/lib/systemd.sh
. "$ROOT_DIR/install/lib/systemd.sh"

config_json_init
configure_compose_values
configure_database_values
config_json_to_env
mkdir -p "$(dirname "$CANVAS_CLI_PATH")"
if ! install_management_cli > "$TMP_DIR/install-management-cli.log" 2>&1; then
  cat "$TMP_DIR/install-management-cli.log" >&2
  exit 1
fi
printf 'managed env CLI installation completed\n'

file_mode() {
  stat -L -c '%a' "$1" 2>/dev/null || stat -L -f '%Lp' "$1"
}

file_owner() {
  stat -L -c '%u:%g' "$1" 2>/dev/null || stat -L -f '%u:%g' "$1"
}

[[ "$(file_mode "$CANVAS_CONFIG_JSON")" == "600" ]]
[[ "$(file_mode "$CANVAS_CONFIG_ENV")" == "600" ]]
[[ "$(file_mode "$CANVAS_COMPOSE_ENV")" == "600" ]]
[[ "$(file_mode "$CANVAS_CLI_PATH")" == "755" ]]
[[ "$("$CANVAS_CLI_PATH")" == '{"cliGeneration":"typescript"}' ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib")" == "755" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib/shared")" == "755" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib/commands")" == "755" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/templates")" == "755" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib/shared/utils.sh")" == "644" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib/commands/update.sh")" == "644" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/lib/systemd.sh")" == "644" ]]
[[ "$(file_mode "$CANVAS_INSTALL_DIR/templates/canvas-notebook.service")" == "644" ]]
expected_host_owner="$(id -u):$(id -g)"
[[ "$(file_owner "$CANVAS_CLI_PATH")" == "$expected_host_owner" ]]
[[ "$(file_owner "$CANVAS_INSTALL_DIR/lib/shared/utils.sh")" == "$expected_host_owner" ]]
[[ "$(file_owner "$CANVAS_INSTALL_DIR/lib/commands/update.sh")" == "$expected_host_owner" ]]
[[ "$(file_owner "$CANVAS_INSTALL_DIR/lib/systemd.sh")" == "$expected_host_owner" ]]
[[ "$(file_owner "$CANVAS_INSTALL_DIR/templates/canvas-notebook.service")" == "$expected_host_owner" ]]
[[ "$(env -u CANVAS_HOST_CODE_OWNER bash -c '. "$1"; _host_code_owner' _ "$ROOT_DIR/install/lib/shared/config_json.sh")" == "root:root" ]]
printf 'managed env file modes and ownership verified\n'

config_before_atomic_write="$TMP_DIR/config-before-atomic-write.json"
ln "$CANVAS_CONFIG_JSON" "$config_before_atomic_write"
config_json_write env.CANVAS_MANAGED_BACKUPS_ENABLED false
if cmp -s "$CANVAS_CONFIG_JSON" "$config_before_atomic_write"; then
  echo "atomic config write updated the existing config file instead of replacing it" >&2
  exit 1
fi
config_json_write env.CANVAS_MANAGED_BACKUPS_ENABLED true
config_json_to_env
if ! config_json_managed_by_control_plane; then
  echo "managed install config was not marked as control-plane managed" >&2
  exit 1
fi
if config_json_image_is_pinned "$(config_json_read image)"; then
  echo "managed install unexpectedly treated the mutable default image as pinned" >&2
  exit 1
fi
if find "$CANVAS_INSTALL_DIR" -maxdepth 1 -name '.*.tmp.*' -print -quit | grep -q .; then
  echo "atomic config write left a temporary file behind" >&2
  exit 1
fi
printf 'managed env config invariants verified\n'

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
  .autoUpdate.enabled == false and
  .env.DATABASE_URL == "postgresql://canvas:safe-postgres-password@postgres:5432/canvas_notebook"
' "$CANVAS_CONFIG_JSON" >/dev/null

grep -q '^COMPOSE_PROFILES=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_DATABASE_PROVIDER=postgres$' "$CANVAS_COMPOSE_ENV"
grep -q '^CANVAS_TEAM_WORKSPACE_ENABLED=true$' "$CANVAS_CONFIG_ENV"
grep -q '^CANVAS_ORGANIZATION_ID=00000000-0000-4000-8000-000000000002$' "$CANVAS_CONFIG_ENV"
grep -q '^DATABASE_URL=postgresql://canvas:safe-postgres-password@postgres:5432/canvas_notebook$' "$CANVAS_CONFIG_ENV"

printf 'managed env output verified\n'
echo "install managed env tests passed"
