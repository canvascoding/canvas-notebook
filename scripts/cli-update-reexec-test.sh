#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/install/lib" "$TMP_DIR/logs" "$TMP_DIR/latest"
cp -R "$ROOT_DIR/install/bin" "$TMP_DIR/install/"
cp -R "$ROOT_DIR/install/lib/shared" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install/lib/commands" "$TMP_DIR/install/lib/"
cp -R "$ROOT_DIR/install" "$TMP_DIR/latest/install"

sed -i.bak 's/^CANVAS_CLI_VERSION=.*/CANVAS_CLI_VERSION="2026.7.8.1"/' "$TMP_DIR/install/bin/canvas-notebook"
rm -f "$TMP_DIR/install/bin/canvas-notebook.bak"
printf '\n# old update command marker\n' >> "$TMP_DIR/install/lib/commands/update.sh"
LATEST_VERSION="$(sed -n -E 's/^CANVAS_CLI_VERSION="([^"]*)".*/\1/p' "$TMP_DIR/latest/install/bin/canvas-notebook")"

cat > "$TMP_DIR/latest/install.sh" <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
. "$root/install/lib/shared/output.sh"
. "$root/install/lib/shared/utils.sh"
. "$root/install/lib/shared/config_json.sh"
canvas_operation_lock_acquire cli-update-installer
[[ "${CANVAS_OPERATION_LOCK_BORROWED:-false}" == "true" ]]
[[ "${CANVAS_VERSION:-}" == "v${CANVAS_EXPECTED_LINUX_CLI_VERSION:?}" ]]
install -m 755 "$root/install/bin/canvas-notebook" "$CANVAS_CLI_PATH"
mkdir -p "$CANVAS_INSTALL_DIR/lib/shared" "$CANVAS_INSTALL_DIR/lib/commands" "$CANVAS_INSTALL_DIR/templates"
cp "$root/install/lib/shared/"*.sh "$CANVAS_INSTALL_DIR/lib/shared/"
cp "$root/install/lib/commands/"*.sh "$CANVAS_INSTALL_DIR/lib/commands/"
cp "$root/install/lib/systemd.sh" "$CANVAS_INSTALL_DIR/lib/systemd.sh"
cp "$root/install/templates/"* "$CANVAS_INSTALL_DIR/templates/"
INSTALLER
chmod +x "$TMP_DIR/latest/install.sh"
printf '%s\n' "$LATEST_VERSION" > "$TMP_DIR/latest/VERSION"
mkdir -p "$TMP_DIR/assets/canvas-notebook-host-cli"
cp "$TMP_DIR/latest/install.sh" "$TMP_DIR/assets/canvas-notebook-host-cli/install.sh"
cp "$TMP_DIR/latest/VERSION" "$TMP_DIR/assets/canvas-notebook-host-cli/VERSION"
cp -R "$TMP_DIR/latest/install" "$TMP_DIR/assets/canvas-notebook-host-cli/install"
tar -czf "$TMP_DIR/assets/canvas-notebook-host-cli.tar.gz" -C "$TMP_DIR/assets" canvas-notebook-host-cli
if command -v sha256sum >/dev/null 2>&1; then
  host_cli_sha="$(sha256sum "$TMP_DIR/assets/canvas-notebook-host-cli.tar.gz" | awk '{print $1}')"
else
  host_cli_sha="$(shasum -a 256 "$TMP_DIR/assets/canvas-notebook-host-cli.tar.gz" | awk '{print $1}')"
fi
printf '%s  canvas-notebook-host-cli.tar.gz\n' "$host_cli_sha" > "$TMP_DIR/assets/canvas-notebook-host-cli.sha256"
printf '%s  canvas-notebook-host-cli.tar.gz\n' "$(printf '0%.0s' {1..64})" > "$TMP_DIR/assets/bad.sha256"

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [[ -z "$out" ]]; then
  exit 0
fi
[[ "$url" == file://* ]]
printf '%s\n' "$url" >> "${CANVAS_TEST_CURL_LOG:?}"
cp "${url#file://}" "$out"
SH
chmod +x "$TMP_DIR/bin/curl"

cat > "$TMP_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  info)
    exit 0
    ;;
  buildx|manifest|image)
    exit 1
    ;;
  compose)
    shift
    printf '%s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"ps -q postgres"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  inspect)
    shift
    printf 'inspect %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ "$*" == *"{{.State.Status}}"* ]]; then
      printf 'running\n'
    elif [[ "$*" == *"{{.Id}}"* ]]; then
      printf 'fake-postgres-id\n'
    fi
    exit 0
    ;;
  exec)
    shift
    printf 'exec %s\n' "$*" >> "${CANVAS_TEST_DOCKER_LOG:?}"
    if [[ ! -t 0 ]]; then
      cat >/dev/null || true
    fi
    exit 0
    ;;
  *)
    echo "unexpected docker command: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$TMP_DIR/bin/docker"

export PATH="$TMP_DIR/bin:$PATH"
export CANVAS_INSTALL_DIR="$TMP_DIR/install"
export CANVAS_CLI_PATH="$TMP_DIR/install/bin/canvas-notebook"
export CANVAS_COMPOSE_FILE="$TMP_DIR/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_JSON="$TMP_DIR/config.json"
export CANVAS_CONFIG_ENV="$TMP_DIR/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TMP_DIR/.env"
export CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
export CANVAS_HOST_CODE_OWNER="$(id -u):$(id -g)"
export CANVAS_MANAGER_LOG_DIR="$TMP_DIR/logs"
export CANVAS_TEST_DOCKER_LOG="$TMP_DIR/docker.log"
export CANVAS_TEST_LATEST_DIR="$TMP_DIR/latest"
export CANVAS_TEST_CURL_LOG="$TMP_DIR/curl.log"
export CANVAS_USE_COLOR=false
export CANVAS_HOST_CLI_VERSION="v${LATEST_VERSION}"
export CANVAS_EXPECTED_LINUX_CLI_VERSION="$LATEST_VERSION"
export CANVAS_HOST_CLI_URL="file://$TMP_DIR/assets/canvas-notebook-host-cli.tar.gz"
export CANVAS_HOST_CLI_SHA256_URL="file://$TMP_DIR/assets/canvas-notebook-host-cli.sha256"
export CANVAS_HOST_CLI_ALLOW_FILE_URL=true

"$CANVAS_CLI_PATH" config-set env.CANVAS_DATABASE_PROVIDER postgres --no-banner > /dev/null
printf '%s' 'update-test-password' | "$CANVAS_CLI_PATH" config-set env.CANVAS_POSTGRES_PASSWORD --stdin --no-banner > /dev/null
printf '%s' 'postgresql://canvas:update-test-password@postgres:5432/canvas_notebook' | "$CANVAS_CLI_PATH" config-set env.DATABASE_URL --stdin --no-banner > /dev/null
"$CANVAS_CLI_PATH" env --sync --no-banner > /dev/null
: > "$CANVAS_TEST_DOCKER_LOG"

"$CANVAS_CLI_PATH" update --no-banner > "$TMP_DIR/update.txt" 2>&1

grep -q "Management CLI updated 2026.7.8.1 -> ${LATEST_VERSION}" "$TMP_DIR/update.txt" || { cat "$TMP_DIR/update.txt" >&2; exit 1; }
grep -q 'Restarting update with updated CLI' "$TMP_DIR/update.txt"
grep -q "^CANVAS_CLI_VERSION=\"${LATEST_VERSION}\"$" "$CANVAS_CLI_PATH"
grep -q -- '--profile postgres up -d --no-recreate postgres' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'exec -i -u postgres fake-postgres-id psql' "$CANVAS_TEST_DOCKER_LOG"
grep -q 'up -d --force-recreate' "$CANVAS_TEST_DOCKER_LOG"
if grep -Eq 'raw\.githubusercontent\.com|/main/|/latest/' "$CANVAS_TEST_CURL_LOG"; then
  echo "cli-update used a mutable update URL" >&2
  exit 1
fi

updated_fingerprint="$(cksum "$CANVAS_CLI_PATH")"
export CANVAS_HOST_CLI_FORCE_UPDATE=true
export CANVAS_HOST_CLI_SHA256_URL="file://$TMP_DIR/assets/bad.sha256"
if "$CANVAS_CLI_PATH" cli-update --no-banner > "$TMP_DIR/checksum-mismatch.out" 2> "$TMP_DIR/checksum-mismatch.err"; then
  echo "cli-update accepted a checksum mismatch" >&2
  exit 1
fi
grep -q 'CLI update failed' "$TMP_DIR/checksum-mismatch.err"
[[ "$updated_fingerprint" == "$(cksum "$CANVAS_CLI_PATH")" ]]

echo "cli update reexec test passed"
